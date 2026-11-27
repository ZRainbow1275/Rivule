import test from 'node:test';
import A from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeSqlJournal} from '../storage/sql-journal.mjs';
import {makeMuseScopedFixture} from '../storage/muse-scoped-fixture.mjs';

const board='split-board',task='assigned-a',key=Buffer.alloc(32,111),artifact='a'.repeat(64);
const coordinator={scope:board,role:'coordinator',subject:'supervisor'};
const authorities=new Set(['pa:assignment:read','pa:assignment:claim','pa:assignment:report']);
function principal(subject='seat-a',options={}){
 const profile={provider:'muse-personal',worker:subject,lane:'lane-'+subject,ready:true,authorized:true,
  capabilities:['public-research'],dataRegions:['us']};
 return {board,subject,policyEpoch:'initial',taskIds:new Set([task]),rights:authorities,active:true,provider:'muse-personal',profile,...options};
}
function handles(file,resolve,failure=()=>false,at=()=>100){
 const db=new DatabaseSync(file);db.exec('PRAGMA busy_timeout=5000');
 const sql={exec:(q,...a)=>q.startsWith('SELECT')?db.prepare(q).all(...a):(a.length?db.prepare(q).run(...a):db.exec(q),[])};
 const transactionSync=f=>{db.exec('BEGIN IMMEDIATE');try{const out=f();if(failure())throw Error('forced rollback');db.exec('COMMIT');return out}catch(e){db.exec('ROLLBACK');throw e}};
 const opts={sql,transactionSync,resolve,clock:at,validatorKey:key};
 const external=makeMuseScopedFixture({...opts,enabled:true});
 const store=makeSqlJournal(opts);
 return {external,store,db,opts};
}
function env(t){
 const dir=mkdtempSync(join(tmpdir(),'muse-scoped-')),file=join(dir,'db.sqlite'),instances=[];
 t.after(()=>{for(const x of instances)x.db.close();rmSync(dir,{recursive:true,force:true})});
 let state=principal(),abort=false,clock=100;
 const open=(resolver=()=>state)=>{const h=handles(file,resolver,()=>abort,()=>clock);instances.push(h);return h};
 const w=open();function put(command,auth=coordinator,profile){
  const p=w.store.project({scope:board,selected:[],readable:[]});
  return w.store.append({auth,at:clock,expectedVersion:p.asOfVersion,command,profile});
 }
 const add=(t,requires=[])=>put({type:'add',task:t,id:'add-'+t,inputDigest:artifact,capability:'public-research',allowedRegions:['us'],requires});
 return {...w,open,put,add,file,set:v=>{state=v},abort:v=>{abort=v},at:v=>{clock=v}};
}
const list=h=>h.external.list({});
const row=h=>list(h).cards.find(c=>c.task===task);
const claim=(h,event='take')=>({task,eventId:event,validator:row(h).validator});
function ack(h){
 const p=principal(),a={scope:board,subject:p.subject,role:'worker'};
 const b=h.put({type:'begin',id:'host-begin',task,fence:1},a,p.profile);
 A(b.permit);
 h.put({type:'acknowledged',id:'host-ack',task,fence:1,receipt:'exact-work'},a);
}
if(!isMainThread){
 const who=workerData.who, h=handles(workerData.file,()=>principal(who)),sync=new Int32Array(workerData.barrier);
 parentPort.postMessage({ready:true});
 Atomics.wait(sync,0,0,7000);
 try{parentPort.postMessage(h.external.claim({},workerData.input));}
 catch(e){parentPort.postMessage({error:e.code??e.message});}
 finally{h.db.close();}
}else{
 test('M01 unrelated traffic leaves list byte-identical and scoped claim still valid; no public revision or permit',t=>{
  const h=env(t);h.add(task);const before=list(h),i=claim(h);
  h.add('other-private'); A.deepEqual(list(h),before);
  A.deepEqual(h.external.claim({},i),{state:'leased'});
  A.deepEqual(h.open().external.claim({},i),{state:'already_observed'});
  A.equal(h.db.prepare('SELECT COUNT(*) AS n FROM lab_coord_event').get().n,3);
  A.throws(()=>h.external.claim({},{...i,validator:row(h).validator}),{code:'assignment_conflict'});
  A(!JSON.stringify(list(h)).includes('other-private'));A(!('asOfVersion'in list(h)));
 });
 test('M02 simultaneous same-task claims from two authorized seats grant exactly one lease',async t=>{
  const h=env(t);h.add(task);
  const b=h.open(()=>principal('seat-b')),barrier=new SharedArrayBuffer(4),sync=new Int32Array(barrier),workers=[],ready=[],done=[];
  for(const [who,input] of [['seat-a',claim(h)],['seat-b',claim(b)]]){
   const w=new Worker(new URL(import.meta.url),{workerData:{who,input,barrier,file:h.file}});workers.push(w);
   ready.push(new Promise((yes,no)=>{w.once('message',m=>m.ready?yes():no(Error(JSON.stringify(m))));w.once('error',no)}));
   done.push(new Promise((yes,no)=>{w.on('message',m=>{if(!m.ready)yes(m)});w.once('error',no)}));
  }
  try{
   await Promise.all(ready);Atomics.store(sync,0,1);Atomics.notify(sync,0);
   const rs=await Promise.all(done);
   A.equal(rs.filter(r=>r.state==='leased').length,1);A.equal(rs.filter(r=>r.error==='assignment_conflict').length,1);
   A.equal(h.db.prepare('SELECT COUNT(*) AS n FROM lab_muse_lease').get().n,1);
  }finally{await Promise.all(workers.map(w=>w.terminate()));}
 });
 test('M03 authorized exact report uses committed receipt; repeats and changes cannot resubmit',t=>{
  const h=env(t);h.add(task);h.external.claim({},claim(h));ack(h);
  const r={task,eventId:'result-a',validator:row(h).validator,fence:1,receipt:'exact-work',artifact};
  A.throws(()=>h.external.report({},{...r,receipt:'not-ours'}),{code:'assignment_conflict'});
  h.add('private-event');
  A.deepEqual(h.external.report({},r),{state:'awaiting_coordinator_review'});
  A.deepEqual(h.open().external.report({},r),{state:'already_observed'});
  A.throws(()=>h.external.report({},{...r,artifact:'b'.repeat(64)}),{code:'assignment_conflict'});
  A.equal(row(h).state,'reported');
 });
 test('M04 revocation and re-enrollment deny old preconditions, results and exact replay',t=>{
  const h=env(t);h.add(task);const i=claim(h);h.external.claim({},i);ack(h);
  const r={task,eventId:'result-a',validator:row(h).validator,fence:1,receipt:'exact-work',artifact};const cold=h.open();
  h.set(principal('seat-a',{active:false}));
  A.throws(()=>list(cold),{code:'not_authorized'});
  A.throws(()=>cold.external.claim({},i),{code:'not_authorized'});
  A.throws(()=>cold.external.report({},r),{code:'not_authorized'});
  h.set(principal('seat-a',{policyEpoch:'new'}));
  A.throws(()=>cold.external.claim({},i),{code:'assignment_conflict'});
  A.throws(()=>cold.external.report({},r),{code:'assignment_conflict'});
  A.throws(()=>cold.external.report({},{...r,validator:row(cold).validator}),{code:'assignment_conflict'});
 });
 test('M05 transaction abort rolls back both lease decision and intent; one retry can commit',t=>{
  const h=env(t);h.add(task);const before=list(h),i=claim(h);
  h.abort(true);A.throws(()=>h.external.claim({},i),/rollback/);h.abort(false);
  const fresh=h.open();A.deepEqual(list(fresh),before);
  A.equal(h.db.prepare('SELECT COUNT(*) AS n FROM lab_muse_intent').get().n,0);
  A.deepEqual(fresh.external.claim({},i),{state:'leased'});
 });
 test('M06 hidden prerequisite alters visible readiness, without naming it; disabled mode has no side-effects',t=>{
  const h=env(t);A.throws(()=>makeMuseScopedFixture(h.opts),{code:'offline_bridge_disabled'});
  h.add('private-prerequisite');h.add(task,['private-prerequisite']);const blocked=claim(h);
  A.equal(row(h).state,'blocked');A(!JSON.stringify(list(h)).includes('private-prerequisite'));
  A.throws(()=>h.external.claim({},blocked),{code:'assignment_conflict'});
  const w={scope:board,subject:'anon',role:'worker'},profile={worker:w.subject,lane:'other-lane',provider:'fixture-peer',dataRegions:['us'],capabilities:['public-research'],ready:true,authorized:true};
  h.put({type:'claim',id:'peer-lease',task:'private-prerequisite',worker:w.subject,leaseMs:1000},w,profile);
  h.put({type:'begin',id:'peer-begin',task:'private-prerequisite',fence:1},w,profile);
  h.put({type:'acknowledged',id:'peer-ack',task:'private-prerequisite',fence:1,receipt:'peer-r'},w);
  h.put({type:'reported',id:'peer-report',task:'private-prerequisite',fence:1,receipt:'peer-r',artifact},w);
  h.put({type:'accept',id:'peer-accept',task:'private-prerequisite',fence:1,artifact});
  A.equal(row(h).state,'ready');A.throws(()=>h.external.claim({},blocked),{code:'assignment_conflict'});
  A.deepEqual(h.external.claim({},claim(h)),{state:'leased'});
 });
}
