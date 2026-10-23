import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ownerDashboardHtml, dashboardClient, selectedWorkbench } from '../src/owner/presentation.mjs';

function clientFixture(fetch, storage, timers = {}) {
  class Element {
    constructor() { this.textContent = ''; this.hidden = false; this.children = []; this.listeners = {}; this.attributes = {}; this.classList = { toggle() {} }; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    insertBefore(child) { this.children.push(child); }
    remove() { this.removed=true; }
    setAttribute(key, value) { this.attributes[key] = value; }
    focus() { this.focused=true; }
    showModal() { this.open=true; }
    close() { this.open=false; }
  }
  const elements = new Map(), window = new Element(), document = new Element();
  document.getElementById = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  document.createElement = () => new Element(); document.createElementNS = () => new Element(); document.body = new Element();
  vm.runInNewContext('(' + dashboardClient.toString() + ')()', { selectedWorkbench, document, window, fetch, Date, localStorage: storage, AbortController, setTimeout, clearTimeout, ...timers });
  return { get: document.getElementById, load: () => window.listeners.pageshow(), hide: () => window.listeners.pagehide(), visible: value=>{document.hidden=!value;document.listeners.visibilitychange();} };
}

test('PA canvas has native auth forms, honest preview, accessible controls and reduced motion', () => {
  const html = ownerDashboardHtml('testnonce');
  assert.match(html, /<style nonce="testnonce">/); assert.match(html, /<script nonce="testnonce">/);
  assert.match(html, /method="post" action="\/dashboard\/login"/);
  assert.match(html, /method="post" action="\/dashboard\/logout"/);
  assert.match(html, /prefers-reduced-motion:reduce/); assert.match(html, /@keyframes arrive/);
  assert.match(html, /aria-controls="settings"/); assert.match(html, /<dialog/);
  assert.match(html, /创建时间<\/dt><dd>未知/); assert.match(html, /预览 · 未连接/);
  assert.doesNotMatch(html, /innerHTML|sessionStorage|(?:src|href)="https?:\/\//);
  assert.equal([...html.matchAll(/fetch\(/g)].length, 2); // task read and explicit same-origin QQ management
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
  assert.equal(nodes[2].textContent, '<script>bad()</script>'); assert.equal(nodes[3].textContent, '');
  assert.equal(c.get('status').textContent, '工作信息已更新 · 30 秒自动刷新');
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
    assert.equal(c.get('connection').textContent, '来源待验证');
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


test('read deadline bounds headers and body, allows retry and ignores late responses', async () => {
 for (const phase of ['headers', 'body']) {
  const timers = new Map(); let timerId = 0, resolveOld, resolveNew, calls = 0, signal;
  const stalled = new Promise(resolve => { resolveOld = resolve; });
  const c = clientFixture((_, options) => {
   calls++; signal = options.signal;
   if (calls === 1) return phase === 'headers' ? stalled : Promise.resolve({status:200,ok:true,json:()=>stalled});
   return new Promise(resolve => { resolveNew = resolve; });
  }, undefined, {setTimeout(fn, ms) { assert.ok([15000,30000,60000].includes(ms)); timers.set(++timerId,fn); return timerId; },clearTimeout(id) { timers.delete(id); }});
  const old = c.load(); await Promise.resolve(); await Promise.resolve();
  const oldSignal = signal; [...timers.values()][0](); await old;
  assert.equal(oldSignal.aborted,true); assert.equal(timers.size,0);
  assert.equal(c.get('refresh').disabled,false); assert.match(c.get('status').textContent,/可重试/);
  const next = c.load(); assert.equal(calls,2); assert.equal(c.get('refresh').disabled,true);
  resolveOld(phase === 'headers' ? {status:401} : {items:[{task_name:'obsolete private data'}]});
  await Promise.resolve(); await Promise.resolve();
  assert.equal(c.get('refresh').disabled,true); assert.match(c.get('status').textContent,/正在读取/);
  resolveNew({status:200,ok:true,json:async()=>({state:'ready',items:[{task_name:'current'}]})}); await next;
  assert.equal(c.get('items').children[0].children[1].textContent,'current');
  assert.equal(timers.size,1);
 }
});

test('page departure cancels the old read without resetting the returning page request', async () => {
 let calls=0,resolveOld,resolveNew,oldSignal;
 const c=clientFixture((_,{signal})=>new Promise(resolve=>{if(++calls===1){resolveOld=resolve;oldSignal=signal;}else resolveNew=resolve;}));
 const old=c.load(); c.hide(); const next=c.load(); await old;
 assert.equal(oldSignal.aborted,true); assert.equal(calls,2); assert.equal(c.get('refresh').disabled,true);
 resolveOld({status:401}); await Promise.resolve();
 assert.match(c.get('status').textContent,/正在读取/);
 resolveNew({status:200,ok:true,json:async()=>({state:'ready',items:[]})}); await next;
 assert.equal(c.get('refresh').disabled,false);assert.equal(c.get('login').hidden,true);
});

test('workbench derives task distributions and confirmation timeline only from selected snapshots', () => {
 const rows=[{state:'available',task_name:'甲',project_name:'项目 A',source_status:'running',last_confirmed_at:'2026-10-23T01:00:00Z'}, {state:'available',task_name:'乙',source_status:'needs_input',pending_action_count:2,last_confirmed_at:'2026-10-23T02:00:00Z'}, {state:'available',task_name:'丙',source_status:'completed',last_confirmed_at:'invalid'}, {state:'unavailable'}];
 const model=selectedWorkbench(rows);assert.deepEqual(model.counts,{running:1,attention:1,completed:1});assert.deepEqual(model.recent.map(x=>x.task_name),['乙','甲']);assert.equal(rows[0].task_name,'甲');
 assert.deepEqual(selectedWorkbench(rows,'attention').visible.map(x=>x.task_name),['乙']);assert.equal(selectedWorkbench(rows,'running','项目 A').visible.length,1);assert.equal(selectedWorkbench(rows,'completed','项目 A').visible.length,0);
});

test('single task hides filters and does not inherit a hidden multi-task filter', async () => {
 const c=clientFixture(async()=>({status:200,ok:true,json:async()=>({items:[{state:'available',task_name:'唯一任务',source_status:'running'}]})}));
 c.get('task-filter').value='completed';c.get('task-search').value='other';await c.load();
 assert.equal(c.get('task-toolbar').hidden,true);assert.equal(c.get('task-distribution').hidden,true);assert.equal(c.get('items').children.length,1);assert.equal(c.get('items').children[0].children[1].textContent,'唯一任务');
});

test('filters, quick actions and view controls are functional without another read', async () => {
 let reads=0;const c=clientFixture(async()=>{reads++;return {status:200,ok:true,json:async()=>({items:[{state:'available',task_name:'进行中任务',source_status:'running'},{state:'available',task_name:'待处理任务',source_status:'needs_input'}]})};});
 await c.load();assert.equal(c.get('task-toolbar').hidden,false);assert.equal(c.get('running-count').textContent,'1');
 c.get('quick-attention').listeners.click();assert.equal(c.get('items').children.length,1);assert.equal(c.get('items').children[0].children[1].textContent,'待处理任务');
 c.get('view-activity').listeners.click();assert.equal(c.get('tasks-view').hidden,true);assert.equal(c.get('activity-view').hidden,false);assert.equal(c.get('view-activity').attributes['aria-pressed'],'true');assert.equal(reads,1);
});

test('session failure clears counts, recent confirmations and ability status, not only tasks', async () => {
 let first=true;const c=clientFixture(async()=>first?{status:200,ok:true,json:async()=>({items:[{state:'available',task_name:'private',source_status:'running',last_confirmed_at:'2026-10-23T02:00:00Z'}]})}:{status:401});
 await c.load();assert.equal(c.get('activity-list').children[0].children[1].textContent,'private');first=false;await c.load();assert.equal(c.get('running-count').textContent,'—');assert.equal(c.get('activity-list').children[0].textContent,'等待读取所选任务');assert.equal(c.get('task-toolbar').hidden,true);
});

 test('single-task hierarchy hides counters and duplicate task status while retaining action details', async () => {
 const c=clientFixture(async()=>({status:200,ok:true,json:async()=>({state:'ready',items:[{state:'available',task_name:'Review proposal',source_status:'needs_input',pending_action_count:2,summary:'Choose a scope'}]})}));
 await c.load(); assert.equal(c.get('task-metrics').hidden,true);
 const nodes=c.get('items').children[0].children;
 assert.equal(nodes.filter(n=>n.className==='task-state').length,0);
 assert.equal(nodes.filter(n=>n.className==='pending-callout').length,1);
 const action=nodes.find(n=>n.className==='pending-callout');assert.equal(action.textContent,'2 项待确认 · 查看详情');action.listeners.click();assert.equal(nodes.find(n=>n.className==='task-facts').open,true);assert.equal(action.attributes['aria-expanded'],'true');
 assert.equal(c.get('capability-list').children[0].children[0].children[0].children[0].attributes['aria-hidden'],'true');
 });

 test('compact mode hides only the preview summary and preserves expanded details', () => {
 const html=ownerDashboardHtml('test');
 assert.match(html,/\.compact \.task>p\{display:none\}/);
 assert.doesNotMatch(html,/\.compact \.task p\{display:none\}/);
 assert.match(html,/#61716b/);
 });

 test('public and failed sessions open capabilities, recovered tasks take focus once', async () => {
 let mode='401';const c=clientFixture(async()=>{if(mode==='fail')throw Error('offline');return mode==='401'?{status:401}:{status:200,ok:true,json:async()=>({state:'ready',items:[{state:'available',task_name:'Selected task'}]})};});
 assert.equal(c.get('capabilities-view').hidden,false);
 await c.load();assert.equal(c.get('capabilities-view').hidden,false);
 mode='ok';await c.load();assert.equal(c.get('tasks-view').hidden,false);
 c.get('view-activity').listeners.click();await c.load();assert.equal(c.get('activity-view').hidden,false);
 mode='fail';await c.load();assert.equal(c.get('activity-view').hidden,false);assert.match(c.get('status').textContent,/保留上次快照/);
 mode='ok';await c.load();assert.equal(c.get('activity-view').hidden,false);
 mode='401';await c.load();assert.equal(c.get('capabilities-view').hidden,false);assert.equal(c.get('items').children.length,1);
 });

 test('accepted colorful skeleton preserves large official emblem and independent add rail', () => {
 const html=ownerDashboardHtml('test');
 assert.match(html,/<aside id="add-column" class="add-column"/);
 assert.doesNotMatch(html,/<div id="add-column" hidden/);
 assert.match(html,/--pa-color:#7053e8/);assert.match(html,/--pa-color:#178d99/);assert.match(html,/--pa-color:#d36d8c/);
 assert.match(html,/transform:rotate\(-8deg\)/);assert.match(html,/background:#ffdac4/);
 assert.match(html,/alt="dot 官方图标"/);assert.match(html,/role="group" aria-label="预览来源"/);
 });
 test('visual provider buttons select only local appearance and make no extra read', () => {
 let reads=0;const c=clientFixture(()=>{reads++;throw Error('not called');});
 c.get('choose-qq').listeners.click();assert.equal(c.get('pa-brand').value,'qq');assert.equal(c.get('choose-qq').attributes['aria-pressed'],'true');assert.equal(c.get('choose-muse').attributes['aria-pressed'],'false');
 c.get('choose-muse').listeners.click();assert.equal(c.get('pa-brand').value,'muse');assert.equal(c.get('choose-qq').attributes['aria-pressed'],'false');
 c.get('choose-custom').listeners.click();assert.equal(c.get('pa-brand').value,'');assert.equal(reads,0);
 });

 test('workbench preferences persist only versioned bounded appearance enums', () => {
 const writes=[];const storage={getItem:k=>k.includes('settings')?JSON.stringify({version:1,density:'compact',width:'wide',icon:'large',contrast:'strong',motion:'off',view:'activity',source:'open',token:'secret',tasks:['private']}):null,setItem:(k,v)=>writes.push([k,JSON.parse(v)])};
 const c=clientFixture(()=>{},storage);assert.equal(c.get('pref-width').value,'wide');assert.equal(c.get('source-details').open,true);
 c.get('pref-density').listeners.change({target:{value:'comfortable'}});
 assert.equal(writes.length,1);assert.equal(writes[0][0],'rivule.workbench.settings.v1');assert.deepEqual(Object.keys(writes[0][1]).sort(),['contrast','density','icon','motion','source','version','view','width']);assert.equal(writes[0][1].density,'comfortable');
 c.get('pref-width').listeners.change({target:{value:'<script>bad</script>'}});assert.equal(writes.length,1);
 });
 test('invalid, oversized and unavailable preference storage uses safe defaults', () => {
 for(const value of ['{','[]','null','x'.repeat(513),'{"version":2,"width":"wide"}','{"version":1,"width":"<img>","__proto__":{"motion":"off"}}']){
 const c=clientFixture(()=>{},{getItem:()=>value,setItem(){throw Error('blocked')}});assert.equal(c.get('pref-width').value,'standard');assert.equal(c.get('pref-motion').value,'full');
 c.get('pref-width').listeners.change({target:{value:'wide'}});assert.equal(c.get('pref-width').value,'wide');assert.match(c.get('settings-feedback').textContent,/无法保存/);
 c.get('settings-reset').listeners.click();assert.equal(c.get('pref-width').value,'standard');assert.match(c.get('settings-feedback').textContent,/无法保存/);
 }
 });
 test('settings native dialog closes on escape with focus returned and reset applies', () => {
 const c=clientFixture(()=>{});c.get('settings-toggle').listeners.click();assert.equal(c.get('settings').open,true);assert.equal(c.get('settings-close').focused,true);
 let prevented=false;c.get('settings').listeners.cancel({preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(c.get('settings').open,false);assert.equal(c.get('settings-toggle').focused,true);assert.equal(c.get('settings-toggle').attributes['aria-expanded'],'false');
 c.get('pref-source').listeners.change({target:{value:'open'}});assert.equal(c.get('source-details').open,true);c.get('settings-reset').listeners.click();assert.equal(c.get('source-details').open,false);
 });
 test('capability cards open complete text in a native detail dialog without reads', () => {
 let reads=0;const c=clientFixture(()=>{reads++;});const opener=c.get('capability-list').children[0].children[0];opener.listeners.click({preventDefault(){}});
 assert.equal(c.get('detail-dialog').open,true);assert.equal(c.get('detail-title').textContent,'来源验证');assert.equal(c.get('detail-content').children[1].textContent,'尚无验证时间');
 c.get('detail-close').listeners.click();assert.equal(c.get('detail-dialog').open,false);assert.equal(c.get('detail-content').children.length,0);assert.equal(opener.focused,true);assert.equal(reads,0);
 });
 test('session invalidation clears open task detail text as well as hidden views', async () => {
 let authorized=true;const c=clientFixture(async()=>authorized?{status:200,ok:true,json:async()=>({state:'ready',items:[{state:'available',task_name:'Private task',summary:'Full private summary'}]})}:{status:401});
 await c.load();const button=c.get('items').children[0].children.find(n=>n.className==='detail-launch');button.listeners.click();assert.equal(c.get('detail-content').children[0].textContent,'Full private summary');
 authorized=false;await c.load();assert.equal(c.get('detail-dialog').open,false);assert.equal(c.get('detail-content').children.length,0);assert.equal(c.get('detail-title').textContent,'');
 });
 test('saved default view applies after authorized read but not anonymous data', async () => {
 const storage={getItem:k=>k.includes('settings')?' {"version":1,"view":"activity"}':null};let authorized=false;const c=clientFixture(async()=>authorized?{status:200,ok:true,json:async()=>({state:'ready',items:[{state:'available',task_name:'Selected'}]})}:{status:401},storage);
 await c.load();assert.equal(c.get('capabilities-view').hidden,false);authorized=true;await c.load();assert.equal(c.get('activity-view').hidden,false);
 });
 test('visual controls preserve colorful shell and expose real native dialog settings', () => {
 const html=ownerDashboardHtml('test');assert.match(html,/<dialog id="settings"/);assert.match(html,/class="setting-grid"/);assert.match(html,/@keyframes modal-in/);assert.match(html,/body\[data-width="wide"\]/);assert.match(html,/body\[data-contrast="strong"\]/);assert.match(html,/body\[data-motion="reduced"\]/);assert.match(html,/prefers-reduced-motion:reduce/);assert.match(html,/<aside id="add-column"/);
 });

 test('manual and system reduced motion suppress focus and add-rail movement', () => {
 const html=ownerDashboardHtml('test');
 assert.match(html,/body\[data-motion="reduced"\] \.capability-detail:focus-within,body\[data-motion="off"\] \.capability-detail:focus-within\{transform:none\}/);
 assert.match(html,/body\[data-motion="reduced"\] \.add-column:hover \.add-emblem,body\[data-motion="off"\] \.add-column:hover \.add-emblem\{transform:rotate\(6deg\)\}/);
 assert.match(html,/@media\(prefers-reduced-motion:reduce\)\{\.capability-detail:focus-within\{transform:none\}\.add-column:hover \.add-emblem\{transform:rotate\(6deg\)\}/);
 });

test('business controls have shrinkable grids, wrapped actions and narrow-screen stacking',()=>{
 const html=ownerDashboardHtml('test');
 assert.match(html,/\.business-metrics,\.budget-fields\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
 assert.match(html,/\.business-actions,#enable-dialog \.buttons\{flex-wrap:wrap\}/);
 assert.match(html,/@media\(max-width:420px\)\{\.business-metrics,\.budget-fields\{grid-template-columns:minmax\(0,1fr\)\}/);
 assert.match(html,/<p id="business-warning" role="status" hidden>/);
 assert.match(html,/<form id="business-budget"><h4>运行预算<\/h4>/);
});

test('budget input exposes the server minute bounds and notification label is user-facing',()=>{
 const html=ownerDashboardHtml('test');
 assert.match(html,/id="budget-minutes" aria-describedby="business-feedback business-warning" type="number" min="1" max="1440" step="1"/);
 assert.match(html,/<dt>通知状态<\/dt><dd id="business-producer">/);
 assert.doesNotMatch(html,/<dt>生产端<\/dt>/);
});

test('management inputs and confirmation expose feedback and consequences to assistive technology',()=>{
 const html=ownerDashboardHtml('test');
 assert.match(html,/id="budget-minutes" aria-describedby="business-feedback business-warning"/);
 assert.match(html,/id="enable-dialog" aria-labelledby="enable-title" aria-describedby="enable-consequence"/);
 assert.match(html,/<p id="enable-consequence" class="enable-consequence">确认后发送一条验证消息/);
});

test('visible polling is bounded, single flight, backs off and stops on owner expiry',async()=>{
 const timers=new Map();let id=0,calls=0,mode='ok';
 const c=clientFixture(async()=>{calls++;if(mode==='failure')throw Error('offline');return mode==='401'?{status:401}:{status:200,ok:true,json:async()=>({state:'connected',items:[{state:'available',task_name:'Retained task'}]})};},undefined,{setTimeout(fn,ms){timers.set(++id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}});
 const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
 await c.load();assert.ok([...timers.values()].some(t=>t.ms===30000));
 mode='failure';[...timers.values()].find(t=>t.ms===30000).fn();await flush();assert.equal(calls,2);assert.match(c.get('status').textContent,/保留上次快照/);assert.equal(c.get('items').children[0].children[1].textContent,'Retained task');assert.ok([...timers.values()].some(t=>t.ms===60000));
 c.visible(false);assert.equal(timers.size,0);c.visible(true);await flush();assert.equal(calls,3);
 mode='401';await c.load();assert.equal(timers.size,0);assert.equal(c.get('items').children[0].textContent,'验证本人后显示任务');
});
test('an interrupted initial read resumes on tab visibility without duplicate requests',async()=>{
 let calls=0,resolve;const c=clientFixture(async()=>{calls++;if(calls===1)return new Promise(r=>resolve=r);return {status:401};});
 const first=c.load();c.visible(false);await first;c.visible(true);for(let i=0;i<15;i++)await Promise.resolve();assert.equal(calls,2);resolve({status:200,ok:true,json:async()=>({items:[{task_name:'stale private data'}]})});for(let i=0;i<15;i++)await Promise.resolve();assert.equal(c.get('items').children[0].textContent,'验证本人后显示任务');
});
test('additional PA errors affect overall status and all private cards clear on expiry',async()=>{
 let authorized=true;const c=clientFixture(async()=>authorized?{status:200,ok:true,json:async()=>({state:'connected',items:[],sources:[{source_id:'muse-main',display_name:'Muse',state:'error',items:[{state:'unavailable'}]}]})}:{status:401});
 await c.load();assert.match(c.get('status').textContent,/部分工作信息读取失败/);const card=c.get('canvas').children[0];assert.equal(card.className,'pa source-card');authorized=false;await c.load();assert.equal(card.removed,true);
});
test('hiding an authenticated page clears primary task and log content',async()=>{
 const c=clientFixture(async()=>({status:200,ok:true,json:async()=>({state:'connected',items:[{state:'available',task_name:'Private selected task'}]})}));await c.load();assert.equal(c.get('items').children.length,1);c.visible(false);assert.equal(c.get('items').children.length,0);assert.equal(c.get('detail-content').children.length,0);
});
