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
const base=n=>({auth:lead,alias,readable:[n],budgetReviewed:true,authorityEpoch:'auth-1',budgetEpoch:'budget-1',inputDigest,
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
 const count=()=>one.db.prepare('SELECT COUNT(*) AS n FROM lab_coord_mock_egress').get().n;
 const visible=withMerge?[name,other,'merge']:[name,other];
 const project=()=>two.j.project({scope,selected:visible,readable:visible});
 return {one,two,host,policy,claim,begin,read,consume,count,project,time:n=>{now=n;},
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
