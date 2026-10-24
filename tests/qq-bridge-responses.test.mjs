import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {QQBridgeQueue} from '../src/owner/qq-integration.mjs';
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const storage={sql:{exec(sql,...a){if(sql.split(';').filter(x=>x.trim()).length>1){db.exec(sql);return {toArray:()=>[]};}return {toArray:()=>db.prepare(sql).all(...a)};}},transaction:async fn=>fn(),transactionSync:fn=>fn(),sync:async()=>{}};
 db.exec('CREATE TABLE events(revision INTEGER,receipt TEXT,source_id TEXT,payload TEXT,decision TEXT)');
 const now=1800000000000,source={source_id:'pa',enabled:true,allowed_hosts:[]},ref='12345678-1234-1234-1234-123456789abc';
 const env={QQ_ENABLED:'true',QQ_OWNER_ID:'owner',QQ_APP_ID:'123',QQ_DELIVERY_ENABLED:'true',QQ_ALLOWED_SOURCE_IDS:'["pa"]',QQ_ALLOWED_PROJECT_IDS:'["project"]'};
 const queue=new QQBridgeQueue(storage,env,'owner',[source],()=>{throw Error('no network');},()=>now);
 const proof={selectable:true,binding:'source-binding',connection_generation:1,last_verified_at:now};queue.attachAuthority(()=>proof);
 let authorized=true,commands=true;
 const event={event_id:'response-event',source_id:'pa',project_id:'project',task_id:'task',run_id:'run',branch_id:'main',kind:'response',summary:'A real user-visible response',sensitivity:'normal'};
 const receipt='bridge_'+ref,context={source_id:'pa',project_id:'project',task_id:'task',run_id:'run',branch_id:'main',thread_id:'thread'};
 const authority={event,revision:2,context,context_ref:ref,consent_revision:3,receiptId:receipt,decision:'bridge_response'};
 queue.attachMessageBridge({qqResponseAuthorized:()=>authorized,responseAuthority:()=>authorized?authority:null,preference:()=>({commands_enabled:commands}),taskAuthority:()=>null});
 db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(2,receipt,'pa',JSON.stringify(event),'bridge_response');
 return {queue,db,env,event,source,receipt,authority,proof,setAuthorized:v=>authorized=v,setCommands:v=>commands=v};
}
async function activate(f){await f.queue.initializeContinuous();f.queue.saveActivation({active:true,grantId:'grant',bindingFingerprint:'binding',startAfterRevision:1,expiresAt:1800000060000});}
test('typed response uses authoritative real revision/context, not applied task state',async t=>{
 const f=fixture(t);await activate(f);assert.equal(f.queue.enqueueResponse(f.source,f.receipt),true);
 const row=f.queue.rows('SELECT * FROM qq_continuous_outbox')[0],job=await f.queue.currentJob(row,f.queue.activation());
 assert.equal(job.job.contentKind,'bridge_response');assert.equal(job.job.responseRevision,2);assert.equal(job.job.acceptedRevision,undefined);assert.equal(job.source.applied,undefined);assert.equal(job.source.decision,'bridge_response');assert.equal(job.job.threadId,'thread');assert.match(job.job.content,/A real user-visible response/);assert.match(job.job.content,/\/rivule/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM events').get().n,1);
});
test('source response authority/consent revoke after queueing blocks current job',async t=>{
 const f=fixture(t);await activate(f);assert.equal(f.queue.enqueueResponse(f.source,f.receipt),true);f.setAuthorized(false);
 await assert.rejects(f.queue.currentJob(f.queue.rows('SELECT * FROM qq_continuous_outbox')[0],f.queue.activation()),/projection_not_authorized/);
});
test('disabled queue, activation cutoff and removed source allowlist block admission',async t=>{
 const f=fixture(t);await activate(f);f.env.QQ_DELIVERY_ENABLED='false';assert.equal(f.queue.enqueueResponse(f.source,f.receipt),false);f.env.QQ_DELIVERY_ENABLED='true';f.queue.saveActivation({...f.queue.activation(),startAfterRevision:2});assert.equal(f.queue.enqueueResponse(f.source,f.receipt),false);f.queue.saveActivation({...f.queue.activation(),startAfterRevision:1});f.env.QQ_ALLOWED_SOURCE_IDS='[]';assert.equal(f.queue.enqueueResponse(f.source,f.receipt),false);assert.equal(f.queue.rows('SELECT * FROM qq_continuous_outbox').length,0);
});
test('commands default off omits command hint but keeps response typed context',async t=>{
 const f=fixture(t);await activate(f);f.setCommands(false);assert.equal(f.queue.enqueueResponse(f.source,f.receipt),true);const job=await f.queue.currentJob(f.queue.rows('SELECT * FROM qq_continuous_outbox')[0],f.queue.activation());assert.ok(!job.job.content.includes('/rivule'));assert.equal(job.job.contentKind,'bridge_response');
});
test('ordinary task updates retain task protocol and add only registered command context',async t=>{
 const f=fixture(t);await activate(f);
 const receipt='rcpt_'+'a'.repeat(32),event={event_id:'task-event',source_id:'pa',project_id:'project',task_id:'task',run_id:'run',branch_id:'main',kind:'progress',source_status:'running',summary:'Task progress',sensitivity:'normal',project_name:'Project',task_name:'Task',occurred_at:new Date(1800000000000).toISOString()};
 f.db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(3,receipt,'pa',JSON.stringify(event),'applied');
 let authority={...f.authority,event,receiptId:receipt,revision:3};
 f.queue.attachMessageBridge({taskAuthority:()=>authority,responseAuthority:()=>null});
 assert.equal(f.queue.enqueue(event,receipt),true);
 const row=f.queue.rows('SELECT * FROM qq_continuous_outbox WHERE receipt=?',receipt)[0],job=await f.queue.currentJob(row,f.queue.activation());
 assert.equal(job.job.contentKind,'task_update');assert.equal(job.job.acceptedRevision,3);assert.equal(job.job.responseRevision,undefined);assert.equal(job.source.applied,true);assert.match(job.job.content,/\/rivule/);
 authority=null;const revoked=await f.queue.currentJob(row,f.queue.activation());assert.equal(revoked.job.contentKind,undefined);assert.ok(!revoked.job.content.includes('/rivule'));assert.notEqual(job.job.payloadHash,revoked.job.payloadHash,'precommit job comparison rejects a changed consent/rendered payload');
});
