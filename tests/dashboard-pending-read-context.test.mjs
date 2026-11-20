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
    contains(target){return contains(this,target);}
    append(...children) { this.children.push(...children); }
    insertBefore(child) { child.parent=this;this.children.push(child); }
    remove() { this.removed=true;if(this.parent)this.parent.children=this.parent.children.filter(e=>e!==this); }
    setAttribute(key, value) { this.attributes[key] = value; }
    focus() { const prior=document.activeElement;document.activeElement=this;this.focused=true;if(prior!==this)prior?.listeners.focusout?.({relatedTarget:this}); }
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

const stamp='2026-11-20T12:00:00Z';
const snap={state:'available',source_id:'zot-main',project_id:'press',project_name:'Print',task_id:'proof',task_name:'Final proof',run_id:'r',branch_id:'hard',branch_name:'Hardcover',source_status:'running',last_confirmed_at:stamp,observed_at:stamp,summary:'EXACT HARDCOVER BODY',stale:false,pending_action_count:0,activity:{state:'available',items:[]}};
const next={...snap,source_status:'needs_input',pending_action_count:2};
const other={...next,source_id:'bound-pa',branch_id:'paper',branch_name:'Paperback',summary:'EXACT PAPERBACK BODY'};
const ok=(main=snap,secondary=other)=>({status:200,ok:true,json:async()=>({state:'connected',items:[main],sources:[{source_id:'bound-pa',state:'connected',items:[secondary]}]})});
async function setup(snapshot=snap,secondary=other){
 let reads=0,payload=ok(snapshot,secondary),id=0;const timers=new Map();
 const c=clientFixture(async(url,opts)=>{reads++;assert.equal(url,'/dashboard/data');assert.equal(opts.method,undefined);return payload;},
 {getItem:()=>null,setItem(){assert.fail('reading pending context must not persist')}},
 {setTimeout(f,ms){timers.set(++id,{f,ms});return id;},clearTimeout(key){timers.delete(key);}});
 await c.load();return {...c,reads:()=>reads,async refresh(response){
   payload=response;const t=[...timers.values()].find(t=>t.ms>=30000&&t.ms<=300000);assert.ok(t);t.f();await new Promise(setImmediate);
 }};
}
const flat=n=>[n,...n.children.flatMap(flat)];
const by=(n,cls)=>flat(n).find(x=>x.className===cls);
const label=(n,t)=>flat(n).find(x=>x.textContent===t);
const text=n=>flat(n).map(x=>x.textContent).filter(Boolean).join(' | ');
const detail=c=>c.get('detail-content');
const sourceCard=c=>by(c.get('canvas'),'pa source-card');
const button=c=>by(c.get('items'),'pending-callout');
const changes=c=>c.get('task-changes-list');
const close=(c,opener)=>{c.get('detail-close').listeners.click();assert.equal(c.document.activeElement,opener);};
function show(c,trigger){assert.ok(trigger);trigger.focus();trigger.listeners.click();return text(detail(c));}
test('a newly actionable reported count stays visible after opening its existing read-only detail',async()=>{
 const c=await setup();await c.refresh(ok());assert.match(c.get('task-changes-title').textContent,/已比较字段无变化/);assert.equal(button(c),undefined);
 await c.refresh(ok(next));assert.match(text(changes(c)),/进行中 → 待决定.*待确认：0 → 2/);assert.match(button(c).textContent,/2 项待确认/);
 const open=button(c),shown=show(c,open);assert.match(shown,/EXACT HARDCOVER BODY/);assert.match(shown,/2 项待确认/);assert.match(shown,/回原 PA/);
 close(c,open);assert.equal(c.reads(),3);
});
test('queue, change row, and secondary detail agree on known pending evidence without adding an operation',async()=>{
 const c=await setup();await c.refresh(ok(next));by(c.get('items'),'detail-launch reading-pin').listeners.click();
 const readers=[c.get('reading-queue-list').children[0].children[0],changes(c).children[0].children[0],label(sourceCard(c),'工作详情与日志')];
 for(const [index,trigger] of readers.entries()){
   const shown=show(c,trigger);assert.match(shown,index===2?/EXACT PAPERBACK BODY/:/EXACT HARDCOVER BODY/);
   assert.match(shown,/2 项待确认/);assert.match(shown,/回原 PA/);assert.equal(flat(detail(c)).some(x=>x.textContent==='批准'||x.textContent==='执行'),false);
   close(c,trigger);
 }
 assert.equal(c.reads(),2);
});
test('failed refresh hides prior change results; pending remains a marked retained snapshot until recovered',async()=>{
 const c=await setup();await c.refresh(ok(next));await c.refresh({status:503,ok:false});assert.equal(c.get('task-changes').hidden,true);
 const old=button(c),shown=show(c,old);assert.equal(c.get('detail-snapshot-warning').hidden,false);assert.match(shown,/2 项待确认/);close(c,old);
 await c.refresh(ok());assert.equal(button(c),undefined);assert.match(text(changes(c)),/待确认：2 → 0/);
 const recovered=label(c.get('items'),'打开详情');assert.doesNotMatch(show(c,recovered),/2 项待确认/);
 assert.equal(c.get('detail-snapshot-warning').hidden,true);assert.equal(c.reads(),4);
});
test('archived or stale reports are historical; zero and unreported are not interchangeable',async()=>{
 const c=await setup({...next,stale:true}, {...other,archived:true});
 for(const [trigger,phrase] of [[button(c),/旧快照记录 · 2 项待确认/],[label(sourceCard(c),'工作详情与日志'),/归档记录 · 2 项待确认/]]){
  assert.match(show(c,trigger),phrase);close(c,trigger);
 }
 for(const [pending_action_count,expected] of [[0,/等待输入；上报 0 项待确认/],[undefined,/等待输入；数量未上报/]]){
  await c.refresh(ok({...next,pending_action_count}));assert.equal(button(c),undefined);
  const open=label(c.get('items'),'打开详情');assert.match(show(c,open),expected);close(c,open);
 }
 assert.equal(c.reads(),3);
});
