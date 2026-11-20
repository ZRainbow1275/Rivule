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





const statuses=c=>c.get('capability-list').children.map(row=>row.children[0].children.at(-1).textContent.replace(/ ›$/,''));
const fixture=handler=>{
 let calls=0;
 const c=clientFixture((path,opts)=>{assert.equal(path,'/dashboard/data');assert.equal(opts.method,undefined);calls++;return handler();}, {getItem:()=>null,setItem(){assert.fail('empty-state presentation must not persist');}}, {setTimeout:()=>1,clearTimeout(){}});
 return {...c,calls:()=>calls};
};
const response=(state,items=[])=>({status:200,ok:true,json:async()=>({state,items})});
const text=(c,id)=>c.get(id).children[0].textContent;
for(const [state,caption,capability,dock,time] of [
 ['connected',/还没有已选任务/,/尚无可读快照/,/尚未配置所选任务/,/^[0-9]/],
 ['error',/任务读取失败/,/读取失败.*数量待确认/,/部分工作信息读取失败/,/本次任务读取失败/],
 ['unconfigured',/尚未连接真实任务服务/,/任务服务未接入/,/部分任务服务尚未接入/,/任务服务尚未接入/],
 [undefined,/任务读取状态待确认/,/任务读取状态待确认/,/数量未知/,/任务读取状态待确认/],
 ['future-unrecognized',/任务读取状态待确认/,/任务读取状态待确认/,/数量未知/,/任务读取状态待确认/]
])test('successful transport keeps the '+state+' task-service outcome consistent across dashboard views',async()=>{
 const c=fixture(async()=>response(state));await c.load();
 c.get('view-tasks').listeners.click();assert.equal(c.get('tasks-view').hidden,false);
 assert.match(text(c,'items'),caption);assert.equal(c.get('item-count').textContent,state==='connected'?'00':'—');
 for(const key of ['running','attention','completed'])assert.equal(c.get(key+'-count').textContent,state==='connected'?'0':'—');
 c.get('view-activity').listeners.click();assert.equal(c.get('activity-view').hidden,false);assert.match(text(c,'activity-list'),caption);
 c.get('view-capabilities').listeners.click();assert.equal(c.get('capabilities-view').hidden,false);assert.match(statuses(c)[1],capability);
 assert.match(c.get('status').textContent,dock);assert.match(c.get('read-time').textContent,time);
 assert.equal(c.get('login').hidden,true);assert.equal(c.get('controls').hidden,false);assert.equal(c.calls(),1);
});
test('a read failure with an empty payload is not retained data and a later proven zero restores the empty state',async()=>{
 let current=response('connected',[{state:'available',task_name:'Old known task',source_id:'zot-main',project_id:'p',task_id:'old',run_id:'r',branch_id:'b',source_status:'running'}]);
 const c=fixture(async()=>current);await c.load();assert.match(JSON.stringify(c.get('items').children),/Old known task/);
 current=response('error');await c.load();assert.doesNotMatch(JSON.stringify(c.get('items').children),/Old known task|还没有已选任务/);
 assert.match(text(c,'items'),/读取失败/);assert.equal(c.get('primary-snapshot-warning').hidden,true);assert.equal(c.get('item-count').textContent,'—');
 current=response('ready');await c.load();assert.match(text(c,'items'),/还没有已选任务/);assert.equal(c.get('item-count').textContent,'00');
 assert.match(text(c,'activity-list'),/还没有已选任务/);assert.equal(c.calls(),3);
});
test('secondary PA cards distinguish known zero from failure and unconfigured sources on the same page',async()=>{
 const c=fixture(async()=>({status:200,ok:true,json:async()=>({state:'connected',items:[],sources:[{source_id:'empty',state:'ready',items:[]},{source_id:'failed',state:'error',items:[]},{source_id:'unbound',state:'unconfigured',items:[]}]})}));
 await c.load();
 const [empty,failed,unbound]=c.get('canvas').children.map(n=>JSON.stringify(n.children));
 assert.match(empty,/所选任务 0/);assert.match(empty,/尚未配置所选任务/);
 assert.match(failed,/所选任务数量待确认/);assert.match(failed,/任务读取失败/);assert.doesNotMatch(failed,/所选任务 0|尚未配置所选任务/);
 assert.match(unbound,/所选任务数量待确认/);assert.match(unbound,/尚未连接真实任务服务/);assert.doesNotMatch(unbound,/所选任务 0|尚未配置所选任务/);
 assert.equal(c.calls(),1);
});
