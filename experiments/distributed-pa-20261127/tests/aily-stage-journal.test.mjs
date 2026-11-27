import test from 'node:test';
import A from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {mkdtempSync,rmSync} from 'node:fs';
import {makeAilyStageJournal} from '../storage/aily-stage-journal.mjs';
const binding={provider:'feishu-aily',tokenKind:'verified-user',publicTextOnly:true,noConnectedTools:true,dedicatedSession:true,tenantRef:'test-tenant',userRef:'test-owner',lane:'test-aily',appId:'spring_lab__c'};
const task='dry-run',data={binding,task},approvedText='List two public product changes (mock trial).';
const inputDigest=createHash('sha256').update(approvedText).digest('hex');
const seed={...data,inputDigest};
const session={id:'session_a1',created_by:binding.userRef};
const message={id:'message_a1',session_id:session.id,sender:{sender_type:'USER',aily_id:binding.userRef},content_type:'TEXT',content:approvedText};
const run={id:'run_a1',app_id:binding.appId,session_id:session.id};
const good=data=>({status:200,json:{code:0,data}});
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'rivule-aily-')),path=join(dir,'lab.db'),dbs=new Set();
 let intercept=()=>{};
 const open=()=>{
  const db=new DatabaseSync(path);dbs.add(db);db.exec('PRAGMA busy_timeout=3000');
  const s=makeAilyStageJournal({
   sql:{exec(q,...xs){intercept(q);return q.startsWith('SELECT')?db.prepare(q).all(...xs):(db.prepare(q).run(...xs),[])}},
   transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const out=fn();db.exec('COMMIT');return out}catch(e){db.exec('ROLLBACK');throw e}}
  });
  return {s,db,close:()=>{if(dbs.delete(db))db.close();}};
 };
 t.after(()=>{for(const db of dbs)db.close();rmSync(dir,{recursive:true,force:true})});
 const one=open();one.s.prepare();
 return {...one,open,path,fail:f=>{intercept=f}};
}
const reserve=(s,expectedRevision,extra={})=>s.reserve({...data,expectedRevision,approvedText,at:10,...extra});
const observe=(s,r,response)=>s.observe({...data,expectedRevision:r.revision,mockTicket:r.mockTicket,response});
const recover=(s,expectedRevision)=>s.recoverAmbiguous({...data,expectedRevision});
async function reachMessage(s){
 A((await s.initialize(seed)).committed);
 const x=await reserve(s,0);
 A.equal((await observe(s,x,good({session}))).state,'session_recorded');
 return reserve(s,2);
}
test('independent SQLite clients allow only one original envelope per durable revision',async t=>{
 const f=fixture(t),other=f.open();await f.s.initialize(seed);
 const p=await Promise.all([reserve(f.s,0),reserve(other.s,0),reserve(f.s,0)]);
 A.equal(p.filter(x=>x.mockRequest).length,1);
 const first=p.find(x=>x.mockRequest);A.equal(first.mockRequest.path,'/open-apis/aily/v1/sessions');
 A(p.filter(x=>!x.mockRequest).every(x=>x.reason==='changed'));
 f.close();other.close();const rotated=f.open().s;
 A.deepEqual(await rotated.view(data),{revision:1,state:'session_sending',plannedReads:[]});
 A.equal((await reserve(rotated,1)).reason,'no_transition');
 A.equal((await recover(rotated,1)).state,'owner_review_no_resend');
 A.equal((await reserve(rotated,2)).mockRequest,undefined);
 A.equal((await observe(rotated,first,good({session}))).reason,'changed');
});
test('an outbox fault rolls back the reservation and discloses no mock envelope',async t=>{
 const f=fixture(t);await f.s.initialize(seed);
 f.fail(q=>{if(q.startsWith('INSERT INTO lab_aily_transition'))throw Error('simulated write fault')});
 await A.rejects(()=>reserve(f.s,0),/write fault/);
 f.fail(()=>{});
 A.deepEqual(await f.s.view(data),{revision:0,state:'ready',plannedReads:[]});
 A.equal(f.db.prepare('SELECT count(*) AS n FROM lab_aily_transition').get().n,1);
 A((await reserve(f.s,0)).mockRequest);
});
test('only a separately selected exact message replay can win once; old receipts are fenced',async t=>{
 const f=fixture(t),m=await reachMessage(f.s);
 A.equal((await f.s.observe({...data,expectedRevision:m.revision,mockTicket:'x'.repeat(64),response:good({message})})).reason,'different_attempt');
 A.equal((await recover(f.s,m.revision)).state,'message_verifying');
 A.equal((await reserve(f.s,4)).mockRequest,undefined);
 await A.rejects(()=>reserve(f.s,4,{manualReplay:true,approvedText:'Different prompt'}),/changed Aily input/);
 const second=f.open().s,opts={manualReplay:true,at:110},pair=await Promise.all([reserve(f.s,4,opts),reserve(second,4,opts)]);
 const x=pair.find(z=>z.mockRequest);
 A.equal(pair.filter(z=>z.mockRequest).length,1);A.deepEqual(x.mockRequest,m.mockRequest);A.notEqual(x.mockTicket,m.mockTicket);
 A.equal((await observe(second,m,good({message}))).reason,'changed');
 A.equal((await recover(second,x.revision)).state,'message_verifying');
 A.equal((await reserve(f.s,6,opts)).mockRequest,undefined);
});
test('lost Run stays read-only across restart; one exact result reaches review without persisting text',async t=>{
 const f=fixture(t),m=await reachMessage(f.s);
 await observe(f.s,m,good({message}));
 const x=await reserve(f.s,4);A.match(x.mockRequest.path,/\/runs$/);f.close();
 const cold=f.open();
 A.equal((await recover(cold.s,x.revision)).state,'run_verifying');
 A.equal((await reserve(cold.s,6)).mockRequest,undefined);
 A.equal((await cold.s.view(data)).plannedReads[0].method,'GET');
 const read=(expectedRevision,response)=>cold.s.reconcile({...data,expectedRevision,response});
 const metadata=x.mockRequest.body.metadata;
 A.equal((await read(6,good({has_more:true,runs:[{...run,metadata}]}))).state,'run_verifying');
 A.equal((await read(6,good({has_more:false,runs:[{...run,metadata}]}))).state,'run_recorded');
 A.equal((await read(7,good({run:{...run,status:'COMPLETED'}}))).state,'awaiting_artifact');
 const proof={id:'message_a1',session_id:session.id,run_id:run.id,sender:{sender_type:'ASSISTANT'},content_type:'TEXT',plain_text:'Verified public material',reasoning_content:'hidden'};
 const view=await cold.s.artifact({...data,expectedRevision:8,response:good({has_more:false,messages:[proof]})});
 A.deepEqual(view,{state:'artifact_pending_rivule_review',artifact:{messageId:proof.id,text:proof.plain_text}});
 const state=cold.db.prepare('SELECT entry FROM lab_aily_stage').get().entry;
 A(!state.includes(approvedText)&&!state.includes(proof.plain_text)&&!state.includes('hidden'));
 A.equal((await cold.s.view(data)).state,'awaiting_artifact');
});
test('reads, ticket reuse, and input replacement stay pinned to tenant, owner, lane, and app',async t=>{
 const f=fixture(t);A((await f.s.initialize(seed)).committed);
 A(!(await f.s.initialize(seed)).committed);
 await A.rejects(()=>f.s.initialize({...seed,inputDigest:'f'.repeat(64)}),/input was already locked/);
 const r=await reserve(f.s,0);
 for(const field of ['tenantRef','userRef','lane','appId']){
  const altered={...binding,[field]:field==='appId'?'spring_foreign__c':'different'};
  A.equal(await f.s.view({binding:altered,task}),null);
  A.equal((await f.s.observe({binding:altered,task,expectedRevision:1,mockTicket:r.mockTicket,response:good({session})})).reason,'not_found');
 }
 A.equal((await observe(f.s,r,good({session}))).state,'session_recorded');
});
test('intent and observation races admit either authoritative answer or review, never a second original session',async t=>{
 const f=fixture(t);await f.s.initialize(seed);
 const p=await reserve(f.s,0),s2=f.open().s;
 const outcomes=await Promise.all([observe(f.s,p,good({session})),recover(s2,p.revision)]);
 A.equal(outcomes.filter(x=>x.committed).length,1);
 const cur=await f.s.view(data);
 A(['session_recorded','owner_review_no_resend'].includes(cur.state));
 const q=await reserve(s2,cur.revision);
 A.notEqual(q.mockRequest?.path,'/open-apis/aily/v1/sessions');
});

test('two standalone worker processes can race the same original reservation in SQLite', {timeout:6000}, async t=>{
 const f=fixture(t);await f.s.initialize(seed);
 const a=[0,1].map(()=>fork(new URL('./fixtures/aily-stage-process.mjs',import.meta.url),[f.path],{stdio:['ignore','ignore','ignore','ipc']}));
 t.after(()=>a.forEach(x=>{if(x.exitCode===null&&x.signalCode===null)x.kill()}));
 const exited=Promise.all(a.map(x=>once(x,'exit')));
 A.deepEqual(await Promise.all(a.map(x=>once(x,'message').then(([m])=>m))),[{ready:true},{ready:true}]);
 const receipts=Promise.all(a.map(x=>once(x,'message').then(([m])=>m)));
 a.forEach(x=>x.send({...data,expectedRevision:0,approvedText,at:10}));
 const rs=await receipts;
 A.equal(rs.filter(x=>x.committed&&x.oneShot).length,1);
 A.equal(rs.filter(x=>x.reason==='changed'&&!x.oneShot).length,1);
 A.deepEqual(await exited,[[0,null],[0,null]]);
 A.equal((await f.s.view(data)).revision,1);
 A.equal(f.db.prepare('SELECT count(*) AS n FROM lab_aily_transition').get().n,2);
});
