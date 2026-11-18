import {dashboardClient,selectedWorkbench} from '../../src/owner/presentation.mjs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
for (const mode of ['close','cancel','expired','401','409','session-expired']) {
class E {constructor(tag=''){this.tag=tag;this.children=[];this.listeners={};this.open=false;this.textContent='';this.classList={toggle(){}};}addEventListener(k,f){this.listeners[k]=f;}replaceChildren(...c){this.children=c;}append(...c){this.children.push(...c);}insertBefore(c){this.children.push(c);}remove(){}setAttribute(){}focus(){doc.activeElement=this;}showModal(){this.open=true;}close(){this.open=false;}}
const doc=new E(),win=new E(),els=new Map(),timers=new Map();let counter=0,revision=1,reads=0,release;const pending=new Promise(r=>release=r);
doc.getElementById=k=>{if(!els.has(k))els.set(k,new E());return els.get(k);};doc.createElement=k=>new E(k);doc.createElementNS=(_,k)=>new E(k);doc.body=new E();
vm.runInNewContext('('+dashboardClient.toString()+')()',{document:doc,window:win,selectedWorkbench,Date,crypto,localStorage:{getItem(){}},AbortController,setTimeout:(f,ms)=>{timers.set(++counter,{f,ms});return counter;},clearTimeout:id=>timers.delete(id),fetch:async(path)=>{if(path==='/dashboard/task-picker')return {ok:true,status:200,json:async()=>({state:'access_required',csrf:'test-csrf',expires_at:new Date(Date.now()+300000).toISOString(),sources:[{source_id:'zot-main'}]})};if(path!=='/dashboard/data')return {ok:true,status:200,json:async()=>({})};reads++;if(reads===2)await pending;return {ok:reads!==1&&!(reads===2&&['401','409'].includes(mode)),status:reads===1?409:reads===2&&['401','409'].includes(mode)?Number(mode):200,json:async()=>({...(reads===2&&mode==='session-expired'?{session_expires_at:'2000-01-01T00:00:00Z'}:{}),items:[{source_id:'zot-main',project_id:'p',task_id:'t',run_id:'r',branch_id:'b',task_name:'Recovered',source_status:'running',state:'available'}]})};}});
const get=()=>doc.getElementById('items').children[0]?.children.find(x=>x.className==='detail-launch');
await win.listeners.pageshow();assert.equal(doc.getElementById('controls').hidden,false,'409 permits reselect/manual retry');
const retry=doc.getElementById('refresh').listeners.click();await doc.getElementById('choose-tasks').listeners.click({currentTarget:doc.getElementById('choose-tasks')});await new Promise(r=>setImmediate(r));assert.equal(doc.getElementById('task-picker').open,true);
release();await retry;assert.equal(get(),undefined,'successful response defers while picker open');
if(['401','409','session-expired'].includes(mode)){assert.equal(doc.getElementById('task-picker').open,false,'authorization failure closes picker');assert.ok(![...timers.values()].some(t=>t.ms===30000),'authorization failure must not enable continuation');if(mode!=='409')assert.equal(doc.getElementById('controls').hidden,true);console.log('PASS picker-recovery',mode);continue;}
if(mode==='cancel')doc.getElementById('task-picker').listeners.cancel({preventDefault(){}});
else if(mode==='expired'){const expiry=[...timers.values()].find(t=>t.ms>290000&&t.ms<=300000);assert.ok(expiry);expiry.f();}
else doc.getElementById('picker-cancel').listeners.click();
assert.equal(doc.getElementById('task-picker').open,false);
const poll=[...timers.values()].find(t=>t.ms===30000);assert.ok(poll,'deferred successful retry must schedule continuation');poll.f();await new Promise(r=>setImmediate(r));assert.ok(get(),'next read populates recovered task');assert.equal(reads,3);console.log('PASS picker-recovery',mode);
}
