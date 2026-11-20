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
const statuses=c=>c.get('capability-list').children.map(row=>row.children[0].children.at(-1).textContent.replace(/ ›$/,''));
const ok=(extra={})=>({status:200,ok:true,json:async()=>({state:'connected',items:[],...extra})});
const gate=['验证本人后查看','验证本人后读取','验证本人后查看'];
test('capability tiles distinguish the active read and a confirmed login gate',async()=>{
 let resolve;const c=fixture(()=>new Promise(r=>{resolve=r;}));const pending=c.load();
 assert.deepEqual(statuses(c).slice(0,3),['核对中','正在读取','核对中']);
 resolve({status:401});await pending;c.get('view-capabilities').listeners.click();
 assert.deepEqual(statuses(c).slice(0,3),gate);
 c.get('capability-list').children[1].children[0].listeners.click({preventDefault(){}});
 assert.equal(c.get('detail-content').children[0].textContent,gate[1]);
 c.visible(false);c.visible(true);assert.deepEqual(statuses(c).slice(0,3),gate);
});
test('past session expiry displays the same login gate',async()=>{const c=fixture(async()=>ok({session_expires_at:'2020-01-01T00:00:00Z'}));await c.load();assert.deepEqual(statuses(c).slice(0,3),gate);});
test('first read failure shows retry rather than a pending or login requirement',async()=>{const c=fixture(async()=>{throw Error('network');});await c.load();assert.equal(statuses(c)[1],'读取失败 · 可重试');assert.equal(statuses(c)[2],'未能确认');});
test('selection scope change explains the next task action',async()=>{const c=fixture(async()=>({status:409}));await c.load();assert.equal(statuses(c)[1],'请重新选择任务');});
test('verified response renders current capability data unchanged',async()=>{const c=fixture(async()=>ok({connection:{qq:{status:'active',scope:'owner_producer_only'}}}));await c.load();assert.equal(statuses(c)[1],'尚无可读快照');assert.match(statuses(c)[2],/^生产端已启用(?: · 来源许可待确认)?$/);assert.equal(statuses(c)[3],'未开放');});
