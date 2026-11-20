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
const stamp='2026-11-20T12:00:00Z';
const fixture={state:'available',source_id:'zot-main',project_id:'p',project_name:'Press',task_id:'proof',task_name:'Proof',run_id:'r',source_status:'running',pending_action_count:0,last_confirmed_at:stamp,observed_at:stamp,stale:false};
const event={kind:'progress',received_at:stamp,source_status:'running',projection_applied:true,delivery:['not_recorded']};
const branch=(i,name)=>({...fixture,branch_id:String(i),branch_name:name,summary:name+' snapshot',activity:{state:'available',items:[{...event,summary:name+' event'}]}});
const complete=[branch(1,'Hardcover'),branch(2,'Paperback'),branch(3,'Audio'),branch(4,'Mobile'),branch(5,'Web')];
const nextScope=[{...branch(11,'Atlas'),task_name:'Atlas',task_id:'atlas'},{...branch(12,'Index'),task_name:'Index',task_id:'index'}];
const knownSource={state:'connected',source_id:'alternate',provider:'test',display_name:'Alternate',items:[]};
async function setup(){
 let reads=0,response=complete,timerId=0;const timers=new Map();
 const s=clientFixture(async(path,options)=>{
   reads++;assert.equal(path,'/dashboard/data');assert.equal(options.method,undefined);
   if(typeof response==='number')return {status:response};
   return {status:200,ok:true,json:async()=>({state:'connected',sources:[knownSource],items:response})};
 },{getItem:()=>null,setItem(){assert.fail('workbench read continuity must not persist data');}},{setTimeout(f,ms){timers.set(++timerId,{f,ms});return timerId;},clearTimeout(id){timers.delete(id);}});
 await s.load();
 return {...s,reads:()=>reads,async apply(value,via='poll'){
   response=value;
   if(via==='poll'){const timer=[...timers.values()].find(t=>t.ms>=30000&&t.ms<=300000);assert.ok(timer);timer.f();await new Promise(setImmediate);}
   else await s.load();
 }};
}
const flat=n=>[n,...n.children.flatMap(flat)];
const byText=(n,value)=>flat(n).find(x=>x.textContent===value);
const byClass=(n,value)=>flat(n).find(x=>x.className?.split(' ').includes(value));
const dump=n=>flat(n).map(x=>x.textContent).filter(Boolean).join(' | ');
const cards=s=>s.get('items').children.filter(n=>n.className==='task');
const q=s=>s.get('reading-queue-list').children;
const detail=s=>s.get('detail-content');
const log=s=>s.get('activity-list').children;
const close=s=>s.get('detail-close').listeners.click();
const filter=(s,name,value)=>{const c=s.get(name);c.value=value;c.listeners[name.endsWith('search')?'input':'change']();};

test('task workbench continuity: locate and pin, compare after a partial read, inspect exact logs, then recover after scope change',async()=>{
 const s=await setup();assert.equal(cards(s).length,5);assert.equal(s.reads(),1);
 for(const c of cards(s))byClass(c,'reading-pin').listeners.click();
 assert.equal(q(s).length,5);assert.equal(q(s).filter(r=>!r.hidden).length,4);
 filter(s,'task-search','Hardcover');filter(s,'task-filter','running');
 assert.equal(cards(s).length,1);assert.match(dump(cards(s)[0]),/Hardcover/);
 s.get('view-activity').listeners.click();filter(s,'activity-search','Hardcover');
 assert.equal(log(s).length,1);const hardLog=byText(log(s)[0],'查看日志');hardLog.listeners.click();
 assert.match(dump(detail(s)),/Hardcover event/);assert.doesNotMatch(dump(detail(s)),/Paperback event/);close(s);
 assert.equal(s.document.activeElement,hardLog);
 s.get('view-tasks').listeners.click();
 const partial=[{...complete[0],activity:{state:'unavailable'}},{...complete[1],source_status:'needs_input',pending_action_count:2},complete[2],{...complete[3],state:'withheld',summary:undefined,activity:undefined},complete[4]];
 await s.apply(partial);
 assert.match(s.get('status').textContent,/部分工作信息读取失败/);
 assert.equal(s.get('task-search').value,'Hardcover');assert.equal(s.get('task-filter').value,'running');
 assert.equal(cards(s).length,1);assert.equal(q(s).length,4);assert.doesNotMatch(dump(s.get('reading-queue-list')),/Mobile/);
 const changed=s.get('task-changes-list');assert.match(dump(changed),/Paperback.*进行中 → 待决定.*待确认：0 → 2/);
 assert.doesNotMatch(dump(changed),/Mobile|Hardcover/);
 const queuedPaperback=q(s)[1].children[0];queuedPaperback.listeners.click();
 assert.match(dump(detail(s)),/Paperback snapshot.*Paperback event/);assert.doesNotMatch(dump(detail(s)),/Hardcover event/);close(s);
 assert.equal(s.document.activeElement,queuedPaperback);
 s.get('view-activity').listeners.click();
 assert.equal(s.get('activity-search').value,'Hardcover');assert.equal(log(s).length,1);
 byText(log(s)[0],'查看日志').listeners.click();assert.match(dump(detail(s)),/日志暂不可用/);assert.doesNotMatch(dump(detail(s)),/Hardcover event|0 条/);close(s);
 await s.apply(409);
 assert.equal(q(s).length,0);assert.equal(changed.children.length,0);assert.equal(detail(s).children.length,0);
 assert.equal(s.get('activity-search').value,'');assert.match(dump(s.get('activity-list')),/任务范围已变化/);
 assert.equal(s.get('capabilities-view').hidden,false);assert.equal(s.reads(),3);
 assert.doesNotMatch(dump(s.get('items')),/Hardcover|Paperback/);
 await s.apply(nextScope,'existing read');s.get('view-tasks').listeners.click();
 assert.equal(cards(s).length,2,'previous task search/status must not hide new-scope tasks');
 assert.equal(s.get('task-filter').value,'all');assert.equal(s.get('task-search').value,'');
 assert.match(dump(s.get('items')),/Atlas.*Index/);assert.doesNotMatch(dump(s.get('items')),/Hardcover|Paperback/);
 assert.equal(changed.children.length,0);assert.equal(q(s).length,0);assert.equal(s.reads(),4);
});
test('a verification interruption clears task search and status without requiring another request to clean the view',async()=>{
 const s=await setup();filter(s,'task-search','Hardcover');filter(s,'task-filter','running');
 await s.apply(401);
 assert.equal(s.get('login').hidden,false);assert.equal(s.get('task-search').value,'');assert.equal(s.get('task-filter').value,'all');
 assert.equal(cards(s).length,0);assert.equal(q(s).length,0);assert.equal(detail(s).children.length,0);assert.equal(s.reads(),2);
});
