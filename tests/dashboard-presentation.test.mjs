import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ownerDashboardHtml, dashboardClient } from '../src/owner/presentation.mjs';

function clientFixture(fetch) {
  class Element {
    constructor() { this.textContent = ''; this.hidden = false; this.children = []; this.listeners = {}; this.attributes = {}; this.classList = { toggle() {} }; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
    focus() {}
  }
  const elements = new Map(), window = new Element(), document = new Element();
  document.getElementById = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  document.createElement = () => new Element(); document.body = new Element();
  vm.runInNewContext('(' + dashboardClient.toString() + ')()', { document, window, fetch, Date });
  return { get: document.getElementById, load: () => window.listeners.pageshow() };
}

test('PA canvas has native auth forms, honest preview, accessible controls and reduced motion', () => {
  const html = ownerDashboardHtml('testnonce');
  assert.match(html, /<style nonce="testnonce">/); assert.match(html, /<script nonce="testnonce">/);
  assert.match(html, /method="post" action="\/dashboard\/login"/);
  assert.match(html, /method="post" action="\/dashboard\/logout"/);
  assert.match(html, /prefers-reduced-motion:reduce/); assert.match(html, /@keyframes arrive/);
  assert.match(html, /aria-controls="settings"/); assert.match(html, /<dialog/);
  assert.match(html, /暂无来源记录/); assert.match(html, /预览 · 未连接/);
  assert.doesNotMatch(html, /innerHTML|localStorage|sessionStorage|https?:\/\//);
  assert.equal([...html.matchAll(/fetch\(/g)].length, 1);
});

test('expired session removes prior data and offers owner verification', async () => {
  const c = clientFixture(async () => ({ status: 401 }));
  c.get('items').append('old-private-snapshot'); await c.load();
  assert.equal(c.get('login').hidden, false); assert.equal(c.get('controls').hidden, true);
  assert.equal(c.get('connection').textContent, '需要本人验证');
  assert.equal(c.get('read-time').textContent, '尚未读取');
  assert.equal(c.get('items').children.length, 1);
  assert.match(c.get('items').children[0].textContent, /验证本人/);
});

test('successful snapshot uses text content, not markup, and marks verified tests', async () => {
  let request;
  const c = clientFixture(async (...args) => { request = args; return { status: 200, ok: true, json: async () => ({ state: 'ready', items: [{ task_name: '<img src=x onerror=alert(1)>', summary: '<script>bad()</script>', selection_kind: 'verified_test', pending_action_count: 0 }] }) }; });
  await c.load(); assert.equal(request[0], '/dashboard/data'); assert.equal(request[1].redirect, 'error');
  assert.equal(c.get('login').hidden, true); assert.equal(c.get('controls').hidden, false);
  const nodes = c.get('items').children[0].children;
  assert.match(nodes[0].textContent, /测试任务/); assert.equal(nodes[1].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(nodes[2].textContent, '<script>bad()</script>'); assert.match(nodes[3].textContent, /待决定：0/);
  assert.match(c.get('status').textContent, /不是实时订阅/);
});

test('initial failure preserves retry and never displays stale snapshots', async () => {
  const c = clientFixture(async () => { throw Error('private transport error'); });
  c.get('items').append('old-private-snapshot'); await c.load();
  assert.equal(c.get('controls').hidden, false); assert.equal(c.get('refresh').disabled, false);
  assert.equal(c.get('read-time').textContent, '本次读取失败');
  assert.doesNotMatch(c.get('status').textContent, /private/);
  assert.match(c.get('items').children[0].textContent, /未展示旧数据/);
});

test('repeat refresh is deduplicated while current read is pending', async () => {
  let calls = 0, resolve;
  const c = clientFixture(() => { calls++; return new Promise(r => { resolve = r; }); });
  const first = c.load(); await c.load(); assert.equal(calls, 1);
  resolve({ status: 401 }); await first; assert.equal(c.get('refresh').disabled, false);
});

test('empty and partial-error states do not fabricate tasks or connection health', async () => {
  for (const state of ['ready', 'error']) {
    const c = clientFixture(async () => ({ status: 200, ok: true, json: async () => ({ state, items: [] }) }));
    await c.load(); assert.equal(c.get('item-count').textContent, '00');
    assert.match(c.get('items').children[0].textContent, /还没有已选任务/);
    assert.match(c.get('status').textContent, state === 'error' ? /读取失败/ : /尚未配置/);
    assert.equal(c.get('connection').textContent, state === 'error' ? '快照读取异常' : '本人会话已验证');
  }
});
