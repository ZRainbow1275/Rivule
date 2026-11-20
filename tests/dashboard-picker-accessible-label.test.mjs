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

const task={ref:'private-ref-a',task_name:'Review proof',project_name:'Print edition',branch_name:'Hardcover',state:'available',source_status:'running',selected:false,configured:false};
const other={...task,ref:'private-ref-b',branch_name:'Paperback',selected:true,configured:true};
const setup=async items=>{const calls=[];const c=fixture(async path=>{calls.push(path);
 assert.ok(['/dashboard/task-picker','/dashboard/task-picker/access'].includes(path));
 return {status:200,ok:true,json:async()=>path.endsWith('/access')?{state:'catalog',csrf:'fake',source_id:'zot-main',items,selected_refs:[],selected_count:0,limit:20,next_cursor:null}:{state:'access_required',csrf:'fake',sources:[{source_id:'zot-main',display_name:'Zot'}],expires_at:new Date(Date.now()+60000).toISOString()}};
});await c.get('choose-tasks').listeners.click({currentTarget:c.get('choose-tasks')});await c.get('picker-access').listeners.click();return {c,calls};};
test('same-title picker checkbox names expose their scoped project and branch',async()=>{
 const {c,calls}=await setup([task,other]),controls=c.get('picker-rows').children.map(n=>n.children[0]);
 assert.deepEqual(controls.map(n=>n.attributes['aria-label']),['Review proof · 项目：Print edition · 分支：Hardcover','Review proof · 项目：Print edition · 分支：Paperback · 配置固定选择']);
 assert.equal(controls[0].checked,false);assert.equal(controls[1].checked,true);assert.equal(controls[1].disabled,true);
 assert.deepEqual(calls,['/dashboard/task-picker','/dashboard/task-picker/access']);
});
test('missing picker titles do not fall back to private identifiers',async()=>{
 const {c,calls}=await setup([{...task,task_name:undefined,project_name:undefined,branch_name:undefined}]);
 assert.equal(c.get('picker-rows').children[0].children[0].attributes['aria-label'],'已上报任务');assert.equal(calls.length,2);
});
