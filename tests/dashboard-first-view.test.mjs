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

const snapshot={state:'available',source_id:'zot-main',task_name:'Prior task',source_status:'running'};
for(const view of ['tasks','activity'])test('first login-gated result honors explicit '+view+' navigation',async()=>{
 let release,reads=0;const c=fixture(path=>{assert.equal(path,'/dashboard/data');reads++;return new Promise(r=>{release=r;});});
 const initial=c.load();c.get('view-'+view).listeners.click();assert.equal(c.get(view+'-view').hidden,false);
 release({status:401});await initial;assert.equal(c.get(view+'-view').hidden,false);assert.equal(c.get('view-'+view).attributes['aria-selected'],'true');
 assert.equal(c.get('login').hidden,false);assert.equal(c.get('controls').hidden,true);
 assert.match(c.get(view==='tasks'?'items':'activity-list').children[0].textContent,/验证本人后显示/);assert.equal(reads,1);
});
test('without a first-read view selection logged-out pages still default to capabilities',async()=>{
 const c=fixture(async()=>({status:401}));await c.load();assert.equal(c.get('capabilities-view').hidden,false);
});
test('a previously read session still resets view and removes old tasks following 401',async()=>{
 let reads=0;const c=fixture(async()=>++reads===1?{status:200,ok:true,json:async()=>({state:'connected',items:[snapshot]})}:{status:401});
 await c.load();c.get('view-tasks').listeners.click();await c.load();
 assert.equal(c.get('capabilities-view').hidden,false);assert.equal(c.get('items').children[0].textContent,'验证本人后显示任务');assert.equal(reads,2);
});
