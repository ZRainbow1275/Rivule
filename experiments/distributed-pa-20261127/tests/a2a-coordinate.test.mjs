import test from 'node:test';import A from 'node:assert/strict';import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {makeSqlJournal} from '../storage/sql-journal.mjs';
import {dispatchA2A,assumeRemoteClosedFromList} from '../adapter/a2a-coordinate.mjs';
const digest=x=>createHash('sha256').update(x).digest('hex'),scope='launch';
const plaintext='Compare two publicly documented patch notes and report their dates.';
const digestInput=digest(plaintext);
async function bench(fault){
 const db=new DatabaseSync(':memory:');
 const sql={exec:(q,...a)=>a.length?db.prepare(q).all(...a):db.exec(q)??[]};
 let now=0,sends=0;
 const journal=makeSqlJournal({sql,transactionSync:f=>{db.exec('BEGIN IMMEDIATE');try{const x=f();db.exec('COMMIT');return x}catch(e){db.exec('ROLLBACK');throw e;}}});
 journal.prepare();
 const step=(command,profile)=>journal.append({auth:{scope,subject:profile?'caller':'lead',role:profile?'worker':'coordinator'},
 expectedVersion:journal.outboxAfter(scope).at(-1)?.version??0,at:++now,command,profile});
 step({type:'add',id:'seed',task:'ch-a',capability:'public',allowedRegions:['sg'],inputDigest:digestInput,requires:[]});
 const profile={worker:'caller',provider:'a2a',lane:'fixed-seat',dataRegions:['sg'],capabilities:['public'],ready:true,authorized:true};
 const worker=c=>step(c,profile);
 worker({type:'claim',id:'rent',task:'ch-a',worker:'caller',leaseMs:1000});
 const binding={approvedClass:'public-text',provider:'a2a',contract:'1.0.1',lane:'fixed-seat',endpointRef:'fixed-peer',inputDigest:digestInput};
 const receipts=new Map();
 const make=()=>dispatchA2A({commit:worker,clock:()=>now,task:'ch-a',fence:1,text:plaintext,binding,
 sendMessage:async x=>{sends++;A.equal(x.endpointRef,'fixed-peer');A(x.request.message.messageId.startsWith('rivule-'));
  const t={id:'T-1',contextId:'C-1',history:[x.request.message],status:{state:'TASK_STATE_COMPLETED'}};
  receipts.set(t.id,t);
  if(fault==='lost')throw Error('server created task before broken response');
  if(fault==='unrelated')return {task:{...t,history:[]}};
  return {task:t};
 }});
 return {make,binding,db,journal,receipts,sendCount:()=>sends};
}
test('correlated A2A receipt still does not count as submitted or accepted',async()=>{
 const x=await bench();try{A.equal((await x.make()).state,'provider_acknowledged');
 const p=x.journal.project({scope,selected:['ch-a'],readable:['ch-a']});A.equal(p.cards[0].state,'running');A.equal(x.sendCount(),1);}finally{x.db.close();}
});
test('server creates work and loses response; two retries leave exactly one call',async()=>{
 const x=await bench('lost');try{A.equal((await x.make()).state,'verify_original_attempt');for(const y of await Promise.all([x.make(),x.make()]))A.equal(y.state,'no_fresh_permit');
 A.equal(x.receipts.size,1);A.equal(x.sendCount(),1);A.equal(assumeRemoteClosedFromList([]),false);
 A.equal(x.journal.project({scope,selected:['ch-a'],readable:['ch-a']}).cards[0].state,'needs_review');}finally{x.db.close();}
});
test('a foreign or unrelated result does not become completion',async()=>{
 const x=await bench('unrelated');try{A.equal((await x.make()).state,'verify_original_attempt');A.equal(x.sendCount(),1);}finally{x.db.close();}
});
test('simultaneous local dispatch attempt has one transaction witness and one sender',async()=>{
 const x=await bench();try{const out=await Promise.all([x.make(),x.make()]);
 A.equal(out.filter(v=>v.state==='provider_acknowledged').length,1);
 A.equal(out.filter(v=>v.state==='no_fresh_permit').length,1);A.equal(x.sendCount(),1);
 }finally{x.db.close();}
});
