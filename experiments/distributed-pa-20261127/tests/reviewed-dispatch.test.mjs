import test from 'node:test';
import A from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeSqlJournal} from '../storage/sql-journal.mjs';

const scope='review-sandbox',task='original',other='independent';
const owner={scope,subject:'lead',role:'coordinator'};
const inputDigest='f'.repeat(64);
const alias='fallback';
const baseline={auth:owner,readable:[task],alias,budgetReviewed:true,
 authorityEpoch:'authority-1',budgetEpoch:'budget-1',inputDigest,
 profile:{worker:'worker-cn',provider:'mock-cn',lane:'lane-1',dataRegions:['cn-mainland'],
  capabilities:['text'],authorized:true,ready:true}};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'rivule-choice-')),path=join(dir,'mock.sqlite');
 const writer=new DatabaseSync(path),reader=new DatabaseSync(path);
 let failOutbox=false;
 const resolve=(db,request,query)=>{
  // Relative to this connection's active transaction; update via a second
  // SQLite connection. While policies change board version stays the same.
  A.equal(db.isTransaction,true);
  const row=db.prepare('SELECT body FROM local_mock_review').get();
  if(request!=='host-session'||query.task!==task||query.alias!==alias||!row)return null;
  return JSON.parse(row.body);
 };
 function make(db,reviewed=true){
  return makeSqlJournal({
   sql:{exec(q,...args){
    if(failOutbox&&q.startsWith('INSERT INTO lab_coord_outbox'))throw Error('injected outbox failure');
    return q.startsWith('SELECT')?db.prepare(q).all(...args):(db.prepare(q).run(...args),[]);
   }},
   transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const x=fn();db.exec('COMMIT');return x;}
    catch(e){db.exec('ROLLBACK');throw e;}},
   ...reviewed&&{reviewedDispatch:{validatorKey:Buffer.alloc(32,27),resolve:(req,q)=>resolve(db,req,q)}}
  });
 }
 const one=make(writer),two=make(reader),legacy=make(reader,false);
 one.prepare();writer.exec('CREATE TABLE local_mock_review(body TEXT NOT NULL)');
 writer.prepare('INSERT INTO local_mock_review VALUES (?)').run(JSON.stringify(baseline));
 const policy=(patch={})=>writer.prepare('UPDATE local_mock_review SET body=?').run(JSON.stringify({...baseline,...patch}));
 const add=(name,expectedVersion)=>one.append({auth:owner,at:expectedVersion+1,expectedVersion,command:{
  id:'add-'+name,type:'add',task:name,inputDigest,allowedRegions:['cn-mainland'],capability:'text',requires:[]}});
 add(task,0);add(other,1);
 const project=()=>two.project({scope,selected:[task,other],readable:[task,other]});
 const spec={scope,task,alias};
 const inspect=()=>one.inspectChoice('host-session',spec);
 const claim=(selection,extra={})=>two.claimChoice('host-session',{...spec,selection,id:'claim',at:3,leaseMs:100,expectedVersion:2,...extra});
 const begin=(extra={})=>two.beginChoice('host-session',{...spec,id:'begin',at:4,expectedVersion:3,fence:1,...extra});
 return {one,two,legacy,inspect,claim,begin,policy,project,fail:v=>{failOutbox=v},
  close:()=>{reader.close();writer.close();rmSync(dir,{recursive:true,force:true});}};
}
test('the same board revision cannot make an old seat choice valid after policy changes',()=>{
 const f=fixture();
 try{
  const {selection}=f.inspect();
  A.throws(()=>f.two.claimChoice('unbound',{scope,task,alias,selection,id:'x',at:3,leaseMs:100,expectedVersion:2}),{code:'not_authorized'});
  A.throws(()=>f.claim('forged'),{code:'dispatch_review_changed'});
  for(const [policy,code] of [
   [{budgetReviewed:false},'budget_unreviewed'],
   [{budgetEpoch:'budget-2'},'dispatch_review_changed'],
   [{authorityEpoch:'authority-2'},'dispatch_review_changed'],
   [{readable:[other]},'not_authorized'],
   [{inputDigest:'a'.repeat(64)},'review_input_changed'],
   [{profile:{...baseline.profile,lane:'lane-2'}},'dispatch_review_changed'],
   [{profile:{...baseline.profile,provider:'mock-changed'}},'dispatch_review_changed'],
   [{profile:{...baseline.profile,dataRegions:['cn-mainland','sg']}},'region_mismatch']
  ]){
   f.policy(policy);A.throws(()=>f.claim(selection),{code});
   A.equal(f.project().asOfVersion,2);
  }
  f.policy({budgetEpoch:'budget-2'});
  const fresh=f.inspect();
  A.notEqual(fresh.selection,selection);
  A.deepEqual(Object.keys(fresh),['task','alias','selection']);
  const leased=f.claim(fresh.selection);
  A(leased.committed&&!leased.permit);
  A.equal(f.project().cards.find(x=>x.task===task).state,'leased');
  A.throws(()=>f.claim(fresh.selection),{code:'not_claimable'});
  A.deepEqual(f.two.outboxAfter(scope,2),[{version:3,phase:'claim',task}]);
 }finally{f.close();}
});

test('before durable begin revalidate the pinned budget, reviewer, exact draft and provider; legacy facades cannot bypass it',()=>{
 const f=fixture();
 try{
  f.claim(f.inspect().selection);
  const raw={auth:{scope,role:'worker',subject:baseline.profile.worker},profile:baseline.profile,
   review:{alias,reviewer:owner.subject,authorityEpoch:'authority-1',budgetEpoch:'budget-1',inputDigest},
   at:4,expectedVersion:3,command:{id:'raw',type:'begin',task,fence:1}};
  for(const facade of [f.two,f.legacy])A.throws(()=>facade.append(raw),{code:'dispatch_review_required'});
  for(const [policy,code] of [
   [{budgetReviewed:false},'budget_unreviewed'],
   [{budgetEpoch:'budget-2'},'dispatch_review_changed'],
   [{authorityEpoch:'authority-2'},'dispatch_review_changed'],
   [{auth:{...owner,subject:'other-coordinator'}},'dispatch_review_changed'],
   [{profile:{...baseline.profile,authorized:false}},'worker_unavailable'],
   [{profile:{...baseline.profile,provider:'mock-other'}},'route_changed'],
   [{profile:{...baseline.profile,lane:'lane-2'}},'route_changed'],
   [{inputDigest:'a'.repeat(64)},'review_input_changed']
  ]){
   f.policy(policy);A.throws(()=>f.begin(),{code});
   A.equal(f.project().asOfVersion,3);A.equal(f.project().cards.find(x=>x.task===task).state,'leased');
   A.deepEqual(f.two.outboxAfter(scope,3),[]);
  }
  f.policy();
  A.throws(()=>f.begin({fence:2}),{code:'stale_fence'});
  f.fail(true);A.throws(()=>f.begin(),/injected outbox failure/);
  A.equal(f.project().cards.find(x=>x.task===task).state,'leased');A.deepEqual(f.two.outboxAfter(scope,3),[]);
  f.fail(false);
  const committed=f.begin();
  A.equal(committed.permit.inputDigest,inputDigest);
  A.equal(committed.permit.provider,baseline.profile.provider);
  A(committed.committed);A.equal(f.project().cards.find(x=>x.task===task).state,'submitting');
  const retry=f.begin();A(retry.duplicate&&!retry.committed&&!retry.permit);
  A.deepEqual(f.two.outboxAfter(scope,3),[{version:4,phase:'begin',task}]);
 }finally{f.close();}
});

test('a held selection never blocks an independent task on an independent lane',()=>{
 const f=fixture();
 try{
  f.claim(f.inspect().selection);f.policy({budgetReviewed:false});
  const profile={...baseline.profile,worker:'second',lane:'second-lane'};
  const auth={scope,role:'worker',subject:profile.worker};
  f.legacy.append({auth,profile,at:4,expectedVersion:3,command:{id:'other-claim',type:'claim',task:other,worker:profile.worker,leaseMs:100}});
  const r=f.legacy.append({auth,profile,at:5,expectedVersion:4,command:{id:'other-begin',type:'begin',task:other,fence:1}});
  A(r.committed&&r.permit);A.equal(r.permit.task,other);
  A.throws(()=>f.begin({at:6,expectedVersion:5}),{code:'budget_unreviewed'});
  A.deepEqual(f.project().cards.map(x=>[x.task,x.state]),[[other,'submitting'],[task,'leased']]);
 }finally{f.close();}
});

test('lease expiration and fresh review can unblock the original task without accepting an old selection',()=>{
 const f=fixture();
 try{
  const first=f.inspect().selection;
  f.claim(first);f.policy({budgetEpoch:'budget-2'});
  A.throws(()=>f.begin(),{code:'dispatch_review_changed'});
  f.one.append({auth:owner,at:103,expectedVersion:3,command:{id:'expire',type:'expire',task,fence:1}});
  A.equal(f.project().cards.find(x=>x.task===task).state,'ready');
  A.throws(()=>f.claim(first,{id:'claim2',at:104,expectedVersion:4}),{code:'dispatch_review_changed'});
  f.claim(f.inspect().selection,{id:'claim2',at:104,expectedVersion:4});
  A.throws(()=>f.begin({at:105,expectedVersion:5}),{code:'stale_fence'});
  A(f.begin({at:105,expectedVersion:5,fence:2}).committed);
 }finally{f.close();}
});
