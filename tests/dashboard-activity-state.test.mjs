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
  return { get: document.getElementById, load: () => window.listeners.pageshow(), pageshow: event=>window.listeners.pageshow(event), hide: () => window.listeners.pagehide(), visible: value=>{document.hidden=!value;document.listeners.visibilitychange();} };
}




const ok=(items,state='connected',expires)=>({status:200,ok:true,json:async()=>({items,state,session_expires_at:expires})});
const fixture=fetch=>clientFixture(fetch,undefined,{setTimeout:()=>1,clearTimeout(){}});
const activity=c=>c.get('activity-list').children[0].textContent;
test('activity distinguishes in-flight request from a completed login gate',async()=>{
 let resolve;const c=fixture(()=>new Promise(r=>{resolve=r;}));const pending=c.load();
 c.get('view-activity').listeners.click();assert.equal(activity(c),'正在读取所选任务的动态与日志…');
 resolve({status:401});await pending;c.get('view-activity').listeners.click();
 assert.equal(activity(c),'验证本人后显示动态与日志');assert.equal(c.get('connection').textContent,'等待本人验证');
 c.visible(false);c.visible(true);assert.equal(activity(c),'验证本人后显示动态与日志');
});
test('session expiry replaces the activity prompt with the login gate',async()=>{const c=fixture(async()=>ok([], 'connected', '2020-01-01T00:00:00Z'));await c.load();assert.equal(activity(c),'验证本人后显示动态与日志');});
test('initial transport failure does not masquerade as pending or empty',async()=>{const c=fixture(async()=>{throw Error('network');});await c.load();assert.equal(activity(c),'动态与日志读取失败，请重试。');});
test('changed selection scope gives a recovery action rather than an indefinite wait',async()=>{const c=fixture(async()=>({status:409}));await c.load();assert.equal(activity(c),'任务范围已变化，请重新选择任务后查看动态与日志。');});
for(const [state,expected] of [['connected','还没有已选任务，选择任务后可查看动态与日志。'],['error','任务读取失败'],['unconfigured','尚未连接真实任务服务']])test('empty '+state+' has accurate activity copy',async()=>{const c=fixture(async()=>ok([],state));await c.load();assert.ok(activity(c).startsWith(expected),activity(c));});
test('a selected task without a confirmation time retains its distinct state',async()=>{const c=fixture(async()=>ok([{state:'available',task_name:'Selected'}]));await c.load();assert.equal(activity(c),'暂无确认时间');});
test('activity shows available data, retains it on retry, then clears it on 401',async()=>{
 const snapshot={state:'available',task_name:'Selected snapshot',last_confirmed_at:'2026-11-19T12:00:00Z',activity:{state:'available',items:[{summary:'Latest event'}]}};
 let reads=0;const c=fixture(async()=>{if(++reads===1)return ok([snapshot]);if(reads===2)throw Error('network');return {status:401};});
 await c.load();assert.match(JSON.stringify(c.get('activity-list').children),/Latest event/);
 await c.load();assert.match(JSON.stringify(c.get('activity-list').children),/Latest event/);
 await c.load();assert.equal(activity(c),'验证本人后显示动态与日志');assert.doesNotMatch(JSON.stringify(c.get('activity-list').children),/Latest event/);
});
