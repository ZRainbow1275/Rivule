import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {ownerDashboardHtml,dashboardClient,selectedWorkbench} from '../src/owner/presentation.mjs';
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



const rows=[{state:'available',task_name:'Alpha',source_status:'running'},{state:'available',task_name:'Beta',source_status:'needs_input'},{state:'available',task_name:'Gamma',source_status:'completed'}];
async function setup(data=rows){let calls=0;const c=clientFixture(async()=>{calls++;return {status:200,ok:true,json:async()=>({state:'ready',items:data})};},undefined,{setTimeout:()=>1,clearTimeout:()=>{}});await c.load();return {...c,calls:()=>calls};}
const names=c=>c.get('items').children.filter(n=>n.className==='task').map(n=>n.children[1].textContent);
for(const [status,expected] of [['running','Alpha'],['attention','Beta'],['completed','Gamma']])test('count shortcut clears obsolete search: '+status,async()=>{const before=JSON.stringify(rows);const c=await setup();c.get('task-search').value='missing';c.get('task-search').listeners.input();c.get('quick-'+status).listeners.click();assert.deepEqual(names(c),[expected]);assert.equal(c.get('task-search').value,'');assert.equal(c.get('task-filter').value,status);assert.equal(c.get('task-filter').focused,true);assert.equal(c.calls(),1);assert.equal(JSON.stringify(rows),before);});
test('ordinary filter changes still combine with search',async()=>{const c=await setup();c.get('task-search').value='Alpha';c.get('task-search').listeners.input();c.get('task-filter').value='running';c.get('task-filter').listeners.change();assert.deepEqual(names(c),['Alpha']);assert.equal(c.get('task-search').value,'Alpha');assert.equal(c.calls(),1);});
test('empty search exposes local reset and returns focus to search',async()=>{const c=await setup();c.get('task-filter').value='running';c.get('task-search').value='Beta';c.get('task-search').listeners.input();assert.deepEqual(names(c),[]);const reset=c.get('items').children.find(n=>n.textContent==='清除筛选，查看全部已选任务');assert.ok(reset);assert.equal(reset.attributes.type,'button');reset.listeners.click();assert.deepEqual(names(c),['Alpha','Beta','Gamma']);assert.equal(c.get('task-filter').value,'all');assert.equal(c.get('task-search').value,'');assert.equal(c.get('task-search').focused,true);assert.equal(c.calls(),1);});
test('no selected tasks does not offer misleading reset',async()=>{const c=await setup([]);assert.equal(c.get('items').children.some(n=>n.textContent==='清除筛选，查看全部已选任务'),false);assert.equal(c.calls(),1);});
