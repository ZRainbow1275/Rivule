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

const pin=row=>row.children.find(n=>n.className?.includes('reading-pin'));
const queue=c=>c.get('reading-queue-list').children;
test('a filtered-out changed task can be pinned directly and read later after the comparison rolls over',async()=>{
 const c=await setup();c.get('task-search').value='Paperback';c.get('task-search').listeners.input();
 await c.refresh([next,B]);const button=pin(rows(c)[0]);assert.ok(button);button.focus();button.listeners.click();
 assert.equal(c.document.activeElement,button);assert.equal(button.attributes['aria-pressed'],'true');assert.match(queue(c)[0].children[0].textContent,/Hardcover/);
 await c.refresh([next,B]);assert.equal(summary(c),'本次刷新 · 已比较字段无变化');assert.equal(c.document.activeElement,c.get('task-changes-title'));
 queue(c)[0].children[0].listeners.click();assert.match(JSON.stringify(c.get('detail-content').children),/Updated hardcover body/);assert.equal(c.reads(),3);
});
test('card, comparison and queue removal use a single pin and predictable state',async()=>{
 const c=await setup();await c.refresh([next,B]);
 const changed=pin(rows(c)[0]),card=pin(c.get('items').children[0]);card.listeners.click();assert.equal(changed.attributes['aria-pressed'],'true');assert.equal(queue(c).length,1);
 changed.listeners.click();assert.equal(card.attributes['aria-pressed'],'false');assert.equal(queue(c).length,0);
 changed.listeners.click();queue(c)[0].children[1].listeners.click();assert.equal(changed.attributes['aria-pressed'],'false');assert.equal(card.attributes['aria-pressed'],'false');assert.equal(c.reads(),2);
});
test('repainted comparison buttons cannot mutate the queue and focus stays on matching pin',async()=>{
 const c=await setup();await c.refresh([next,B]);const old=pin(rows(c)[0]);old.focus();
 await c.refresh([{...next,pending_action_count:1},B]);const current=pin(rows(c)[0]);assert.notEqual(current,old);assert.equal(c.document.activeElement,current);
 old.listeners.click();assert.equal(queue(c).length,0);current.listeners.click();assert.equal(queue(c).length,1);
 await c.refresh('logout');current.listeners.click();assert.equal(queue(c).length,0);assert.equal(c.reads(),4);
});
