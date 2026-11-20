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

const first=c=>c.get('items').children[0]?.textContent;
test('task pane explains progress while waiting and keeps verification guidance after tab switching',async()=>{
 let resolve,reads=0;const c=fixture(()=>{reads++;return new Promise(r=>{resolve=r;});});
 const pending=c.load();c.get('view-tasks').listeners.click();assert.equal(first(c),'正在读取所选任务…');
 resolve({status:401});await pending;assert.equal(first(c),'验证本人后显示任务');
 c.visible(false);c.visible(true);c.get('view-tasks').listeners.click();assert.equal(first(c),'验证本人后显示任务');assert.equal(reads,1);
});
test('changed task scope gives the owner an action in the task pane',async()=>{
 let reads=0;const c=fixture(async()=>{reads++;return {status:409};});await c.load();c.get('view-tasks').listeners.click();
 assert.equal(first(c),'任务范围已变化，请重新选择已上报任务。');assert.equal(c.get('refresh').disabled,false);assert.ok(reads>=1);
});
test('successful empty snapshot replaces transient task text',async()=>{
 const c=fixture(async()=>({ok:true,status:200,json:async()=>({state:'connected',items:[]})}));await c.load();
 assert.equal(first(c),'还没有已选任务');
});
test('failed initial request keeps the existing retry guidance',async()=>{
 const c=fixture(async()=>{throw Error('transport');});await c.load();assert.equal(first(c),'读取失败，请重试。');
});
test('inactive tab does not erase an existing logged-out task prompt',async()=>{
 const c=fixture(async()=>({status:401}));await c.load();assert.equal(first(c),'验证本人后显示任务');
 c.visible(false);c.visible(true);assert.equal(first(c),'验证本人后显示任务');
});
test('expired read shows the task verification prompt instead of a blank pane',async()=>{
 const c=fixture(async()=>({ok:true,status:200,json:async()=>({state:'connected',items:[],session_expires_at:'2020-01-01T00:00:00Z'})}));
 await c.load();assert.equal(first(c),'验证本人后显示任务');
});
