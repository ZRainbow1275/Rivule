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
    focus() { const previous=document.activeElement;document.activeElement=this;if(previous!==this)previous?.listeners.focusout?.({relatedTarget:this}); }
    showModal() { this.open=true; }
    close() { this.open=false; }
  }
  const elements = new Map(), window = new Element(), document = new Element();
  document.getElementById = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  document.createElement = () => new Element(); document.createElementNS = () => new Element(); document.body = new Element();
  vm.runInNewContext('(' + dashboardClient.toString() + ')()', { selectedWorkbench, document, window, fetch, Date, crypto, localStorage: storage, AbortController, setTimeout, clearTimeout, ...timers });
  document.getElementById('login').hidden=true;
  return { document,get: document.getElementById, load: () => window.listeners.pageshow(), pageshow: event=>window.listeners.pageshow(event), hide: () => window.listeners.pagehide(), visible: value=>{document.hidden=!value;document.listeners.visibilitychange();} };
}
const tabs=['tasks','activity','capabilities'];
const snapshot={state:'available',source_id:'zot-main',project_id:'p',project_name:'Press',task_id:'proof',task_name:'Proof',run_id:'r',branch_id:'current',branch_name:'Current',source_status:'running',summary:'Latest proof',last_confirmed_at:'2026-11-20T12:00:00Z',activity:{state:'available',items:[]}};
const setup=(handler=async()=>({status:200,ok:true,json:async()=>({state:'connected',items:[snapshot]})}))=>{
 let reads=0;
 const c=clientFixture((url,options)=>{reads++;assert.equal(url,'/dashboard/data');assert.equal(options.method,undefined);return handler();},{getItem:()=>null,setItem(){assert.fail('workbench navigation must not persist');}},{setTimeout:()=>1,clearTimeout(){}});
 return {...c,reads:()=>reads};
};
const tab=(c,name)=>c.get('view-'+name),panel=(c,name)=>c.get(name+'-view');
const active=(c)=>tabs.filter(name=>tab(c,name).attributes['aria-selected']==='true');
const tabStops=c=>tabs.filter(name=>tab(c,name).tabIndex===0);
const panels=c=>tabs.filter(name=>!panel(c,name).hidden&&panel(c,name).tabIndex===0);
function key(node,value,flags={}){
 let eaten=false;node.listeners.keydown?.({key:value,...flags,preventDefault(){eaten=true;}});
 if(!eaten&&['Enter',' '].includes(value))node.listeners.click?.(); // Native button activation modeled.
 return eaten;
}
function realTemplate(){
 const start=source.indexOf('export function ownerDashboardHtml('),end=source.indexOf('export function selectedWorkbench(');
 const fn=source.slice(start,end).replace(/^export /,'');
 const dependencies=Object.fromEntries([...fn.matchAll(/\$\{([\w]+)(?:\(\)|\.toString\(\))\}/g)].map(([,name])=>[name,()=> '']));
 return vm.runInNewContext(fn+';ownerDashboardHtml("offline")',{...dependencies,BRAND_IMAGES:{}}).split('<script')[0];
}
const attrs=tag=>Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,k,v])=>[k,v]));
test('the compiled template has an ordered tablist, one initial tab stop, and a named panel for each view',()=>{
 const html=realTemplate();
 const list=html.match(/<[^>]+class="work-nav"[^>]*>/)[0];assert.equal(attrs(list).role,'tablist');
 const n=html.match(/<[^>]+class="work-nav"[^>]*>(.*?)<p id="primary-snapshot-warning"/s)[1];
 const options=[...n.matchAll(/<button[^>]+>/g)].map(m=>attrs(m[0]));
 assert.deepEqual(options.map(a=>a.id),tabs.map(name=>'view-'+name));
 assert.deepEqual(options.filter(a=>a.tabindex==='0').map(a=>a.id),['view-tasks']);
 for(const a of options){
  assert.equal(a.role,'tab');assert.equal(a['aria-pressed'],undefined);assert.equal(a.type,'button');
  const tag=html.match(new RegExp('<section[^>]+id="'+a['aria-controls']+'"[^>]*>'))[0],p=attrs(tag);
  assert.equal(p.role,'tabpanel');assert.equal(p['aria-labelledby'],a.id);
  assert.equal(p.tabindex,a['aria-selected']==='true'?'0':'-1');
 }
 assert.match(html,/\.work-nav \[role=tab\]:focus-visible,\.card-body>\[role=tabpanel\]:focus-visible\{outline:2px solid currentColor/);
});
test('Arrow/Home/End rove one tab stop without selecting; Enter, Space, and click select the named panel',async()=>{
 const c=setup();await c.load();
 assert.deepEqual(active(c),['tasks']);assert.deepEqual(tabStops(c),['tasks']);assert.deepEqual(panels(c),['tasks']);
 const [tasks,activity,capability]=tabs.map(name=>tab(c,name));
 tasks.focus();assert.equal(key(tasks,'ArrowRight'),true);assert.equal(c.document.activeElement,activity);
 assert.deepEqual(active(c),['tasks']);assert.deepEqual(tabStops(c),['activity']);assert.deepEqual(panels(c),['tasks']);
 assert.equal(key(activity,'ArrowRight',{ctrlKey:true}),false);assert.equal(key(activity,'ArrowDown'),false);assert.equal(key(activity,'Escape'),false);assert.equal(c.document.activeElement,activity);
 assert.equal(key(activity,'End'),true);assert.equal(c.document.activeElement,capability);
 assert.equal(key(capability,'Home'),true);assert.equal(c.document.activeElement,tasks);
 assert.equal(key(tasks,'ArrowLeft'),true);assert.equal(c.document.activeElement,capability);
 key(capability,'Enter');assert.deepEqual(active(c),['capabilities']);assert.deepEqual(panels(c),['capabilities']);
 key(capability,'ArrowLeft');assert.equal(c.document.activeElement,activity);
 key(activity,' ');assert.deepEqual(active(c),['activity']);assert.deepEqual(panels(c),['activity']);assert.deepEqual(tabStops(c),['activity']);
 tasks.listeners.click();assert.equal(c.document.activeElement,tasks);assert.deepEqual(active(c),['tasks']);assert.equal(c.reads(),1);
});
test('leaving an unactivated tab returns the entry stop to the selected tab and reaches the active panel only',async()=>{
 const c=setup();await c.load();
 tab(c,'tasks').focus();key(tab(c,'tasks'),'ArrowRight');
 assert.deepEqual(tabStops(c),['activity']);assert.deepEqual(panels(c),['tasks']);
 assert.deepEqual(tabs.filter(name=>panel(c,name).tabIndex===0),['tasks']);
 assert.equal(key(tab(c,'activity'),'Tab'),false);panel(c,'tasks').focus();
 assert.equal(c.document.activeElement,panel(c,'tasks'));assert.deepEqual(tabStops(c),['tasks']);
 assert.deepEqual(active(c),['tasks']);assert.equal(c.reads(),1);
});
test('an arriving verification gate does not steal focus; only activating a view sets first-read intent',async()=>{
 let once;
 const c=setup(()=>new Promise(r=>{once=r;}));
 const starting=c.load();tab(c,'capabilities').focus();key(tab(c,'capabilities'),'ArrowLeft');
 once({status:401});await starting;
 assert.deepEqual(active(c),['capabilities']);assert.deepEqual(panels(c),['capabilities']);
 assert.equal(c.document.activeElement,tab(c,'activity'));assert.deepEqual(tabStops(c),['activity']);
 panel(c,'capabilities').focus();assert.deepEqual(tabStops(c),['capabilities']);assert.equal(c.reads(),1);
 const second=setup(()=>new Promise(r=>{once=r;})),pending=second.load();
 tab(second,'capabilities').focus();key(tab(second,'capabilities'),'ArrowLeft');key(tab(second,'activity'),'Enter');
 once({status:401});await pending;
 assert.deepEqual(active(second),['activity']);assert.deepEqual(panels(second),['activity']);
 assert.match(second.get('activity-list').children[0].textContent,/验证本人后显示/);assert.equal(second.reads(),1);
});
test('quick task filters keep their direct focus; a log detail still closes on Escape to the same opener',async()=>{
 const c=setup(async()=>({status:200,ok:true,json:async()=>({state:'connected',items:[snapshot,{...snapshot,branch_id:'draft',branch_name:'Draft',source_status:'completed'}]})}));await c.load();
 tab(c,'activity').listeners.click();
 const row=c.get('activity-list').children[0],opener=row.children.find(n=>n.textContent==='查看日志');opener.focus();opener.listeners.click();
 let stopped=false;c.get('detail-dialog').listeners.cancel({preventDefault(){stopped=true;}});
 assert.equal(stopped,true);assert.equal(c.document.activeElement,opener);assert.deepEqual(active(c),['activity']);
 c.get('quick-running').listeners.click();assert.equal(c.document.activeElement,c.get('task-filter'));
 assert.deepEqual(tabStops(c),['tasks']);assert.deepEqual(active(c),['tasks']);assert.equal(c.reads(),1);
});
