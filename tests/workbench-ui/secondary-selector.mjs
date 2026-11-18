import {dashboardClient,selectedWorkbench} from '../../src/owner/presentation.mjs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
for (const mode of ['same','renamed','reordered','sourceChanged','removed','hidden','unauthorized']) {
class E {constructor(tag=''){this.tag=tag;this.children=[];this.listeners={};this.open=false;this.textContent='';this.classList={toggle(){}};}addEventListener(k,f){this.listeners[k]=f;}replaceChildren(...c){this.children=c;}append(...c){this.children.push(...c);}insertBefore(c){this.children.push(c);c.parent=this;}remove(){this.parent?.children.splice(this.parent.children.indexOf(this),1);}setAttribute(){}focus(){doc.activeElement=this;}showModal(){this.open=true;}close(){this.open=false;}}
const doc=new E(),win=new E(),els=new Map(),timers=new Map();let counter=0,revision=1,reads=0;
doc.getElementById=k=>{if(!els.has(k))els.set(k,new E());return els.get(k);};doc.createElement=k=>new E(k);doc.createElementNS=(_,k)=>new E(k);doc.body=new E();
vm.runInNewContext('('+dashboardClient.toString()+')()',{document:doc,window:win,selectedWorkbench,Date,crypto,localStorage:{getItem(){}},AbortController,setTimeout:(f,ms)=>{timers.set(++counter,{f,ms});return counter;},clearTimeout:id=>timers.delete(id),fetch:async()=>{reads++;const second=revision===2;let sources=[{source_id:second&&mode==='sourceChanged'?'other-main':'muse-main',display_name:second&&mode==='renamed'?'New Muse':'Muse',items:[]}];if(second&&mode==='removed')sources=[];if(mode==='reordered'){const other={source_id:'other-main',display_name:'Other',items:[]};sources=second?[other,...sources]:[...sources,other];}return {ok:!(second&&mode==='unauthorized'),status:second&&mode==='unauthorized'?401:200,json:async()=>({items:[],sources})};}});
const get=()=>doc.getElementById('canvas').children.find(c=>c.children[0]?.children[0]?.children[0]?.textContent==='muse-main')?.children.at(-1).children[0];
await win.listeners.pageshow();get().focus();const before=get();revision=2;
if(mode==='hidden'){doc.hidden=true;doc.listeners.visibilitychange();doc.hidden=false;doc.listeners.visibilitychange();await new Promise(r=>setImmediate(r));}
else {const poll=[...timers.values()].find(t=>t.ms===30000);poll.f();await new Promise(r=>setImmediate(r));}
assert.notEqual(get(),before);if(['same','renamed','reordered'].includes(mode))assert.equal(doc.activeElement,get(),mode);else assert.notEqual(doc.activeElement,get(),mode);console.log('PASS selector',mode);
}
