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

const item=(source_id,task_name)=>({state:'available',source_id,project_id:'demo',task_id:'t',run_id:'r',branch_id:'main',task_name,source_status:'running',summary:'普通进展预览',blocker:'等待最终批注'});
const data={state:'connected',items:[item('zot-main','主任务')],sources:[{state:'connected',source_id:'spark-main',display_name:'Spark',items:[item('spark-main','次要任务')]}]};
const descendants=node=>[node,...(node.children||[]).flatMap(descendants)];
test('compact CSS hides only the explicit task preview paragraph',()=>{
 assert.match(source,/\.compact \.task>\.task-preview-summary\{display:none\}/);
 assert.doesNotMatch(source,/\.compact \.task\s*>?\s*p\s*\{display:none/);
});
test('the shipped primary and secondary cards mark their previews and preserve expanded text',async()=>{
 const c=fixture(async()=>({status:200,ok:true,json:async()=>data}));await c.load();
 const primary=c.get('items').children[0],secondary=descendants(c.get('canvas')).find(n=>n.className==='task');
 for(const card of [primary,secondary]){
  const preview=card.children.find(n=>n.textContent==='普通进展预览');
  assert.equal(preview?.className,'task-preview-summary');

 }
 const detail=descendants(primary).find(n=>n.className==='full-summary');assert.equal(detail?.textContent,'普通进展预览');
});
