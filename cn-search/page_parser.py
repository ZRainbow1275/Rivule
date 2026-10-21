"""Bounded DOM extraction. Page text is data, never an instruction or code."""

import base64
from dataclasses import dataclass, field
from html.parser import HTMLParser
import re
from urllib.parse import urljoin, urlsplit


class PageError(Exception):
    def __init__(self, code, message, status="failed"):
        super().__init__(message)
        self.code, self.status = code, status


@dataclass
class Node:
    tag: str
    attrs: dict = field(default_factory=dict)
    children: list = field(default_factory=list)

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.walk()

    def text(self):
        if self.tag in {"head", "script", "style", "template", "nav", "footer", "aside"}:
            return ""
        style = self.attrs.get("style", "").replace(" ", "").lower()
        if "hidden" in self.attrs or self.attrs.get("aria-hidden") == "true" or "display:none" in style:
            return ""
        parts = [child.text() if isinstance(child, Node) else child for child in self.children]
        separator = "\n" if self.tag in {"html", "body", "div", "article", "main", "section", "p", "li", "br"} else ""
        return separator.join(parts)


class Document(HTMLParser):
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.root = Node("document")
        self.stack = [self.root]
        self.count = 0
        try:
            self.feed(html)
            self.close()
        except RecursionError as error:
            raise PageError("parser_limit", "Page DOM nesting exceeds the parser limit.") from error

    def handle_starttag(self, tag, attrs):
        self.count += 1
        if self.count > 50000 or len(self.stack) > 128:
            raise PageError("parser_limit", "Page DOM exceeds 50,000 nodes or 128 nesting levels.")
        node = Node(tag, {key: value or "" for key, value in attrs})
        self.stack[-1].children.append(node)
        if tag not in self.VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def clean(text):
    return "\n".join(line for raw in text.splitlines() if (line := re.sub(r"[\t\r\f\v ]+", " ", raw).strip()))


def extract_text(document):
    preferred_ids = {"js_content", "article-content", "article_content"}
    preferred_classes = {"RichText", "Post-RichText", "RichContent-inner", "tgme_widget_message_text", "wall_post_text"}
    nodes = list(document.root.walk())
    scopes = [node for node in nodes if node.attrs.get("id") in preferred_ids or preferred_classes.intersection(node.attrs.get("class", "").split())]
    if not scopes:
        scopes = [node for node in nodes if node.tag == "article"]
    if not scopes:
        scopes = [node for node in nodes if node.tag == "main" or node.attrs.get("role") == "main"]
    if not scopes:
        return clean(document.root.text())
    selected, seen = [], set()
    for node in scopes:
        if id(node) not in seen:
            selected.append(clean(node.text()))
            seen.update(id(child) for child in node.walk())
    return "\n\n".join(part for part in selected if part)


def check_content(title, text, final_url, status, document=None):
    sample = (title + "\n" + text[:2500]).lower()
    gate_title = title.lower()
    if re.search(r"captcha|百度安全验证|安全验证|环境异常|доступ ограничен|подтвердите.*(?:не робот|человек)|just a moment", gate_title) or re.search(r"/showcaptcha|/challenge(?:/|\?)|captcha\.yandex", final_url):
        raise PageError("captcha", "The site returned an access challenge; no bypass was attempted.", "blocked")
    if len(text) < 4000 and any(marker in sample for marker in ("verify you are human", "подтвердите, что вы не робот", "访问过于频繁", "完成验证后", "请完成安全验证", "enable javascript and cookies to continue")):
        raise PageError("captcha", "The site returned an access challenge; no bypass was attempted.", "blocked")
    if status == 401 or (len(text) < 4000 and (re.match(r"^(?:登录|登入|login\b|log in\b|sign in\b|вход\b|авторизация\b)", gate_title) or any(marker in sample for marker in ("登录后查看全文", "登录后即可查看", "请登录后继续", "sign in to continue", "log in to continue", "войдите, чтобы")) or (document and any(node.tag == "input" and node.attrs.get("type", "").lower() == "password" for node in document.root.walk())))):
        raise PageError("authentication_required", "The public page requires authentication.", "blocked")
    if status in {403, 407, 451} or gate_title.strip() == "access denied":
        raise PageError("access_denied", f"The site refused public access (HTTP {status}).", "blocked")
    if status == 429:
        raise PageError("rate_limited", "The site rate-limited this request (HTTP 429).", "blocked")
    if status >= 400:
        raise PageError("http_error", f"The main document returned HTTP {status}.")
    if status < 200:
        raise PageError("browser_error", "No successful HTTP main-document response was received.")
    if re.search(r"^(?:this site can.t be reached|webpage not available|privacy error|error loading page|сайт недоступен|无法访问此网站|网页无法打开)", gate_title) or final_url.startswith(("chrome-error:", "about:neterror", "moli-error:")):
        raise PageError("browser_error", "A browser-generated error page is not source content.")
    if len(re.findall(r"[^\W_]", text, re.UNICODE)) < 80:
        raise PageError("empty_content", "No substantive public page content was extracted.", "blocked")
    if text.count("\ufffd") > max(3, len(text) // 100):
        raise PageError("decode_error", "The page contains too many replacement characters to read reliably.")


def read_page(payload):
    if not isinstance(payload, dict) or type(payload.get("status")) is not int or not isinstance(payload.get("final_url"), str):
        raise PageError("invalid_engine_output", "Moli JSON is missing status or final_url.")
    title = payload.get("title") or ""
    if not isinstance(title, str):
        raise PageError("invalid_engine_output", "Moli title is not text.")
    html = payload.get("html")
    if isinstance(html, str):
        document = Document(html)
        text = extract_text(document)
    elif isinstance(payload.get("body_base64"), str):
        headers = payload.get("headers", [])
        content_type = next((header.get("value", "") for header in headers if isinstance(header, dict) and header.get("name", "").lower() == "content-type"), "")
        if not content_type.lower().startswith("text/"):
            raise PageError("unsupported_content_type", "Only rendered HTML and public text responses are supported.")
        charset = re.search(r"charset\s*=\s*[\"']?([\w-]+)", content_type, re.I)
        try:
            text = base64.b64decode(payload["body_base64"], validate=True).decode(charset[1] if charset else "utf-8")
        except (ValueError, UnicodeError, LookupError) as error:
            raise PageError("decode_error", "The response body could not be decoded using its declared charset.") from error
        document = None
    else:
        raise PageError("empty_content", "Moli returned neither rendered HTML nor a text body.", "blocked")
    check_content(title, text, payload["final_url"], payload["status"], document)
    host, path = urlsplit(payload["final_url"]).hostname or "", urlsplit(payload["final_url"]).path
    if document is not None:
        nodes = list(document.root.walk())
        if host == "mp.weixin.qq.com" and path.rstrip("/") == "/s" and not any(node.attrs.get("id") == "js_content" and clean(node.text()) for node in nodes):
            raise PageError("empty_content", "The WeChat response contains no public article body.", "blocked")
        if (host == "zhihu.com" or host.endswith(".zhihu.com")) and path.startswith(("/question/", "/p/")) and not any(set(node.attrs.get("class", "").split()).intersection({"RichText", "RichContent-inner", "Post-RichText"}) and clean(node.text()) for node in nodes):
            raise PageError("empty_content", "The Zhihu response contains no public answer or article body.", "blocked")
    return document, text, title


def search_sources(document, engine, base_url, limit, language):
    if document is None:
        raise PageError("search_parse_error", "The search engine did not return an HTML result page.", "blocked")
    containers = []
    for node in document.root.walk():
        classes = set(node.attrs.get("class", "").split())
        if (engine == "baidu" and classes.intersection({"result", "result-op", "c-container"})) or (engine == "yandex" and classes.intersection({"serp-item", "Organic"})):
            containers.append(node)
    sources, seen = [], set()
    for container in containers:
        if any("adv" in key.lower() for key in container.attrs) or "serp-adv" in container.attrs.get("class", ""):
            continue
        heading = next((node for node in container.walk() if node.tag in {"h2", "h3"}), None)
        anchor = next((node for node in (heading or container).walk() if node.tag == "a" and node.attrs.get("href") and (heading is not None or "OrganicTitle-Link" in node.attrs.get("class", ""))), None)
        if anchor is None:
            continue
        try:
            url = urljoin(base_url, anchor.attrs["href"])
            parsed = urlsplit(url)
            host, port = (parsed.hostname or "").rstrip("."), parsed.port
        except ValueError:
            continue
        title = clean((heading or anchor).text())
        if parsed.scheme not in {"http", "https"} or not host or port not in {None, 80, 443} or parsed.username is not None or parsed.password is not None or not title or url in seen:
            continue
        # Baidu's paid-click endpoint can reappear in nested result containers.
        if engine == "baidu" and (host == "baidu.com" or host.endswith(".baidu.com")) and parsed.path == "/baidu.php":
            continue
        if parsed.path in {"/search", "/search/", "/s"} and parsed.hostname in {"yandex.ru", "www.baidu.com"}:
            continue
        snippet = clean(container.text())
        if snippet.startswith(title):
            snippet = snippet[len(title):].strip()
        sources.append({"title": title, "url": url, "snippet": snippet, "provider": engine, "language": language})
        seen.add(url)
        if len(sources) >= limit:
            break
    if not sources:
        raise PageError("search_parse_error", "No organic result links were found; the engine may have changed or blocked access.", "blocked")
    return sources
