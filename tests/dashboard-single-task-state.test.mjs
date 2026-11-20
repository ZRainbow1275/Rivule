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

const task={state:'available',source_id:'zot-main',project_id:'sample',task_id:'proof',run_id:'one',branch_id:'main',task_name:'Reviewed proof',source_status:'running',pending_action_count:0};
const setup=async items=>{let reads=0;const c=fixture(async path=>{assert.equal(path,'/dashboard/data');reads++;return {status:200,ok:true,json:async()=>({state:'connected',items})};});await c.load();return {...c,reads:()=>reads};};
const control=(c,kind,index=0)=>c.get('items').children[index].children.find(n=>n.className===kind);
test('a lone source waiting for input remains labeled when no pending objects were reported',async()=>{
 const c=await setup([{...task,source_status:'needs_input'}]);const chip=control(c,'task-state');assert.equal(chip?.attributes['data-kind'],'needs_input');assert.match(chip.textContent,/待决定|等待输入/);
 assert.equal(control(c,'pending-callout'),undefined);control(c,'detail-launch').listeners.click();assert.equal(c.get('detail-dialog').open,true);assert.equal(c.reads(),1);
});
for(const pending_action_count of [0,1])test('a lone failed task stays labeled regardless of pending actions: '+pending_action_count,async()=>{
 const c=await setup([{...task,source_status:'failed',pending_action_count}]);const chip=control(c,'task-state');assert.equal(chip?.attributes['data-kind'],'failed');assert.match(chip.textContent,/遇到问题|失败/);assert.equal(!!control(c,'pending-callout'),pending_action_count>0);assert.equal(c.reads(),1);
});
test('the waiting chip is omitted only when the sole card already has its pending action',async()=>{
 const waiting={...task,source_status:'needs_input',pending_action_count:2};
 const single=await setup([waiting]);assert.equal(control(single,'task-state'),undefined);assert.match(control(single,'pending-callout').textContent,/2 项待确认/);
 const multi=await setup([waiting,{...task,task_id:'other'}]);assert.equal(control(multi,'task-state').attributes['data-kind'],'needs_input');
});
