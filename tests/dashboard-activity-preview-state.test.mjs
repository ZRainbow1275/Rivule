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

const task={state:'available',source_id:'zot-main',task_name:'Print proof',source_status:'running',last_confirmed_at:'2026-11-19T10:00:00Z'};
const setup=async activity=>{let reads=0;const c=fixture(async path=>{assert.equal(path,'/dashboard/data');reads++;return {status:200,ok:true,json:async()=>({state:'connected',items:[{...task,activity}]})};});await c.load();c.get('view-activity').listeners.click();return {...c,reads:()=>reads};};
const text=c=>JSON.stringify(c.get('activity-list').children);
for(const [name,activity] of [['absent',undefined],['unavailable',{state:'unavailable',items:[]}],['failed response with previous preview',{state:'unavailable',items:[{summary:'Previous summary'}]}],['unknown state',{state:'future',items:[]}]])test('activity preview does not imply a successful empty log: '+name,async()=>{
 const c=await setup(activity);assert.match(text(c),/日志暂不可用/);assert.doesNotMatch(text(c),/尚无可展示的最新事件|Previous summary|0 条可展示事件/);assert.equal(c.reads(),1);
});
test('authorized empty and populated log previews keep their own states',async()=>{
 const a=await setup({state:'available',items:[]}),b=await setup({state:'available',items:[{summary:'New summary'}]});
 assert.match(text(a),/尚无可展示的最新事件/);assert.match(text(a),/0 条可展示事件/);assert.match(text(b),/New summary/);assert.match(text(b),/1 条可展示事件/);
 assert.equal(a.reads(),1);assert.equal(b.reads(),1);
});
