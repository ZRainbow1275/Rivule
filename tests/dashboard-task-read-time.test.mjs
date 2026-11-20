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

const row={state:'available',source_id:'zot-main',task_name:'Current task',source_status:'running'};
const message=c=>c.get('read-time').textContent;
for(const [state,copy] of [['unconfigured','任务服务尚未接入'],['error','本次任务读取失败'],['future','任务读取状态待确认']])test('no fresh timestamp on '+state,async()=>{
 const c=fixture(async()=>({status:200,ok:true,json:async()=>({state,items:[]})}));await c.load();assert.equal(message(c),copy);
});
test('last successful snapshot time survives a failed refresh, then clears on logout',async()=>{
 let mode='ready';const c=fixture(async()=>{if(mode==='offline')throw Error('offline');if(mode==='signed-out')return {status:401};return {status:200,ok:true,json:async()=>({state:'connected',items:[row]})};});
 await c.load();const good=message(c);assert.match(good,/\d{4}.*\d{1,2}:\d{2}:\d{2}/);
 mode='offline';await c.load();assert.equal(message(c),'上次成功读取：'+good+' · 本次更新失败');
 mode='signed-out';await c.load();assert.equal(message(c),'尚未读取');
});
test('successful empty selection confirms a read; a later opaque empty response replaces it',async()=>{
 let state='connected';const c=fixture(async()=>({status:200,ok:true,json:async()=>({state,items:[]})}));await c.load();assert.match(message(c),/\d{4}/);
 state='error';await c.load();assert.equal(message(c),'本次任务读取失败');
});

test('an in-flight first read does not advertise a timestamp',async()=>{
 let release;const c=fixture(()=>new Promise(r=>{release=r;}));const pending=c.load();
 assert.equal(message(c),'正在读取任务…');release({status:401});await pending;assert.equal(message(c),'尚未读取');
});
