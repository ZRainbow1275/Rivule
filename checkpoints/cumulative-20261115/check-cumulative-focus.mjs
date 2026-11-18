// Offline browser-model tests: replacing a subtree blurs a focused descendant.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import vm from 'node:vm';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

if(!process.argv[2]) throw Error('Usage: node check-cumulative-focus.mjs PATH_TO_RESTORED_SOURCE');
const {dashboardClient,selectedWorkbench}=await import(pathToFileURL(join(resolve(process.argv[2]),'src/owner/presentation.mjs')));
const pause=()=>new Promise(ok=>setImmediate(ok));
function fixture(area,control,change) {
  let doc, revision=1, calls=0, timerID=0;
  const roots=new Map(), timers=new Map();
  class Element {
    constructor(tag=''){this.tag=tag;this.children=[];this.listeners={};this.attrs={};this.open=false;this.textContent='';this.classList={toggle(){}};}
    addEventListener(k,fn){this.listeners[k]=fn;}
    setAttribute(k,v){this.attrs[k]=String(v);}
    contains(n){return n===this||this.children.some(c=>c?.contains?.(n));}
    append(...nodes){for(const n of nodes){if(n!=null && typeof n==='object') {n.parent=this;this.children.push(n);}}}
    replaceChildren(...nodes){for(const n of [...this.children])n.remove();this.append(...nodes);}
    remove(){if(!this.parent)return;if(this.contains(doc.activeElement))doc.activeElement=doc.body;
      const index=this.parent.children.indexOf(this);if(index!==-1)this.parent.children.splice(index,1);this.parent=null;}
    insertBefore(node){this.append(node);}
    focus(){if(this===doc.body || doc.body.contains(this))doc.activeElement=this;}
    close(){this.open=false;} showModal(){this.open=true;}
  }
  doc=new Element();doc.body=new Element('body');doc.activeElement=doc.body;
  doc.getElementById=id=>{if(!roots.has(id)){const node=new Element();doc.body.append(node);roots.set(id,node);}return roots.get(id);};
  doc.createElement=tag=>new Element(tag);doc.createElementNS=(_,tag)=>new Element(tag);
  const win=new Element();
  const read=async url=>{
    assert.equal(url,'/dashboard/data');calls++;
    const second=revision>1, actualSource=area==='primary'?'zot-main':'illustration';
    const item={source_id:actualSource,project_id:'garden',task_id:'tulip',run_id:'run',branch_id:'one',task_name:'Tulip',source_status:'running',state:'available',summary:'revision '+revision,pending_action_count:2};
    if(second&&change==='identity')item.branch_id='new';
    if(second&&change==='handled')item.pending_action_count=0;
    const other={...item,task_name:'River',task_id:'river'};
    const entries=second&&change==='removed'?[]:second&&change==='reorder'?[other,item]:[item,other];
    return {ok:true,status:200,json:async()=>area==='primary'?{items:entries,sources:[]}:
      {items:[],sources:[{source_id:actualSource,display_name:second?'Drawing':'Art',state:'ready',items:entries}]}};
  };
  vm.runInNewContext('('+dashboardClient.toString()+')()',{document:doc,window:win,selectedWorkbench,Date,crypto,
    localStorage:{getItem(){}},AbortController,setTimeout:(f,ms)=>{const id=++timerID;timers.set(id,{f,ms});return id;},clearTimeout:id=>timers.delete(id),fetch:read});
  const flat=n=>[n,...n.children.flatMap(flat)];
  function nodes(){
    const base=doc.getElementById(area==='primary'?'items':'canvas');
    const card=flat(base).find(n=>n.tag==='article'&&n.className==='task'&&n.children.some(t=>t.tag==='h3'&&t.textContent==='Tulip'));
    if(control==='diagnostic'||control==='selector'){
      const n=flat(base).find(e=>e.textContent===(control==='selector'?'选择已上报任务':'连接诊断'));return {node:n};
    }
    if(!card)return {};
    const facts=card.children.find(e=>e.className==='task-facts');
    const n=control==='summary'?facts?.children.find(e=>e.tag==='summary'):card.children.find(e=>e.className===(control==='pending'?'pending-callout':'detail-launch'));
    return {node:n, facts};
  }
  async function run(){
    await win.listeners.pageshow();assert.equal(calls,1);
    const before=nodes();assert.ok(before.node,area+': '+control);if(before.facts)before.facts.open=true;
    before.node.focus();assert.equal(doc.activeElement,before.node);revision=2;
    const poll=[...timers.values()].find(t=>t.ms===30000);assert.ok(poll);poll.f();await pause();assert.equal(calls,2);
    const after=nodes();assert.notEqual(after.node,before.node);assert.ok(!doc.body.contains(before.node));
    if(['same','reorder'].includes(change)){assert.equal(doc.activeElement,after.node);if(after.facts)assert.equal(after.facts.open,true);}
    else{assert.equal(doc.activeElement,doc.body);if(after.facts&&change==='identity')assert.equal(after.facts.open,false);}
    if(change==='handled'&&control==='pending')assert.equal(after.node,undefined);
  }
  return run;
}
for(const area of ['primary','secondary']){
  for(const control of (area==='primary'?['summary','detail','pending']:['detail','pending'])){
    for(const change of ['same','reorder','identity','removed',...(control==='pending'?['handled']:[])]){
      test(area+' '+control+' keeps the correct keyboard position after '+change,fixture(area,control,change));
    }
  }
}
for(const control of ['selector','diagnostic'])test('secondary '+control+' survives a rename',fixture('secondary',control,'same'));

