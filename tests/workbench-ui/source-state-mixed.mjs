import {dashboardClient,selectedWorkbench} from '../../src/owner/presentation.mjs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
class E {constructor(tag=''){this.tag=tag;this.children=[];this.listeners={};this.open=false;this.textContent='';this.classList={toggle(){}};}addEventListener(k,f){this.listeners[k]=f;}replaceChildren(...c){this.children=c;}append(...c){this.children.push(...c);}insertBefore(c){this.children.push(c);c.parent=this;}remove(){this.parent?.children.splice(this.parent.children.indexOf(this),1);}setAttribute(k,v){(this.attrs??={})[k]=v;}focus(){doc.activeElement=this;}showModal(){this.open=true;}close(){this.open=false;}}
const doc=new E(),win=new E(),els=new Map(),timers=new Map();let counter=0,revision=1,reads=0;
doc.getElementById=k=>{if(!els.has(k))els.set(k,new E());return els.get(k);};doc.createElement=k=>new E(k);doc.createElementNS=(_,k)=>new E(k);doc.body=new E();
vm.runInNewContext('('+dashboardClient.toString()+')()',{document:doc,window:win,selectedWorkbench,Date,crypto,localStorage:{getItem(){}},AbortController,setTimeout:(f,ms)=>{timers.set(++counter,{f,ms});return counter;},clearTimeout:id=>timers.delete(id),fetch:async()=>({ok:true,status:200,json:async()=>({items:[],sources:revision===1?[makeSource('a','revoked'),makeSource('b','verified'),makeSource('c','failed')]:[makeSource('c','verified'),makeSource('a','verified'),makeSource('b','disabled')]})})});
function makeSource(id,mode){return {source_id:id,display_name:id,state:'connected',connection:{observed_at:'2026-11-17T08:00:00Z',source:{status:mode==='failed'?'verified':mode,evidence_kind:'accepted_event',last_verified_at:'2026-11-17T07:59:00Z',proof_max_age_ms:86400000}},items:[{source_id:id,project_id:'p',task_id:'t',run_id:'r',branch_id:'b',state:'available',source_status:mode==='failed'?'failed':'running',stale:false}]};}
const cards=()=>new Map(doc.getElementById('canvas').children.filter(c=>c.className==='pa source-card').map(c=>[c.children[0].children[0].children[0].textContent,c]));
function check(id,state,label){const card=cards().get(id);assert.equal(card.attrs['data-state'],state,id);assert.equal(card.children[0].children[0].children[1].textContent,label,id);}
await win.listeners.pageshow();
check('a','warning','来源授权已撤销');check('b','active','来源已验证');check('c','warning','来源已验证');assert.equal(cards().size,3);console.log('PASS mixed initial cards isolated');
revision=2;const poll=[...timers.values()].find(t=>t.ms===30000);poll.f();await new Promise(r=>setImmediate(r));
check('a','active','来源已验证');check('b','warning','来源已停用');check('c','active','来源已验证');assert.equal(cards().size,3);assert.deepEqual([...cards().keys()],['c','a','b']);console.log('PASS mixed recovery and revocation reordered');
