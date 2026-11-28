import test from 'node:test';
import A from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {makeSqlJournal} from '../storage/sql-journal.mjs';

const scope='delivery-order', profile={
 worker:'helper',provider:'glean-durable',lane:'original-lane',dataRegions:['sg'],
 capabilities:['text'],authorized:true,ready:true
};
const ids=['public-source','independent','merge'];
const artifact='c'.repeat(64), evidence='e'.repeat(64);
function fixture(run){
 const root=mkdtempSync(join(tmpdir(),'rivule-delivery-')), path=join(root,'coordinator.sqlite'), dbs=[];
 function open(){
  const db=new DatabaseSync(path);dbs.push(db);
  return makeSqlJournal({
   sql:{exec(q,...args){if(q.startsWith('SELECT'))return db.prepare(q).all(...args);db.prepare(q).run(...args);return [];}},
   transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v}catch(e){db.exec('ROLLBACK');throw e}}
  });
 }
 let at=0;
 try{
  const active=open();active.prepare();const cold=open();
  const view=(store=active)=>store.project({scope,selected:ids,readable:ids});
  const post=(command,{store=active,role='coordinator',expectedVersion=view(store).asOfVersion}={})=>store.append({
   command,expectedVersion,at:++at,profile,
   auth:{scope,role,subject:role==='coordinator'?'lead':profile.worker}
  });
  const worker=(command,opts={})=>post(command,{...opts,role:'worker'});
  for(const task of ids)post({type:'add',id:'add-'+task,task,capability:'text',allowedRegions:['sg'],inputDigest:'d'.repeat(64),requires:task==='merge'?ids.slice(0,2):[]});
  const begin=(task,receipt)=>{
   worker({type:'claim',id:'claim-'+task,task,worker:profile.worker,leaseMs:450});
   const result=worker({type:'begin',id:'begin-'+task,task,fence:1});
   A(result.committed&&result.permit);
   worker({type:'acknowledged',id:'ack-'+task,task,fence:1,receipt});
  };
  begin(ids[0],'fixture-source-receipt');
  const ok={type:'reported',id:'report-source',task:ids[0],fence:1,receipt:'fixture-source-receipt',artifact};
  const fail={type:'failed',id:'failed-source',task:ids[0],fence:1,receipt:ok.receipt,evidence};
  run({active,cold,view,post,worker,begin,ok,fail});
 }finally{for(const db of dbs)db.close();rmSync(root,{recursive:true,force:true});}
}
test('settled offline board holds accepted work through stale and fresh late failures',()=>fixture(c=>{
 const {active,cold,view,post,worker,begin,ok,fail}=c, frames=[];
 const capture=(label,failedIgnored)=>frames.push({...view(cold),label,settled:{failedIgnored}});
 const previous=view().asOfVersion, card=(task)=>view().cards.find(c=>c.task===task);
 worker(ok);capture('来源已交稿，主 Agent 还未验收。',0);
 const pending=view();
 A.throws(()=>worker(fail,{store:cold}),{code:'receipt_mismatch'});
 A.deepEqual(view(),pending);
 post({type:'accept',id:'accept-source',task:ids[0],fence:1,artifact});
 begin(ids[1],'fixture-independent-receipt');
 capture('来源已验收。同一个席位已经在处理独立任务。',0);
 const settled=view(),outbox=active.outboxAfter(scope);
 // Simulate the stale callback worker retrying only its write against a new
 // revision. Neither rejected write becomes a journal entry or a new send.
 A.throws(()=>worker(fail,{store:cold,expectedVersion:previous}),{code:'revision_conflict'});
 A.throws(()=>worker(fail,{store:cold}),{code:'receipt_mismatch'});
 const repeat=worker(ok,{store:cold,expectedVersion:previous});
 A(repeat.duplicate&&!repeat.committed&&!repeat.permit);
 A.deepEqual(view(),settled);A.deepEqual(cold.outboxAfter(scope),outbox);
 A.equal(card(ids[0]).state,'accepted');A.equal(card(ids[1]).state,'running');
 capture('旧失败回包被拒，来源仍是已验收，独立任务继续执行。',1);
 const peerArtifact='a'.repeat(64);
 worker({type:'reported',id:'report-peer',task:ids[1],fence:1,receipt:'fixture-independent-receipt',artifact:peerArtifact});
 A.equal(card('merge').state,'blocked');
 post({type:'accept',id:'accept-peer',task:ids[1],fence:1,artifact:peerArtifact});
 A.equal(card('merge').state,'ready');
 A.equal(active.outboxAfter(scope).filter(e=>e.phase==='begin').length,2);
 capture('独立任务也通过验收，两份结果才一起解锁合稿。',1);
 if(process.env.RIVULE_SETTLED_REPLAY==='1')console.log('RIVULE_SETTLED_REPLAY:'+JSON.stringify(frames));
}));
test('a failure that actually arrived first is not erased by a later success',()=>fixture(({active,cold,view,worker,ok,fail})=>{
 const write=worker(fail);A(write.committed&&!write.permit);
 const before=view(),outbox=active.outboxAfter(scope);
 A.equal(before.cards.find(c=>c.task===ids[0]).state,'failed');
 A.throws(()=>worker(ok,{store:cold}),{code:'receipt_mismatch'});
 const repeat=worker(fail,{store:cold,expectedVersion:0});
 A(repeat.duplicate&&!repeat.committed&&!repeat.permit);
 A.deepEqual(view(cold),before);A.deepEqual(cold.outboxAfter(scope),outbox);
 A.equal(before.cards.find(c=>c.task==='merge').state,'blocked');
}));
