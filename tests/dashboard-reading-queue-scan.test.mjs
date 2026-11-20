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

const tasks=Array.from({length:20},(_,i)=>({...identity,task_id:'batch-'+i,task_name:'Proof '+(i+1),branch_id:'b'+i,branch_name:'Branch '+(i+1),summary:'Body '+(i+1)}));
const revealed=c=>rows(c).filter(row=>!row.hidden).length;
const toggle=c=>c.get('reading-queue-toggle');
const packageCases=[['full',tasks],['partial',tasks.map((t,i)=>i<6?t:{...t,state:'withheld'})],['empty',[]]];
for(const [type,snapshot] of packageCases)test('reading scan in '+type+' snapshot exposes a bounded preview',async()=>{
 const c=await setup(snapshot),pins=snapshot.filter(t=>t.state==='available').length;
 for(let i=0;i<pins;i++)pin(c,i).listeners.click();
 assert.equal(rows(c).length,pins);assert.equal(revealed(c),Math.min(4,pins));
 assert.equal(toggle(c).hidden,pins<=4);assert.equal(queue(c).hidden,pins===0);
 if(pins>4){assert.match(toggle(c).textContent,new RegExp('其余 '+(pins-4)+' 项'));assert.equal(toggle(c).attributes['aria-expanded'],'false');
  toggle(c).focus();toggle(c).listeners.click();assert.equal(revealed(c),pins);assert.equal(c.document.activeElement,toggle(c));
  toggle(c).listeners.click();assert.equal(revealed(c),4);assert.equal(c.document.activeElement,toggle(c));
 }
 assert.equal(c.reads(),1);
});
test('continuous reading crosses the preview boundary and reveals the last opener on close',async()=>{
 const c=await setup(tasks.slice(0,6));for(let i=0;i<6;i++)pin(c,i).listeners.click();assert.equal(revealed(c),4);open(c,3).listeners.click();
 c.get('queue-detail-next').listeners.click();assert.match(c.get('queue-detail-position').textContent,/5 \/ 6/);assert.match(JSON.stringify(c.get('detail-content').children),/Body 5/);
 c.get('detail-close').listeners.click();assert.equal(revealed(c),6);assert.equal(c.document.activeElement,open(c,4));assert.equal(toggle(c).attributes['aria-expanded'],'true');assert.equal(c.reads(),1);
});
test('detached or hidden queue-row actions do not change what is read or pinned',async()=>{
 const c=await setup(tasks.slice(0,6));for(let i=0;i<6;i++)pin(c,i).listeners.click();
 const hidden=rows(c)[5];assert.equal(hidden.hidden,true);hidden.children[0].listeners.click();hidden.children[1].listeners.click();
 assert.equal(rows(c).length,6);assert.notEqual(c.get('detail-dialog').open,true);assert.equal(c.reads(),1);
});

test('refresh moves focus to the queue summary when the expansion button ceases to be needed',async()=>{
 const c=await setup(tasks.slice(0,6));for(let i=0;i<6;i++)pin(c,i).listeners.click();toggle(c).focus();
 await c.refresh(tasks.slice(0,4));assert.equal(revealed(c),4);assert.equal(toggle(c).hidden,true);assert.equal(c.document.activeElement,c.get('reading-queue-title'));assert.equal(c.reads(),2);
});
