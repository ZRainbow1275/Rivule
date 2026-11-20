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
    constructor(tag = '') { this.tag=tag; this.scrollTop=0; this.parent=null; this.textContent = ''; this.hidden = false; this.children = []; this.listeners = {}; this.attributes = {}; this.classList = { toggle() {} }; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    replaceChildren(...children) { this.repaints=(this.repaints||0)+1; if(this.children.some(n=>contains(n,document.activeElement)))document.activeElement=document.body; this.children = children; }
    append(...children) { this.children.push(...children); }
    insertBefore(child) { child.parent=this;this.children.push(child); }
    remove() { this.removed=true;if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this); }
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
const item=(source,i)=>({state:'available',source_id:source,project_id:'p',task_id:'task'+i,task_name:'Proof '+i,project_name:'Press',run_id:'r',branch_id:'branch',branch_name:'Release',source_status:'running',pending_action_count:0,summary:'Synthetic body '+i});
const fixtureSource=(id,count=20)=>({source_id:id,state:'connected',display_name:id.toUpperCase(),items:Array.from({length:count},(_,i)=>item(id,i+1))});
async function setup(initial=[fixtureSource('alpha'),fixtureSource('beta')]){
 let reads=0,payload=initial,n=0;const timers=new Map();
 const c=clientFixture(async(path,opts)=>{
  reads++;assert.equal(path,'/dashboard/data');assert.equal(opts.method,undefined);
  if(payload==='invalidate')return {status:409};
  return {status:200,ok:true,json:async()=>({state:'connected',items:[],sources:payload})};
 },{getItem:()=>null,setItem(){assert.fail('scroll recovery must not persist state');}},{setTimeout(f,ms){timers.set(++n,{f,ms});return n;},clearTimeout(id){timers.delete(id);}});
 await c.load();return {...c,reads:()=>reads,async poll(value){
  payload=value;const timer=[...timers.values()].find(t=>t.ms>=30000&&t.ms<=300000);assert.ok(timer);timer.f();await new Promise(setImmediate);
 },async read(value){payload=value;await c.load();}};
}
const all=(e,p)=>[...(p(e)?[e]:[]),...e.children.flatMap(x=>all(x,p))];
const column=(c,id)=>c.get('canvas').children.find(n=>all(n,x=>x.className==='provider'&&x.textContent===id).length);
const body=node=>node.children.find(x=>x.className==='card-body');
const detail=(node,which)=>all(body(node),x=>x.textContent==='工作详情与日志')[which];
const offset=(c,id)=>[column(c,id).scrollTop,body(column(c,id)).scrollTop];
test('accepted refresh preserves each secondary source reading position for both possible scroll containers',async()=>{
 const c=await setup(),a=column(c,'alpha'),b=column(c,'beta');
 // Compact/short may scroll the card; desktop scrolls its body.
 a.scrollTop=720;body(b).scrollTop=910;
 await c.poll([fixtureSource('beta'),fixtureSource('alpha')]);
 assert.notEqual(column(c,'alpha'),a);assert.notEqual(column(c,'beta'),b);
 assert.deepEqual(offset(c,'alpha'),[720,0],'a different card instance must not reset the reader to the top');
 assert.deepEqual(offset(c,'beta'),[0,910]);assert.equal(c.reads(),2);
});
test('focus continues to exact secondary branch and independent sources do not inherit another source offset',async()=>{
 const c=await setup();const b=column(c,'beta');b.scrollTop=190;body(b).scrollTop=620;
 const before=detail(b,6);before.focus();
 const updated=[fixtureSource('beta'),fixtureSource('new')];
 updated[0].items[6]={...updated[0].items[6],summary:'Updated seventh body'};
 await c.poll(updated);
 assert.equal(c.document.activeElement,detail(column(c,'beta'),6));assert.notEqual(c.document.activeElement,before);
 assert.deepEqual(offset(c,'beta'),[190,620]);assert.deepEqual(offset(c,'new'),[0,0]);
 c.document.activeElement.listeners.click();assert.match(JSON.stringify(c.get('detail-content').children),/Updated seventh body/);
 assert.equal(c.reads(),2);
});
test('scope invalidation and actual tab departure discard old positions, even if the same sources reappear',async()=>{
 const c=await setup();column(c,'alpha').scrollTop=250;body(column(c,'alpha')).scrollTop=480;
 await c.poll('invalidate');assert.deepEqual(offset(c,'alpha'),[0,0]);
 await c.read([fixtureSource('alpha'),fixtureSource('beta')]);assert.deepEqual(offset(c,'alpha'),[0,0]);
 body(column(c,'beta')).scrollTop=610;c.hide();assert.equal(c.get('canvas').children.length,0);
 await c.read([fixtureSource('alpha'),fixtureSource('beta')]);assert.deepEqual(offset(c,'beta'),[0,0]);assert.equal(c.reads(),4);
});
