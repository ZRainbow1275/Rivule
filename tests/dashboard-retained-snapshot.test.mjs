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
    focus() { this.focused=true; }
    showModal() { this.open=true; }
    close() { this.open=false; }
  }
  const elements = new Map(), window = new Element(), document = new Element();
  document.getElementById = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  document.createElement = () => new Element(); document.createElementNS = () => new Element(); document.body = new Element();
  vm.runInNewContext('(' + dashboardClient.toString() + ')()', { selectedWorkbench, document, window, fetch, Date, crypto, localStorage: storage, AbortController, setTimeout, clearTimeout, ...timers });
  document.getElementById('login').hidden=true;
  const warning=document.getElementById('primary-snapshot-warning');
  warning.hidden=true;
  warning.textContent=/<p id="primary-snapshot-warning"[^>]*>([^<]*)<\/p>/.exec(source)?.[1] || '';
  return { get: document.getElementById, load: () => window.listeners.pageshow(), pageshow: event=>window.listeners.pageshow(event), hide: () => window.listeners.pagehide(), visible: value=>{document.hidden=!value;document.listeners.visibilitychange();} };
}





const fixture=fetch=>clientFixture(fetch,undefined,{setTimeout:()=>1,clearTimeout(){}});

const confirmation='2026-11-19T08:00:00Z';
const task={state:'available',task_name:'Last task snapshot',source_id:'zot-main',project_id:'book',task_id:'print',run_id:'one',branch_id:'main',last_confirmed_at:confirmation,activity:{state:'available',items:[{summary:'Last event'}]}};
const ok=items=>({status:200,ok:true,json:async()=>({state:'connected',items})});
test('failed refresh locally labels retained task and activity until recovery',async()=>{
 let mode='ready',reads=0;const c=fixture(async()=>{reads++;if(mode==='fail')throw Error('network');return ok([mode==='recover'?{...task,task_name:'Fresh task'}:task]);});
 await c.load();const warning=c.get('primary-snapshot-warning'),row=c.get('items').children[0];assert.equal(warning.hidden,true);
 mode='fail';await c.load();assert.equal(warning.hidden,false);assert.match(warning.textContent,/上次快照.*更新失败/);assert.equal(c.get('items').children[0],row);
 c.get('view-activity').listeners.click();assert.equal(warning.hidden,false);assert.match(JSON.stringify(c.get('activity-list').children),/Last event/);
 mode='recover';await c.load();assert.equal(warning.hidden,true);assert.match(JSON.stringify(c.get('items').children),/Fresh task/);assert.equal(reads,3);
});
test('first failure does not show a stale-data notice without a prior snapshot',async()=>{
 const c=fixture(async()=>{throw Error('network');});await c.load();assert.equal(c.get('primary-snapshot-warning').hidden,true);assert.doesNotMatch(JSON.stringify(c.get('items').children),/上次快照/);
});
test('after a retained failure, 401 clears both notice and previous data',async()=>{
 let reads=0;const c=fixture(async()=>{switch(++reads){case 1:return ok([task]);case 2:throw Error('network');default:return {status:401};}});
 await c.load();await c.load();assert.equal(c.get('primary-snapshot-warning').hidden,false);await c.load();
 assert.equal(c.get('primary-snapshot-warning').hidden,true);assert.doesNotMatch(JSON.stringify(c.get('items').children),/Last task snapshot/);assert.doesNotMatch(JSON.stringify(c.get('activity-list').children),/Last event/);
});
test('empty successful snapshot remains distinct from a first read failure',async()=>{
 const c=fixture(async()=>ok([]));await c.load();assert.equal(c.get('primary-snapshot-warning').hidden,true);assert.match(JSON.stringify(c.get('items').children),/还没有已选任务/);
});
