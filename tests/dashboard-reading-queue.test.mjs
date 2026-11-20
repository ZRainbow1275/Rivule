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







const identity={state:'available',source_id:'zot-main',project_id:'project',project_name:'Print',task_id:'proof',run_id:'one',source_status:'running'};
const A={...identity,task_name:'Proof',branch_id:'hard',branch_name:'Hardcover',summary:'Hardcover body'};
const B={...identity,task_name:'Proof',branch_id:'paper',branch_name:'Paperback',summary:'Paperback body'};
const setup=async(initial=[A,B])=>{let data=initial,reads=0,id=0;const timers=new Map();
 const c=clientFixture(async(path,options)=>{reads++;assert.equal(path,'/dashboard/data');assert.equal(options.method,undefined);if(data==='logout')return {status:401};return {status:200,ok:true,json:async()=>({state:'connected',items:data})};},{getItem:()=>null,setItem(){assert.fail('reading queue must not persist data');}},{setTimeout(fn,ms){timers.set(++id,[fn,ms]);return id;},clearTimeout(key){timers.delete(key);}});
 await c.load();return {...c,reads:()=>reads,async refresh(next){data=next;const poll=[...timers.values()].find(([,ms])=>ms>=30000&&ms<=300000);assert.ok(poll);poll[0]();await new Promise(setImmediate);}};
};
const cards=c=>c.get('items').children.filter(n=>n.className==='task');
const pin=(c,i)=>cards(c)[i].children.find(n=>n.className?.includes('reading-pin'));
const queue=c=>c.get('reading-queue');
const rows=c=>c.get('reading-queue-list').children;
const open=(c,i)=>rows(c)[i].children[0];
test('pinning shows a branch-aware local queue that keeps access across task filtering',async()=>{
 const c=await setup();assert.equal(queue(c).hidden,true);
 const p=pin(c,1);p.focus();p.listeners.click();assert.equal(c.document.activeElement,p);assert.equal(p.attributes['aria-pressed'],'true');assert.equal(queue(c).open,true);assert.match(c.get('reading-queue-title').textContent,/1 项/);
 c.get('task-search').value='Hardcover';c.get('task-search').listeners.input();assert.equal(cards(c).length,1);assert.match(open(c,0).textContent,/Paperback/);
 open(c,0).listeners.click();assert.match(JSON.stringify(c.get('detail-content').children),/Paperback body/);assert.doesNotMatch(JSON.stringify(c.get('detail-content').children),/Hardcover body/);
 c.get('detail-close').listeners.click();assert.equal(c.document.activeElement,open(c,0));assert.equal(c.reads(),1);
});
test('two same-title pins stay distinct and one can be removed with a keyboard return point',async()=>{
 const c=await setup();pin(c,0).listeners.click();pin(c,1).listeners.click();
 assert.deepEqual(rows(c).map(n=>n.children[0].textContent),['Proof · Print · 分支：Hardcover','Proof · Print · 分支：Paperback']);
 const remove=rows(c)[0].children[1];remove.focus();remove.listeners.click();assert.equal(rows(c).length,1);assert.equal(pin(c,0).attributes['aria-pressed'],'false');assert.equal(c.document.activeElement,pin(c,0));assert.equal(c.reads(),1);
 pin(c,1).listeners.click();assert.equal(queue(c).hidden,true);assert.equal(queue(c).open,false);
});
test('refresh uses the exact task key and fresh content while obsolete elements cannot open',async()=>{
 const c=await setup();pin(c,1).listeners.click();const old=open(c,0);old.focus();
 await c.refresh([A,{...B,task_name:'Revised Proof',summary:'Updated paper body'}]);const current=open(c,0);
 assert.notEqual(current,old);assert.equal(c.document.activeElement,current);assert.match(current.textContent,/Revised Proof/);
 old.listeners.click();assert.notEqual(c.get('detail-dialog').open,true);
 current.listeners.click();assert.match(JSON.stringify(c.get('detail-content').children),/Updated paper body/);assert.equal(c.reads(),2);
});
test('a pin is removed when its exact task is unavailable even if a similarly named task remains',async()=>{
 const c=await setup();pin(c,0).listeners.click();const previous=open(c,0);previous.focus();
 await c.refresh([{...A,state:'withheld',task_name:'Withheld title'},B]);
 assert.equal(queue(c).hidden,true);assert.equal(rows(c).length,0);assert.equal(pin(c,0),undefined);
 previous.listeners.click();assert.notEqual(c.get('detail-dialog').open,true);assert.equal(c.document.activeElement,c.get('view-tasks'));assert.equal(c.reads(),2);
});
test('internal views preserve pins; leaving the page or a lost read scope clears them',async()=>{
 const c=await setup();pin(c,0).listeners.click();c.get('view-activity').listeners.click();c.get('view-tasks').listeners.click();assert.equal(rows(c).length,1);
 c.hide();assert.equal(rows(c).length,0);assert.equal(queue(c).hidden,true);assert.equal(c.reads(),1);
 const hidden=await setup();pin(hidden,0).listeners.click();hidden.visible(false);assert.equal(rows(hidden).length,0);assert.equal(queue(hidden).hidden,true);assert.equal(hidden.reads(),1);
 const d=await setup();pin(d,1).listeners.click();await d.refresh('logout');assert.equal(rows(d).length,0);assert.equal(queue(d).hidden,true);assert.equal(d.reads(),2);
});
test('only 20 pins fit and removing one restores the capacity',async()=>{
 const c=await setup(Array.from({length:21},(_,i)=>({...A,task_id:String(i),task_name:'Task '+i})));
 for(let i=0;i<20;i++)pin(c,i).listeners.click();assert.equal(rows(c).length,20);assert.equal(pin(c,20).disabled,true);
 pin(c,20).listeners.click();assert.equal(rows(c).length,20);
 rows(c)[0].children[1].listeners.click();assert.equal(pin(c,20).disabled,false);pin(c,20).listeners.click();assert.equal(rows(c).length,20);assert.equal(c.reads(),1);
});
