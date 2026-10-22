import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ownerDashboardHtml, dashboardClient } from '../src/owner/presentation.mjs';

function clientFixture(fetch, storage) {
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
  vm.runInNewContext('(' + dashboardClient.toString() + ')()', { document, window, fetch, Date, localStorage: storage });
  return { get: document.getElementById, load: () => window.listeners.pageshow() };
}

test('PA canvas has native auth forms, honest preview, accessible controls and reduced motion', () => {
  const html = ownerDashboardHtml('testnonce');
  assert.match(html, /<style nonce="testnonce">/); assert.match(html, /<script nonce="testnonce">/);
  assert.match(html, /method="post" action="\/dashboard\/login"/);
  assert.match(html, /method="post" action="\/dashboard\/logout"/);
  assert.match(html, /prefers-reduced-motion:reduce/); assert.match(html, /@keyframes arrive/);
  assert.match(html, /aria-controls="settings"/); assert.match(html, /<dialog/);
  assert.match(html, /创建时间<\/dt><dd>未知/); assert.match(html, /预览 · 未连接/);
  assert.doesNotMatch(html, /innerHTML|sessionStorage|https?:\/\//);
  assert.equal([...html.matchAll(/fetch\(/g)].length, 1);
});

test('expired session removes prior data and offers owner verification', async () => {
  const c = clientFixture(async () => ({ status: 401 }));
  c.get('items').append('old-private-snapshot'); await c.load();
  assert.equal(c.get('login').hidden, false); assert.equal(c.get('controls').hidden, true);
  assert.equal(c.get('connection').textContent, '等待本人验证');
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
  assert.equal(c.get('status').textContent, '快照已更新');
});

test('initial failure preserves retry and never displays stale snapshots', async () => {
  const c = clientFixture(async () => { throw Error('private transport error'); });
  c.get('items').append('old-private-snapshot'); await c.load();
  assert.equal(c.get('controls').hidden, false); assert.equal(c.get('refresh').disabled, false);
  assert.equal(c.get('read-time').textContent, '本次读取失败');
  assert.doesNotMatch(c.get('status').textContent, /private/);
  assert.equal(c.get('items').children[0].textContent, '读取失败，请重试。');
  assert.doesNotMatch(JSON.stringify(c.get('items').children), /old-private-snapshot/);
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
    assert.equal(c.get('connection').textContent, state === 'error' ? '快照读取异常' : '未选择任务');
  }
});

test('viewport layout centers a single PA and separates immutable source from alias', () => {
 const html=ownerDashboardHtml('nonce');
 assert.match(html,/height:100dvh;overflow:hidden/);
 assert.match(html,/\.pa:first-child\{margin-left:auto\}/);
 assert.match(html,/\.pa:nth-last-child\(2\)\{margin-right:auto\}/);
 assert.match(html,/\.card-body\{flex:1;min-height:0;overflow:auto/);
 assert.doesNotMatch(html,/PA \/ 01|PERSONAL ASSISTANT SPACE|YOUR ASSISTANTS/);
 assert.match(html,/class="provider">dot</); assert.match(html,/id="zot-name">zot</);
 assert.match(html,/alt="dot 官方图标"/); assert.match(html,/class="rivule-logo"/);
 assert.match(html,/warning-stripe 5s linear infinite/);
});

test('connection coloring requires a valid readable snapshot, not owner login', async () => {
 const snapshot={source_id:'zot-main',state:'available',stale:false,source_status:'running',observed_at:'2026-10-22T15:00:00Z'};
 for(const [items,state] of [[[],'unknown'],[[{...snapshot,source_id:'other'}],'unknown'],[[snapshot],'unknown'],[[{...snapshot,stale:true}],'warning'],[[{...snapshot,source_status:'needs_input'}],'warning']]) {
  const c=clientFixture(async()=>({status:200,ok:true,json:async()=>({state:'connected',items})})); await c.load();
  assert.equal(c.get('zot-card').attributes['data-state'],state);
 }
});

test('appearance storage is bounded and never stores task data or changes source identity', () => {
 const writes=[];const storage={getItem:()=>JSON.stringify({name:'小助理',icon:'★',token:'discard',items:['discard']}),setItem:(k,v)=>writes.push([k,JSON.parse(v)])};
 const c=clientFixture(()=>{},storage);assert.equal(c.get('zot-name').textContent,'小助理');assert.equal(c.get('zot-emblem').textContent,'★');assert.equal(c.get('zot-emblem').attributes['aria-label'],'编辑 小助理 图标');
 c.get('name-dialog').close=()=>{};c.get('display-name').value='新名字';c.get('name-form').listeners.submit({preventDefault(){}});
 assert.deepEqual(writes,[['rivule.appearance.zot-main.v1',{name:'新名字',icon:'★'}]]);
 const broken=clientFixture(()=>{},{getItem(){throw Error('blocked')},setItem(){throw Error('blocked')}});
 assert.equal(broken.get('zot-name').textContent,'');
});

test('only fresh bounded source evidence enables full color; channel is not a PA', async () => {
 const connection={source:{status:'verified',evidence_kind:'read_probe',last_verified_at:'2026-10-22T15:00:00Z',proof_max_age_ms:86400000},qq:{status:'active',scope:'owner_producer_only'},observed_at:'2026-10-22T15:01:00Z'};
 for(const [change,expected] of [[{},'active'],[{evidence_kind:'historical_task'},'unknown'],[{proof_max_age_ms:86400001},'unknown'],[{last_verified_at:'2026-10-20T00:00:00Z'},'unknown'],[{status:'stale'},'warning'],[{status:'revoked'},'warning']]) {
  const c=clientFixture(async()=>({status:200,ok:true,json:async()=>({state:'connected',items:[],connection:{...connection,source:{...connection.source,...change}}})}));
  await c.load(); assert.equal(c.get('zot-card').attributes['data-state'],expected); assert.equal(c.get('qq-channel').textContent,'生产端已启用');
 }
});

test('malformed and oversized appearance state is ignored; HTML-like names remain plain text', () => {
 for(const raw of ['{broken','[]','"name"','null','x'.repeat(513),JSON.stringify({name:'x'.repeat(33),icon:'x'.repeat(9)})]) {
  const c=clientFixture(()=>{},{getItem:()=>raw,setItem(){}});assert.equal(c.get('zot-name').textContent,'');assert.equal(c.get('zot-emblem').textContent,'');
 }
 const writes=[];const c=clientFixture(()=>{},{getItem:()=>'{"__proto__":{"token":"bad"},"name":"<img src=x onerror=alert(1)>"}',setItem:(k,v)=>writes.push(JSON.parse(v))});
 assert.equal(c.get('zot-name').textContent,'<img src=x onerror=alert(1)>');
 c.get('name-dialog').close=()=>{};c.get('display-name').value='x'.repeat(60);c.get('name-form').listeners.submit({preventDefault(){}});
 assert.equal(c.get('zot-name').textContent.length,32);assert.deepEqual(Object.keys(writes[0]),['name']);assert.equal({}.token,undefined);
});

test('connection freshness expires at the exact server boundary', async () => {
 const c=clientFixture(async()=>({status:200,ok:true,json:async()=>({items:[],connection:{observed_at:'2026-10-22T15:00:00Z',source:{status:'verified',evidence_kind:'read_probe',last_verified_at:'2026-10-21T15:00:00Z',proof_max_age_ms:86400000}}})}));
 await c.load();assert.equal(c.get('zot-card').attributes['data-state'],'unknown');
});

test('status copy stays concise while retaining read-only scope', () => {
 const html=ownerDashboardHtml('nonce');
 assert.match(html,/只读：已选任务与连接状态/);
 assert.doesNotMatch(html,/非实时|未展示旧数据|不批准操作|不扩大权限/);
});
