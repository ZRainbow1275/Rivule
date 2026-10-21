"""Local fixtures for safety/parsing/recovery; these do not claim live-site coverage."""

import asyncio
import base64
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from network_guard import NetworkPolicy, PolicySocksProxy, URLPolicyError
from install_moli import license_path
from page_parser import Document, PageError, read_page, search_sources
from worker import Bridge, BridgeError, Heartbeat, MAX_PACKET, Moli, Worker, atomic_json, browser_environment, encode, public_url, run_process, worker_lock


def job():
    return {"job_id": "fixture-job", "workspace_id": "fixture-workspace", "task_id": "fixture-task", "operation": "fetch_public_page", "arguments": {"url": "https://public.test/"}, "lease_token": secrets.token_urlsafe(16), "lease_expires_at": (datetime.now(timezone.utc) + timedelta(minutes=2)).isoformat()}


def page(html, **updates):
    return {"status": 200, "final_url": "https://public.test/article", "title": "公开文章 / Новости", "html": html, **updates}


class ParserTests(unittest.TestCase):
    def test_article_and_russian_unicode(self):
        content = "公开网页正文，保留中文。 Новости науки и технологий. " * 12
        _, extracted, _ = read_page(page(f"<nav>导航</nav><article><p>{content}</p><script>ignore()</script></article><footer>页脚</footer>"))
        self.assertIn("Новости", extracted)
        self.assertNotIn("ignore", extracted)
        self.assertNotIn("导航", extracted)

    def test_wechat_and_nested_zhihu_scopes_not_duplicated(self):
        content = "公开中文文章内容以及正常段落。" * 20
        _, extracted, _ = read_page(page(f"<div class='RichText'><div class='RichContent-inner'>{content}</div></div>"))
        self.assertEqual(extracted, content)
        _, extracted, _ = read_page(page(f"<div id='js_content'>{content}</div>"))
        self.assertEqual(extracted, content)

    def test_declared_russian_encoding(self):
        content = "Открытая русская новость. Наука и технологии. " * 12
        payload = page(None, headers=[{"name": "Content-Type", "value": "text/plain; charset=windows-1251"}], body_base64=base64.b64encode(content.encode("cp1251")).decode())
        self.assertEqual(read_page(payload)[1], content)

    def test_public_vk_and_telegram_posts_keep_separate_text(self):
        for css in ("wall_post_text", "tgme_widget_message_text"):
            first, second = "Первая открытая новость. " * 8, "Вторая открытая новость. " * 8
            _, extracted, _ = read_page(page(f"<nav>login</nav><div class='{css}'>{first}</div><div class='{css}'>{second}</div>"))
            self.assertIn(first.strip(), extracted)
            self.assertIn(second.strip(), extracted)
            self.assertNotIn("login", extracted)

    def test_challenge_auth_empty_and_browser_error(self):
        for title, html, expected in [("百度安全验证", "<body>验证</body>", "captcha"), ("Вход", "<form><input type=password></form>", "authentication_required"), ("App", "<div id=root></div>", "empty_content"), ("This site can’t be reached", "<p>Connection failed</p>", "browser_error")]:
            with self.subTest(expected=expected), self.assertRaises(PageError) as caught:
                read_page(page(html, title=title))
            self.assertEqual(caught.exception.code, expected)

    def test_http_errors_are_not_source_content(self):
        for status, expected in [(401, "authentication_required"), (403, "access_denied"), (429, "rate_limited"), (500, "http_error")]:
            with self.subTest(status=status), self.assertRaises(PageError) as caught:
                read_page(page("<article>" + "public source text " * 30 + "</article>", status=status))
            self.assertEqual(caught.exception.code, expected)

    def test_search_provenance_and_link_parsers(self):
        fixtures = [("baidu", "<div class='result c-container'><h3><a href='/link?url=abc'>中文标题</a></h3><p>公开摘要</p></div>", "zh"), ("yandex", "<li class=serp-item><div class=Organic><h2><a class=OrganicTitle-Link href='https://news.test/report'>Новости</a></h2><p>Открытая новость</p></div></li>", "ru")]
        for engine, html, language in fixtures:
            container = "result" if engine == "baidu" else "serp-item"
            html += f"<div class='{container}'><h2><a href='https://@news.test/private'>must not return credential URL</a></h2></div>"
            sources = search_sources(Document(html), engine, "https://www.baidu.com/" if engine == "baidu" else "https://yandex.ru/", 3, language)
            self.assertEqual(len(sources), 1)
            self.assertEqual(sources[0]["provider"], engine)
            self.assertEqual(sources[0]["language"], language)
            self.assertTrue(sources[0]["url"].startswith("https://"))

    def test_baidu_paid_clicks_are_excluded_even_in_nested_containers(self):
        # VPS-observed title and URL shape; opaque query values are local fixtures.
        paid = "https://www.baidu.com/baidu.php?url=fixture-paid-click"
        organic = "https://www.baidu.com/link?url=fixture-organic"
        other = "https://public.example/baidu.php?url=fixture-article"
        ad_title = "不受国内限制浏览器-点击进入-安全无痕浏览"
        html = f"""<div class="c-container">
          <div class="result c-container"><h3><a href="{paid}">{ad_title}</a></h3>
            <div class="c-container"><h3><a href="{paid}">{ad_title}</a></h3></div>
          </div>
          <div class="result c-container"><h3><a href="{organic}">公开浏览器研究</a></h3><p>原样摘要：公开技术说明。</p>
            <div class="c-container"><h3><a href="{organic}">公开浏览器研究</a></h3></div>
          </div>
        </div><div class="result"><h3><a href="{other}">{ad_title}</a></h3><p>其他网站的同名路径。</p></div>"""
        sources = search_sources(Document(html), "baidu", "https://www.baidu.com/", 10, "zh")
        self.assertEqual([source["url"] for source in sources], [organic, other])
        self.assertEqual(sources[0]["title"], "公开浏览器研究")
        self.assertIn("原样摘要：公开技术说明。", sources[0]["snippet"])
        self.assertEqual(sources[1]["title"], ad_title)

    def test_baidu_url_filter_preserves_web_links_and_rejects_unsafe_authorities(self):
        keep = ["http://www.baidu.com:80/link?url=fixture-organic", "https://public.example:443/baidu.php?url=fixture-article", "https://www.baidu.com.example/baidu.php?url=fixture-lookalike"]
        reject = ["https://baidu.com/baidu.php?url=fixture-paid", "https://WWW.BAIDU.COM.:443/baidu.php?url=fixture-paid", "https://baidu.com@public.example/baidu.php", "https://@public.example/baidu.php", "https://public.example:invalid/baidu.php", "https://public.example:65536/baidu.php", "https://public.example:8080/baidu.php", "https://[invalid/baidu.php"]
        html = "".join(f'<div class="result"><h3><a href="{url}">原始标题</a></h3><p>原始摘要</p></div>' for url in reject + keep)
        sources = search_sources(Document(html), "baidu", "https://www.baidu.com/", 10, "zh")
        self.assertEqual([source["url"] for source in sources], keep)
        self.assertTrue(all(source["title"] == "原始标题" and source["snippet"] == "原始摘要" for source in sources))

    def test_parser_is_bounded(self):
        with self.assertRaises(PageError) as caught:
            Document("<div>" * 140)
        self.assertEqual(caught.exception.code, "parser_limit")

    def test_wechat_shell_and_missing_http_response_are_not_articles(self):
        with self.assertRaises(PageError) as caught:
            read_page(page("<body>" + "public navigation menu " * 20 + "</body>", final_url="https://mp.weixin.qq.com/s?id=fixture"))
        self.assertEqual(caught.exception.code, "empty_content")
        with self.assertRaises(PageError) as caught:
            read_page(page("<body>" + "browser-generated diagnostic " * 20 + "</body>", status=0))
        self.assertEqual(caught.exception.code, "browser_error")


class SafetyTests(unittest.TestCase):
    def test_release_license_paths_cannot_escape_local_runtime(self):
        self.assertEqual(license_path("package/licenses/NOTICE"), Path("moli-licenses/licenses/NOTICE"))
        for member in ("package/licenses/../../secret", "/licenses/secret", "package/licenses/C:\\Windows\\secret", "../LICENSE-MIT", "package/not-a-license"):
            self.assertIsNone(license_path(member))

    def test_url_policy_and_mixed_dns(self):
        invalid = ["file:///etc/passwd", "http://user:pass@public.test/", "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/", "http://10.0.0.1/", "http://localhost./", "http://router.local/", "https://public.test:8080/", "https://public.test/\r\nX:1"]
        for url in invalid:
            with self.subTest(url=url), self.assertRaises(PageError):
                public_url(url)
        records = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443)), (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]
        with patch("worker.socket.getaddrinfo", return_value=records), self.assertRaises(PageError) as caught:
            public_url("https://public.test/")
        self.assertEqual(caught.exception.code, "private_network")

    def test_browser_environment_excludes_worker_secret_and_proxies(self):
        with patch.dict(os.environ, {"WORKER_TOKEN": "fixture-only", "HTTP_PROXY": "http://fixture-proxy", "MOLI_RESOURCE": "1"}):
            environment = browser_environment(Path("."))
        self.assertNotIn("WORKER_TOKEN", environment)
        self.assertNotIn("HTTP_PROXY", environment)
        self.assertNotIn("MOLI_RESOURCE", environment)
        self.assertEqual(environment["NO_PROXY"], "*")
        self.assertIn("PLAYWRIGHT_BROWSERS_PATH", environment)

    def test_serial_slot_and_owned_process_cancellation(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with worker_lock(directory):
                with self.assertRaises(ValueError):
                    with worker_lock(directory):
                        self.fail("A second worker acquired the browser slot.")
            cancel = threading.Event()
            timer = threading.Timer(0.3, cancel.set)
            timer.start()
            started = time.monotonic()
            with self.assertRaises(PageError) as caught:
                run_process([sys.executable, "-c", "import time; time.sleep(20)"], directory, cancel=cancel)
            timer.join()
            self.assertEqual(caught.exception.code, "lease_revoked")
            self.assertLess(time.monotonic() - started, 4)

    def test_subprocess_output_bound_and_secret_stripping(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with patch.dict(os.environ, {"WORKER_TOKEN": "fixture-only"}):
                code, output, _ = run_process([sys.executable, "-c", "import os; print(os.getenv('WORKER_TOKEN','absent'))"], directory)
            self.assertEqual(code, 0)
            self.assertEqual(output.strip(), b"absent")
            with self.assertRaises(PageError) as caught:
                run_process([sys.executable, "-c", "import sys; sys.stdout.write('x'*9000000)"], directory)
            self.assertEqual(caught.exception.code, "output_too_large")

    def test_long_content_keeps_recoverable_full_artifact(self):
        class FixtureMoli(Moli):
            def fetch(self, *_args, **_kwargs):
                return page("<article>" + "公开内容和完整原文。" * 30000 + "</article>")
        with tempfile.TemporaryDirectory() as temporary, patch("worker.public_url", side_effect=lambda url, **_: url):
            engine = object.__new__(FixtureMoli)
            engine.jobs = Path(temporary)
            result, artifacts = engine.execute("fetch_public_page", {"url": "https://public.test/"})
        self.assertTrue(any("original_chars=" in warning and "content.txt" in warning for warning in result["warnings"]))
        self.assertEqual(artifacts[0][0], "content.txt")
        self.assertGreater(len(artifacts[0][2]), len(result["content"].encode()))
        self.assertLess(len(encode(result)), MAX_PACKET)

    def test_job_arguments_cannot_add_scripts_or_browser_options(self):
        with tempfile.TemporaryDirectory() as temporary:
            engine = object.__new__(Moli)
            engine.jobs = Path(temporary)
            for operation, arguments in [("fetch_public_page", {"url": "https://public.test/", "eval": "fixture-only"}), ("fetch_public_page", {"url": "https://public.test/", "screenshot": "true"}), ("regional_search", {"query": "fixture", "engine": "baidu", "limit": True}), ("regional_search", {"query": "fixture", "engine": "chromium"})]:
                with self.subTest(arguments=arguments), self.assertRaises(PageError) as caught:
                    engine.execute(operation, arguments)
                self.assertEqual(caught.exception.code, "invalid_arguments")


class GuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_socks_private_connect_is_rejected_before_network(self):
        async with PolicySocksProxy(NetworkPolicy()) as proxy:
            port = int(proxy.url.rsplit(":", 1)[1])
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.write(b"\x05\x01\x00")
            await writer.drain()
            self.assertEqual(await reader.readexactly(2), b"\x05\x00")
            writer.write(b"\x05\x01\x00\x01\x7f\x00\x00\x01\x00\x50")
            await writer.drain()
            self.assertEqual((await reader.readexactly(10))[1], 2)
            writer.close()
            await writer.wait_closed()
            self.assertEqual(proxy.blocked, 1)

    async def test_dns_is_rechecked_and_numeric_address_is_pinned(self):
        records = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))]
        private = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.1", 443))]
        policy = NetworkPolicy()
        with patch("network_guard.socket.getaddrinfo", side_effect=[records, private]) as resolve:
            self.assertEqual(await policy.resolve_connection("public.test", 443), ("1.1.1.1",))
            with self.assertRaises(URLPolicyError):
                await policy.resolve_connection("public.test", 443)
        self.assertEqual(resolve.call_count, 2)
        with patch("network_guard.asyncio.open_connection", new_callable=unittest.mock.AsyncMock, return_value=("reader", "writer")) as connect:
            self.assertEqual(await PolicySocksProxy.connect(("1.1.1.1",), 443), ("reader", "writer"))
            connect.assert_awaited_once_with("1.1.1.1", 443)


class NativeMoliTests(unittest.TestCase):
    @unittest.skipUnless((Path(__file__).resolve().parents[1] / ".runtime" / ("moli.exe" if os.name == "nt" else "moli")).is_file(), "Install pinned Moli for this native runtime check.")
    def test_native_private_network_blocker_never_hits_loopback_server(self):
        hits = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_GET(self):
                hits.append(self.path)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"not a public page")

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        binary = Path(__file__).resolve().parents[1] / ".runtime" / ("moli.exe" if os.name == "nt" else "moli")
        try:
            with tempfile.TemporaryDirectory() as temporary:
                code, _, diagnostic = run_process([str(binary), "fetch", "--dump", "json", "--wait-until", "done", "--block-private-networks", "--http-no-proxy", "*", "--timeout", "3000", f"http://127.0.0.1:{server.server_port}/private-fixture"], Path(temporary), timeout=6)
            self.assertNotEqual(code, 0)
            self.assertIn(b"blocked", diagnostic.lower())
            self.assertEqual(hits, [])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    @unittest.skipUnless((Path(__file__).resolve().parents[1] / ".runtime" / ("moli.exe" if os.name == "nt" else "moli")).is_file(), "Install pinned Moli for native subresource checks.")
    def test_native_subresource_and_replacement_navigation_are_blocked(self):
        hits = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_GET(self):
                hits.append(self.path)
                self.send_response(200)
                self.end_headers()

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        binary = Path(__file__).resolve().parents[1] / ".runtime" / ("moli.exe" if os.name == "nt" else "moli")
        private = f"http://127.0.0.1:{server.server_port}/native-private-fixture"
        html = f"<html><body><p id='ran'>pending</p><script>fetch('{private}').catch(()=>{{const marker=document.querySelector('#ran');marker.id='settled';marker.textContent='script-executed';}});</script></body></html>"
        try:
            with tempfile.TemporaryDirectory() as temporary:
                command = [str(binary), "fetch", "--dump", "json", "--trace-network", "--block-private-networks", "--http-no-proxy", "*", "--timeout", "5000"]
                code, output, _ = run_process(command + ["--wait-selector", "#settled", "data:text/html," + quote(html)], Path(temporary), timeout=8)
                self.assertEqual(code, 0)
                payload = json.loads(output)
                marker = next(node for node in Document(payload["html"]).root.walk() if node.attrs.get("id") == "settled")
                self.assertEqual(marker.text(), "script-executed")
                request = next(item for item in payload["network"]["subresources"] if item["url"] == private)
                self.assertFalse(request["ok"])
                self.assertIn("blocked private network", request["error_text"])
                redirect = "<html><script>location.href=" + json.dumps(private) + ";</script></html>"
                code, output, diagnostic = run_process(command + ["data:text/html," + quote(redirect)], Path(temporary), timeout=8)
                self.assertNotEqual(code, 0)
                self.assertIn(b"blocked private network", diagnostic.lower())
                self.assertEqual(hits, [])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.claimed = job()
        self.token = secrets.token_urlsafe(24)
        self.results, self.uploads = [], []
        self.requests = []
        self.drop_first_result = False
        self.heartbeat_status = 200
        self.claim_count = 0
        self.redirect_claim = False
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                self.handle_request()

            def do_PUT(self):
                self.handle_request()

            def handle_request(self):
                if self.headers.get("Authorization") != "Bearer " + owner.token:
                    self.send_error(401)
                    return
                owner.requests.append((self.command, self.path, self.headers.get("User-Agent")))
                body = self.rfile.read(int(self.headers["Content-Length"]))
                value = json.loads(body) if self.command == "POST" else None
                status, response = 200, {}
                if self.path == "/api/worker/claim":
                    owner.claim_count += 1
                    if owner.redirect_claim:
                        self.send_response(302)
                        self.send_header("Location", f"http://127.0.0.1:{owner.server.server_port}/must-not-receive-auth")
                        self.end_headers()
                        return
                    owner.assertEqual(value["capabilities"], ["regional_search", "fetch_public_page"])
                    response = {"job": owner.claimed}
                elif self.path == "/api/worker/heartbeat":
                    status = owner.heartbeat_status
                    response = {"lease_expires_at": owner.claimed["lease_expires_at"]}
                elif self.path == "/api/worker/result":
                    owner.results.append(body)
                    if owner.drop_first_result and len(owner.results) == 1:
                        self.close_connection = True
                        self.connection.shutdown(socket.SHUT_RDWR)
                        return
                    response = "acknowledged"
                elif self.path.startswith("/api/worker/artifacts/"):
                    owner.assertEqual(self.headers.get("X-Worker-Lease"), owner.claimed["lease_token"])
                    owner.uploads.append((self.path, body))
                    response = {"artifact_id": "fixture-artifact"}
                else:
                    self.send_error(404)
                    return
                self.send_response(status)
                self.end_headers()
                self.wfile.write(encode(response) if isinstance(response, dict) else response.encode())

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.bridge = Bridge(f"http://127.0.0.1:{self.server.server_port}", self.token)
        self.temporary = tempfile.TemporaryDirectory()
        self.spool = Path(self.temporary.name)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temporary.cleanup()

    def test_unknown_ack_retries_same_packet_without_execution_or_upload(self):
        class FixtureExecutor:
            calls = 0
            def execute(self, *_):
                self.calls += 1
                return {"content": "fixture content", "engine": "fixture-only"}, [("content.txt", "text/plain", b"fixture artifact")]
        executor = FixtureExecutor()
        self.drop_first_result = True
        with self.assertRaises(BridgeError):
            Worker(self.bridge, executor, self.spool).step()
        self.assertTrue((self.spool / self.claimed["job_id"] / "state.json").exists())
        self.assertEqual(executor.calls, 1)
        def unavailable_engine():
            raise AssertionError("Pending result delivery must not initialize or execute a browser.")
        Worker(self.bridge, unavailable_engine, self.spool).step()
        self.assertEqual(executor.calls, 1)
        self.assertEqual(self.claim_count, 1)
        self.assertEqual(len(self.uploads), 1)
        self.assertEqual(self.results[0], self.results[1])
        self.assertEqual([request for request in self.requests if request[1] == "/api/worker/result"], [("POST", "/api/worker/result", "Rivule-regional-worker/0.1")] * 2)
        self.assertIsNone(Worker(self.bridge, executor, self.spool).pending())

    def test_application_user_agent_is_shared_by_all_control_and_artifact_requests(self):
        identity = {"job_id": self.claimed["job_id"], "lease_token": self.claimed["lease_token"]}
        artifact_route = f"/api/worker/artifacts/{self.claimed['job_id']}/content.txt"
        self.bridge.request("/api/worker/claim", {"capabilities": ["regional_search", "fetch_public_page"]})
        self.bridge.request("/api/worker/heartbeat", identity)
        self.bridge.request(artifact_route, b"fixture artifact", method="PUT", lease=self.claimed["lease_token"])
        self.bridge.request("/api/worker/result", {**identity, "status": "succeeded", "result": {"content": "fixture content"}})
        routes = [("POST", "/api/worker/claim"), ("POST", "/api/worker/heartbeat"), ("PUT", artifact_route), ("POST", "/api/worker/result")]
        self.assertEqual(self.requests, [(method, route, "Rivule-regional-worker/0.1") for method, route in routes])

    def test_interrupted_job_is_not_reexecuted(self):
        class NoExecution:
            def execute(self, *_):
                raise AssertionError("A saved active job must not be re-executed.")
        directory = self.spool / self.claimed["job_id"]
        directory.mkdir()
        atomic_json(directory / "state.json", {"job": self.claimed, "artifacts": [], "uploaded": []})
        Worker(self.bridge, NoExecution(), self.spool).step()
        self.assertEqual(json.loads(self.results[0])["error"]["code"], "worker_interrupted")
        self.assertEqual(self.claim_count, 0)

    def test_revoked_heartbeat_cancels_execution(self):
        class WaitForCancellation:
            def execute(self, _operation, _args, cancellation):
                deadline = time.monotonic() + 3
                while not cancellation.is_set() and time.monotonic() < deadline:
                    time.sleep(0.01)
                if not cancellation.is_set():
                    raise AssertionError("The revoked lease was not propagated.")
                raise PageError("lease_revoked", "fixture revoked", "blocked")
        self.heartbeat_status = 410
        with self.assertRaises(BridgeError) as caught:
            self.bridge.request("/api/worker/heartbeat", {"job_id": self.claimed["job_id"], "lease_token": self.claimed["lease_token"]})
        cause = caught.exception.__cause__
        self.assertIsInstance(cause, HTTPError)
        try:
            self.assertEqual(caught.exception.status, 410)
            self.assertEqual(cause.code, 410)
            self.assertTrue(cause.fp.closed)
        finally:
            cause.close()
        Worker(self.bridge, WaitForCancellation(), self.spool).step()
        self.assertEqual(json.loads(self.results[0])["status"], "blocked")

    def test_expiration_cancels_without_waiting_for_heartbeat_io(self):
        self.claimed["lease_expires_at"] = (datetime.now(timezone.utc) + timedelta(milliseconds=50)).isoformat()
        heartbeat = Heartbeat(self.bridge, self.claimed)
        time.sleep(0.07)
        self.assertTrue(heartbeat.is_set())

    def test_control_redirect_does_not_forward_bearer_token(self):
        self.redirect_claim = True
        with self.assertRaises(BridgeError) as caught:
            self.bridge.request("/api/worker/claim", {"capabilities": ["regional_search", "fetch_public_page"]})
        self.assertEqual(caught.exception.status, 302)
        self.assertEqual(self.claim_count, 1)
        cause = caught.exception.__cause__
        self.assertIsInstance(cause, HTTPError)
        try:
            self.assertEqual(cause.code, 302)
            self.assertTrue(cause.fp.closed)
        finally:
            cause.close()

    def test_local_cli_artifacts_are_not_pending_remote_jobs(self):
        (self.spool / "local.fixture").mkdir()
        self.assertIsNone(Worker(self.bridge, None, self.spool).pending())


if __name__ == "__main__":
    unittest.main()
