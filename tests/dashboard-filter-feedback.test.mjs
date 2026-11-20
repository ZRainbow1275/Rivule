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
  document.getElementById('task-filter').value='all';
  return { get: document.getElementById, load: () => window.listeners.pageshow(), pageshow: event=>window.listeners.pageshow(event), hide: () => window.listeners.pagehide(), visible: value=>{document.hidden=!value;document.listeners.visibilitychange();} };
}






const items=[{state:'available',task_name:'Alpha',source_status:'running'},{state:'available',task_name:'Beta',source_status:'completed'},{state:'available',task_name:'Alpha archived',source_status:'completed'}];
const setup=async(rows=items,state='connected')=>{let reads=0;const c=clientFixture(async()=>{reads++;return {status:200,ok:true,json:async()=>({items:rows,state})};},undefined,{setTimeout:()=>1,clearTimeout(){}});await c.load();return {...c,reads:()=>reads};};
const resetLabel='清除筛选，查看全部已选任务';
const taskNames=c=>c.get('items').children.filter(n=>n.className==='task').map(n=>n.children[1].textContent);
const filter=(c,query,state)=>{c.get('task-search').value=query;c.get('task-filter').value=state;c.get('task-search').listeners.input();};
test('partial results show their true scope and clear the two filters with keyboard focus intact',async()=>{
 const c=await setup(),wrap=c.get('task-filter-feedback'),count=c.get('task-match-count'),clear=c.get('task-clear-partial');
 assert.equal(wrap.hidden,true);filter(c,'Alpha','running');
 assert.equal(wrap.hidden,false);assert.equal(count.textContent,'显示 1 / 3 项');assert.equal(clear.hidden,false);assert.deepEqual(taskNames(c),['Alpha']);
 clear.listeners.click();assert.deepEqual(taskNames(c),['Alpha','Beta','Alpha archived']);assert.equal(c.get('task-search').focused,true);assert.equal(wrap.hidden,true);assert.equal(c.reads(),1);
});
test('zero matches show the scoped count and retain only the existing clear action',async()=>{
 const c=await setup();filter(c,'no match','all');assert.equal(c.get('task-match-count').textContent,'显示 0 / 3 项');assert.equal(c.get('task-clear-partial').hidden,true);
 const reset=c.get('items').children.filter(n=>n.textContent===resetLabel);assert.equal(reset.length,1);
 reset[0].listeners.click();assert.equal(c.get('task-filter-feedback').hidden,true);assert.equal(c.get('task-search').focused,true);assert.equal(c.reads(),1);
});
test('unfiltered, single task, no task, and unavailable views do not offer a filter count',async()=>{
 for(const [rows,state] of [[items,'connected'],[[items[0]],'connected'],[[],'connected'],[[],'unconfigured']]){const c=await setup(rows,state);assert.equal(c.get('task-filter-feedback').hidden,true);assert.equal(c.get('task-match-count').textContent,'');}
});
