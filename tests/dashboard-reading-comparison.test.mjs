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
    constructor(tag = '') { this.tag=tag; this.textContent = ''; this.hidden = false; this.children = []; this.listeners = {}; this.attributes = {}; this.classList = { toggle() {} }; }
    get firstChild() { return this.children[0] || null; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    replaceChildren(...children) { if(this.children.some(n=>contains(n,document.activeElement)))document.activeElement=document.body; this.children = children; }
    append(...children) { this.children.push(...children); }
    insertBefore(child) { this.children.push(child); }
    remove() { this.removed=true; }
    setAttribute(key, value) { this.attributes[key] = value; }
    focus() { this.focused=true;document.activeElement=this; }
    showModal() { this.open=true;this.opens=(this.opens||0)+1; }
    close() { this.open=false; }
  }
  const contains=(node,target)=>node===target||(node.children||[]).some(n=>contains(n,target));
  const elements = new Map(), window = new Element(), document = new Element();
  document.getElementById = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  document.createElement = tag => new Element(tag); document.createElementNS = () => new Element(); document.body = new Element();
  vm.runInNewContext('(' + dashboardClient.toString() + ')()', { selectedWorkbench, document, window, fetch, Date, crypto, localStorage: storage, AbortController, setTimeout, clearTimeout, ...timers });
  document.getElementById('login').hidden=true;
  return { document,get: document.getElementById, load: () => window.listeners.pageshow(), pageshow: event=>window.listeners.pageshow(event), hide: () => window.listeners.pagehide(), visible: value=>{document.hidden=!value;document.listeners.visibilitychange();} };
}
const fixture={state:'available',source_id:'zot-main',project_id:'p',project_name:'Press',task_id:'proof',task_name:'Proof',run_id:'r',source_status:'running',pending_action_count:0,last_confirmed_at:'2026-11-20T12:00:00Z',stale:false};
const task=(branch,summary,over={})=>({...fixture,branch_id:branch,branch_name:branch,summary,...over});
const cover=task('Hardcover','Hardcover proof in review',{progress:{done:3,total:5,unit:'页'}});
const paper=task('Paperback','Paperback needs page count',{source_status:'needs_input',pending_action_count:2,stale:true,last_confirmed_at:'2026-11-20T10:00:00Z'});
const alternate=task('Paperback','Alternate proof',{run_id:'r2',archived:true,source_status:undefined,pending_action_count:undefined,last_confirmed_at:undefined});
async function setup(initial=[cover,paper,alternate]){
 let reads=0,response=initial,timerId=0;const timers=new Map();
 const s=clientFixture(async(path,options)=>{
   reads++;assert.equal(path,'/dashboard/data');assert.equal(options.method,undefined);
   if(response==='fail')throw Error('offline');
   if(response==='logout')return {status:401};
   return {status:200,ok:true,json:async()=>({state:'connected',items:response})};
 },{getItem:()=>null,setItem(){assert.fail('comparison must not persist data');}},{setTimeout(f,ms){timers.set(++timerId,{f,ms});return timerId;},clearTimeout(id){timers.delete(id);}});
 await s.load();
 return {...s,reads:()=>reads,async apply(value,via='poll'){
   response=value;
   if(via==='poll'){const timer=[...timers.values()].find(t=>t.ms>=30000&&t.ms<=300000);assert.ok(timer);timer.f();await new Promise(setImmediate);}
   else await s.load();
 }};
}
const flat=n=>[n,...n.children.flatMap(flat)],dump=n=>flat(n).map(x=>x.textContent).filter(Boolean).join(' | ');
const byClass=(n,cls)=>flat(n).filter(x=>x.className?.split(' ').includes(cls));
const detail=s=>s.get('detail-content'),compare=s=>s.get('reading-queue-compare'),dialog=s=>s.get('detail-dialog');
const cards=s=>s.get('items').children.filter(n=>n.className==='task');
const pin=(s,i)=>byClass(cards(s)[i],'reading-pin')[0];
const queue=s=>s.get('reading-queue-list').children;
const choose=(node,index)=>{node.value=String(index);node.listeners.change();};
const selectors=s=>byClass(detail(s),'compare-select');
const values=(s,label)=>{
 const section=byClass(detail(s),'compare-field').find(x=>x.children[0].textContent===label);
 return byClass(section,'compare-value').map(x=>x.textContent);
};
const open=s=>{assert.equal(compare(s).hidden,false,'comparison must be reachable once two tasks are pinned');compare(s).listeners.click();};
test('compare two same-name branches concurrently without a tab change, extra request, or guess about unknown values',async()=>{
 const s=await setup();pin(s,0).listeners.click();assert.equal(compare(s).hidden,true);
 pin(s,1).listeners.click();pin(s,2).listeners.click();
 assert.equal(compare(s).disabled,false);
 s.get('task-search').value='Hardcover';s.get('task-search').listeners.input();
 assert.equal(cards(s).length,1);
 open(s);const [a,b]=selectors(s);
 assert.equal(s.document.activeElement,a);assert.equal(a.attributes['aria-describedby'],'reading-compare-help');assert.equal(dialog(s).opens,1);assert.equal(s.get('detail-title').textContent,'对照暂存任务');
 assert.deepEqual(a.children.map(o=>o.textContent),['Proof · Press · 分支：Hardcover','Proof · Press · 分支：Paperback · 清单第 2 项','Proof · Press · 分支：Paperback · 清单第 3 项']);
 assert.deepEqual([a.value,b.value],['0','1']);
 assert.deepEqual(values(s,'任务状态'),['进行中','待决定']);assert.deepEqual(values(s,'待确认'),['0 项（来源上报）','2 项（来源上报）']);
 assert.deepEqual(values(s,'来源最近确认'),[cover.last_confirmed_at,paper.last_confirmed_at]);assert.match(dump(detail(s)),/B · 所选任务 · 快照已过期/);
 assert.deepEqual(values(s,'最新进展'),[cover.summary,paper.summary]);assert.match(values(s,'阶段与进度')[0],/3 \/ 5 页/);
 choose(b,2);assert.deepEqual(values(s,'任务状态'),['进行中','状态未上报']);
 assert.deepEqual(values(s,'待确认'),['0 项（来源上报）','数量未上报']);assert.equal(values(s,'来源最近确认')[1],'时间未上报');
 assert.match(dump(detail(s)),/B · 已归档/);assert.doesNotMatch(dump(detail(s)),/Paperback needs page count/);
 assert.equal(s.reads(),1);assert.equal(s.get('task-search').value,'Hardcover');
});
test('choosing an occupied task swaps sides, Escape restores the queue opener, and old controls cannot repaint',async()=>{
 const s=await setup();pin(s,0).listeners.click();pin(s,1).listeners.click();open(s);
 const [a,b]=selectors(s);a.focus();choose(a,1);
 assert.deepEqual([a.value,b.value],['1','0']);assert.equal(s.document.activeElement,a);
 assert.deepEqual(values(s,'最新进展'),[paper.summary,cover.summary]);
 choose(a,'');assert.equal(a.value,'1');
 let cancelled=false;dialog(s).listeners.cancel({preventDefault(){cancelled=true;}});
 assert.equal(cancelled,true);assert.equal(s.document.activeElement,compare(s));assert.equal(dialog(s).open,false);
 assert.equal(detail(s).children.length,0);choose(a,0);assert.equal(detail(s).children.length,0);
 open(s);assert.deepEqual(values(s,'最新进展'),[cover.summary,paper.summary]);assert.equal(s.reads(),1);
});
test('a retained snapshot is labeled, an unavailable item cannot be chosen, and visibility clears the comparison',async()=>{
 const s=await setup();pin(s,0).listeners.click();pin(s,1).listeners.click();pin(s,2).listeners.click();
 await s.apply('fail');open(s);assert.equal(s.get('detail-snapshot-warning').hidden,false);
 s.get('detail-close').listeners.click();
 await s.apply([cover,{...paper,state:'withheld'},alternate]);open(s);const [a]=selectors(s);
 assert.equal(a.children.length,2);assert.doesNotMatch(dump(detail(s)),/Paperback needs page count/);
 assert.deepEqual(values(s,'最新进展'),[cover.summary,alternate.summary]);s.visible(false);
 assert.equal(compare(s).hidden,true);assert.equal(compare(s).disabled,true);assert.equal(dialog(s).open,false);assert.equal(detail(s).children.length,0);
 choose(a,1);assert.equal(detail(s).children.length,0);assert.equal(queue(s).length,0);assert.equal(s.reads(),3);
});
test('the inline styles keep the reading order A then B, with flexible columns and visible select focus',()=>{
 assert.match(source,/\.compare-columns\{[^}]*repeat\(2,minmax\(0,1fr\)\)/);
 assert.match(source,/@media \(max-width:480px\)\{\.compare-columns\{grid-template-columns:minmax\(0,1fr\)/);
 assert.match(source,/\.compare-select:focus-visible\{outline:2px solid currentColor/);
});
test('losing the second readable item hides comparison and returns keyboard focus to the remaining queue',async()=>{
 const s=await setup();pin(s,0).listeners.click();pin(s,1).listeners.click();compare(s).focus();
 await s.apply([cover,{...paper,state:'withheld'},alternate]);
 assert.equal(compare(s).hidden,true);assert.equal(compare(s).disabled,true);
 assert.equal(s.document.activeElement,s.get('reading-queue-title'));
 compare(s).listeners.click();assert.equal(!!dialog(s).open,false);
 assert.equal(queue(s).length,1);assert.equal(s.reads(),2);
});
