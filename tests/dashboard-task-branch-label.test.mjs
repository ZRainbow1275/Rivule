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
  return { get: document.getElementById, load: () => window.listeners.pageshow(), pageshow: event=>window.listeners.pageshow(event), hide: () => window.listeners.pagehide(), visible: value=>{document.hidden=!value;document.listeners.visibilitychange();} };
}





const fixture=fetch=>clientFixture(fetch,undefined,{setTimeout:()=>1,clearTimeout(){}});

const task={state:'available',source_status:'running',source_id:'zot-main',project_id:'print',project_name:'Book edition',task_id:'proof',task_name:'Review proof',run_id:'one',branch_id:'main',branch_name:'Hardcover'};
const labels=c=>c.get('items').children.map(card=>card.children[3]?.textContent);
const setup=async(items)=>{let reads=0;const c=fixture(async()=>{reads++;return {status:200,ok:true,json:async()=>({state:'connected',items})};});await c.load();return {...c,reads:()=>reads};};
test('same-name selected tasks display distinct reported branches before opening details',async()=>{
 const c=await setup([task,{...task,branch_id:'alt',branch_name:'Paperback'}]);
 assert.deepEqual(labels(c),['Book edition · 分支：Hardcover','Book edition · 分支：Paperback']);
 c.get('task-search').value='Paperback';c.get('task-search').listeners.input();
 assert.deepEqual(labels(c),['Book edition · 分支：Paperback']);assert.equal(c.reads(),1);
});
test('branch labels coexist with snapshot status and do not substitute internal identifiers',async()=>{
 const c=await setup([{...task,stale:true,archived:true},{...task,branch_id:'only-internal-id',branch_name:undefined}]);
 assert.deepEqual(labels(c),['Book edition · 分支：Hardcover · 快照已过期 · 已归档','Book edition']);
});
