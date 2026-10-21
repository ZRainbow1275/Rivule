"""Explicit compatibility engine, in an owned child process. No user JS API."""

import argparse
import asyncio
import json
import sys

from network_guard import NetworkPolicy, PolicySocksProxy, URLPolicyError
from page_parser import PageError


async def fetch(url, dump, executable):
    from playwright.async_api import async_playwright, Error, TimeoutError as BrowserTimeout

    policy = NetworkPolicy()
    await policy.validate_request(url)
    async with PolicySocksProxy(policy) as proxy, async_playwright() as playwright:
        options = {"headless": True, "chromium_sandbox": True, "proxy": {"server": proxy.url}, "timeout": 15000, "args": ["--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-quic", "--dns-prefetch-disable", "--proxy-bypass-list=<-loopback>", "--disable-features=MediaRouter,OptimizationHints", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"]}
        if executable:
            options["executable_path"] = executable
        browser = None
        try:
            browser = await playwright.chromium.launch(**options)
            context = await browser.new_context(accept_downloads=False, service_workers="block", ignore_https_errors=False, viewport={"width": 1280, "height": 800})
            warnings = []

            async def route(route, request):
                if request.method not in {"GET", "HEAD"}:
                    if "non_get_requests_blocked" not in warnings:
                        warnings.append("non_get_requests_blocked")
                    await route.abort("blockedbyclient")
                    return
                try:
                    await policy.validate_request(request.url)
                except (URLPolicyError, ValueError):
                    proxy.blocked += 1
                    await route.abort("blockedbyclient")
                    return
                await route.continue_()

            async def websocket(route):
                await route.close(code=1008, reason="Public fetch worker disables WebSockets")

            await context.route("**/*", route)
            await context.route_web_socket("**/*", websocket)
            await context.add_init_script("for (const k of ['RTCPeerConnection','webkitRTCPeerConnection']) Object.defineProperty(globalThis,k,{value:undefined,writable:false,configurable:false});")
            page = await context.new_page()
            last_response = None

            def remember(response):
                nonlocal last_response
                if response.frame == page.main_frame and response.request.is_navigation_request():
                    last_response = response

            page.on("response", remember)
            await page.goto(url, wait_until="domcontentloaded", timeout=25000)
            try:
                await page.wait_for_load_state("networkidle", timeout=5000)
            except BrowserTimeout:
                warnings.append("networkidle_not_reached; content checked after DOMContentLoaded")
            await policy.validate_request(page.url)
            if last_response is None:
                raise PageError("browser_error", "Chromium received no main-document response.")
            if proxy.blocked:
                warnings.append(f"private_or_invalid_requests_blocked={proxy.blocked}")
            if dump == "screenshot":
                output = await page.screenshot(type="png", full_page=False, timeout=10000)
            else:
                html = await page.content()
                if len(html.encode("utf-8")) > 7 * 1024 * 1024:
                    raise PageError("output_too_large", "Chromium HTML exceeds the bounded serialization limit.")
                output = json.dumps({"final_url": page.url, "title": await page.title(), "status": last_response.status, "html": html, "warnings": warnings, "browser_version": browser.version}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            return output
        except BrowserTimeout as error:
            raise PageError("timeout", "Chromium exceeded its navigation or capture deadline.") from error
        except Error as error:
            if "Executable doesn't exist" in str(error):
                raise PageError("chromium_unavailable", "Install the browser from the pinned Playwright SDK or explicitly set CHROMIUM_BIN to an installed compatible browser.") from error
            if "net::ERR_CERT_" in str(error):
                raise PageError("tls_error", "Chromium rejected the TLS certificate; verification was not disabled.") from error
            if proxy.blocked:
                raise PageError("private_network", "The policy proxy blocked a private or invalid destination.", "blocked") from error
            raise PageError("compatibility_engine_failed", "Chromium compatibility mode failed; sandboxing and TLS verification remained enabled.") from error
        finally:
            if browser is not None:
                await browser.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url")
    parser.add_argument("--dump", choices=("json", "screenshot"), required=True)
    parser.add_argument("--executable")
    args = parser.parse_args()
    try:
        output = asyncio.run(asyncio.wait_for(fetch(args.url, args.dump, args.executable), 40))
        if len(output) > 8 * 1024 * 1024:
            raise PageError("output_too_large", "Chromium output exceeds 8 MiB.")
        sys.stdout.buffer.write(output)
        return 0
    except URLPolicyError:
        error = PageError("private_network", "Private or invalid Chromium destinations are blocked.", "blocked")
    except TimeoutError:
        error = PageError("timeout", "Chromium exceeded its 40-second operation deadline.")
    except PageError as caught:
        error = caught
    except Exception:
        error = PageError("compatibility_engine_failed", "Chromium could not start with the installed pinned dependencies and sandbox.")
    sys.stdout.write(json.dumps({"error": {"code": error.code, "message": str(error), "status": error.status}}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
