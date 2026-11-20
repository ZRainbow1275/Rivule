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






const original={state:'available',task_name:'Print run',source_id:'zot-main',project_id:'print',task_id:'one',run_id:'r',branch_id:'main',source_status:'needs_input',pending_action_count:1};
const fixture=async(initial=original)=>{let current=initial,reads=0,id=0;const timers=new Map();const c=clientFixture(async(path,options)=>{assert.equal(path,'/dashboard/data');assert.equal(options.method,undefined);reads++;return {status:200,ok:true,json:async()=>({state:'connected',items:[current]})};},undefined,{setTimeout(fn,ms){timers.set(++id,[fn,ms]);return id;},clearTimeout(id){timers.delete(id);}});await c.load();return {...c,reads:()=>reads,async update(snapshot){current=snapshot;const poll=[...timers.values()].find(([,ms])=>ms===30000);assert.ok(poll);poll[0]();await new Promise(setImmediate);}};};
const action=(c,cls)=>c.get('items').children[0].children.find(n=>n.className===cls);
test('a cleared pending-action control falls back to the same task detail on background refresh',async()=>{
 const c=await fixture();const button=action(c,'pending-callout');button.focus();await c.update({...original,pending_action_count:0,source_status:'running'});
 assert.equal(action(c,'pending-callout'),undefined);assert.equal(c.document.activeElement,action(c,'detail-launch'));assert.equal(c.reads(),2);
});
test('an unchanged pending-action control remains the focus target',async()=>{const c=await fixture();const before=action(c,'pending-callout');before.focus();await c.update({...original});assert.notEqual(action(c,'pending-callout'),before);assert.equal(c.document.activeElement,action(c,'pending-callout'));});
test('a different branch never inherits focus from a vanished control',async()=>{const c=await fixture();action(c,'pending-callout').focus();await c.update({...original,branch_id:'other',pending_action_count:0});assert.equal(c.document.activeElement,c.document.body);});
test('focus outside the task cards is not moved by their refresh',async()=>{const c=await fixture();const search=c.get('task-search');search.focus();await c.update({...original,pending_action_count:0});assert.equal(c.document.activeElement,search);});
