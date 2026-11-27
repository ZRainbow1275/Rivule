import test from 'node:test';import A from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {makeSqlJournal} from '../storage/sql-journal.mjs';
const source={scope:'fixture',subject:'lead',role:'coordinator'}, worker={scope:'fixture',subject:'w',role:'worker'};
const binding={worker:'w',provider:'cue',lane:'one',dataRegions:['sg'],capabilities:['text'],ready:true,authorized:true};
const subject={task:'synthetic-task',id:'add',type:'add',inputDigest:'a'.repeat(64),allowedRegions:['sg'],capability:'text',requires:[]};
function setup(){
 const db=new DatabaseSync(':memory:');let fault=false;
 const make=()=>makeSqlJournal({
  sql:{exec(q,...xs){if(fault&&q.startsWith('INSERT INTO lab_coord_outbox'))throw new Error('outbox failed');
   if(q.startsWith('SELECT'))return db.prepare(q).all(...xs);db.prepare(q).run(...xs);return []}},
  transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}
 });
 const store=make();store.prepare();
 const add=(t=store)=>t.append({auth:source,command:subject,expectedVersion:0,at:1});
 const view=(t=store)=>t.project({scope:'fixture',selected:[subject.task],readable:[subject.task]});
 return {store,db,make,add,view,fault:x=>{fault=x}};
}
test('outbox insertion failure rolls back the task event and permit together',()=>{
 const f=setup();try{
  f.fault(true);A.throws(()=>f.add(),/outbox failed/);
  A.deepEqual(f.view().cards,[]);A.deepEqual(f.store.outboxAfter('fixture'),[]);
  f.fault(false);A(f.add().committed);A.equal(f.view().cards[0].state,'ready');
  A.deepEqual(f.store.outboxAfter('fixture'),[{version:1,phase:'add',task:subject.task}]);
 }finally{f.db.close()}
});
test('cold facade sees outbox and exact intent; repeating committed begin returns no permit',()=>{
 const f=setup();try{
  f.add();
  const c={auth:worker,profile:binding,expectedVersion:1,at:2,command:{type:'claim',id:'claim',task:subject.task,worker:'w',leaseMs:100}};
  const b={...c,expectedVersion:2,at:3,command:{type:'begin',id:'begin',task:subject.task,fence:1}};
  A(f.store.append(c).committed);const write=f.store.append(b);A(write.committed&&write.permit);
  const cold=f.make();const repeated=cold.append(b);
  A(repeated.duplicate&&!repeated.committed&&!repeated.permit);A.equal(f.view(cold).cards[0].state,'submitting');
  A.deepEqual(cold.outboxAfter('fixture',2),[{version:3,phase:'begin',task:subject.task}]);
  A.deepEqual(cold.outboxAfter('other-board'),[]);
  A.throws(()=>cold.append({...c,command:{...c.command,id:'claim-anew'}}),/revision_conflict/);
 }finally{f.db.close()}
});
