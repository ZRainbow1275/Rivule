import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
// Evaluate the actual self-contained inline client without booting server integrations.
const source=readFileSync(process.env.PRESENTATION_SOURCE || new URL('../src/owner/presentation.mjs',import.meta.url),'utf8');
const client=source.slice(source.indexOf('export function dashboardClient('),source.indexOf('export function qqSettingsClient(')).replace(/^export /,'');
const dashboardClient=vm.runInNewContext('('+client.trim()+')');
const a=source.indexOf('export function selectedWorkbench('),b=source.indexOf('export function dashboardClient(');
const model=source.slice(a,b).replace(/^export /,'');
const selectedWorkbench=vm.runInNewContext(model+';selectedWorkbench');
function clientFixture(fetch, storage, timers = {}) {
  class Element {
    constructor(tag = '') { this.tag=tag; this.textContent = ''; this.hidden = false; this.children = []; this.listeners = {}; this.attributes = {}; this.classList = { toggle() {} }; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    replaceChildren(...children) { if(this.children.some(n=>contains(n,document.activeElement)))document.activeElement=document.body; this.children = children; }
    append(...children) { this.children.push(...children); }
    insertBefore(child) { this.children.push(child); }
    remove() { this.removed=true; }
    setAttribute(key, value) { this.attributes[key] = value; }
    focus() { this.focused=true;document.activeElement=this; }
    showModal() { this.open=true;this.opens=(this.opens||0)+1; }
    close() { this.open=false; }
  }
  const contains=(node,target)=>node===target||(node.children||[]).some(n=>contains(n,target));
  const elements = new Map(), window = new Element(), document = new Element();
  document.getElementById = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  document.createElement = tag => new Element(tag); document.createElementNS = () => new Element(); document.body = new Element();
  vm.runInNewContext('(' + dashboardClient.toString() + ')()', { selectedWorkbench, document, window, fetch, Date, crypto, localStorage: storage, AbortController, setTimeout, clearTimeout, ...timers });
  document.getElementById('login').hidden=true;
  return { document,get: document.getElementById, load: () => window.listeners.pageshow(), pageshow: event=>window.listeners.pageshow(event), hide: () => window.listeners.pagehide(), visible: value=>{document.hidden=!value;document.listeners.visibilitychange();} };
}
const day='2026-11-20', stamp=(h)=>day+'T'+h+':00:00Z';
const main={state:'available',source_id:'zot-main',project_id:'project',project_name:'Print',task_id:'proof',run_id:'one',task_name:'Proof',source_status:'running',last_confirmed_at:stamp('14')};
const event={kind:'progress',received_at:stamp('14'),occurred_at:stamp('11'),source_status:'running',projection_applied:true,summary:'Hardcover proof approved',phase_label:'Print check',progress:{done:3,total:5,unit:'pages'},delivery:['queued']};
const prior={...event,kind:'correction',received_at:stamp('13'),occurred_at:stamp('12'),projection_applied:false,summary:'Paper batch corrected\nSecond line',delivery:['failed']};
const good=(items,extra={})=>({state:'available',observed_at:stamp('15'),items,...extra});
const hard={...main,branch_name:'Hardcover',branch_id:'hard',summary:'Hardcover snapshot',activity:good([event,prior],{truncated:true,withheld_count:2})};
const paper={...main,branch_name:'Paperback',branch_id:'paper',summary:'Paperback snapshot',activity:good([{...event,summary:'Paperback event'}])};
const setup=async(items)=>{
  let reads=0;
  const c=clientFixture(async(path,options)=>{reads++;assert.equal(path,'/dashboard/data');assert.equal(options.method,undefined);return {status:200,ok:true,json:async()=>({state:'connected',items})};},{getItem:()=>null,setItem(){assert.fail('event record presentation must not persist data');}});
  await c.load();return {...c,reads:()=>reads};
};
const all=(n,p)=>[...(p(n)?[n]:[]),...n.children.flatMap(x=>all(x,p))];
const content=c=>c.get('detail-content');
const text=n=>all(n,()=>true).map(x=>x.textContent).filter(Boolean).join(' | ');
const find=(n,p)=>all(n,p)[0];
const by=(n,cls)=>find(n,x=>x.className===cls);
const catalog=c=>c.get('items').children.filter(x=>x.tag==='article');
const taskButton=(c,i)=>find(catalog(c)[i],x=>x.textContent==='打开详情');
const logButton=(c,i)=>find(c.get('activity-list').children[i],x=>x.textContent==='查看日志');
const timeline=c=>by(content(c),'event-timeline');
const close=c=>c.get('detail-close').listeners.click();
test('activity separates event text, received time, source time, and delivery while preserving server order',async()=>{
  const c=await setup([hard,paper]);c.get('view-activity').listeners.click();const trigger=logButton(c,0);trigger.listeners.click();
  const t=timeline(c);
  assert.ok(t,'activity must have a semantic event timeline instead of concatenated paragraphs');assert.equal(t.tag,'section');
  const list=by(t,'event-log-list');assert.equal(list.tag,'ol');assert.equal(list.children.length,2);
  const [one,two]=list.children;assert.equal(one.tag,'li');
  assert.equal(by(one,'event-log-summary').textContent,event.summary);
  assert.equal(by(two,'event-log-summary').textContent,prior.summary);
  for(const [entry,row] of [[one,event],[two,prior]]){
    const times=all(entry,n=>n.tag==='time');assert.equal(times.length,2);
    assert.equal(times[0].attributes.datetime,row.received_at);assert.match(times[0].textContent,/Rivule 收到/);
    assert.equal(times[1].attributes.datetime,row.occurred_at);assert.match(times[1].textContent,/来源发生/);
  }
  assert.match(text(by(one,'event-log-signals')),/已更新快照.*3 \/ 5 pages/);
  assert.match(text(by(two,'event-log-signals')),/未替换任务快照/);
  assert.match(text(by(two,'event-log-meta')),/Discord 投递 · 发送失败/);
  assert.match(text(t),/日志读取.*仅显示最近 30 条事件.*2 条敏感事件未展示.*不代表 QQ 投递/s);
  assert.doesNotMatch(text(t),/Paperback event/);
  assert.equal(c.document.activeElement,c.get('detail-close'));close(c);assert.equal(c.document.activeElement,trigger);assert.equal(c.reads(),1);
});
test('task details provide the same log in one collapsed disclosure without switching views or branches',async()=>{
  const c=await setup([hard,paper]);c.get('view-tasks').listeners.click();c.get('task-search').value='Paperback';c.get('task-search').listeners.input();
  const trigger=taskButton(c,0);trigger.listeners.click();const t=timeline(c);
  assert.ok(t,'the task modal must expose the log as its own disclosure');assert.equal(t.tag,'details');assert.equal(!!t.open,false);
  assert.equal(t.children[0].tag,'summary');assert.match(t.children[0].textContent,/1 条可展示事件/);
  assert.match(text(t),/Paperback event/);assert.doesNotMatch(text(content(c)),/Hardcover proof approved/);
  close(c);assert.equal(c.document.activeElement,trigger);assert.equal(c.get('task-search').value,'Paperback');
  assert.equal(c.get('tasks-view').hidden,false);assert.equal(c.reads(),1);
});
test('readable empty, unavailable and withheld task state never masquerade as one another',async()=>{
  const c=await setup([{...hard,activity:good([])},{...paper,activity:{state:'unavailable',items:[event]}},{...main,branch_id:'restricted',state:'withheld',activity:good([event])}]);
  for(const [i,available] of [[0,true],[1,false],[2,false]]){
    taskButton(c,i).listeners.click();const t=timeline(c);
    assert.ok(t,'log state must have a dedicated summary');assert.match(t.children[0].textContent,available?/0 条可展示事件/:/暂不可用/);
    assert.equal(!!by(t,'event-log-list'),false);
    assert.match(text(t),available?/暂无可展示的普通业务事件/:/日志暂不可用/);
    assert.doesNotMatch(text(t),/Hardcover proof approved|Paper batch corrected/);close(c);
  }
  c.get('view-activity').listeners.click();logButton(c,1).listeners.click();assert.match(text(timeline(c)),/日志暂不可用/);
  c.hide();assert.equal(c.get('detail-dialog').open,false);assert.equal(content(c).children.length,0);assert.equal(c.reads(),1);
});
test('the narrow-friendly timeline styling preserves wrapping and keyboard focus',()=>{
  assert.match(source,/\.event-timeline\{[^}]*min-width:0[^}]*overflow-wrap:anywhere/);
  for(const cls of ['event-log-heading','event-log-signals','event-log-meta'])assert.match(source,new RegExp('\\.'+cls+'[^{}]*\\{[^}]*flex-wrap:wrap'));
  assert.match(source,/\.event-timeline>summary:focus-visible\{[^}]*outline:2px solid currentColor/);
});
