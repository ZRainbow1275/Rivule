import test from 'node:test';
import A from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {makeSqlJournal} from '../storage/sql-journal.mjs';

const scope='boundary-fixture',name='prepared',alias='selected',other='parallel';
const lead={scope,subject:'lead',role:'coordinator'};
const inputDigest='1'.repeat(64);
const slot=n=>({scope,task:n,alias,fence:1});
const base=n=>({auth:lead,alias,readable:[n],budgetReviewed:true,canCloseMock:true,authorityEpoch:'auth-1',budgetEpoch:'budget-1',inputDigest,
 profile:{worker:'worker-'+n,provider:'mock-local',lane:'lane-'+n,authorized:true,ready:true,dataRegions:['cn-mainland'],capabilities:['text']}});
function setup({withMerge=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'rivule-mock-boundary-')),file=join(dir,'synthetic.sqlite');
 const connections=[];let now=10, fault=null;
 function host(outcome){
  const db=new DatabaseSync(file);connections.push(db);
  let close=false;
  const facade=makeSqlJournal({
   sql:{exec(q,...args){
    if(q===fault?.sql&&!fault.after)throw Error('fixture SQL interrupt');
    const result=q.startsWith('SELECT')?db.prepare(q).all(...args):(db.prepare(q).run(...args),[]);
    if(q===fault?.sql&&fault.after)throw Error('fixture SQL interrupt');
    return result;
   }},
   transactionSync(fn){
    db.exec('BEGIN IMMEDIATE');try{const x=fn();db.exec('COMMIT');return x;}
    catch(e){db.exec('ROLLBACK');throw e;}
   },
   reviewedDispatch:{validatorKey:Buffer.alloc(32,79),
    resolve(request,{task}){
     A(db.isTransaction);
     if(request!=='host'&&request!=='viewer')return null;
     const row=db.prepare('SELECT body FROM fixture_policy WHERE task=?').get(task);
     const a=row&&JSON.parse(row.body);
     if(a&&request==='viewer')a.auth.subject='alternate';
     return a;
    },
    ...(outcome===null?{}:{mockEgress:{clock:()=>{A(db.isTransaction);return now;},outcome}})
   }
  });
  return {db,j:facade,close(){if(!close){close=true;db.close();connections.splice(connections.indexOf(db),1);}}};
 }
 const one=host('accepted'),two=host('accepted');one.j.prepare();
 one.db.exec('CREATE TABLE fixture_policy(task TEXT PRIMARY KEY,body TEXT)');
 for(const n of [name,other]){
  one.db.prepare('INSERT INTO fixture_policy VALUES (?,?)').run(n,JSON.stringify(base(n)));
  const version=n===name?0:1;
  one.j.append({auth:lead,at:version+1,expectedVersion:version,command:{id:'add-'+n,type:'add',task:n,inputDigest,allowedRegions:['cn-mainland'],capability:'text',requires:[]}});
 }
 if(withMerge)one.j.append({auth:lead,at:3,expectedVersion:2,command:{id:'add-merge',type:'add',task:'merge',inputDigest,allowedRegions:['cn-mainland'],capability:'text',requires:[name,other]}});
 const policy=(n,patch)=>one.db.prepare('UPDATE fixture_policy SET body=? WHERE task=?').run(JSON.stringify({...base(n),...patch}),n);
 const claim=(n,v,opt={})=>{
  const a=slot(n),{selection}=one.j.inspectChoice('host',a);
  return two.j.claimChoice('host',{...a,selection,id:'claim-'+n,leaseMs:50,at:v+1,expectedVersion:v,...opt});
 };
 const begin=(n,v,j=two.j)=>j.beginChoice('host',{...slot(n),id:'begin-'+n,at:v+1,expectedVersion:v});
 const read=(n,j=two.j,opt={})=>j.inspectMockEgress('host',{...slot(n),...opt});
 const consume=(n,j=two.j,opt={})=>j.consumeMockEgress('host',{...slot(n),...opt});
 const closeAttempt=(n,expectedVersion,j=two.j,opt={})=>j.closeMockEgress('host',{...slot(n),id:'close-'+n,expectedVersion,...opt});
 const count=()=>one.db.prepare('SELECT COUNT(*) AS n FROM lab_coord_mock_egress').get().n;
 const visible=withMerge?[name,other,'merge']:[name,other];
 const project=()=>two.j.project({scope,selected:visible,readable:visible});
 return {one,two,host,policy,claim,begin,read,consume,closeAttempt,count,project,time:n=>{now=n;},
  fault:f=>{fault=f;},close(){for(const db of connections)db.close();rmSync(dir,{recursive:true,force:true});}};
}
const pending={state:'pending',receipt:null,simulation:true};
const unknown={state:'unknown',receipt:null,simulation:true};
const armSQL="INSERT INTO lab_coord_mock_egress (board,task,fence,reviewer,alias,begin_v,state,receipt) VALUES (?,?,?,?,?,?,'pending',NULL)";
const consumeSQL="UPDATE lab_coord_mock_egress SET state=?,receipt=? WHERE board=? AND task=? AND fence=? AND state='pending'";

test('after durable begin, current authority, budget, input, profile, exact regions and lease are checked again at mock egress',()=>{
 const f=setup();
 try{
  A(f.claim(name,2).committed);
  A.deepEqual(f.read(name),null);
  A.throws(()=>f.consume(name),{code:'mock_egress_not_armed'});
  const b=f.begin(name,3);
  A(b.committed);A.equal(b.permit,null);A.equal(b.simulation,'pending');
  A.deepEqual(f.read(name),pending);
  A(f.begin(name,3).duplicate);A.equal(f.count(),1);
  const profile=base(name).profile;
  for(const [values,code] of [
   [{budgetReviewed:false},'budget_unreviewed'],
   [{budgetEpoch:'budget-2'},'dispatch_review_changed'],
   [{authorityEpoch:'auth-2'},'dispatch_review_changed'],
   [{inputDigest:'a'.repeat(64)},'review_input_changed'],
   [{profile:{...profile,lane:'lane-other'}},'route_changed'],
   [{profile:{...profile,provider:'mock-different'}},'route_changed'],
   [{profile:{...profile,ready:false}},'worker_unavailable'],
   [{profile:{...profile,dataRegions:['cn-mainland','sg']}},'region_mismatch'],
   [{readable:[other]},'not_authorized']
  ]){
   f.policy(name,values);A.throws(()=>f.consume(name),{code});
   A.equal(f.project().asOfVersion,4);
   A.equal(f.count(),1);
  }
  f.policy(name,{authorityEpoch:'auth-2'});
  A.deepEqual(f.read(name),pending); // authorized history read doesn't confer dispatch rights
  A.throws(()=>f.two.j.inspectMockEgress('viewer',slot(name)),{code:'not_authorized'});
  A.throws(()=>f.two.j.consumeMockEgress('anonymous',slot(name)),{code:'not_authorized'});
  A(f.claim(other,4).committed);A(f.begin(other,5).committed);
  const k=f.consume(other);
  A(k.receipt&&k.state==='accepted'&&!k.duplicate&&k.simulation);
  A.deepEqual(f.read(name),pending);
  A.throws(()=>f.consume(name),{code:'dispatch_review_changed'});
  f.policy(name,{});f.time(53);
  A.throws(()=>f.consume(name),{code:'lease_expired'});
  A.equal(f.project().asOfVersion,6);
 }finally{f.close();}
});

test('a durable mock receipt survives loss of the response and is read back without a second attempt',()=>{
 const f=setup();
 try{
  f.claim(name,2);f.begin(name,3);
  const first=f.consume(name);
  A.equal(first.duplicate,false);A.equal(first.state,'accepted');
  f.two.close();
  f.policy(name,{budgetReviewed:false,budgetEpoch:'budget-2',authorityEpoch:'auth-2'});
  const reopened=f.host('unknown'); // changed adapter result cannot change a consumed attempt
  const read=f.read(name,reopened.j);
  A.deepEqual(read,{state:'accepted',receipt:first.receipt,simulation:true});
  A.deepEqual(f.consume(name,reopened.j),{...read,duplicate:true});
  A.deepEqual(f.read(name,reopened.j,{fence:2}),null);
  A.throws(()=>f.consume(name,reopened.j,{fence:2}),{code:'mock_egress_not_armed'});
  A.equal(f.count(),1);
 }finally{f.close();}
});

test('an ambiguous mock response is retained against the original fence and never resent automatically',()=>{
 const f=setup();
 try{
  f.claim(name,2);
  const flaky=f.host('unknown');
  A(f.begin(name,3,flaky.j).committed);
  A.deepEqual(f.consume(name,flaky.j),{...unknown,duplicate:false});
  flaky.close();
  A.deepEqual(f.read(name),unknown);
  A.deepEqual(f.consume(name),{...unknown,duplicate:true});
  A.equal(f.count(),1);
  A.equal(f.project().cards.find(c=>c.task===name).state,'submitting');
 }finally{f.close();}
});

test('mock row and journal begin are atomic; a failed local status write never appears accepted',()=>{
 const f=setup();
 try{
  f.claim(name,2);
  f.fault({sql:armSQL,after:true});
  A.throws(()=>f.begin(name,3),/fixture SQL interrupt/);
  A.equal(f.count(),0);A.equal(f.project().asOfVersion,3);
  A.deepEqual(f.two.j.outboxAfter(scope,3),[]);
  f.fault(null);A(f.begin(name,3).committed);
  f.fault({sql:consumeSQL,after:true});
  A.throws(()=>f.consume(name),/fixture SQL interrupt/);
  A.deepEqual(f.read(name),pending);A.equal(f.count(),1);
  f.fault(null);A.equal(f.consume(name).state,'accepted');
 }finally{f.close();}
});

test('a begin issued without this feature cannot be turned into mock egress on re-open',()=>{
 const f=setup();
 try{
  const legacy=f.host(null);
  f.claim(name,2);A(f.begin(name,3,legacy.j).permit);
  A.throws(()=>legacy.j.consumeMockEgress('host',slot(name)),{code:'mock_egress_disabled'});
  A.throws(()=>f.consume(name),{code:'mock_egress_not_armed'});
  A(f.begin(name,3).duplicate);
  A.equal(f.count(),0);
 }finally{f.close();}
});


test('mock egress offline board demonstrates revocation after begin and original receipt readback',()=>{
 const f=setup({withMerge:true});
 try{
  const view=phase=>{
   const board=f.project();
   const cards=board.cards.map(c=>({...c,worker:({'worker-prepared':'first-demo','worker-parallel':'second-demo'})[c.worker]??null}));
   return {...board,cards,egress:{phase,first:f.read(name)?.state??null,second:f.read(other)?.state??null}};
  };
  A(f.claim(name,3).committed);A.equal(f.begin(name,4).simulation,'pending');
  const frames=[view('armed')];
  f.policy(name,{authorityEpoch:'auth-2'});
  A.throws(()=>f.consume(name),{code:'dispatch_review_changed'});
  frames.push(view('revoked'));
  A.equal(frames[1].asOfVersion,frames[0].asOfVersion);
  A(f.claim(other,5).committed);A(f.begin(other,6).committed);
  const firstProcess=f.host('accepted');
  A.equal(f.consume(other,firstProcess.j).state,'accepted');
  firstProcess.close();
  frames.push(view('parallel'));
  const nextProcess=f.host('unknown');
  const read=f.read(other,nextProcess.j);A.equal(read.state,'accepted');
  A.deepEqual(f.consume(other,nextProcess.j),{...read,duplicate:true});
  A.throws(()=>f.consume(name),{code:'dispatch_review_changed'});
  frames.push(view('readback'));
  A.equal(frames[2].asOfVersion,frames[3].asOfVersion);
  A(frames.every(x=>x.cards.find(c=>c.task==='merge').state==='blocked'&&x.egress.first==='pending'));
  A.deepEqual(frames.map(x=>x.egress.second),[null,null,'accepted','accepted']);
  A(!JSON.stringify(frames).includes(read.receipt));
  if(process.env.RIVULE_MOCK_EGRESS_REPLAY==='1')console.log('RIVULE_MOCK_EGRESS_REPLAY:'+JSON.stringify(frames));
 }finally{f.close();}
});


test('explicit closure unlocks a new fenced attempt only when atomic local storage proves no receive',()=>{
 const f=setup();
 try{
  const n=name, stale=f.one.j.inspectChoice('host',slot(n)).selection;
  f.claim(n,2);f.begin(n,3);
  f.policy(n,{budgetReviewed:false,authorityEpoch:'auth-2',canCloseMock:false});
  A.throws(()=>f.consume(n),{code:'budget_unreviewed'});
  A.throws(()=>f.closeAttempt(n,4),{code:'mock_close_not_authorized'});
  f.policy(n,{budgetReviewed:false,authorityEpoch:'auth-2'});
  A.throws(()=>f.closeAttempt(n,3),{code:'revision_conflict'});
  const raw={auth:lead,mockClose:true,expectedVersion:4,at:10,command:{type:'mock_close',id:'bogus',task:n,fence:1}};
  A.throws(()=>f.two.j.append(raw),{code:'mock_closure_required'});
  const close=f.closeAttempt(n,4);
  A.deepEqual(close,{state:'closed_no_send',receipt:null,simulation:true,duplicate:false,closeVersion:5});
  A.equal(f.project().cards.find(c=>c.task===n).state,'ready');
  A.deepEqual(f.consume(n),{state:'closed_no_send',receipt:null,simulation:true,duplicate:true});
  A.deepEqual(f.closeAttempt(n,4),{...close,duplicate:true});
  A.throws(()=>f.claim(n,5),{code:'budget_unreviewed'});
  f.policy(n,{budgetEpoch:'budget-2',authorityEpoch:'auth-2'});
  A.throws(()=>f.two.j.claimChoice('host',{...slot(n),selection:stale,id:'stale',at:11,leaseMs:50,expectedVersion:5}),{code:'dispatch_review_changed'});
  f.time(13);
  A(f.claim(n,5,{id:'claim-fresh',at:11}).committed);
  A.throws(()=>f.two.j.beginChoice('host',{...slot(n),id:'attempt-begin',at:12,expectedVersion:6}),{code:'stale_fence'});
  A(f.two.j.beginChoice('host',{...slot(n),fence:2,id:'attempt-begin',at:12,expectedVersion:6}).committed);
  A.equal(f.consume(n,f.two.j,{fence:2}).state,'accepted');
  A.equal(f.count(),2);A.equal(f.read(n).state,'closed_no_send');
  const closedOutbox=f.two.j.outboxAfter(scope,4).filter(x=>x.phase==='mock_close');
  A.deepEqual(closedOutbox,[{version:5,phase:'mock_close',task:n}]);
 }finally{f.close();}
});

test('unknown and accepted mock outcomes never turn into unsent, even with a legacy facade or a closed provider assertion',()=>{
 for(const outcome of ['unknown','accepted']){
  const f=setup();
  try{
   const n=name, second=f.host(outcome),legacy=f.host(null);
   f.claim(n,2);f.begin(n,3,second.j);f.consume(n,second.j);
   A.throws(()=>f.closeAttempt(n,4),{code:'mock_not_closable'});
   A.throws(()=>legacy.j.closeMockEgress('host',{...slot(n),id:'legacy-close',expectedVersion:4}),{code:'mock_egress_disabled'});
   const worker={scope,role:'worker',subject:base(n).profile.worker};
   A.throws(()=>legacy.j.append({auth:worker,at:7,expectedVersion:4,command:{type:'acknowledged',id:'fakeAck',task:n,fence:1,receipt:'fake-receipt'}}),{code:'mock_outcome_requires_local_evidence'});
   A(legacy.j.append({auth:worker,at:7,expectedVersion:4,command:{type:'uncertain',id:'hold',task:n,fence:1}}).committed);
   const digest='2'.repeat(64);
   const forged={verified:true,scope,task:n,fence:1,worker:worker.subject,provider:'mock-local',lane:'lane-'+n,
    key:scope+'/'+n+'/1',digest,verdict:'closed_not_sent',submitterQuiesced:true,remoteRequestClosed:true};
   A.throws(()=>legacy.j.append({auth:lead,at:8,expectedVersion:5,attestation:forged,command:{type:'reconcile',id:'fake-close',task:n,fence:1,attestation:digest}}),{code:'mock_outcome_requires_local_evidence'});
   A.equal(f.read(n).state,outcome);
   A.equal(f.project().cards.find(c=>c.task===n).state,'needs_review');
  }finally{f.close();}
 }
});

test('closure write failure rolls back the board and outbox as well; the old fixture table upgrades in place',()=>{
 const f=setup();
 try{
  f.one.db.exec('DROP TABLE lab_coord_mock_closure');
  f.claim(name,2);f.begin(name,3);
  f.one.j.prepare();A.deepEqual(f.read(name),pending);
  f.fault({sql:'INSERT INTO lab_coord_mock_closure (board,task,fence,close_v) VALUES (?,?,?,?)',after:true});
  A.throws(()=>f.closeAttempt(name,4),/fixture SQL interrupt/);
  A.equal(f.project().asOfVersion,4);A.deepEqual(f.read(name),pending);
  A.deepEqual(f.two.j.outboxAfter(scope,4),[]);
  f.fault(null);A.equal(f.closeAttempt(name,4).state,'closed_no_send');
  const reopen=f.host('unknown');reopen.j.prepare();A.equal(f.read(name,reopen.j).state,'closed_no_send');
 }finally{f.close();}
});

test('mock closure offline board contrasts confirmed not sent and unknown response',()=>{
 const f=setup({withMerge:true});
 try{
  const frame=phase=>{
   const {cards,...board}=f.project();
   return {...board,cards:cards.map(c=>({...c,worker:({'worker-prepared':'first-demo','worker-parallel':'second-demo'})[c.worker]??null})),
    closure:{phase,original:f.read(name)?.state??null,unknown:f.read(other)?.state??null,replacement:f.read(name,f.two.j,{fence:2})?.state??null}};
  };
  f.claim(name,3);f.begin(name,4);
  f.claim(other,5);f.begin(other,6);
  const remoteLookalike=f.host('unknown');
  A.equal(f.consume(other,remoteLookalike.j).state,'unknown');
  f.policy(name,{budgetReviewed:false,authorityEpoch:'auth-2'});
  A.throws(()=>f.consume(name),{code:'budget_unreviewed'});
  const frames=[frame('separate')];
  A.throws(()=>f.closeAttempt(other,7),{code:'mock_not_closable'});
  A.equal(f.closeAttempt(name,7).state,'closed_no_send');
  frames.push(frame('closed'));
  A.throws(()=>f.claim(name,8,{id:'new-claim',at:11}),{code:'budget_unreviewed'});
  f.policy(name,{budgetEpoch:'budget-2',authorityEpoch:'auth-2'});
  A(f.claim(name,8,{id:'new-claim',at:11}).committed);
  frames.push(frame('fresh'));
  A(f.two.j.beginChoice('host',{...slot(name),fence:2,id:'new-begin',at:12,expectedVersion:9}).committed);
  f.time(13);A.equal(f.consume(name,f.two.j,{fence:2}).state,'accepted');
  A.equal(f.consume(other).state,'unknown');
  frames.push(frame('replaced'));
  A.deepEqual(frames.map(x=>x.asOfVersion),[7,8,9,10]);
  A(frames.every(x=>x.cards.find(c=>c.task==='merge').state==='blocked'));
  if(process.env.RIVULE_MOCK_CLOSURE_REPLAY==='1')console.log('RIVULE_MOCK_CLOSURE_REPLAY:'+JSON.stringify(frames));
 }finally{f.close();}
});
