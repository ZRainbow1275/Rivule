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
  document.getElementById('detail-snapshot-warning').hidden=true;
  return { document,get: document.getElementById, load: () => window.listeners.pageshow(), pageshow: event=>window.listeners.pageshow(event), hide: () => window.listeners.pagehide(), visible: value=>{document.hidden=!value;document.listeners.visibilitychange();} };
}







const row={state:'available',source_id:'zot-main',project_id:'print',task_id:'proof',run_id:'one',branch_id:'main',task_name:'Reviewed proof',summary:'Prior task content',source_status:'running',last_confirmed_at:'2026-11-19T10:00:00Z',activity:{state:'available',items:[{summary:'Prior event'}]}};
const setup=async()=>{let resolve,reads=0,id=0;const slots=new Map();
 const c=clientFixture(async path=>{assert.equal(path,'/dashboard/data');if(++reads===1)return {status:200,ok:true,json:async()=>({state:'connected',items:[row]})};return new Promise(r=>{resolve=r;});},undefined,{setTimeout(fn,ms){slots.set(++id,[fn,ms]);return id;},clearTimeout(id){slots.delete(id);}});
 await c.load();return {...c,reads:()=>reads,begin(){const poll=[...slots.values()].find(([,ms])=>ms===30000);assert.ok(poll);poll[0]();},async fail(){resolve({status:503});await new Promise(setImmediate);}};};
const entry=(c,kind)=>kind==='task'?c.get('items').children[0].children.find(n=>n.className==='detail-launch'):c.get('activity-list').children[0].children.at(-1);
for(const details of ['task','log'])test(details+' dialog keeps keyboard focus and explains a refresh failure that arrives while open',async()=>{
 const c=await setup();if(details==='log')c.get('view-activity').listeners.click();c.begin();const opener=entry(c,details);opener.listeners.click();
 const warning=c.get('detail-snapshot-warning'),before=c.get('detail-content').children;
 assert.equal(warning.hidden,true);assert.equal(c.document.activeElement,c.get('detail-close'));
 await c.fail();assert.equal(warning.hidden,false);assert.equal(c.get('detail-content').children,before);assert.equal(c.document.activeElement,c.get('detail-close'));
 c.get('detail-close').listeners.click();assert.equal(warning.hidden,true);assert.equal(c.document.activeElement,opener);assert.equal(c.reads(),2);
});
test('details opened on an already retained snapshot show warning, and independent capability details do not',async()=>{
 const c=await setup();c.begin();await c.fail();entry(c,'task').listeners.click();const warning=c.get('detail-snapshot-warning');
 assert.equal(warning.hidden,false);c.get('detail-close').listeners.click();
 c.get('view-capabilities').listeners.click();c.get('capability-list').children[0].children[0].listeners.click({preventDefault(){}});assert.equal(warning.hidden,true);assert.equal(c.reads(),2);
});
