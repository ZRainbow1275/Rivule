import {dashboardClient,selectedWorkbench} from '../../src/owner/presentation.mjs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
for (const mode of ['initial-settings']) {
class E {constructor(tag=''){this.tag=tag;this.children=[];this.listeners={};this.open=false;this.textContent='';this.classList={toggle(){}};}addEventListener(k,f){this.listeners[k]=f;}replaceChildren(...c){this.children=c;}append(...c){this.children.push(...c);}insertBefore(c){this.children.push(c);}remove(){}setAttribute(){}focus(){doc.activeElement=this;}showModal(){this.open=true;}close(){this.open=false;}}
const doc=new E(),win=new E(),els=new Map(),timers=new Map();let counter=0,revision=1,reads=0,release;const pending=new Promise(r=>release=r);
doc.getElementById=k=>{if(!els.has(k))els.set(k,new E());return els.get(k);};doc.createElement=k=>new E(k);doc.createElementNS=(_,k)=>new E(k);doc.body=new E();
vm.runInNewContext('('+dashboardClient.toString()+')()',{document:doc,window:win,selectedWorkbench,Date,crypto,localStorage:{getItem(){}},AbortController,setTimeout:(f,ms)=>{timers.set(++counter,{f,ms});return counter;},clearTimeout:id=>timers.delete(id),fetch:async()=>{reads++;if(reads===1)await pending;return {ok:!(/401|409/.test(mode)&&revision===2),status:revision===2&&/401|409/.test(mode)?Number(mode.split('-')[1]):200,json:async()=>({...(revision===2&&mode.endsWith('expired')?{session_expires_at:'2020-01-01T00:00:00Z'}:{}),items:[{source_id:'zot-main',project_id:'layout',task_id:'annual-report',run_id:'working',branch_id:'main',task_name:'年报排版',source_status:'running',state:'available',summary:'工作说明第 '+revision+' 版',...(['source_id','project_id','task_id','run_id','branch_id'].includes(mode)&&revision===2?{[mode]:'different'}:{})}]})};}});
const get=()=>doc.getElementById('items').children[0]?.children.find(x=>x.className==='detail-launch');
const initial=win.listeners.pageshow();doc.getElementById('settings').showModal();release();await initial;
assert.equal(get(),undefined);doc.getElementById('settings').close();
const poll=[...timers.values()].find(t=>t.ms===30000);assert.ok(poll,'initial settings deferral schedules continuation');poll.f();await new Promise(r=>setImmediate(r));assert.ok(get(),'next read populates selected task');assert.equal(reads,2);console.log('PASS initial-settings-continuation');
}
