import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import A from 'node:assert/strict';
import {makeViktorBoardFixture} from '../storage/viktor-board-fixture.mjs';
import {sha} from '../storage/viktor-rest-fixture.mjs';

const scope='rivule-lab-us',task='public-date',worker='viktor-actor',coordinator='primary-agent';
const owner={role:'coordinator',subject:coordinator,scope},agent={role:'worker',subject:worker,scope};
const profile={provider:'viktor-rest',worker,lane:'us-viktor-lab',ready:true,authorized:true,dataRegions:['us'],capabilities:['public-research']};
const overseas={provider:'glean',worker:'independent',lane:'us-glean-lab',ready:true,authorized:true,dataRegions:['us'],capabilities:['public-research']};
const binding={enabled:true,mode:'offline-fixture',provider:'viktor-rest',keyKind:'personal-key',publicTextOnly:true,dedicated:true,
 connectionsDisabled:true,region:'us-reviewed-fixture',workspace:'wk',actor:'fixture-seat',lane:profile.lane,scopes:['threads:create','runs:read','runs:create']};
const approvedText='Examine an unrelated public fixture date.',question='Which synthetic public source should I use?',report='A synthetic report.';
const ack={source:'mock-original-create',workspace:binding.workspace,actor:binding.actor,status:202,
 json:{thread:{id:'thread-4'},message:{id:'message-4'},run:{id:'run-4'}}};
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'rivule-viktor-board-')),file=join(dir,'board.sqlite'),connections=[];
 t.after(()=>{connections.forEach(db=>db.close());rmSync(dir,{recursive:true,force:true})});
 let abort=false,active=true;
 return {abort(v){abort=v},enroll(v){active=v},open(){
  const db=new DatabaseSync(file);connections.push(db);
  db.exec('PRAGMA busy_timeout=5000');
  const bridge=makeViktorBoardFixture({enabled:true,
   sql:{exec:(q,...a)=>q.startsWith('SELECT')?db.prepare(q).all(...a):(a.length?db.prepare(q).run(...a):db.exec(q),[])},
   resolve:s=>active&&s.scope===scope&&s.task===task?{...s,profile,binding,coordinator}:null,
   transactionSync(fn){
    db.exec('BEGIN IMMEDIATE');try{const out=fn();if(abort)throw Error('rollback');db.exec('COMMIT');return out}
    catch(e){db.exec('ROLLBACK');throw e}
   }});
  return {db,...bridge};
 }};
}
const write=(v,auth,expectedVersion,aTask,type,fields,p)=>v.board.append({auth,expectedVersion,at:100+expectedVersion,
 command:{task:aTask,type,id:'event-'+(expectedVersion+1),...fields},profile:p});
const add=(v,task,version,requires=[],body=approvedText)=>write(v,owner,version,task,'add',
 {requires,capability:'public-research',allowedRegions:['us'],inputDigest:sha(body)});
const card=(v,which=task)=>v.board.project({scope,selected:[which],readable:[which]}).cards[0];
const args=(bv,pv=0,a=owner)=>({task,fence:1,auth:a,at:100+bv,eventId:'event-'+(bv+1),expectedBoardVersion:bv,expectedProviderRevision:pv});
function prepare(v,phase){
 add(v,task,0);add(v,'merge',1,[task]);add(v,'peer',2,[],'Independent public request.');
 write(v,agent,3,task,'claim',{worker,leaseMs:1000},profile);
 const start=v.start({...args(4,0,agent),approvedText});A.equal(start.boardVersion,5);A.equal(start.mockRequest.method,'POST');
 const accepted=v.observeCreate({...args(5,0,agent),mockTicket:start.mockTicket,observation:ack});A.equal(accepted.boardVersion,6);
 const run=v.readPlan(args(6,1)).mockRequest;A.equal(run.method,'GET');
 A.equal(v.observeStatus({...args(6,1),observation:{source:'mock-verified-run',request:run,httpStatus:200,status:phase,
  runId:'run-4',threadId:'thread-4',resultAvailable:true}}).committed,true);
 const request=v.readPlan(args(6,2)).mockRequest;
 return {source:'mock-verified-result',request,httpStatus:200,status:phase,runId:'run-4',threadId:'thread-4',
   kind:'text/plain',content:phase==='requires_action'?question:report,files:[]};
}
test('A question survives cold restart, is distinct from success, and independent work may finish',t=>{
 const e=fixture(t),v=e.open(),q=prepare(v,'requires_action'),frames=[];
 const snap=(db,label)=>frames.push({...db.board.project({scope,selected:[task,'peer','merge'],readable:[task,'peer','merge']}),label});
 snap(v,'Viktor 已接单。只查询原任务的回执。');
 const out=v.checkpoint({...args(6,2),observation:q});
 A.deepEqual(out,{committed:true,boardVersion:7,providerRevision:3,phase:'owner_input_required'});
 snap(v,'Viktor 请求补充资料。原任务暂停，不自动回答。');
 const cold=e.open();
 snap(cold,'重启后仍保留等待状态，合稿保持锁定。');
 A.equal(card(cold).deliveryState,'owner_input_required');A.equal(card(cold).state,'needs_review');
 A.equal(card(cold,'merge').state,'blocked');
 A.throws(()=>write(cold,owner,7,task,'accept',{fence:1,artifact:sha(question)}),/artifact_mismatch/);
 A.throws(()=>write(cold,owner,7,task,'reconcile',{fence:1,attestation:sha('other')}),/not_under_review/);
 A.equal(cold.readPlan(args(7,3)).mockRequest,undefined);
 A.equal(cold.start({...args(7,3,agent),approvedText}).mockRequest,undefined);
 A.equal(cold.checkpoint({...args(7,3),observation:q}).committed,false);
 const other={...agent,subject:overseas.worker};
 write(cold,other,7,'peer','claim',{worker:other.subject,leaseMs:1000},overseas);
 write(cold,other,8,'peer','begin',{fence:1},overseas);
 write(cold,other,9,'peer','acknowledged',{fence:1,receipt:'other-run'});
 write(cold,other,10,'peer','reported',{fence:1,receipt:'other-run',artifact:sha('independent public report')});
 write(cold,owner,11,'peer','accept',{fence:1,artifact:sha('independent public report')});
 A.equal(card(cold,'peer').state,'accepted');A.equal(card(cold,'merge').state,'blocked');
 snap(cold,'另一项工作已验收。Viktor 还在等输入，合稿依然不会开始。');
 if(process.env.RIVULE_VIKTOR_REPLAY==='1')console.log('RIVULE_VIKTOR_REPLAY:'+JSON.stringify(frames));
 const serial=JSON.stringify({events:cold.db.prepare('SELECT body FROM lab_coord_event').all(),provider:cold.db.prepare('SELECT entry FROM lab_viktor_rest_v1').all()});
 A(!serial.includes(question));A(!serial.includes(approvedText));
 const noAccess=cold.board.project({scope,selected:[task],readable:[]});A.deepEqual(noAccess.cards,[]);
});
test('Provider result and canonical board either both commit or both roll back',t=>{
 const e=fixture(t),v=e.open(),r=prepare(v,'completed'),a={...args(6,2),observation:r};
 e.abort(true);A.throws(()=>v.checkpoint(a),/rollback/);e.abort(false);
 const cold=e.open(),digest=sha(report);
 A.equal(card(cold).state,'running');
 A.equal(cold.readPlan(args(6,2)).mockRequest.path,r.request.path);
 A.equal(cold.checkpoint(a).phase,'awaiting_main_agent');A.equal(card(cold).state,'reported');
 A.equal(v.checkpoint(a).committed,false);
 A.equal(card(cold,'merge').state,'blocked');
 write(cold,owner,7,task,'accept',{fence:1,artifact:digest});
 A.equal(card(cold).state,'accepted');A.equal(card(cold,'merge').state,'ready');
});
test('Stale board, wrong actor, changed receipt and revoked enrollment cannot publish',t=>{
 const e=fixture(t),v=e.open(),q=prepare(v,'requires_action'),a={...args(6,2),observation:q};
 A.equal(v.checkpoint({...a,expectedBoardVersion:5}).committed,false);
 A.equal(v.checkpoint({...a,fence:2}).committed,false);
 A.throws(()=>v.checkpoint({...a,auth:{...owner,scope:'unrelated'}}),/enrollment/);
 A.throws(()=>v.checkpoint({...a,auth:agent}),/bound role/);
 A.equal(v.checkpoint({...a,observation:{...q,runId:'different'}}).committed,false);
 A.throws(()=>write(v,owner,6,task,'viktor_checkpoint',{fence:1,attestation:sha('forged')}),/invalid_attestation/);
 e.enroll(false);A.throws(()=>v.checkpoint(a),/enrollment/);e.enroll(true);
 A.equal(e.open().checkpoint(a).phase,'owner_input_required');
});
test('Question can be observed after lease loss on the exact known run, never on a fresh task',t=>{
 const {open}=fixture(t),v=open(),q=prepare(v,'requires_action');
 v.board.append({auth:owner,expectedVersion:6,at:1500,command:{type:'expire',task,id:'lease-expires',fence:1}});
 A.equal(card(v).state,'needs_review');
 const next={...args(7,2),at:1501,observation:q};
 A.equal(v.checkpoint(next).phase,'owner_input_required');
 A.equal(card(open()).deliveryState,'owner_input_required');
});
