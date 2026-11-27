import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import A from 'node:assert/strict';
import {makeViktorRestFixture,sha} from '../storage/viktor-rest-fixture.mjs';
const binding={enabled:true,mode:'offline-fixture',provider:'viktor-rest',keyKind:'personal-key',publicTextOnly:true,dedicated:true,
 connectionsDisabled:true,region:'us-reviewed-fixture',workspace:'workspace-fixture',actor:'verified-seat',lane:'sample',scopes:['threads:create','runs:read','runs:create']};
const args={binding,task:'test-viktor'},approvedText='Check an officially published vendor release date.',input={...args,approvedText,inputDigest:sha(approvedText)};
const quote={source:'mock-original-create',workspace:binding.workspace,actor:binding.actor,status:202,
 json:{thread:{id:'thread-5'},message:{id:'message-4'},run:{id:'run-6'},wait_timed_out:true}};
function workspace(t){
 const dir=mkdtempSync(join(tmpdir(),'rv-viktor-')),file=join(dir,'lab.sqlite'),open=new Set();
 t.after(()=>{open.forEach(db=>db.close());rmSync(dir,{recursive:true,force:true})});
 let abort=false;
 return {fail(next){abort=next},open(){
  const db=new DatabaseSync(file);db.exec('PRAGMA busy_timeout=5000');open.add(db);
  const v=makeViktorRestFixture({sql:{exec:(q,...a)=>q.startsWith('SELECT')?db.prepare(q).all(...a):(a.length?db.prepare(q).run(...a):db.exec(q),[])},
    transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const x=fn();if(abort)throw Error('rollback');db.exec('COMMIT');return x}catch(e){db.exec('ROLLBACK');throw e}}});
  return {db,v};
 }};
}
const start=v=>{
 const first=v.reserve(input),o={...args,expectedRevision:0,mockTicket:first.mockTicket,observation:quote};
 return {first,o};
};
const status=(req,phase)=>({source:'mock-verified-run',request:req,httpStatus:200,status:phase,runId:'run-6',threadId:'thread-5',resultAvailable:true});
const result=(req,phase)=>({source:'mock-verified-result',request:req,httpStatus:200,status:phase,runId:'run-6',threadId:'thread-5',
 kind:'text/plain',content:phase==='completed'?'Bound public result.':'Which public source should I use?',files:[]});
test('Viktor default disabled; dedicated actor, scopes, region and external connections independently checked', t=>{
 const {v}=workspace(t).open();
 for(const change of [{enabled:false},{mode:'live'},{keyKind:'team-key'},{dedicated:false},{connectionsDisabled:false},{region:'unknown'},
  {publicTextOnly:false},{scopes:[...binding.scopes,'scripts:execute']},{scopes:['runs:read']}])
  A.throws(()=>v.reserve({...input,binding:{...binding,...change}}),/lab seat/);
 A.equal(v.view(args),null);
});
test('One committed Viktor POST on two connections; open lost attempt cannot be replayed', t=>{
 const e=workspace(t),{v}=e.open(),another=e.open().v;
 const {first,o}=start(v);
 A.equal(first.mockRequest.path,'/api/public/v1/threads');A.equal(first.mockRequest.method,'POST');A(first.mockRequest.headers['Idempotency-Key']);
 A(!('Authorization' in first.mockRequest.headers));A.equal(first.mockRequest.body.message,approvedText);
 const fail={...o.observation,status:503,json:null};
 A.equal(another.observeCreate({...o,observation:fail}).state,'unknown');
 A.equal(another.reserve(input).mockRequest,undefined);A.equal(v.readPlan({...args,expectedRevision:1}).mockRequest,undefined);
 A.throws(()=>another.reserve({...input,approvedText:'New body',inputDigest:sha('New body')}),/locked/);
 A.equal(another.observeCreate(o).reason,'stale');
 A.equal(another.observeCreate({...o,expectedRevision:1,mockTicket:'wrong'}).committed,false);
 A.equal(another.observeCreate({...o,expectedRevision:1}).state,'acknowledged');
 A.equal(v.readPlan({...args,expectedRevision:2}).mockRequest.path,'/api/public/v1/runs/run-6');
});
test('Wait timeout known receipt is read-only; different actor, workspace/thread/run or endpoint cannot deliver', t=>{
 const {v}=workspace(t).open();const {o}=start(v);
 A.equal(v.observeCreate({...o,observation:{...quote,actor:'other'}}).committed,false);
 A.equal(v.observeCreate(o).state,'acknowledged');
 const request=v.readPlan({...args,expectedRevision:1}).mockRequest;
 A.deepEqual(request,{method:'GET',path:'/api/public/v1/runs/run-6',workspace:binding.workspace,actor:binding.actor});
 const s={...args,expectedRevision:1,observation:status(request,'completed')};
 for(const bad of [{runId:'wrong'},{threadId:'wrong'},{request:{...request,path:request.path+'/wrong'}},
  {request:{...request,workspace:'other'}},{waitTimedOut:true},{resultAvailable:false},{status:'running'},{httpStatus:429}])
  A.equal(v.observeStatus({...s,observation:{...s.observation,...bad}}).committed,false);
 A.equal(v.readPlan({...args,expectedRevision:1}).mockRequest.method,'GET');
 A.equal(v.observeStatus(s).state,'result_available');
});
for(const phase of ['requires_action','completed'])test('Viktor '+phase+' never opens more POSTs or counts as accepted', t=>{
 const w=workspace(t),{v,db}=w.open(),{o}=start(v);
 v.observeCreate(o);const req=v.readPlan({...args,expectedRevision:1}).mockRequest;
 A(v.observeStatus({...args,expectedRevision:1,observation:status(req,phase)}).committed);
 const rr=v.readPlan({...args,expectedRevision:2}).mockRequest;
 A.equal(rr.path,req.path+'/result');
 const observation=result(rr,phase);
 A.equal(v.observeResult({...args,expectedRevision:2,observation:{...observation,files:['file-token']}}).committed,false);
 A.equal(v.observeResult({...args,expectedRevision:2,observation:{...observation,kind:'application/json'}}).committed,false);
 const wanted=phase==='requires_action'?'owner_input_required':'awaiting_main_agent';
 A.equal(v.observeResult({...args,expectedRevision:2,observation}).state,wanted);
 const cold=w.open().v;
 A.deepEqual(cold.view(args),{revision:3,state:wanted,run:'run-6',thread:'thread-5',message:'message-4',digest:sha(observation.content)});
 A.equal(cold.readPlan({...args,expectedRevision:3}).mockRequest,undefined);
 A.equal(cold.reserve(input).mockRequest,undefined);
 const raw=db.prepare('SELECT entry FROM lab_viktor_rest_v1').get().entry;
 A(!raw.includes(approvedText));A(!raw.includes(observation.content));
});
test('Aborted local reserve creates no half-entry; new independent task proceeds while original is paused', t=>{
 const e=workspace(t),{v}=e.open();
 e.fail(true);A.throws(()=>v.reserve(input),/rollback/);e.fail(false);A.equal(v.view(args),null);
 const {o}=start(v);A.equal(v.observeCreate({...o,observation:{...quote,status:429}}).state,'unknown');
 A.equal(v.reserve({...input,task:'independent'}).state,'sending');
 const sameNameOther={...args,binding:{...binding,workspace:'another'}};
 A.equal(v.view(sameNameOther),null);
});
test('The provider terminal timed_out is not a wait timeout, nor a prompt to open another thread',t=>{
 const {v}=workspace(t).open(),{o}=start(v);
 v.observeCreate(o);
 const request=v.readPlan({...args,expectedRevision:1}).mockRequest;
 const o2={...args,expectedRevision:1,observation:status(request,'timed_out')};
 A.equal(v.observeStatus({...o2,observation:{...o2.observation,waitTimedOut:true}}).committed,false);
 A.equal(v.observeStatus(o2).state,'terminal_needs_evidence');
 A.equal(v.readPlan({...args,expectedRevision:2}).mockRequest,undefined);
 A.equal(v.reserve(input).mockRequest,undefined);
});
