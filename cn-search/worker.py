"""Serial public-web worker; the bridge owns authorization and job assignment."""

import argparse
import contextlib
import ctypes
from datetime import datetime, timezone
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urlencode, urlsplit, urlunsplit

from page_parser import PageError, read_page, search_sources
from platform_limits import ProcessJob


BASE = Path(__file__).resolve().parent
MAX_ARTIFACT = 8 * 1024 * 1024
MAX_PACKET = 256 * 1024
MAX_MEMORY = 768 * 1024 * 1024
ENGINE = "moli/1.1.18"
SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
SAFE_FILE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\Z")


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def resolve_host(host, port):
    completed, values = threading.Event(), []

    def lookup():
        try:
            values.append(socket.getaddrinfo(host, port, type=socket.SOCK_STREAM))
        except OSError:
            values.append(None)
        finally:
            completed.set()

    threading.Thread(target=lookup, daemon=True).start()
    if not completed.wait(10):
        raise PageError("dns_timeout", "Public DNS lookup exceeded ten seconds.")
    if not values[0]:
        raise PageError("dns_error", "The public hostname could not be resolved.")
    return values[0]


def public_url(value, *, resolve=True):
    if not isinstance(value, str) or len(value) > 8192 or re.search(r"[\x00-\x20\x7f\\]", value):
        raise PageError("invalid_url", "A bounded HTTP(S) URL without control characters is required.")
    try:
        url = urlsplit(value)
        if url.scheme not in {"http", "https"} or not url.hostname or url.username is not None or url.password is not None or url.port not in {None, 80, 443}:
            raise ValueError("unsupported URL")
        host = url.hostname.encode("idna").decode("ascii")
        try:
            addresses = [ipaddress.ip_address(host)]
        except ValueError:
            if host.rstrip(".").lower() == "localhost" or host.rstrip(".").lower().endswith((".localhost", ".local", ".internal", ".home", ".home.arpa", ".lan")) or "." not in host:
                raise PageError("private_network", "Private or local hostnames are blocked.", "blocked")
            addresses = [ipaddress.ip_address(item[4][0]) for item in resolve_host(host, url.port or (443 if url.scheme == "https" else 80))] if resolve else []
        if any(not address.is_global or address.is_multicast for address in addresses):
            raise PageError("private_network", "Every resolved address must be globally routable.", "blocked")
        if resolve and not addresses:
            raise PageError("dns_error", "The public hostname has no address.")
        netloc = (f"[{host}]" if ":" in host else host) + (f":{url.port}" if url.port else "")
        return urlunsplit((url.scheme, netloc, url.path or "/", url.query, ""))
    except (ValueError, UnicodeError) as error:
        raise PageError("invalid_url", "The public URL is invalid or contains credentials or a non-web port.") from error
    except OSError as error:
        raise PageError("dns_error", "The public hostname could not be resolved.") from error


def bridge_origin(value):
    try:
        parsed = urlsplit(value)
        if parsed.path not in {"", "/"} or parsed.query or parsed.fragment or parsed.username is not None or parsed.password is not None:
            raise ValueError("origin only")
        loopback = parsed.hostname == "localhost"
        try:
            loopback = loopback or ipaddress.ip_address(parsed.hostname).is_loopback
        except (ValueError, TypeError):
            pass
        if parsed.scheme == "http" and loopback:
            return value.rstrip("/")
        if parsed.scheme != "https":
            raise ValueError("HTTPS is required")
        return public_url(value).rstrip("/")
    except (ValueError, TypeError, PageError) as error:
        raise ValueError("BRIDGE_ORIGIN must be one public HTTPS origin (HTTP loopback is allowed for tests).") from error


def private_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise ValueError("State directories cannot be symbolic links.")
    os.chmod(path, 0o700)
    return path


def atomic_json(path, value):
    temporary = path.with_suffix(".tmp")
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb") as output:
        output.write(encode(value))
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    if os.name != "nt":
        descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


@contextlib.contextmanager
def worker_lock(spool):
    private_directory(spool)
    with (spool / "worker.lock").open("a+b") as lock:
        if os.name == "nt":
            import msvcrt
            try:
                lock.seek(0)
                if not lock.read(1):
                    lock.write(b"0")
                    lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as error:
                raise ValueError("Another worker already owns this spool and browser slot.") from error
        else:
            import fcntl
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                raise ValueError("Another worker already owns this spool and browser slot.") from error
        try:
            yield
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def browser_environment(directory):
    environment = {name: os.environ[name] for name in ("SystemRoot", "WINDIR", "SYSTEMDRIVE") if name in os.environ}
    environment.update({"PATH": os.defpath, "HOME": str(directory), "USERPROFILE": str(directory), "TMPDIR": str(directory), "TMP": str(directory), "TEMP": str(directory), "LANG": "C.UTF-8", "NO_PROXY": "*"})
    cache = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if not cache:
        cache_root = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) if os.name == "nt" else Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
        cache = str(cache_root / "ms-playwright")
    environment["PLAYWRIGHT_BROWSERS_PATH"] = cache
    return environment


def resident_memory(process):
    if os.name == "nt":
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [(name, ctypes.c_size_t) for name in ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]

        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        query = ctypes.WinDLL("psapi", use_last_error=True).GetProcessMemoryInfo
        query.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD]
        query.restype = wintypes.BOOL
        if not query(int(process._handle), ctypes.byref(counters), counters.cb):
            if process.poll() is not None:
                return 0
            raise PageError("resource_monitor_error", "Cannot read browser memory usage.")
        return max(counters.WorkingSetSize, counters.PagefileUsage)
    try:
        fields = Path(f"/proc/{process.pid}/statm").read_text().split()
        return int(fields[1]) * os.sysconf("SC_PAGE_SIZE")
    except FileNotFoundError:
        return 0


def run_process(command, directory, *, timeout=45, cancel=None):
    process = subprocess.Popen(command, cwd=directory, env=browser_environment(directory), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=os.name != "nt")
    try:
        job = ProcessJob(process, MAX_MEMORY)
    except OSError:
        process.kill()
        process.wait()
        process.stdout.close()
        process.stderr.close()
        raise
    outputs = [bytearray(), bytearray()]
    overflow = threading.Event()

    def read(stream, output, limit):
        while chunk := stream.read(16384):
            remaining = limit - len(output)
            output.extend(chunk[:max(remaining, 0)])
            if len(chunk) > remaining:
                overflow.set()

    readers = [threading.Thread(target=read, args=(stream, output, limit), daemon=True) for stream, output, limit in zip((process.stdout, process.stderr), outputs, (MAX_ARTIFACT, 65536))]
    for reader in readers:
        reader.start()
    started = time.monotonic()
    try:
        while process.poll() is None:
            if cancel is not None and cancel.is_set():
                raise PageError("lease_revoked", "The lease was cancelled, paused, revoked, or expired.", "blocked")
            if time.monotonic() - started > timeout:
                raise PageError("timeout", f"The browser exceeded its {timeout}-second wall-clock limit.")
            if overflow.is_set():
                raise PageError("output_too_large", "Browser output exceeded the 8 MiB content or 64 KiB diagnostic limit.")
            if resident_memory(process) > MAX_MEMORY:
                raise PageError("memory_limit", "The browser exceeded its 768 MiB memory limit.")
            time.sleep(0.05)
    finally:
        if process.poll() is None:
            if os.name == "nt":
                process.kill()
            else:
                os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        job.close()
        if os.name != "nt":
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
        for reader in readers:
            reader.join(timeout=2)
        process.stdout.close()
        process.stderr.close()
    if overflow.is_set():
        raise PageError("output_too_large", "Browser output exceeded its bounded capture limit.")
    return process.returncode, bytes(outputs[0]), bytes(outputs[1])


class Moli:
    engine = ENGINE

    def __init__(self, binary, jobs):
        self.binary = str(Path(binary).resolve())
        self.jobs = private_directory(jobs)
        with tempfile.TemporaryDirectory(dir=jobs, prefix="version-") as temporary:
            code, output, _ = run_process([self.binary, "--version"], Path(temporary), timeout=5)
        if code or output.decode("utf-8", "replace").strip() != "moli 1.1.18":
            raise ValueError("MOLI_BIN must be the pinned Moli 1.1.18 binary.")

    def fetch(self, url, directory, dump="json", cancel=None):
        url = public_url(url)
        command = [self.binary, "fetch", "--dump", dump, "--wait-until", "done", "--block-private-networks", "--http-no-proxy", "*", "--timeout", "25000", "--http-timeout", "25000", "--http-connect-timeout", "10000", "--http-max-response-size", str(MAX_ARTIFACT), "--http-max-concurrent", "4", "--http-max-total-connections", "8"]
        if dump == "screenshot":
            command.extend(["--layout", "--image", "--font"])
        command.append(url)
        code, output, diagnostic = run_process(command, directory, cancel=cancel)
        if code:
            detail = diagnostic.decode("utf-8", "replace").lower()
            if any(marker in detail for marker in ("private network", "private-network", "blocked by", "blocked address", "network policy")):
                raise PageError("private_network", "Moli blocked a private-network navigation or resource.", "blocked")
            if "timed out" in detail or "timeout" in detail:
                raise PageError("timeout", "Moli could not complete the page within its readiness deadline.")
            if "certificate" in detail or "tls" in detail:
                raise PageError("tls_error", "TLS certificate verification failed; verification was not disabled.")
            raise PageError("engine_failed", f"Moli exited with code {code}; no page content was accepted.")
        if dump == "screenshot":
            if not output.startswith(b"\x89PNG\r\n\x1a\n") or len(output) < 64:
                raise PageError("invalid_screenshot", "Moli did not return a non-empty PNG.")
            return output
        try:
            payload = json.loads(output.decode("utf-8"))
        except (ValueError, UnicodeError) as error:
            raise PageError("invalid_engine_output", "Moli did not return valid UTF-8 JSON.") from error
        if isinstance(payload, dict) and isinstance(payload.get("final_url"), str):
            public_url(payload["final_url"])
            for hop in payload.get("redirect_chain", []):
                if isinstance(hop, dict):
                    for key in ("url", "from_url", "to_url", "location"):
                        if isinstance(hop.get(key), str) and hop[key].startswith(("http://", "https://")):
                            public_url(hop[key])
        return payload

    def execute(self, operation, arguments, cancel=None):
        if not isinstance(arguments, dict):
            raise PageError("invalid_arguments", "Job arguments must be an object.")
        artifacts = []
        with tempfile.TemporaryDirectory(dir=self.jobs, prefix="page-") as temporary:
            directory = Path(temporary)
            if operation == "fetch_public_page":
                if set(arguments) - {"url", "screenshot"} or type(arguments.get("screenshot", False)) is not bool:
                    raise PageError("invalid_arguments", "fetch_public_page accepts only url and an optional boolean screenshot.")
                url = public_url(arguments.get("url"), resolve=False)
            elif operation == "regional_search":
                if set(arguments) - {"query", "engine", "limit", "language"}:
                    raise PageError("invalid_arguments", "regional_search arguments contain unsupported fields.")
                query, engine, limit = arguments.get("query"), arguments.get("engine"), arguments.get("limit", 5)
                if not isinstance(query, str) or not query.strip() or len(query) > 2000 or re.search(r"[\x00-\x1f\x7f]", query) or engine not in {"baidu", "yandex"} or type(limit) is not int or not 1 <= limit <= 10:
                    raise PageError("invalid_arguments", "Search requires a non-empty query, baidu/yandex, and limit 1..10.")
                language = arguments.get("language", "zh" if engine == "baidu" else "ru")
                if language not in {"zh", "ru"}:
                    raise PageError("invalid_arguments", "language must be zh or ru.")
                url = "https://www.baidu.com/s?" + urlencode({"wd": query, "rn": limit}) if engine == "baidu" else "https://yandex.ru/search/?" + urlencode({"text": query, "numdoc": limit, "lang": language})
            else:
                raise PageError("unsupported_operation", "This worker supports only regional_search and fetch_public_page.")
            payload = self.fetch(url, directory, cancel=cancel)
            document, text, title = read_page(payload)
            if len(title) > 4096:
                raise PageError("output_too_large", "The page title exceeds the result size boundary.")
            result = {"url": url, "final_url": payload["final_url"], "title": title, "egress": "direct; inherited proxies disabled", "warnings": [f"retrieval_engine={self.engine}", f"http_status={payload['status']}"]}
            result["warnings"].extend(payload.get("warnings", []))
            if self.engine != ENGINE:
                result["warnings"].extend(["explicit_chromium_compatibility_mode; no automatic fallback", f"browser_version={payload.get('browser_version', 'unknown')}"])
            if operation == "regional_search":
                result.update(engine=engine, sources=search_sources(document, engine, payload["final_url"], limit, language))
                if len(encode(result)) > 160 * 1024:
                    original = encode(result["sources"])
                    if len(original) > MAX_ARTIFACT:
                        raise PageError("output_too_large", "Complete search sources exceed the 8 MiB artifact limit.")
                    artifacts.append(("sources.json", "application/json", original))
                    for source in result["sources"]:
                        length = len(source["snippet"])
                        source["snippet"] = source["snippet"][:1000]
                        if length > 1000:
                            result["warnings"].append(f"snippet_truncated: url={source['url']}; original_chars={length}; returned_chars=1000; full=sources.json")
            else:
                result.update(engine=self.engine, content=text)
                if len(text.encode("utf-8")) > 160 * 1024:
                    content = text.encode("utf-8")
                    if len(content) > MAX_ARTIFACT:
                        raise PageError("output_too_large", "Complete text exceeds the 8 MiB artifact limit.")
                    result["content"] = content[:160 * 1024].decode("utf-8", "ignore")
                    result["warnings"].append(f"content_truncated: original_chars={len(text)}; returned_chars={len(result['content'])}; full=content.txt")
                    artifacts.append(("content.txt", "text/plain; charset=utf-8", content))
                if arguments.get("screenshot"):
                    artifacts.append(("viewport.png", "image/png", self.fetch(url, directory, dump="screenshot", cancel=cancel)))
                    result["warnings"].append(f"screenshot_separate_navigation: viewport.png is a separate {self.engine} navigation, not a precision Capture artifact")
            if len(encode(result)) > 230 * 1024:
                raise PageError("output_too_large", "The structured result cannot fit the 256 KiB transport boundary.")
            return result, artifacts


class Chromium(Moli):
    engine = "chromium/playwright-1.61.0"

    def __init__(self, binary, jobs):
        import importlib.metadata
        try:
            version = importlib.metadata.version("playwright")
        except importlib.metadata.PackageNotFoundError as error:
            raise ValueError("Explicit Chromium mode requires requirements-chromium.txt.") from error
        if version != "1.61.0":
            raise ValueError("Explicit Chromium mode requires requirements-chromium.txt (Playwright 1.61.0).")
        self.jobs = private_directory(jobs)
        self.executable = os.environ.get("CHROMIUM_BIN")
        if self.executable:
            self.executable = str(Path(self.executable).resolve(strict=True))

    def fetch(self, url, directory, dump="json", cancel=None):
        url = public_url(url)
        command = [sys.executable, str(BASE / "chromium_fetch.py"), url, "--dump", dump]
        if self.executable:
            command.extend(["--executable", self.executable])
        code, output, _ = run_process(command, directory, cancel=cancel)
        if code:
            try:
                error = json.loads(output)["error"]
                raise PageError(error["code"], error["message"], error["status"])
            except (ValueError, KeyError, TypeError):
                raise PageError("compatibility_engine_failed", "The Chromium child failed before returning a bounded result.")
        if dump == "screenshot":
            if not output.startswith(b"\x89PNG\r\n\x1a\n") or len(output) < 64:
                raise PageError("invalid_screenshot", "Chromium did not return a valid viewport PNG.")
            return output
        try:
            payload = json.loads(output)
            public_url(payload["final_url"])
            return payload
        except (ValueError, KeyError, TypeError) as error:
            raise PageError("invalid_engine_output", "The Chromium child returned invalid JSON metadata.") from error


class BridgeError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


class Bridge:
    def __init__(self, origin, token):
        self.origin = bridge_origin(origin)
        if not token or len(token) > 4096 or re.search(r"[\r\n]", token):
            raise ValueError("WORKER_TOKEN must be a non-empty bearer token without newlines.")
        self.token = token
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def request(self, route, data, *, method="POST", lease=None):
        if not route.startswith("/api/worker/") or "?" in route or "#" in route:
            raise ValueError("Only the fixed worker control routes are allowed.")
        body = data if isinstance(data, bytes) else encode(data)
        if len(body) > (MAX_ARTIFACT if method == "PUT" else MAX_PACKET):
            raise BridgeError("Outbound control payload exceeds its size limit.")
        headers = {"Authorization": "Bearer " + self.token, "Content-Type": "application/octet-stream" if method == "PUT" else "application/json", "User-Agent": "Rivule-regional-worker/0.1"}
        if lease is not None:
            headers["X-Worker-Lease"] = lease
        request = urllib.request.Request(self.origin + route, data=body, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=20) as response:
                if route == "/api/worker/result":
                    return {}
                payload = response.read(MAX_PACKET + 1)
                if len(payload) > MAX_PACKET:
                    raise BridgeError("The bridge response exceeds 256 KiB.")
                if not payload:
                    return {}
                try:
                    value = json.loads(payload)
                    if not isinstance(value, dict):
                        raise ValueError("not an object")
                    return value
                except ValueError as error:
                    if route == "/api/worker/heartbeat":
                        return {}
                    raise BridgeError("The bridge returned invalid JSON.") from error
        except urllib.error.HTTPError as error:
            error.close()
            raise BridgeError(f"Bridge HTTP {error.code}; the saved job remains pending.", error.code) from error
        except (OSError, urllib.error.URLError) as error:
            raise BridgeError("Bridge delivery failed or acknowledgment is unknown; retrying the saved identity.") from error


def lease_time(value):
    if not isinstance(value, str):
        raise ValueError("Lease expiry must be an ISO8601 timestamp.")
    moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if moment.tzinfo is None:
        raise ValueError("Lease expiry requires a timezone.")
    return moment.timestamp()


def validate_job(job):
    if not isinstance(job, dict) or not isinstance(job.get("job_id"), str) or not SAFE_ID.fullmatch(job["job_id"]):
        raise BridgeError("The claimed job has no safe job_id.")
    for field in ("workspace_id", "task_id", "operation", "lease_token"):
        value = job.get(field)
        if not isinstance(value, str) or not value or len(value) > 1024 or re.search(r"[\x00-\x1f\x7f]", value):
            raise BridgeError("The claimed job has invalid identity metadata.")
    try:
        lease_time(job.get("lease_expires_at"))
    except ValueError as error:
        raise BridgeError("The claimed job has invalid lease_expires_at.") from error
    if len(encode(job)) > MAX_PACKET:
        raise BridgeError("The claimed job is too large.")
    return job


class Heartbeat:
    def __init__(self, bridge, job):
        self.bridge, self.job = bridge, job
        self.stop = threading.Event()
        self.cancel = threading.Event()
        self.expiry = lease_time(job["lease_expires_at"])
        self.thread = threading.Thread(target=self.run, daemon=True)

    def is_set(self):
        return self.cancel.is_set() or time.time() >= self.expiry

    def run(self):
        while not self.stop.is_set():
            if time.time() >= self.expiry:
                self.cancel.set()
                return
            try:
                value = self.bridge.request("/api/worker/heartbeat", {"job_id": self.job["job_id"], "lease_token": self.job["lease_token"]})
                if "lease_expires_at" in value:
                    self.expiry = lease_time(value["lease_expires_at"])
            except BridgeError as error:
                if error.status in {409, 410}:
                    self.cancel.set()
                    return
            except ValueError:
                self.cancel.set()
                return
            if self.stop.wait(min(10, max(0.1, self.expiry - time.time()))):
                return

    def __enter__(self):
        if time.time() >= self.expiry:
            self.cancel.set()
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        self.thread.join(timeout=21)


class Worker:
    def __init__(self, bridge, executor, spool):
        self.bridge, self.executor, self.spool = bridge, executor, private_directory(spool)

    def pending(self):
        directories = [path for path in self.spool.iterdir() if path.is_dir() and SAFE_ID.fullmatch(path.name)]
        if len(directories) > 1:
            raise BridgeError("Multiple pending job directories require operator reconciliation.")
        return directories[0] if directories else None

    def step(self):
        directory = self.pending()
        if directory is None:
            response = self.bridge.request("/api/worker/claim", {"capabilities": ["regional_search", "fetch_public_page"]})
            if "job" not in response:
                raise BridgeError("The claim response is missing job.")
            if response["job"] is None:
                return False
            job = validate_job(response["job"])
            directory = private_directory(self.spool / job["job_id"])
            state = {"job": job, "artifacts": [], "uploaded": []}
            atomic_json(directory / "state.json", state)
            with Heartbeat(self.bridge, job) as heartbeat:
                try:
                    if heartbeat.is_set():
                        raise PageError("lease_revoked", "The lease expired before browser execution.", "blocked")
                    executor = self.executor() if callable(self.executor) else self.executor
                    result, artifacts = executor.execute(job["operation"], job.get("arguments"), heartbeat)
                    if heartbeat.is_set():
                        raise PageError("lease_revoked", "The lease was revoked during browser execution.", "blocked")
                    state["packet"] = {"job_id": job["job_id"], "lease_token": job["lease_token"], "status": "succeeded", "result": result}
                    for filename, media_type, body in artifacts:
                        if not SAFE_FILE.fullmatch(filename) or ".." in filename or len(body) > MAX_ARTIFACT:
                            raise PageError("artifact_limit", "An artifact violates filename or size limits.")
                        with os.fdopen(os.open(directory / filename, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "wb") as output:
                            output.write(body)
                            output.flush()
                            os.fsync(output.fileno())
                        state["artifacts"].append({"filename": filename, "media_type": media_type, "size_bytes": len(body)})
                except PageError as error:
                    state["packet"] = {"job_id": job["job_id"], "lease_token": job["lease_token"], "status": error.status, "error": {"code": error.code, "message": str(error)}}
                    state["artifacts"] = []
                except Exception:
                    state["packet"] = {"job_id": job["job_id"], "lease_token": job["lease_token"], "status": "failed", "error": {"code": "worker_error", "message": "Local worker execution failed; no source content was accepted."}}
                    state["artifacts"] = []
                atomic_json(directory / "state.json", state)
        else:
            state = json.loads((directory / "state.json").read_text(encoding="utf-8"))
            job = validate_job(state["job"])
            if job["job_id"] != directory.name:
                raise BridgeError("The saved job identity does not match its spool directory.")
            if "packet" not in state:
                state["packet"] = {"job_id": job["job_id"], "lease_token": job["lease_token"], "status": "failed", "error": {"code": "worker_interrupted", "message": "The worker stopped before committing its result; the web job was not re-executed."}}
                state["artifacts"] = []
                atomic_json(directory / "state.json", state)
        self.deliver(directory, state)
        return True

    def deliver(self, directory, state):
        job, packet = state["job"], state["packet"]
        for artifact in state["artifacts"]:
            if artifact["filename"] in [item["filename"] for item in state["uploaded"]]:
                continue
            filename = artifact["filename"]
            if not SAFE_FILE.fullmatch(filename) or ".." in filename:
                raise BridgeError("Unsafe artifact filename in spool.")
            path = directory / filename
            if path.is_symlink() or path.stat().st_size != artifact["size_bytes"] or path.stat().st_size > MAX_ARTIFACT:
                raise BridgeError("The saved artifact is missing, changed, or oversized.")
            response = self.bridge.request(f"/api/worker/artifacts/{quote(job['job_id'], safe='')}/{filename}", path.read_bytes(), method="PUT", lease=job["lease_token"])
            if not isinstance(response.get("artifact_id"), str) or not response["artifact_id"]:
                raise BridgeError("Artifact upload acknowledgment is missing artifact_id.")
            saved = {**artifact, "artifact_id": response["artifact_id"]}
            if isinstance(response.get("url"), str):
                saved["url"] = response["url"]
            state["uploaded"].append(saved)
            atomic_json(directory / "state.json", state)
        if state["uploaded"]:
            packet.setdefault("result", {})["artifacts"] = state["uploaded"]
        if len(encode(packet)) > MAX_PACKET:
            raise BridgeError("The saved result packet exceeds 256 KiB.")
        atomic_json(directory / "state.json", state)
        self.bridge.request("/api/worker/result", packet)
        if directory.resolve().parent != self.spool.resolve() or directory.is_symlink():
            raise BridgeError("Refusing to remove a spool directory outside this worker's state root.")
        shutil.rmtree(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--moli-bin", default=os.environ.get("MOLI_BIN", str(BASE / ".runtime" / ("moli.exe" if os.name == "nt" else "moli"))))
    parser.add_argument("--browser", choices=("moli", "chromium"), default=os.environ.get("FETCH_ENGINE", "moli"), help="Chromium is an explicit operator-selected compatibility mode, never an automatic retry.")
    parser.add_argument("--spool", type=Path, default=Path(os.environ.get("SPOOL_DIR", BASE / ".spool")))
    parser.add_argument("--jobs", type=Path, default=Path(os.environ.get("JOBS_DIR", BASE / ".jobs")))
    commands = parser.add_subparsers(dest="command", required=True)
    fetch = commands.add_parser("fetch", help="Fetch one public page; artifacts remain in a private local job directory.")
    fetch.add_argument("url")
    fetch.add_argument("--screenshot", action="store_true")
    search = commands.add_parser("search", help="Search Baidu or Yandex without synthesizing new claims.")
    search.add_argument("query")
    search.add_argument("--engine", choices=("baidu", "yandex"), default="baidu")
    search.add_argument("--limit", type=int, default=5)
    search.add_argument("--language", choices=("zh", "ru"))
    poll = commands.add_parser("poll", help="Poll the authenticated bridge, with one browser job at a time.")
    poll.add_argument("--once", action="store_true", help="Claim or deliver at most one job, then exit.")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        with worker_lock(args.spool):
            if args.browser not in {"moli", "chromium"}:
                raise ValueError("FETCH_ENGINE must be moli or explicitly chromium.")
            engine_class = Moli if args.browser == "moli" else Chromium
            if args.command == "poll":
                bridge = Bridge(os.environ.get("BRIDGE_ORIGIN", ""), os.environ.get("WORKER_TOKEN", ""))
                worker = Worker(bridge, lambda: engine_class(args.moli_bin, args.jobs), args.spool)
                delay = 10
                while True:
                    try:
                        worked = worker.step()
                        delay = 10
                        if args.once:
                            return 0
                        if not worked:
                            time.sleep(delay)
                    except BridgeError as error:
                        print(str(error), file=sys.stderr)
                        if args.once:
                            return 2
                        time.sleep(delay)
                        delay = min(120, delay * 2)
            else:
                executor = engine_class(args.moli_bin, args.jobs)
                arguments = {"url": args.url, "screenshot": args.screenshot} if args.command == "fetch" else {"query": args.query, "engine": args.engine, "limit": args.limit}
                if args.command == "search" and args.language:
                    arguments["language"] = args.language
                result, artifacts = executor.execute("fetch_public_page" if args.command == "fetch" else "regional_search", arguments)
                if artifacts:
                    directory = private_directory(Path(tempfile.mkdtemp(dir=args.spool, prefix="local.")))
                    result["artifacts"] = []
                    for filename, media_type, body in artifacts:
                        path = directory / filename
                        path.write_bytes(body)
                        result["artifacts"].append({"filename": filename, "path": str(path.resolve()), "media_type": media_type, "size_bytes": len(body)})
                sys.stdout.buffer.write(encode({"status": "succeeded", "result": result}) + b"\n")
                return 0
    except PageError as error:
        sys.stdout.buffer.write(encode({"status": error.status, "error": {"code": error.code, "message": str(error)}}) + b"\n")
        return 3 if error.status == "blocked" else 1
    except (ValueError, OSError, BridgeError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
