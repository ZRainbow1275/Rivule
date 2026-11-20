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
    constructor() { this.textContent = ''; this.hidden = false; this.children = []; this.listeners = {}; this.attributes = {}; this.classList = { toggle() {} }; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    replaceChildren(...children) { if(this.children.some(n=>contains(n,document.activeElement)))document.activeElement=document.body; this.children = children; }
    append(...children) { this.children.push(...children); }
    insertBefore(child) { this.children.push(child); }
    remove() { this.removed=true; }
    setAttribute(key, value) { this.attributes[key] = value; }
    focus() { this.focused=true;document.activeElement=this; }
    showModal() { this.open=true; }
    close() { this.open=false; }
  }
  const contains=(node,target)=>node===target||(node.children||[]).some(n=>contains(n,target));
  const elements = new Map(), window = new Element(), document = new Element();
  document.getElementById = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  document.createElement = () => new Element(); document.createElementNS = () => new Element(); document.body = new Element();
  vm.runInNewContext('(' + dashboardClient.toString() + ')()', { selectedWorkbench, document, window, fetch, Date, crypto, localStorage: storage, AbortController, setTimeout, clearTimeout, ...timers });
  document.getElementById('login').hidden=true;
  return { document,get: document.getElementById, load: () => window.listeners.pageshow(), pageshow: event=>window.listeners.pageshow(event), hide: () => window.listeners.pagehide(), visible: value=>{document.hidden=!value;document.listeners.visibilitychange();} };
}








const id={state:'available',source_id:'zot-main',project_id:'project',project_name:'Press',task_id:'proof',run_id:'one',source_status:'running',pending_action_count:0};
const A={...id,task_name:'Proof',branch_id:'hard',branch_name:'Hardcover',summary:'Previous body'};
const B={...id,task_name:'Proof',branch_id:'paper',branch_name:'Paperback',summary:'Paperback body'};
const next={...A,source_status:'needs_input',pending_action_count:2,summary:'Updated hardcover body'};
const setup=async(initial=[A,B])=>{let data=initial,reads=0,id=0;const timers=new Map();const c=clientFixture(async(path,options)=>{reads++;assert.equal(path,'/dashboard/data');assert.equal(options.method,undefined);if(data==='fail')throw Error('offline');if(data==='logout')return {status:401};return {status:200,ok:true,json:async()=>({state:'connected',items:data})};},{getItem:()=>null,setItem(){assert.fail('changes should not use storage');}},{setTimeout(fn,ms){timers.set(++id,[fn,ms]);return id;},clearTimeout(key){timers.delete(key);}});
 await c.load();return {...c,reads:()=>reads,async refresh(value){data=value;const poll=[...timers.values()].find(([,ms])=>ms>=30000&&ms<=300000);assert.ok(poll);poll[0]();await new Promise(setImmediate);}};
};
const panel=c=>c.get('task-changes'),summary=c=>c.get('task-changes-title').textContent,context=c=>c.get('task-changes-context').textContent,rows=c=>c.get('task-changes-list').children;
test('successful comparison has timestamp, exact branch, and existing detail link',async()=>{
 const c=await setup();assert.equal(panel(c).hidden,true);await c.refresh([next,B]);assert.equal(panel(c).hidden,false);
 assert.equal(summary(c),'本次刷新 · 1 项变化');assert.match(context(c),/本次读取：\d{4}.*比较 2 \/ 2 项/);
 const row=rows(c)[0],opener=row.children[0];assert.match(opener.textContent,/Hardcover/);assert.match(row.children[1].textContent,/状态：进行中 → 待决定；待确认：0 → 2/);
 assert.doesNotMatch(JSON.stringify(row),/Previous body|Updated hardcover body/);opener.listeners.click();assert.match(JSON.stringify(c.get('detail-content').children),/Updated hardcover body/);
 c.get('detail-close').listeners.click();assert.equal(c.document.activeElement,opener);assert.equal(c.reads(),2);
});
test('new identity is not called a task change; known unchanged comparison is explicit',async()=>{
 const c=await setup();await c.refresh([A,{...B,task_id:'new',source_status:'completed'}]);
 assert.equal(summary(c),'本次刷新 · 已比较字段无变化');assert.match(context(c),/比较 1 \/ 2 项/);
 assert.doesNotMatch(JSON.stringify(rows(c)),/Paperback|新增|已完成/);
});
test('unreadable or stale branches do not produce changes or seed a future comparison',async()=>{
 const c=await setup();await c.refresh([{...next,state:'withheld',task_name:'Hidden title'}, {...B,stale:true,source_status:'completed'}]);
 assert.equal(panel(c).hidden,true);assert.deepEqual(rows(c),[]);
 await c.refresh([next,{...B,source_status:'completed'}]);assert.equal(panel(c).hidden,true);
 await c.refresh([next,{...B,source_status:'completed'}]);assert.equal(summary(c),'本次刷新 · 已比较字段无变化');assert.equal(c.reads(),4);
});
test('local search and pins neither generate a change nor alter its comparison scope',async()=>{
 const c=await setup();const search=c.get('task-search');search.value='Paperback';search.listeners.input();assert.equal(panel(c).hidden,true);
 await c.refresh([next,B]);assert.equal(summary(c),'本次刷新 · 1 项变化');assert.equal(c.get('items').children.filter(n=>n.className==='task').length,1);assert.match(rows(c)[0].children[0].textContent,/Hardcover/);
 c.get('items').children[0].children.find(n=>n.className?.includes('reading-pin')).listeners.click();assert.equal(summary(c),'本次刷新 · 1 项变化');assert.equal(c.reads(),2);
});
test('failed read hides the comparison; subsequent successful read and logout are distinct',async()=>{
 const c=await setup();await c.refresh([next,B]);const old=rows(c)[0].children[0];await c.refresh('fail');
 assert.equal(panel(c).hidden,true);assert.equal(context(c),'');assert.equal(rows(c).length,0);
 old.listeners.click();assert.notEqual(c.get('detail-dialog').open,true);
 await c.refresh([{...next,pending_action_count:1},B]);assert.match(JSON.stringify(rows(c)),/待确认：2 → 1/);
 await c.refresh('logout');assert.equal(panel(c).hidden,true);assert.equal(rows(c).length,0);assert.equal(context(c),'');assert.equal(c.reads(),5);
});
test('unreported pending counts are not interpreted as zero',async()=>{
 const c=await setup([{...A,pending_action_count:undefined}]);await c.refresh([{...A,pending_action_count:1}]);
 assert.equal(summary(c),'本次刷新 · 已比较字段无变化');assert.doesNotMatch(JSON.stringify(rows(c)),/待确认：0 → 1/);
});
