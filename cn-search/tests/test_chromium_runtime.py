"""Opt-in real Chromium checks; fixed data/loopback fixtures, not live-site coverage."""

import asyncio
import json
import os
from pathlib import Path
import sys
import unittest
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from network_guard import NetworkPolicy, PolicySocksProxy


@unittest.skipUnless(os.getenv("RUN_NATIVE_CHROMIUM_CHECKS") == "1", "Explicitly enable in the pinned Chromium container.")
class NativeChromiumTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.hits = []

        async def handler(reader, writer):
            self.hits.append(await reader.readline())
            writer.close()
            await writer.wait_closed()

        self.server = await asyncio.start_server(handler, "127.0.0.1", 0)
        self.private = f"http://127.0.0.1:{self.server.sockets[0].getsockname()[1]}/native-private-fixture"

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()

    async def test_browser_cannot_bypass_socks_for_loopback(self):
        from playwright.async_api import async_playwright, Error

        async with PolicySocksProxy(NetworkPolicy()) as proxy, async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True, chromium_sandbox=True, proxy={"server": proxy.url}, timeout=15000, args=["--proxy-bypass-list=<-loopback>", "--disable-background-networking"])
            try:
                page = await browser.new_page()
                # Deliberately omit route interception to exercise the real proxy path.
                with self.assertRaises(Error):
                    await page.goto(self.private, timeout=5000)
                self.assertGreater(proxy.blocked, 0)
                self.assertEqual(self.hits, [])
            finally:
                await browser.close()

    async def test_private_subresource_and_replacement_navigation_are_blocked(self):
        from playwright.async_api import async_playwright, Error

        async with PolicySocksProxy(NetworkPolicy()) as proxy, async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True, chromium_sandbox=True, proxy={"server": proxy.url}, timeout=15000, args=["--proxy-bypass-list=<-loopback>", "--disable-background-networking"])
            try:
                page = await browser.new_page()
                html = f"<html><body><p id='pending'>fixture</p><script>fetch({json.dumps(self.private)}).catch(()=>{{document.querySelector('p').id='settled';}});</script></body></html>"
                await page.goto("data:text/html," + quote(html))
                await page.wait_for_selector("#settled", timeout=5000)
                self.assertGreater(proxy.blocked, 0)
                self.assertEqual(self.hits, [])
                before = proxy.blocked
                redirect = "<html><script>location.href=" + json.dumps(self.private) + ";</script></html>"
                async with page.expect_event("requestfailed", predicate=lambda request: request.url == self.private, timeout=5000):
                    try:
                        await page.goto("data:text/html," + quote(redirect), timeout=5000)
                    except Error:
                        pass  # Replacement navigation may abort the fixture's goto.
                self.assertGreater(proxy.blocked, before)
                self.assertEqual(self.hits, [])
            finally:
                await browser.close()


if __name__ == "__main__":
    unittest.main()
