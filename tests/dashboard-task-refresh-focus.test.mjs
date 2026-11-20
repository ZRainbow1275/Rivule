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
const base={state:'available',source_id:'zot-main',project_id:'press',project_name:'Press',run_id:'run',branch_id:'main',branch_name:'Main',last_confirmed_at:'2026-11-20T12:00:00Z'};
const item=(i,status)=>({...base,task_id:'proof-'+i,task_name:'Proof '+i,source_status:status,summary:'Detail '+i});
const A=item(1,'running'),B=item(2,'completed'),C=item(3,'running');
async function setup(initial=[A,B]){
 let reads=0,payload={state:'connected',items:initial},id=0;const timers=new Map();
 const s=clientFixture(async(path,options)=>{reads++;assert.equal(path,'/dashboard/data');assert.equal(options.method,undefined);return {status:200,ok:true,json:async()=>payload};},
 {getItem:()=>null,setItem(){assert.fail('refresh focus recovery must not persist');}},{setTimeout(f,ms){timers.set(++id,{f,ms});return id;},clearTimeout(id){timers.delete(id);}});
 await s.load();
 return {...s,reads:()=>reads,async poll(items,state='connected'){
  payload={items,state};const t=[...timers.values()].find(t=>t.ms>=30000&&t.ms<=300000);assert.ok(t);t.f();await new Promise(setImmediate);
 }};
}
const cards=s=>s.get('items').children.filter(x=>x.tag==='article');
const opener=node=>node.children.find(x=>x.textContent==='打开详情');
const reset=s=>s.get('items').children.find(x=>x.textContent==='清除筛选，查看全部已选任务');
const filter=(s,value)=>{const el=s.get('task-filter');el.value=value;el.listeners.change();};
test('a polled completion moves focus from the last matching card to the existing clear-filter action',async()=>{
 const s=await setup();filter(s,'running');assert.equal(cards(s).length,1);opener(cards(s)[0]).focus();
 await s.poll([{...A,source_status:'completed'},B]);
 assert.equal(s.get('task-filter').value,'running');assert.equal(cards(s).length,0);assert.match(s.get('items').children[0].textContent,/没有匹配/);
 assert.ok(reset(s));assert.equal(s.document.activeElement,reset(s));
 reset(s).listeners.click();assert.equal(cards(s).length,2);assert.equal(s.document.activeElement,s.get('task-search'));assert.equal(s.reads(),2);
});
test('a focused empty-result action stays reachable across repeated repaint; a new match falls back to the existing filter',async()=>{
 const completed={...A,source_status:'completed'},s=await setup([completed,B]);filter(s,'running');
 const old=reset(s);assert.ok(old);old.focus();await s.poll([completed,B]);assert.notEqual(reset(s),old);assert.equal(s.document.activeElement,reset(s));
 await s.poll([A,B]);
 assert.equal(reset(s),undefined);assert.equal(cards(s).length,1);assert.equal(s.document.activeElement,s.get('task-filter'));assert.equal(s.reads(),3);
});
test('a known service failure that removes the focused search goes to the current named Tasks pane',async()=>{
 const s=await setup();s.get('task-search').focus();await s.poll([],'error');
 assert.equal(s.get('task-toolbar').hidden,true);assert.match(s.get('items').children[0].textContent,/任务读取失败/);
 assert.equal(s.document.activeElement,s.get('tasks-view'));assert.equal(s.get('tasks-view').tabIndex,0);assert.equal(s.reads(),2);
});
test('an available exact task stays focused and a refresh does not move focus from another view',async()=>{
 const s=await setup([A,B,C]);filter(s,'running');const old=opener(cards(s)[1]);old.focus();
 await s.poll([{...A,source_status:'completed'},B,C]);
 assert.equal(cards(s).length,1);assert.notEqual(opener(cards(s)[0]),old);assert.equal(s.document.activeElement,opener(cards(s)[0]));
 s.get('view-activity').listeners.click();const activityTab=s.get('view-activity');assert.equal(s.document.activeElement,activityTab);
 await s.poll([],'error');assert.equal(s.get('activity-view').hidden,false);assert.equal(s.document.activeElement,activityTab);
 assert.equal(s.reads(),3);
});

test('a disappearing partial clear button advances to the existing empty-result clear action',async()=>{
 const s=await setup([A,B,C]);filter(s,'running');assert.equal(cards(s).length,2);
 const partial=s.get('task-clear-partial');assert.equal(partial.hidden,false);partial.focus();
 await s.poll([{...A,source_status:'completed'},B,{...C,source_status:'completed'}]);
 assert.equal(partial.hidden,true);assert.equal(s.document.activeElement,reset(s));assert.equal(s.reads(),2);
});
