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

const first={state:'available',source_status:'running',source_id:'zot-main',project_id:'internal-project',project_name:'Print edition',run_id:'internal-run',task_id:'internal-task',task_name:'Review proof',branch_id:'internal-main',branch_name:'Hardcover',last_confirmed_at:'2026-11-19T10:00:00Z',activity:{state:'available',items:[{summary:'Hardcover sent'}]}};
const setup=async items=>{let reads=0;const c=fixture(async()=>{reads++;return {status:200,ok:true,json:async()=>({state:'connected',items})};});await c.load();c.get('view-activity').listeners.click();return {...c,reads:()=>reads};};
test('same-title activity rows and log buttons identify their reported branches',async()=>{
 const other={...first,branch_id:'internal-alt',branch_name:'Paperback',activity:{state:'available',items:[{summary:'Paperback proof arrived'}]}};
 const c=await setup([first,other]),rows=c.get('activity-list').children;
 assert.deepEqual(rows.map(r=>r.children[2].textContent),['进行中 · Print edition · 分支：Hardcover','进行中 · Print edition · 分支：Paperback']);
 const buttons=rows.map(r=>r.children.at(-1));assert.deepEqual(buttons.map(b=>b.textContent),['查看日志','查看日志']);
 assert.deepEqual(buttons.map(b=>b.attributes['aria-label']),['查看日志：Review proof · Print edition · 分支：Hardcover','查看日志：Review proof · Print edition · 分支：Paperback']);
 buttons[1].listeners.click();assert.equal(c.get('detail-title').textContent,'Review proof · Print edition · 分支：Paperback');assert.match(JSON.stringify(c.get('detail-content').children),/Paperback proof arrived/);assert.doesNotMatch(JSON.stringify(c.get('detail-content').children),/Hardcover sent/);
 c.get('detail-close').listeners.click();assert.equal(buttons[1].focused,true);assert.equal(c.reads(),1);
});
test('an unreported branch and project never become internal identifiers in activity',async()=>{
 const c=await setup([{...first,branch_name:undefined,project_name:undefined}]),row=c.get('activity-list').children[0],button=row.children.at(-1);
 assert.equal(row.children[2].textContent,'进行中');assert.equal(button.attributes['aria-label'],'查看日志：Review proof');
 button.listeners.click();assert.equal(c.get('detail-title').textContent,'Review proof');assert.equal(c.reads(),1);
});
