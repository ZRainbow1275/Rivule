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







const base={state:'available',source_id:'zot-main',project_id:'printing',run_id:'run',source_status:'running'};
const events={...base,task_id:'a',project_name:'Café Print',task_name:'Review proof',branch_id:'hard',branch_name:'Hardcover',last_confirmed_at:'2026-11-19T13:00:00Z',activity:{state:'available',items:[{summary:'Inner log phrase'}]}};
const empty={...events,task_id:'b',branch_id:'paper',branch_name:'Paperback',last_confirmed_at:'2026-11-19T12:00:00Z',activity:{state:'available',items:[],truncated:true,withheld_count:30}};
const unavailable={...events,task_id:'c',project_name:'Project B',branch_id:'ebook',branch_name:'Ebook',last_confirmed_at:'2026-11-19T11:00:00Z',activity:{state:'unavailable',items:[]}};
const setup=async(initial=[events,empty,unavailable])=>{let current=initial,reads=0,id=0;const timers=new Map();const c=clientFixture(async(path,options)=>{assert.equal(path,'/dashboard/data');assert.equal(options.method,undefined);reads++;if(current==='logout')return {status:401};return {status:200,ok:true,json:async()=>({state:'connected',items:current})};},undefined,{setTimeout(fn,ms){timers.set(++id,[fn,ms]);return id;},clearTimeout(id){timers.delete(id);}});await c.load();c.get('view-activity').listeners.click();return {...c,reads:()=>reads,async refresh(data){current=data;const poll=[...timers.values()].find(([,ms])=>ms>=30000 && ms<=300000);assert.ok(poll);poll[0]();await new Promise(setImmediate);}};};
const rows=c=>c.get('activity-list').children.filter(n=>n.className==='activity-row');
const branches=c=>rows(c).map(n=>n.children[2].textContent.split('分支：')[1]);
const select=(c,filter)=>{c.get('activity-filter').value=filter;c.get('activity-filter').listeners.change();};
const search=(c,text)=>{c.get('activity-search').value=text;c.get('activity-search').listeners.input();};
test('navigator filters display names and equivalent spellings, never log content',async()=>{
 const c=await setup();assert.equal(c.get('activity-tools').hidden,false);assert.deepEqual(branches(c),['Hardcover','Paperback','Ebook']);
 search(c,'Cafe\u0301');assert.deepEqual(branches(c),['Hardcover','Paperback']);assert.equal(c.get('activity-match-count').textContent,'显示 2 / 3 项');
 search(c,'ＰＡＰＥＲＢＡＣＫ');assert.deepEqual(branches(c),['Paperback']);
 search(c,'Inner log phrase');assert.deepEqual(branches(c),[]);assert.match(c.get('activity-list').children[0].textContent,/没有符合筛选条件/);
 search(c,'printing');assert.deepEqual(branches(c),[]);assert.equal(c.get('activity-match-count').textContent,'显示 0 / 3 项');
 c.get('activity-clear').listeners.click();assert.deepEqual(branches(c),['Hardcover','Paperback','Ebook']);assert.equal(c.document.activeElement,c.get('activity-search'));assert.equal(c.get('activity-clear').disabled,true);assert.equal(c.reads(),1);
});
test('log availability distinguishes visible events, displayable empty, and unreadable',async()=>{
 const c=await setup();
 for(const [state,branch] of [['events','Hardcover'],['empty','Paperback'],['unavailable','Ebook']]){select(c,state);assert.deepEqual(branches(c),[branch]);assert.equal(c.get('activity-match-count').textContent,'显示 1 / 3 项');}
 select(c,'events');search(c,'Paperback');assert.deepEqual(branches(c),[]);assert.equal(c.get('activity-clear').disabled,false);assert.equal(c.reads(),1);
});
test('filtered results open the exact existing log and preserve row focus on close',async()=>{
 const c=await setup();search(c,'hardcover');const button=rows(c)[0].children.at(-1);button.listeners.click();
 assert.match(c.get('detail-title').textContent,/Café Print · 分支：Hardcover/);assert.match(JSON.stringify(c.get('detail-content').children),/Inner log phrase/);
 c.get('detail-close').listeners.click();assert.equal(c.document.activeElement,button);assert.deepEqual(branches(c),['Hardcover']);assert.equal(c.reads(),1);
});
test('refresh preserves an unchanged log target; if log status no longer matches, focus returns to search',async()=>{
 const c=await setup();select(c,'events');const old=rows(c)[0].children.at(-1);old.focus();await c.refresh([events,empty,unavailable]);const newButton=rows(c)[0].children.at(-1);
 assert.notEqual(newButton,old);assert.equal(c.document.activeElement,newButton);
 await c.refresh([{...events,activity:{state:'unavailable',items:[]}},empty,unavailable]);assert.deepEqual(branches(c),[]);assert.equal(c.document.activeElement,c.get('activity-search'));assert.equal(c.reads(),3);
});
test('navigating and changing task filters does not reset activity filters or change task rows',async()=>{
 const c=await setup();search(c,'Ebook');assert.deepEqual(branches(c),['Ebook']);assert.equal(c.get('items').children.length,3);
 c.get('view-tasks').listeners.click();c.get('task-search').value='cannot match';c.get('task-search').listeners.input();
 c.get('view-activity').listeners.click();assert.deepEqual(branches(c),['Ebook']);assert.equal(c.reads(),1);
});
test('empty and logged-out snapshots hide the navigator and clear prior scope values',async()=>{
 const c=await setup([]);assert.equal(c.get('activity-tools').hidden,true);assert.match(c.get('activity-list').children[0].textContent,/还没有已选任务/);
 const selected=await setup();search(selected,'Ebook');select(selected,'unavailable');await selected.refresh('logout');assert.equal(selected.get('activity-tools').hidden,true);
 assert.equal(selected.get('activity-search').value,'');assert.equal(selected.get('activity-filter').value,'all');assert.equal(selected.get('activity-match-count').textContent,'');
});
