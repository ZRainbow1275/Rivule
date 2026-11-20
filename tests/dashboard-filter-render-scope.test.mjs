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
    replaceChildren(...children) { this.repaints=(this.repaints||0)+1; if(this.children.some(n=>contains(n,document.activeElement)))document.activeElement=document.body; this.children = children; }
    append(...children) { this.children.push(...children); }
    insertBefore(child) { this.children.push(child); }
    remove() { this.removed=true; }
    setAttribute(key, value) { this.attributes[key] = value; }
    focus() { this.focused=true;document.activeElement=this; }
    showModal() { this.open=true;this.opens=(this.opens||0)+1; }
    close() { this.open=false; }
  }
  const contains=(node,target)=>node===target||(node.children||[]).some(n=>contains(n,target));
  let created=0;const elements = new Map(), window = new Element(), document = new Element();
  document.getElementById = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  document.createElement = tag => {created++;return new Element(tag);}; document.createElementNS = () => new Element(); document.body = new Element();
  vm.runInNewContext('(' + dashboardClient.toString() + ')()', { selectedWorkbench, document, window, fetch, Date, crypto, localStorage: storage, AbortController, setTimeout, clearTimeout, ...timers });
  document.getElementById('login').hidden=true;
  return { document,created:()=>created,get: document.getElementById, load: () => window.listeners.pageshow(), pageshow: event=>window.listeners.pageshow(event), hide: () => window.listeners.pagehide(), visible: value=>{document.hidden=!value;document.listeners.visibilitychange();} };
}
const observed='2026-11-20T12:00:00Z';
const item=i=>({state:'available',source_id:'zot-main',project_id:'press',project_name:'Press',task_id:'issue',task_name:'Proof',run_id:'run',branch_id:String(i),branch_name:'版次 '+String(i).padStart(2,'0'),source_status:i%2?'running':'completed',pending_action_count:0,last_confirmed_at:observed,observed_at:observed,summary:'Summary '+i,stale:false,activity:{state:'available',items:[{received_at:observed,kind:'progress',summary:'Event '+i}]}}); 
const starting=Array.from({length:20},(_,i)=>item(i+1));
async function setup(initial=starting){
 let reads=0,payload=initial,n=0;const timers=new Map();
 const s=clientFixture(async(path,options)=>{
   reads++;assert.equal(path,'/dashboard/data');assert.equal(options.method,undefined);
   return {status:200,ok:true,json:async()=>({state:'connected',items:payload})};
 },{getItem:()=>null,setItem(){assert.fail('local filtering must not write storage');}},{setTimeout(f,ms){timers.set(++n,{f,ms});return n;},clearTimeout(id){timers.delete(id);}});
 await s.load();
 return {...s,reads:()=>reads,async refresh(value){payload=value;
   const timer=[...timers.values()].find(t=>t.ms>=30000&&t.ms<=300000);assert.ok(timer);timer.f();await new Promise(setImmediate);
 }};
}
const cards=s=>s.get('items').children.filter(x=>x.tag==='article');
const pin=(s,i)=>cards(s)[i].children.find(x=>x.className?.includes('reading-pin'));
const queue=s=>s.get('reading-queue-list');
const activities=s=>s.get('activity-list');
const search=(s,value)=>{const field=s.get('task-search');field.value=value;field.focus();field.listeners.input();};
const changeFilter=(s,value)=>{const field=s.get('task-filter');field.value=value;field.focus();field.listeners.change();};
const text=node=>[node.textContent,...node.children.map(text)].filter(Boolean).join(' | ');
test('filtering task cards leaves independent queue and activity DOM untouched on a full 20-task snapshot',async()=>{
 const s=await setup();for(const i of [0,2,4,6,8,10])pin(s,i).listeners.click();
 s.get('reading-queue-toggle').listeners.click();assert.equal(queue(s).children.filter(x=>!x.hidden).length,6);
 const qRef=queue(s).children[0],activityRef=activities(s).children[0],qBefore=queue(s).repaints,aBefore=activities(s).repaints;
 const markupBefore=s.created();
 for(const query of ['版','版次','版次 ','版次 0','版次 01','版次 01X'])search(s,query);
 assert.equal(cards(s).length,0);assert.equal(s.document.activeElement,s.get('task-search'));
 if(process.env.RIVULE_REPAINT_METRICS==='1')console.log(JSON.stringify({repaints:{queue:queue(s).repaints-qBefore,activity:activities(s).repaints-aBefore},constructedElements:s.created()-markupBefore}));
 assert.equal(queue(s).repaints,qBefore);assert.equal(activities(s).repaints,aBefore);
 assert.equal(queue(s).children[0],qRef);assert.equal(activities(s).children[0],activityRef);
 assert.equal(queue(s).children.filter(x=>!x.hidden).length,6);
 s.get('items').children.find(x=>x.tag==='button').listeners.click();
 assert.equal(cards(s).length,20);assert.equal(pin(s,0).attributes['aria-pressed'],'true');assert.equal(s.document.activeElement,s.get('task-search'));
 changeFilter(s,'running');assert.equal(cards(s).length,10);
 s.get('quick-completed').listeners.click();assert.equal(cards(s).length,10);assert.equal(s.document.activeElement,s.get('task-filter'));
 assert.equal(queue(s).repaints,qBefore);assert.equal(activities(s).repaints,aBefore);assert.equal(s.reads(),1);
});
test('the next accepted partial snapshot still repaints queue and logs independently of task filters',async()=>{
 const s=await setup();pin(s,0).listeners.click();pin(s,2).listeners.click();
 search(s,'版次 03');assert.equal(cards(s).length,1);assert.match(text(s.get('items')),/Summary 3/);
 s.get('view-activity').listeners.click();s.get('activity-search').value='版次 03';s.get('activity-search').listeners.input();
 const old=activities(s).children[0],trigger=old.children.find(x=>x.textContent==='查看日志');trigger.focus();
 const rows=starting.map((x,i)=>i===0?{...x,state:'withheld',activity:undefined,summary:undefined}:i===2?{...x,activity:{state:'available',items:[{summary:'Updated branch event'}]}}:x);
 await s.refresh(rows);
 assert.equal(activities(s).children.length,1);assert.notEqual(activities(s).children[0],old);
 assert.match(text(activities(s)),/Updated branch event/);
 assert.equal(s.document.activeElement,activities(s).children[0].children.find(x=>x.textContent==='查看日志'));
 assert.equal(queue(s).children.length,1);assert.match(text(queue(s)),/版次 03/);assert.doesNotMatch(text(queue(s)),/版次 01/);
 assert.equal(s.get('task-search').value,'版次 03');assert.equal(s.get('activity-search').value,'版次 03');assert.equal(s.reads(),2);
});
