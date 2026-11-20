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
    replaceChildren(...children) { if(this.children.some(n=>contains(n,document.activeElement)))document.activeElement=document.body; this.children = children; }
    append(...children) { this.children.push(...children); }
    insertBefore(child) { this.children.push(child); }
    remove() { this.removed=true; }
    setAttribute(key, value) { this.attributes[key] = value; }
    focus() { this.focused=true;document.activeElement=this; }
    showModal() { this.open=true; }
    close() { this.open=false; }
  }
  const contains=(node,target)=>node===target||(node.children||[]).some(n=>contains(n,target));
  const elements = new Map(), window = new Element(), document = new Element();
  document.getElementById = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  document.createElement = () => new Element(); document.createElementNS = () => new Element(); document.body = new Element();
  vm.runInNewContext('(' + dashboardClient.toString() + ')()', { selectedWorkbench, document, window, fetch, Date, crypto, localStorage: storage, AbortController, setTimeout, clearTimeout, ...timers });
  document.getElementById('login').hidden=true;
  return { document,get: document.getElementById, load: () => window.listeners.pageshow(), pageshow: event=>window.listeners.pageshow(event), hide: () => window.listeners.pagehide(), visible: value=>{document.hidden=!value;document.listeners.visibilitychange();} };
}







const ok=label=>({status:200,ok:true,json:async()=>({state:'connected',items:[{state:'available',task_name:label}]})});
const mode=async()=>{let reads=0,release,id=0;const timers=new Map();const c=clientFixture(async path=>{reads++;assert.equal(path,'/dashboard/data');if(reads===1)return ok('Currently shown');return new Promise(r=>{release=r;});},undefined,{setTimeout(fn,ms){timers.set(++id,[fn,ms]);return id;},clearTimeout(id){timers.delete(id);}});await c.load();
 return {...c,reads:()=>reads,background(){[...timers.values()].find(([,ms])=>ms===30000)[0]();},async finish(){release(ok('Deferred result'));await new Promise(setImmediate);}};
};
for(const modal of ['detail-dialog','settings','task-picker'])test('completed background refresh stops false loading while '+modal+' is open',async()=>{
 const c=await mode(),previous=c.get('status').textContent;c.background();c.get(modal).showModal();await c.finish();
 assert.equal(c.get(modal).open,true);assert.equal(c.get('refresh').disabled,false);assert.equal(c.get('status').textContent,previous);
 assert.match(JSON.stringify(c.get('items').children),/Currently shown/);assert.doesNotMatch(JSON.stringify(c.get('items').children),/Deferred result/);assert.equal(c.reads(),2);
});
test('manual refresh status resolves to last displayed snapshot when rendering waits for the open dialog',async()=>{
 const c=await mode(),previous=c.get('status').textContent;const pending=c.load();assert.equal(c.get('status').textContent,'正在读取所选任务快照…');
 c.get('settings').showModal();await c.finish();await pending;
 assert.equal(c.get('status').textContent,previous);assert.equal(c.get('refresh').disabled,false);assert.equal(c.reads(),2);
});
