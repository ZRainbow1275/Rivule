import A from 'node:assert/strict';import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {makeOpenAssistantTaskJournal} from '../storage/openassistant-task-journal.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const binding={mode:'offline-fixture',enabled:true,provider:'openassistant-rest',keyMode:'verified-user-key',dedicated:true,
 connectionsDisabled:true,scope:'public-text',ownerRef:'fixture-owner',assistantRef:'fixture-assistant',lane:'us-text'};
const root='one-task',scope=[binding.ownerRef,binding.assistantRef,binding.lane,root],taskId='original-task';
const head={binding,root},text='Read the two public summaries.',processText='Compare public dates.',
 request={...head,approvedText:text,approvedDigest:sha(text),now:100};
const permit={source:'mock-owner-registry',scope,taskId,revision:1,approvalId:'owner-check',
 approvedDigest:sha(processText),explicitProcessApproval:true,verifiedNoExecution:true,verifiedAt:105};
const go={...head,expectedRevision:1,approvalId:permit.approvalId,approvedText:processText,approvedDigest:permit.approvedDigest,now:120};
const createBody={id:taskId,owner:binding.ownerRef,assistant:{id:binding.assistantRef}};
const createResponse={status:201,json:{ok:true,task:createBody}};
function testDb(t){
 const dir=mkdtempSync(join(tmpdir(),'rv-oa-')),file=join(dir,'lab.sqlite'),handles=new Set();let proof=null,abort=false,reads=0;
 t.after(()=>{for(const d of handles)d.close();rmSync(dir,{recursive:true,force:true})});
 return {set(p){proof=p},abort(flag){abort=flag},reads(){return reads},open(){
  const db=new DatabaseSync(file);db.exec('PRAGMA busy_timeout=5000');handles.add(db);
  const store=makeOpenAssistantTaskJournal({
   sql:{exec:(q,...a)=>q.startsWith('SELECT')?db.prepare(q).all(...a):(a.length?db.prepare(q).run(...a):db.exec(q),[])},
   transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();if(abort)throw Error('rollback');db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}},
   resolveProcessEvidence(){reads++;return proof},
  });
  return {db,store};
 }};
}
const receipt=(send,phase,expectedRevision,response)=>({...head,phase,expectedRevision,mockTicket:send.mockTicket,
 observation:{source:'mock-bound-response',scope,path:send.mockRequest.path,response}});
const created=async s=>{const create=await s.reserveCreate(request);A(create.mockRequest);A(s.observe(receipt(create,'create',0,createResponse)).committed);return create};
test('OpenAssistant is disabled unless a dedicated public-text fixture is selected',async t=>{
 const s=testDb(t).open().store;
 for(const patch of [{enabled:false},{mode:'live'},{scope:'private'},{connectionsDisabled:false},{ownerRef:'?'}])
  await A.rejects(()=>s.reserveCreate({...request,binding:{...binding,...patch}}),/disabled/);
 A.equal(s.view(head),null);
});
test('Concurrent create CAS returns one sender; old/unknown response never allows a replay or second stage',async t=>{
 const f=testDb(t),a=f.open().store,b=f.open().store;
 const received=await Promise.all([a.reserveCreate(request),b.reserveCreate(request)]);
 A.equal(received.filter(x=>x.mockRequest).length,1);
 const first=received.find(x=>x.mockRequest);
 const observed=receipt(first,'create',0,undefined);
 A.equal(b.observe(observed).state,'create_unknown');
 A.equal(b.observe({...observed,observation:{...observed.observation,response:createResponse}}).committed,false);
 A.equal(b.view(head).taskId,null);A.equal(b.readPlan({...head,expectedRevision:1}).mockRequest,undefined);
 A.equal((await b.reserveCreate(request)).mockRequest,undefined);
 A.equal((await b.reserveProcess(go)).mockRequest,undefined);
 A.equal(a.observe(receipt(first,'create',1,createResponse)).state,'task_created');
 A.equal(a.readPlan({...head,expectedRevision:2}).mockRequest.path,'/api/tasks/'+taskId);
});
test('Process needs trusted scoped explicit approval and fresh proof of no prior execution',async t=>{
 const f=testDb(t),{store:s}=f.open();await created(s);
 for(const changes of [{verifiedNoExecution:false},{explicitProcessApproval:false},{taskId:'another'},{scope:['foreign']},
   {approvedDigest:sha('different')},{verifiedAt:121},{verifiedAt:99_000},{revision:2}]){
  f.set({...permit,...changes}); A.equal((await s.reserveProcess(go)).mockRequest,undefined);
 }
 f.set(permit);
 A.equal((await s.reserveProcess({...go,now:permit.verifiedAt+30001})).mockRequest,undefined);
 A.equal((await s.reserveProcess({...go,approvalId:'forged'})).mockRequest,undefined);
 const n=f.reads(),a=await s.reserveProcess(go);A(a.mockRequest);A(f.reads()>=n+2);
 A.equal(a.mockRequest.path,'/api/tasks/'+taskId+'/process');
});
test('Independent process send is at most once across connections, response ticket and task must match',async t=>{
 const f=testDb(t),a=f.open(),b=f.open();
 const first=await created(a.store);f.set(permit);
 const v=(await Promise.all([a.store.reserveProcess(go),b.store.reserveProcess(go)])).filter(x=>x.mockRequest);
 A.equal(v.length,1);const proc=v[0];A.notEqual(first.mockRequest.body.clientMessageId,proc.mockRequest.body.clientMessageId);
 const response={status:200,json:{ok:true,process:{success:true,taskId:'other',executionId:'run-original'}}};
 const rec=receipt(proc,'process',2,response);
 A.equal(b.store.observe({...rec,mockTicket:first.mockTicket}).committed,false);
 A.equal(b.store.observe(rec).state,'process_unknown');
 A.equal((await b.store.reserveProcess(go)).mockRequest,undefined);
 response.json.process.taskId=taskId;
 A.equal(b.store.observe({...rec,expectedRevision:3}).state,'execution_acknowledged');
 A.equal(a.store.classifyResult({...head,expectedRevision:4,observation:{source:'mock-original-read',scope,method:'GET',
  path:'/api/tasks/'+taskId,response:{status:200,json:{ok:true,task:{...createBody,status:'completed'}}}}}).state,'result_unverified');
 const raw=a.db.prepare('SELECT entry FROM lab_openassistant_v1').get().entry;
 A(!raw.includes(text));A(!raw.includes(processText));
});
test('Injected transaction rollback neither issues writes nor moves the second-phase state',async t=>{
 const f=testDb(t),{store:s}=f.open();
 f.abort(true);await A.rejects(()=>s.reserveCreate(request),/rollback/);f.abort(false);
 A.equal(s.view(head),null);
 await created(s);f.set(permit);
 f.abort(true);await A.rejects(()=>s.reserveProcess(go),/rollback/);f.abort(false);
 A.equal(s.view(head).state,'task_created');
 A.equal((await f.open().store.reserveProcess(go)).state,'process_sending');
});
