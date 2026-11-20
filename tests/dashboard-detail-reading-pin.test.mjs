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

const time='2026-11-20T12:00:00Z',id={state:'available',source_id:'zot-main',project_id:'press',project_name:'Print',task_id:'proof',task_name:'Final proof',run_id:'r',source_status:'running',pending_action_count:0,stale:false,archived:false,last_confirmed_at:time,observed_at:time,activity:{state:'available',items:[]}};
const item=branch_name=>({...id,branch_id:branch_name,branch_name,summary:branch_name+' ordinary snapshot'});
const hard=item('Hardcover'),paper=item('Paperback'),changed={...hard,source_status:'needs_input',pending_action_count:2,summary:'Hardcover asks for cover approval'};
const secondary={...hard,source_id:'second-pa',branch_name:'Foreign',summary:'SECOND PA BODY'};
const secondarySource={source_id:'second-pa',display_name:'Secondary',state:'connected',items:[secondary]};
const ok=items=>({status:200,ok:true,json:async()=>({state:'connected',items,sources:[secondarySource]})});
const pending=()=>{let release;const result=new Promise(r=>release=r);return {result,release};};
const flush=()=>new Promise(setImmediate);
async function setup(initial=[hard,paper]){
 let reads=0,payload=ok(initial),id=0;const timers=new Map();
 const c=clientFixture(async(url,opts)=>{reads++;assert.equal(url,'/dashboard/data');assert.equal(opts.method,undefined);return payload;},
 {getItem:()=>null,setItem(){assert.fail('detail-level pin must not persist data');}},{setTimeout(f,ms){timers.set(++id,{f,ms});return id;},clearTimeout(i){timers.delete(i);}});
 await c.load();return {...c,reads:()=>reads,poll(next){
  payload=next;const t=[...timers.values()].find(t=>t.ms>=30000&&t.ms<=300000);assert.ok(t);t.f();
 },async accept(next){this.poll(next);await flush();}};
}
const all=n=>[n,...n.children.flatMap(all)];
const text=n=>all(n).map(x=>x.textContent).filter(Boolean).join(' | ');
const by=(n,cls)=>all(n).find(x=>x.className?.split(' ').includes(cls));
const label=(n,value)=>all(n).find(x=>x.textContent===value);
const cards=c=>c.get('items').children.filter(n=>n.tag==='article');
const queue=c=>c.get('reading-queue-list').children;
const content=c=>c.get('detail-content'),dialog=c=>c.get('detail-dialog');
const detailPin=c=>by(content(c),'detail-reading-pin'),feedback=c=>by(content(c),'detail-reading-feedback');
const pinCard=(c,i)=>by(cards(c)[i],'reading-pin');
const openCard=(c,i)=>label(cards(c)[i],'打开详情');
const press=button=>{assert.ok(button);button.focus();if(!button.disabled)button.listeners.click();};
const search=(c,value)=>{c.get('task-search').value=value;c.get('task-search').listeners.input();};
const close=c=>c.get('detail-close').listeners.click();
test('pin after reading a filtered-out exact branch, keeping dialog/focus and surviving the next unchanged refresh',async()=>{
 const c=await setup();search(c,'Paperback');await c.accept(ok([changed,paper]));
 const row=c.get('task-changes-list').children[0],opener=row.children[0],rowPin=by(row,'reading-pin');
 press(opener);assert.match(text(content(c)),/Hardcover asks for cover approval/);
 const pin=detailPin(c);assert.ok(pin,'detail needs an explicit existing-queue action');assert.match(pin.attributes['aria-label'],/Hardcover/);
 press(pin);assert.equal(dialog(c).open,true);assert.equal(c.document.activeElement,pin);
 assert.equal(feedback(c).attributes.role,'status');assert.match(feedback(c).textContent,/已暂存.*1 \/ 20/);
 assert.equal(rowPin.attributes['aria-pressed'],'true');assert.equal(pin.attributes['aria-pressed'],'true');
 assert.equal(queue(c).length,1);assert.match(text(queue(c)[0]),/Hardcover/);assert.equal(c.get('task-search').value,'Paperback');
 close(c);assert.equal(c.document.activeElement,opener);
 await c.accept(ok([changed,paper]));assert.match(c.get('task-changes-title').textContent,/已比较字段无变化/);
 assert.equal(queue(c).length,1);press(queue(c)[0].children[0]);assert.match(text(content(c)),/Hardcover asks for cover approval/);
 assert.equal(detailPin(c),undefined,'do not duplicate the remove action when entered from the queue');close(c);assert.equal(c.reads(),3);
});
test('manual remove from task detail reuses the same toggle and does not repaint its dialog',async()=>{
 const c=await setup();press(openCard(c,0));const pin=detailPin(c);assert.ok(pin);press(pin);
 const pressed=()=>[pin.attributes['aria-pressed'],pinCard(c,0).attributes['aria-pressed']];
 assert.deepEqual(pressed(),['true','true']);assert.equal(queue(c).length,1);
 press(pin);assert.deepEqual(pressed(),['false','false']);assert.equal(queue(c).length,0);
 assert.equal(detailPin(c),pin);assert.equal(c.document.activeElement,pin);assert.equal(dialog(c).open,true);
 assert.match(feedback(c).textContent,/已从暂存移除.*0 \/ 20/);close(c);assert.equal(c.reads(),1);
});
test('stale, archived, unavailable, log-only and foreign details do not create a new pin action',async()=>{
 const c=await setup([{...hard,stale:true},{...paper,archived:true},{...item('Unavailable'),state:'unavailable',summary:undefined}]);
 for(let i=0;i<3;i++){press(openCard(c,i));assert.equal(detailPin(c),undefined);close(c);}
 c.get('view-activity').listeners.click();const log=label(c.get('activity-list'),'查看日志');press(log);assert.equal(detailPin(c),undefined);close(c);
 const foreign=label(c.get('canvas'),'工作详情与日志');press(foreign);assert.match(text(content(c)),/SECOND PA BODY/);assert.equal(detailPin(c),undefined);close(c);
 assert.equal(queue(c).length,0);assert.equal(c.reads(),1);
});
test('during a read in flight and after its failure no newly opened detail can pin; 401 invalidates old handlers',async()=>{
 const c=await setup();press(openCard(c,0));const oldPin=detailPin(c);assert.ok(oldPin);close(c);
 const fail=pending();c.poll(fail.result);press(openCard(c,0));assert.equal(detailPin(c),undefined);
 fail.release({status:503,ok:false});await flush();assert.equal(c.get('detail-snapshot-warning').hidden,false);
 oldPin.listeners.click();assert.equal(queue(c).length,0);close(c);
 press(openCard(c,0));assert.equal(detailPin(c),undefined);close(c);
 const gate=pending();c.poll(gate.result);press(openCard(c,0));gate.release({status:401,ok:false});await flush();
 assert.equal(dialog(c).open,false);assert.equal(content(c).children.length,0);oldPin.listeners.click();assert.equal(queue(c).length,0);assert.equal(c.reads(),3);
});
test('the detail action observes capacity and uses the existing queue removal policy',async()=>{
 const c=await setup(Array.from({length:21},(_,i)=>item('Edition '+(i+1))));
 for(let i=0;i<20;i++)press(pinCard(c,i));
 assert.equal(queue(c).length,20);press(openCard(c,20));const extra=detailPin(c);
 assert.ok(extra);assert.equal(extra.disabled,true);assert.equal(extra.attributes['aria-disabled'],'true');
 assert.match(feedback(c).textContent,/已满.*20/);extra.listeners.click();assert.equal(queue(c).length,20);close(c);
 press(openCard(c,19));const existing=detailPin(c);assert.equal(existing.disabled,false);press(existing);
 assert.equal(queue(c).length,19);assert.match(feedback(c).textContent,/已从暂存移除/);assert.equal(c.reads(),1);
});
