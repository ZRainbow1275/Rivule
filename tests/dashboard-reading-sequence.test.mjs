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
    showModal() { this.open=true;this.opens=(this.opens||0)+1; }
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
const C={...identity,task_name:'Proof',branch_id:'ebook',branch_name:'Ebook',summary:'Ebook body'};
const current=c=>JSON.stringify(c.get('detail-content').children);
const nav=c=>c.get('queue-detail-nav'),prev=c=>c.get('queue-detail-prev'),next=c=>c.get('queue-detail-next'),position=c=>c.get('queue-detail-position');
test('reads three same-title tasks in pinned order without wrapping or reopening the modal',async()=>{
 const c=await setup([A,B,C]),detail=c.get('detail-dialog');for(const i of [1,0,2])pin(c,i).listeners.click();open(c,0).listeners.click();
 assert.equal(nav(c).hidden,false);assert.equal(position(c).textContent,'阅读清单 1 / 3');assert.equal(prev(c).disabled,true);
 assert.match(current(c),/Paperback body/);assert.match(next(c).attributes['aria-label'],/Hardcover/);
 prev(c).listeners.click();assert.match(current(c),/Paperback body/);next(c).listeners.click();assert.equal(position(c).textContent,'阅读清单 2 / 3');assert.match(current(c),/Hardcover body/);assert.equal(c.document.activeElement,next(c));
 next(c).listeners.click();assert.equal(position(c).textContent,'阅读清单 3 / 3');assert.match(current(c),/Ebook body/);assert.equal(next(c).disabled,true);assert.equal(c.document.activeElement,position(c));assert.equal(detail.opens,1);
 next(c).listeners.click();assert.match(current(c),/Ebook body/);prev(c).listeners.click();assert.match(current(c),/Hardcover body/);
 c.get('detail-close').listeners.click();assert.equal(nav(c).hidden,true);assert.equal(c.document.activeElement,open(c,1));assert.equal(c.reads(),1);assert.equal(rows(c).length,3);
});
test('ordinary details and a single queued item stay free of sequence controls',async()=>{
 const c=await setup();pin(c,0).listeners.click();open(c,0).listeners.click();assert.equal(nav(c).hidden,true);c.get('detail-close').listeners.click();
 pin(c,1).listeners.click();const normal=cards(c)[0].children.find(n=>n.textContent==='打开详情');normal.listeners.click();assert.equal(nav(c).hidden,true);c.get('detail-close').listeners.click();
 assert.equal(c.document.activeElement,normal);assert.equal(c.reads(),1);
});
test('the queue keeps normal paused-refresh behavior and follows readable updated entries afterward',async()=>{
 const c=await setup([A,B,C]);for(const i of [0,1,2])pin(c,i).listeners.click();open(c,0).listeners.click();
 await c.refresh([{...A,state:'withheld'},{...B,summary:'Updated paperback'},C]);assert.equal(c.reads(),1);assert.equal(position(c).textContent,'阅读清单 1 / 3');
 c.get('detail-close').listeners.click();await c.refresh([{...A,state:'withheld'},{...B,summary:'Updated paperback'},C]);
 assert.equal(c.reads(),2);assert.equal(rows(c).length,2);open(c,0).listeners.click();assert.equal(position(c).textContent,'阅读清单 1 / 2');assert.match(current(c),/Updated paperback/);
 c.hide();next(c).listeners.click();assert.equal(nav(c).hidden,true);assert.equal(rows(c).length,0);assert.equal(c.reads(),2);
});
