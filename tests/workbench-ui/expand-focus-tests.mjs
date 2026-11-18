import {dashboardClient,selectedWorkbench} from '../../src/owner/presentation.mjs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
// Target: expand
for (const mode of ['same','closed','source_id','project_id','task_id','run_id','branch_id','hidden','focus']) {
class E {constructor(tag=''){this.tag=tag;this.children=[];this.listeners={};this.open=false;this.textContent='';this.classList={toggle(){}};}addEventListener(k,f){this.listeners[k]=f;}replaceChildren(...c){this.children=c;}append(...c){this.children.push(...c);}insertBefore(c){this.children.push(c);}remove(){}setAttribute(){}focus(){doc.activeElement=this;}showModal(){this.open=true;}close(){this.open=false;}}
const doc=new E(),win=new E(),els=new Map(),timers=new Map();let counter=0,revision=1,reads=0;
doc.getElementById=k=>{if(!els.has(k))els.set(k,new E());return els.get(k);};doc.createElement=k=>new E(k);doc.createElementNS=(_,k)=>new E(k);doc.body=new E();
vm.runInNewContext('('+dashboardClient.toString()+')()',{document:doc,window:win,selectedWorkbench,Date,crypto,localStorage:{getItem(){}},AbortController,setTimeout:(f,ms)=>{timers.set(++counter,{f,ms});return counter;},clearTimeout:id=>timers.delete(id),fetch:async()=>{reads++;return {ok:true,status:200,json:async()=>({items:[{source_id:'zot-main',project_id:'layout',task_id:'annual-report',run_id:'working',branch_id:'main',task_name:'年报排版',source_status:'running',state:'available',summary:'工作说明第 '+revision+' 版',pending_action_count:1,...(['source_id','project_id','task_id','run_id','branch_id'].includes(mode)&&revision===2?{[mode]:'different'}:{})}]})};}});
const get=()=>doc.getElementById('items').children[0].children.find(x=>x.tag==='details');
await win.listeners.pageshow();get().open=mode!=='closed';if(mode==='focus')doc.getElementById('items').children[0].children.find(x=>x.className==='detail-launch').focus();const before=get();revision=2;
if(mode==='hidden'){doc.hidden=true;doc.listeners.visibilitychange();doc.hidden=false;doc.listeners.visibilitychange();await new Promise(r=>setImmediate(r));}
const poll=[...timers.values()].find(t=>t.ms===30000);poll.f();await new Promise(r=>setImmediate(r));
assert.equal(get().open,['same','focus'].includes(mode),mode);if(mode==='focus')assert.equal(doc.activeElement,doc.getElementById('items').children[0].children.find(x=>x.className==='detail-launch')); assert.equal(get().children.find(n=>n.className==='full-summary').textContent,'工作说明第 2 版');console.log('PASS',mode);
}
