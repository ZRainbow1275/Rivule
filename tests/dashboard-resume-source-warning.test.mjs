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
const primary={state:'available',source_id:'zot-main',project_id:'press',project_name:'Print',task_id:'proof',task_name:'Final proof',run_id:'r',branch_id:'hard',branch_name:'Hardcover',source_status:'running',last_confirmed_at:stamp,observed_at:stamp,summary:'EXACT HARDCOVER DETAIL',stale:false,activity:{state:'available',observed_at:stamp,items:[{kind:'progress',summary:'HARDCOVER LOG',received_at:stamp}]}};
const secondary={...primary,source_id:'bound-pa',branch_id:'paper',branch_name:'Paperback',summary:'EXACT PAPERBACK DETAIL',activity:{...primary.activity,items:[{kind:'progress',summary:'PAPERBACK LOG',received_at:stamp}]}};
const response=(items=[primary],other=[secondary])=>({status:200,ok:true,json:async()=>({state:'connected',items,sources:[{source_id:'bound-pa',display_name:'Reader PA',state:'connected',items:other}]})});
const pending=()=>{let release;const result=new Promise(r=>{release=r;});return {result,release};};
async function setup(){
 let reads=0,reply=response(),id=0;const timers=new Map();
 const c=clientFixture(async(url,opts)=>{reads++;assert.equal(url,'/dashboard/data');assert.equal(opts.method,undefined);return reply;},
 {getItem:()=>null,setItem(){assert.fail('resume paths must not write data');}},{setTimeout(f,ms){timers.set(++id,{f,ms});return id;},clearTimeout(i){timers.delete(i);}});
 await c.load();return {...c,reads:()=>reads,
  poll(value){reply=value;const timer=[...timers.values()].find(t=>t.ms>=30000&&t.ms<=300000);assert.ok(timer);timer.f();}
 };
}
const flat=n=>[n,...n.children.flatMap(flat)];
const label=(n,t)=>flat(n).find(x=>x.textContent===t);
const text=n=>flat(n).map(x=>x.textContent).filter(Boolean).join(' | ');
const warning=c=>c.get('detail-snapshot-warning');
const detail=c=>c.get('detail-content');
const sourceCard=c=>c.get('canvas').children.find(x=>x.className==='pa source-card');
const setupPin=c=>flat(c.get('items')).find(x=>x.className?.includes('reading-pin')).listeners.click();
function getEntry(c,i){
 if(i==='activity'){c.get('view-activity').listeners.click();return label(c.get('activity-list'),'查看日志');}
 c.get('view-tasks').listeners.click();
 if(i==='main')return label(c.get('items'),'打开详情');
 if(i==='queue')return c.get('reading-queue-list').children[0].children[0];
 return label(sourceCard(c),'工作详情与日志');
}
function verifyEntry(c,i,retained){
 const trigger=getEntry(c,i);assert.ok(trigger,i);trigger.focus();trigger.listeners.click();
 const expected=i==='activity'?'HARDCOVER LOG':i==='secondary'?'EXACT PAPERBACK DETAIL':'EXACT HARDCOVER DETAIL';
 assert.match(text(detail(c)),new RegExp(expected));assert.match(text(detail(c)),new RegExp(stamp));
 assert.equal(warning(c).hidden,!retained,i+' retained warning');
 c.get('detail-close').listeners.click();assert.equal(c.document.activeElement,trigger);
}
const offline={status:503,ok:false};const flush=()=>new Promise(setImmediate);
test('all read paths distinguish the same successful read from retained content after one failed refresh',async()=>{
 const c=await setup();setupPin(c);
 for(const i of ['main','queue','activity','secondary'])verifyEntry(c,i,false);
 assert.equal(c.reads(),1);c.poll(offline);await flush();
 const sourceNotice=sourceCard(c).children.find(x=>x.className==='snapshot-warning');
 assert.equal(sourceNotice.hidden,false);assert.match(c.get('read-time').textContent,/上次成功读取/);
 for(const i of ['main','queue','activity','secondary'])verifyEntry(c,i,true);
 assert.equal(c.reads(),2);c.poll(response());await flush();
 assert.equal(sourceCard(c).children.find(x=>x.className==='snapshot-warning').hidden,true);
 for(const i of ['main','queue','activity','secondary'])verifyEntry(c,i,false);
 assert.equal(c.reads(),3);
});
test('a second PA detail already open shows that same warning if an in-flight read fails',async()=>{
 const c=await setup(),read=pending();c.poll(read.result);const trigger=getEntry(c,'secondary');trigger.listeners.click();
 assert.equal(warning(c).hidden,true);read.release(offline);await flush();
 assert.equal(warning(c).hidden,false);assert.match(text(detail(c)),/EXACT PAPERBACK DETAIL/);assert.equal(c.reads(),2);
 c.get('detail-close').listeners.click();assert.equal(warning(c).hidden,true);
});
