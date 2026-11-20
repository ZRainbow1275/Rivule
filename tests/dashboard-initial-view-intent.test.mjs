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
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    insertBefore(child) { this.children.push(child); }
    remove() { this.removed=true; }
    setAttribute(key, value) { this.attributes[key] = value; }
    focus() { const previous=document.activeElement;document.activeElement=this;if(previous!==this)previous?.listeners.focusout?.({relatedTarget:this}); }
    showModal() { this.open=true; }
    close() { this.open=false; }
  }
  const elements = new Map(), window = new Element(), document = new Element();
  document.getElementById = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  document.createElement = () => new Element(); document.createElementNS = () => new Element(); document.body = new Element();
  vm.runInNewContext('(' + dashboardClient.toString() + ')()', { selectedWorkbench, document, window, fetch, Date, crypto, localStorage: storage, AbortController, setTimeout, clearTimeout, ...timers });
  document.getElementById('login').hidden=true;
  return { document,get: document.getElementById, load: () => window.listeners.pageshow(), pageshow: event=>window.listeners.pageshow(event), hide: () => window.listeners.pagehide(), visible: value=>{document.hidden=!value;document.listeners.visibilitychange();} };
}
const tabs=['tasks','activity','capabilities'];
const snapshot={state:'available',source_id:'zot-main',project_id:'p',project_name:'Press',task_id:'proof',task_name:'Proof',run_id:'r',branch_id:'current',branch_name:'Current',source_status:'running',summary:'Latest proof',last_confirmed_at:'2026-11-20T12:00:00Z',activity:{state:'available',items:[]}};
const setup=(handler=async()=>({status:200,ok:true,json:async()=>({state:'connected',items:[snapshot]})}))=>{
 let reads=0;
 const c=clientFixture((url,options)=>{reads++;assert.equal(url,'/dashboard/data');assert.equal(options.method,undefined);return handler();},{getItem:()=>null,setItem(){assert.fail('workbench navigation must not persist');}},{setTimeout:()=>1,clearTimeout(){}});
 return {...c,reads:()=>reads};
};
const tab=(c,name)=>c.get('view-'+name),panel=(c,name)=>c.get(name+'-view');
const active=(c)=>tabs.filter(name=>tab(c,name).attributes['aria-selected']==='true');
const tabStops=c=>tabs.filter(name=>tab(c,name).tabIndex===0);
const panels=c=>tabs.filter(name=>!panel(c,name).hidden&&panel(c,name).tabIndex===0);
function key(node,value,flags={}){
 let eaten=false;node.listeners.keydown?.({key:value,...flags,preventDefault(){eaten=true;}});
 if(!eaten&&['Enter',' '].includes(value))node.listeners.click?.(); // Native button activation modeled.
 return eaten;
}

const ok=(items,state='connected',sources)=>({status:200,ok:true,json:async()=>({state,items,sources})});
const state=(c,view)=>{
 assert.deepEqual(active(c),[view]);
 assert.deepEqual(panels(c),[view]);
 assert.deepEqual(tabStops(c),[view]);
};
const pending=()=>{let release;const promise=new Promise(r=>{release=r;});return {promise,release};};
test('a late usable result does not undo deliberate keyboard activation of Activity',async()=>{
 const wait=pending(),c=setup(()=>wait.promise),first=c.load();
 tab(c,'capabilities').focus();key(tab(c,'capabilities'),'ArrowLeft');key(tab(c,'activity'),'Enter');
 state(c,'activity');wait.release(ok([snapshot]));await first;state(c,'activity');
 assert.equal(c.document.activeElement,tab(c,'activity'));assert.match(JSON.stringify(c.get('activity-list').children),/Proof/);
 assert.equal(c.reads(),1);
});
for(const [mode,expected] of [['ready',/还没有已选任务/],['error',/任务读取失败/]])test('genuine Tasks click survives initial '+mode+' snapshot and shows its result',async()=>{
 const wait=pending(),c=setup(()=>wait.promise),first=c.load();
 tab(c,'tasks').listeners.click();state(c,'tasks');wait.release(ok([],mode));await first;state(c,'tasks');
 assert.match(c.get('items').children[0].textContent,expected);
 assert.equal(c.document.activeElement,tab(c,'tasks'));assert.equal(c.reads(),1);
});
test('transport failure and a later successful retry both respect the same explicit selection',async()=>{
 let wait=pending();
 const c=setup(()=>wait.promise),first=c.load();tab(c,'activity').listeners.click();
 wait.release({status:503,ok:false});await first;state(c,'activity');
 assert.match(c.get('activity-list').children[0].textContent,/读取失败/);
 wait=pending();const retry=c.load();wait.release(ok([snapshot]));await retry;
 state(c,'activity');assert.equal(c.reads(),2);
});
test('an expired previously read scope still discards intent and uses the normal recovered default',async()=>{
 let response=ok([snapshot]),c=setup(async()=>response);
 await c.load();tab(c,'activity').listeners.click();state(c,'activity');
 // Stop browsing before the simulated scope failure, to check the next entry point.
 c.document.body.focus();response={status:401,ok:false};await c.load();state(c,'capabilities');
 assert.equal(c.get('login').hidden,false);
 response=ok([snapshot]);await c.load();state(c,'tasks');assert.equal(c.reads(),3);
});
