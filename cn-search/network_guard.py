"""Adapted from Capture MCP's MIT-licensed security.py; see THIRD_PARTY.md.

Only Chromium compatibility mode uses this loopback SOCKS guard. DNS is checked
for every CONNECT and the connection uses the approved numeric IP, not the name.
"""

import asyncio
import contextlib
import ipaddress
import socket
from urllib.parse import urlsplit


class URLPolicyError(ValueError):
    pass


class NetworkPolicy:
    async def validate_request(self, url):
        parsed = urlsplit(url)
        if parsed.scheme in {"about", "blob", "data"}:
            return
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username is not None or parsed.password is not None:
            raise URLPolicyError("Only credential-free HTTP(S) requests are allowed.")
        await self.resolve_connection(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))

    async def resolve_connection(self, host, port):
        try:
            host = host.rstrip(".").encode("idna").decode("ascii").lower()
        except UnicodeError as error:
            raise URLPolicyError("Invalid DNS hostname.") from error
        if port not in {80, 443} or host == "localhost" or host.endswith((".local", ".localhost", ".internal", ".home.arpa", ".lan", ".home")) or "." not in host:
            raise URLPolicyError("Local names and non-web ports are blocked.")
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise URLPolicyError("IP-literal browser destinations are blocked.")
        try:
            infos = await asyncio.wait_for(asyncio.to_thread(socket.getaddrinfo, host, port, type=socket.SOCK_STREAM), 10)
        except (OSError, TimeoutError) as error:
            raise URLPolicyError("Public DNS resolution failed.") from error
        addresses = tuple(sorted({item[4][0] for item in infos}))
        if not addresses:
            raise URLPolicyError("No approved destination addresses.")
        for address in addresses:
            ip = ipaddress.ip_address(address)
            if not ip.is_global or ip.is_multicast or ip.is_reserved or (isinstance(ip, ipaddress.IPv6Address) and ip.is_site_local):
                raise URLPolicyError("A destination resolved to a non-public address.")
        return addresses


class PolicySocksProxy:
    def __init__(self, policy):
        self.policy = policy
        self.server = None
        self.writers = set()
        self.tasks = set()
        self.blocked = 0

    @property
    def url(self):
        return f"socks5://127.0.0.1:{self.server.sockets[0].getsockname()[1]}"

    async def __aenter__(self):
        self.server = await asyncio.start_server(self.handle, "127.0.0.1", 0, limit=65536)
        return self

    async def __aexit__(self, *_):
        self.server.close()
        await self.server.wait_closed()
        for writer in tuple(self.writers):
            writer.close()
        for task in tuple(self.tasks):
            task.cancel()
        await asyncio.gather(*tuple(self.tasks), return_exceptions=True)

    async def handle(self, reader, writer):
        task = asyncio.current_task()
        self.tasks.add(task)
        self.writers.add(writer)
        upstream = None
        relays = []
        try:
            async with asyncio.timeout(10):
                version, count = await reader.readexactly(2)
                methods = await reader.readexactly(count)
                if version != 5 or 0 not in methods:
                    writer.write(b"\x05\xff")
                    await writer.drain()
                    return
                writer.write(b"\x05\x00")
                await writer.drain()
                version, command, reserved, address_type = await reader.readexactly(4)
                if version != 5 or command != 1 or reserved != 0:
                    await self.reply(writer, 7)
                    return
                host = await self.read_host(reader, address_type)
                port = int.from_bytes(await reader.readexactly(2), "big")
                addresses = await self.policy.resolve_connection(host, port)
                upstream_reader, upstream = await self.connect(addresses, port)
                self.writers.add(upstream)
                await self.reply(writer, 0)
            relays = [asyncio.create_task(self.relay(reader, upstream)), asyncio.create_task(self.relay(upstream_reader, writer))]
            await asyncio.wait(relays, return_when=asyncio.FIRST_COMPLETED)
        except URLPolicyError:
            self.blocked += 1
            await self.reply(writer, 2)
        except (asyncio.IncompleteReadError, TimeoutError, ConnectionError, OSError, UnicodeError, ValueError):
            await self.reply(writer, 4)
        finally:
            for relay in relays:
                relay.cancel()
            await asyncio.gather(*relays, return_exceptions=True)
            for stream in (upstream, writer):
                if stream:
                    self.writers.discard(stream)
                    stream.close()
                    with contextlib.suppress(ConnectionError, OSError, TimeoutError):
                        await asyncio.wait_for(stream.wait_closed(), 1)
            self.tasks.discard(task)

    @staticmethod
    async def read_host(reader, kind):
        if kind == 1:
            return str(ipaddress.IPv4Address(await reader.readexactly(4)))
        if kind == 4:
            return str(ipaddress.IPv6Address(await reader.readexactly(16)))
        if kind == 3:
            length = (await reader.readexactly(1))[0]
            if not length:
                raise URLPolicyError("Empty destination.")
            return (await reader.readexactly(length)).decode("ascii")
        raise URLPolicyError("Unsupported address type.")

    @staticmethod
    async def connect(addresses, port):
        last_error = None
        for address in addresses:
            try:
                return await asyncio.open_connection(address, port)
            except OSError as error:
                last_error = error
        raise last_error or OSError("No approved destination.")

    @staticmethod
    async def relay(reader, writer):
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()

    @staticmethod
    async def reply(writer, code):
        if not writer.is_closing():
            with contextlib.suppress(ConnectionError, OSError):
                writer.write(bytes((5, code, 0, 1, 0, 0, 0, 0, 0, 0)))
                await writer.drain()
