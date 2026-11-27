import A from 'node:assert/strict';import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {makeAgentCoreAguiFixture} from '../adapter/agentcore-agui-fixture.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex'),text='Compare the two public manuals.';
const grant={enabled:true,mode:'offline-fixture',surface:'agentcore-harness',scope:'public-text',region:'cn-mainland',toolsDisabled:true,subject:'principal',harness:'sandbox',lane:'cn',epoch:'active',explicitMockDispatch:true,approvedDigest:sha(text),attachSupported:true};
const head={request:'yes',job:'job',epoch:'active'};
const ids={threadId:'orig-thread',runId:'orig-run'},request={...head,thread:ids.threadId,run:ids.runId,message:'question',text};
const event=(h,type,fields={})=>({source:'fixture-wire',session:ids.threadId,ticket:h.ticket,kind:'event',event:{type,...fields}});
function store(t){
 const p=mkdtempSync(join(tmpdir(),'agentcore-fixture-')),handles=[];let b=grant,abort=false;
 t.after(()=>{handles.forEach(x=>x.close());rmSync(p,{recursive:true,force:true});});
 return {bind(g){b=g},abort(x){abort=x},open(){
  const db=new DatabaseSync(join(p,'agui.db'));handles.push(db);
  const journal=makeAgentCoreAguiFixture({enabled:true,resolve:r=>r==='yes'?b:null,
   sql:{exec:(q,...a)=>q.startsWith('SELECT')?db.prepare(q).all(...a):(a.length?db.prepare(q).run(...a):db.exec(q),[])},
   transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();if(abort)throw Error('rollback');db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}},
  });
  return {journal,db};
 }};
}
const observe=(j,r,o)=>j.observe({...head,revision:r.revision,observation:o});
const emit=(j,h,r,sequence,type,fields)=>observe(j,r,{...event(h,type,fields),sequence});
const misc=(j,h,r,kind,code)=>observe(j,r,{...event(h,null),kind,code});
function started(j){
 const h=j.open(request);A(h.mockRequest);
 const a=emit(j,h,h,0,'RUN_STARTED',ids);
 const b=emit(j,h,a,1,'TEXT_MESSAGE_START',{messageId:'a1',role:'assistant'});
 return {h,b};
}
test('initial request is explicit, unique and synthetic; attach never occurs before a durable cursor',t=>{
 const f=store(t),{journal:j}=f.open(); A.throws(()=>makeAgentCoreAguiFixture(),/disabled/);
 f.bind({...grant,region:'global'});A.equal(j.open(request).reason,'binding_or_input');f.bind(grant);
 A.equal(j.open({...request,text:'different prompt'}).reason,'binding_or_input');
 const h=j.open(request);A.equal(h.mockRequest.body.messages[0].content,text);A.equal(h.mockRequest.session,ids.threadId);
 A.equal(j.open({...request,run:'other'}).reason,'original_reserved');
 A.equal(j.open({...request,job:'another-task'}).reason,'original_reserved');
 A.equal(j.attach({...head,revision:h.revision}).reason,'original_recovery_unverified');
 const lost=misc(j,h,h,'closed');A.equal(lost.state,'disconnected');
 A.equal(j.attach({...head,revision:lost.revision}).reason,'original_recovery_unverified');
});
test('two connections attach exactly once with empty input; original assistant result only after success',t=>{
 const f=store(t),{journal:j}=f.open(),{h,b}=started(j);
 const c=emit(j,h,b,2,'TEXT_MESSAGE_CONTENT',{messageId:'a1',delta:'first'});
 const lost=misc(j,h,c,'closed'),{journal:j2,db}=f.open();
 const a=j2.attach({...head,revision:lost.revision});
 A.deepEqual(a.mockRequest,{method:'POST',path:'/ag-ui/agent',session:ids.threadId,body:{...ids,state:{},tools:[],context:[],messages:[],forwardedProps:{agentcore:{attach:{afterSequence:2}}}}});
 A.equal(j.attach({...head,revision:a.revision}).reason,'original_recovery_unverified');
 A.equal(emit(j,h,a,3,'TEXT_MESSAGE_END',{messageId:'a1'}).reason,'receipt_not_original');
 A.equal(emit(j,a,a,2,'TEXT_MESSAGE_CONTENT',{messageId:'a1',delta:'duplicate'}).reason,'old_event');
 const d=emit(j,a,a,3,'TEXT_MESSAGE_CONTENT',{messageId:'a1',delta:' second'});
 const e=emit(j,a,d,4,'TEXT_MESSAGE_END',{messageId:'a1'});A(!e.candidate);
 const next=emit(j,a,e,5,'RUN_FINISHED',{...ids,outcome:{type:'success'}});
 A.equal(next.state,'result_for_review');A.deepEqual(next.candidate,{text:'first second',sha256:sha('first second')});
 const raw=db.prepare('SELECT payload FROM lab_agentcore_agui_v1').get().payload;
 A(!raw.includes(text)&&!raw.includes('first second'));A.equal(j.read(head).resultDigest,sha('first second'));
});
test('interrupt waits without new prompt or auto-answer',t=>{
 const {journal:j}=store(t).open(),{h,b}=started(j);
 const v=emit(j,h,b,2,'RUN_FINISHED',{...ids,outcome:{type:'interrupt',value:'a question'}});
 A.equal(v.state,'waiting_for_input');A(!v.candidate);A.equal(j.open(request).committed,false);
 A.equal(j.attach({...head,revision:v.revision}).committed,false);
});
test('no schema guess on gaps, wrong run, expired/revoked binding, or lost second stream',t=>{
 const f=store(t),{journal:j}=f.open(),{h,b}=started(j);
 f.bind({...grant,epoch:'revoked'});A.equal(j.read(head),null);A.equal(emit(j,h,b,2,'TEXT_MESSAGE_END',{messageId:'a1'}).reason,'receipt_not_original');f.bind(grant);
 const v=emit(j,h,b,3,'RUN_FINISHED',{...ids,outcome:{type:'success'}});
 A.equal(v.state,'needs_review');A.equal(v.afterSequence,1);A(!v.candidate);
});
for(const code of ['RUN_ALREADY_TERMINAL','RUN_ALREADY_ATTACHED','RUN_ATTACH_UNSUPPORTED','RUN_NOT_FOUND','closed']){
 test('Attach '+code+' stays unresolved without resend',t=>{
  const {journal:j}=store(t).open(),{h,b}=started(j);
  const lost=misc(j,h,b,'closed'),a=j.attach({...head,revision:lost.revision});
  const v=misc(j,a,a,code==='closed'?'closed':'reject',code);A.equal(v.state,'needs_review');
  A.equal(j.open(request).committed,false);A.equal(j.attach({...head,revision:v.revision}).committed,false);
 });
}
test('transaction rollback never releases a prompt or advances the accepted sequence',t=>{
 const f=store(t),{journal:j}=f.open();
 f.abort(true);A.throws(()=>j.open(request),/rollback/);f.abort(false);A.equal(j.read(head),null);
 const {h,b}=started(j);f.abort(true);A.throws(()=>emit(j,h,b,2,'TEXT_MESSAGE_CONTENT',{messageId:'a1',delta:'a'}),/rollback/);f.abort(false);
 A.equal(j.read(head).afterSequence,1);
 const wrong=emit(j,h,b,2,'RUN_FINISHED',{...ids,runId:'another',outcome:{type:'success'}});A.equal(wrong.state,'needs_review');A(!wrong.candidate);
});
