import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const raw=readFileSync(new URL('../src/gateway/worker.mjs',import.meta.url),'utf8');
const sandbox=vm.createContext({structuredClone,TextEncoder,TextDecoder,EventTarget,URL,Response,Request,AbortSignal,setTimeout,clearTimeout,crypto:webcrypto,fetch(){throw Error('offline only');}});
vm.runInContext(raw.replace('import { DurableObject } from "cloudflare:workers";','class DurableObject {}').replace('export { QQGatewayObject, worker_default as default };','')+'\nglobalThis.subject={RivuleContinuous,continuousRequest,verifyResponseAuthority,hmac,check,hash};',sandbox);
const {RivuleContinuous:C,continuousRequest,verifyResponseAuthority,hmac,check,hash}=sandbox.subject;
async function fixture(){
 let now=400000,posts=0;const state={};
 const binding={ownerId:'owner',appId:'123',userOpenId:'recipient',confirmedAt:100};
 const permission={kind:'authenticated_C2C_MSG_RECEIVE',eventKey:'permission',revision:1,confirmedAt:100,bindingFingerprint:'binding',sessionFingerprint:'session',eventAt:now,receivedAt:now};
 const context={enabled:true,running:true,ready:true,healthy:true,credentialsCurrent:true,ownerId:'owner',appId:'123',binding,bindingFingerprint:'binding',projectIds:['project'],remainingMs:7200000,runtimeLimitMs:7200000,budgetRevision:0,runtimeEpoch:'runtime',permission,permissionRevision:1,permissionSessionFingerprint:'session',probe:{kind:'isolated_active_probe_observation',bindingFingerprint:'binding',confirmedAt:100,permissionRevision:1,receipt:{state:'sent',messageId:'proof'},checkedAt:now,validUntil:now+300000}};
 const store={transaction:async fn=>fn(state)};
 const ctl=new C.ContinuousDeliveryController({store,command:async fn=>fn(),context:()=>context,acquireToken:async()=> 'token',post:async()=>{posts++;return {state:'sent',messageId:'provider-id'};},random:()=> 'challenge-012345678901234567890123456789',now:()=>now});
 const g=await ctl.enroll({ownerAuthenticated:true,interactionId:'approval',policyFingerprint:JSON.stringify(C.POLICY),policyRevision:C.POLICY.revision,budgetRevision:0,backlog:'new_only',startAfterRevision:4,expiresAt:now+300000});
 await ctl.acknowledgeProducer({approvalInteractionId:'approval',grantId:g.id,startAfterRevision:4});
 const job={intentId:'intent',sourceId:'source',sourceGeneration:1,sourceBindingDigest:'source-binding',projectId:'project',receiptId:'receipt',eventId:'response-message',responseRevision:5,payloadHash:await hash('Normal response'),content:'Normal response',grantId:g.id,bindingFingerprint:'binding',contentKind:'bridge_response',contextRef:'context',consentRevision:1,threadId:'thread'};
 const source={selectable:true,enabled:true,sourceId:'source',generation:1,bindingDigest:'source-binding',verifiedAt:now,receiptId:'receipt',eventId:'response-message',responseRevision:5,projectAllowed:true,projectId:'project',sensitivity:'normal',kind:'response',payloadHash:job.payloadHash,decision:'bridge_response',registeredContext:true,scope:'task_context_only',mode:'every_response',contextRef:'context',consentRevision:1,threadId:'thread'};
 const policy={sourceId:'source',sourceGeneration:1,sourceBindingDigest:'source-binding',projectId:'project',contextRef:'context',consentRevision:1,grantId:g.id,bindingFingerprint:'binding',expiresAt:now+300000,enabled:true};
 const actor={continuous:ctl,store,config:()=>({ownerId:'owner',appId:'123'}),env:{QQ_BRIDGE_SECRET:'offline-bridge-secret-abcdefghijklmnopqrstuvwxyz'},now:()=>now};
 async function call(operation,payload,domain='rivule-qq-request-v2'){const body=JSON.stringify({version:2,timestamp:now,ownerId:'owner',appId:'123',operation,payload});return check(actor.env.QQ_BRIDGE_SECRET,'rivule-qq-response-v2',await continuousRequest(actor,{body,signature:await hmac(actor.env.QQ_BRIDGE_SECRET,domain,body)}));}
 let ownerConsent=null,authorityReads=0;
 const endpoint={async fetch(request){authorityReads++;assert.equal(request.url,'https://rivule-owner.internal/internal/qq-response-authority');assert.equal(request.redirect,'manual');
  const packet=await request.json(),e=await check(actor.env.QQ_BRIDGE_SECRET,'rivule-qq-response-authority-request-v1',packet);
  const authorized=ownerConsent?.enabled===true&&['sourceId','sourceGeneration','sourceBindingDigest','projectId','contextRef','consentRevision','grantId','bindingFingerprint'].every(k=>ownerConsent[k]===e.job[k]);
  const body=JSON.stringify({version:1,nonce:e.nonce,requestHash:await hash(packet.body),authorized,validUntil:now+30000});
  return new Response(JSON.stringify({body,signature:await hmac(actor.env.QQ_BRIDGE_SECRET,'rivule-qq-response-authority-response-v1',body)}));
 }};
 ctl.verifyResponse=(job,context,grant)=>verifyResponseAuthority(actor,job,context,grant);
 const authorize=async policy=>{ownerConsent=structuredClone(policy);actor.env.QQ_RESPONSE_AUTHORITY_ENABLED='true';actor.env.QQ_RESPONSE_AUTHORITY=endpoint;};
 const permit=p=>({intentId:job.intentId,challenge:p.challenge,expiresAt:p.expiresAt,grantRevision:p.grantRevision,payloadHash:job.payloadHash});
 return {state,context,ctl,actor,job,source,policy,call,permit,authorize,endpoint,authorityReads:()=>authorityReads,posts:()=>posts,advance:n=>now+=n};
}
test('legacy grant denies responses; independent fixed-binding owner verification permits exact response and provider receipt only',async()=>{
 const f=await fixture();let r=await f.call('response_prepare',{job:f.job,source:f.source});assert.equal(r.result.diagnostic.code,'response_consent_required');assert.equal(f.posts(),0);
 await f.authorize(f.policy);r=await f.call('response_prepare',{job:f.job,source:f.source});assert.equal(r.result.state,'prepared');
 await assert.rejects(f.call('commit',{intentId:'intent',permit:f.permit(r.result),source:f.source}),/protocol_kind_mismatch/);assert.equal(f.posts(),0);
 const sent=await f.call('response_commit',{intentId:'intent',permit:f.permit(r.result),source:f.source});assert.equal(sent.result.reason,'provider_accepted');assert.equal(sent.result.state,'sent');assert.equal(sent.result.recipientConfirmed,undefined);assert.equal(f.posts(),1);
 await f.call('response_commit',{intentId:'intent',permit:f.permit(r.result),source:f.source});assert.equal(f.posts(),1);
});
test('response source cannot self mint policy, forge context, use stale cursor, or cross signature domains',async()=>{
 for(const change of [{contextRef:'other'},{responseRevision:4},{threadId:'other'},{registeredContext:false},{scope:'general_conversation'},{kind:'task'},{consentRevision:2}]){
  const f=await fixture();await f.authorize(f.policy);const r=await f.call('response_prepare',{job:f.job,source:{...f.source,...change}});assert.equal(r.result.state,'suppressed');assert.equal(f.posts(),0);
 }
 const f=await fixture();await assert.rejects(f.call('response_policy',f.policy,'rivule-qq-web-request-v1'));assert.equal(f.state.qqContinuous.responsePolicies,undefined);
 await f.authorize(f.policy);const wrong=await f.call('prepare',{job:f.job,source:f.source});assert.equal(wrong.result.diagnostic.code,'protocol_kind_mismatch');
});
test('revocation, expiry, runtime change and source revocation between prepare/commit all stop sends',async()=>{
 for(const mutation of [async f=>f.authorize({...f.policy,consentRevision:2,enabled:false}),async f=>f.advance(300001),async f=>{f.context.runtimeEpoch='new';},async f=>{f.source.revoked=true;}]){
  const f=await fixture();await f.authorize(f.policy);const prepared=(await f.call('response_prepare',{job:f.job,source:f.source})).result;await mutation(f);
  const r=await f.call('response_commit',{intentId:'intent',permit:f.permit(prepared),source:f.source});assert.equal(r.result.state,'suppressed');assert.equal(f.posts(),0);
 }
});
test('response malformed schema and raw secret text are rejected before outbound work',async()=>{
 for(const patch of [{acceptedRevision:5},{content:'password=secret-value'},{contentKind:'unknown'}]){
  const f=await fixture();await f.authorize(f.policy);const job={...f.job,...patch};job.payloadHash=await hash(job.content);const r=await f.call('response_prepare',{job,source:{...f.source,payloadHash:job.payloadHash}});assert.equal(r.result.state,'suppressed');assert.equal(f.posts(),0);
 }
});
test('command authority is read-only, exact current recipient and runtime limited',async()=>{
 const f=await fixture(),before=JSON.stringify(f.state);const r=(await f.call('command_authority',null)).result;assert.equal(r.active,true);assert.equal(r.userOpenId,'recipient');assert.equal(r.generation,'runtime');assert.equal(JSON.stringify(f.state),before);f.context.running=false;assert.equal((await f.call('command_authority',null)).result.active,false);assert.equal(f.posts(),0);
});
test('responses share existing quota and unknown-outcome no-resend rules',async()=>{
 const f=await fixture();await f.authorize(f.policy);const prepared=(await f.call('response_prepare',{job:f.job,source:f.source})).result;
 f.state.qqContinuous.quotas[0]={count:100,lastAt:399999};
 let r=await f.call('response_commit',{intentId:'intent',permit:f.permit(prepared),source:f.source});assert.equal(r.result.reason,'daily_quota_exhausted');assert.equal(f.posts(),0);
 const g=await fixture();await g.authorize(g.policy);let calls=0;g.ctl.post=async()=>{calls++;throw Error('unknown network outcome');};const p=(await g.call('response_prepare',{job:g.job,source:g.source})).result;
 r=await g.call('response_commit',{intentId:'intent',permit:g.permit(p),source:g.source});assert.equal(r.result.state,'uncertain');assert.equal(g.state.qqContinuous.grant.state,'paused');
 r=await g.call('response_commit',{intentId:'intent',permit:g.permit(p),source:g.source});assert.equal(calls,1);assert.equal(r.result.state,'suppressed');
});

test('existing signed producer cannot mint response consent through the production RPC',async()=>{
 const f=await fixture();await assert.rejects(f.call('response_policy',f.policy),/continuous_operation_invalid/);assert.equal(f.state.qqContinuous.responsePolicies,undefined);assert.equal(f.posts(),0);
});
test('authority verification occurs independently at both prepare and commit',async()=>{
 const f=await fixture();await f.authorize(f.policy);const p=(await f.call('response_prepare',{job:f.job,source:f.source})).result;assert.equal(p.state,'prepared',JSON.stringify(p));assert.equal(f.authorityReads(),1);
 await f.call('response_commit',{intentId:'intent',permit:f.permit(p),source:f.source});assert.equal(f.authorityReads(),2);assert.equal(f.posts(),1);
});
test('missing binding, redirect, network uncertainty, excessive body and forged owner reply fail closed',async()=>{
 const cases=[undefined,{fetch:async()=>new Response(null,{status:302,headers:{location:'https://attacker.invalid'}})},{fetch:async()=>{throw Error('offline failure');}},{fetch:async()=>new Response('x'.repeat(8193))},{fetch:async()=>new Response(JSON.stringify({body:'{}',signature:'0'.repeat(64)}))}];
 for(const binding of cases){const f=await fixture();await f.authorize(f.policy);f.actor.env.QQ_RESPONSE_AUTHORITY=binding;const r=await f.call('response_prepare',{job:f.job,source:f.source});assert.equal(r.result.diagnostic.code,'response_consent_required');assert.equal(f.posts(),0);}
});
test('even correctly signed stale, wrong nonce, wrong request digest, and overlong proofs are rejected',async()=>{
 for(const patch of [{nonce:'old'},{requestHash:'0'.repeat(64)},{validUntil:1},{validUntil:999999},{authorized:false}]){
  const f=await fixture();await f.authorize(f.policy);const original=f.endpoint.fetch;
  f.actor.env.QQ_RESPONSE_AUTHORITY={fetch:async request=>{const r=await original(request),packet=await r.json(),body=JSON.stringify({...JSON.parse(packet.body),...patch});return new Response(JSON.stringify({body,signature:await hmac(f.actor.env.QQ_BRIDGE_SECRET,'rivule-qq-response-authority-response-v1',body)}));}};
  const r=await f.call('response_prepare',{job:f.job,source:f.source});assert.equal(r.result.diagnostic.code,'response_consent_required');assert.equal(f.posts(),0);
 }
});
test('owner consent has no five-minute expiration; each delivery gets a fresh proof',async()=>{
 const f=await fixture();await f.authorize(f.policy);f.advance(300001);f.source.verifiedAt=f.actor.now();
 const p=(await f.call('response_prepare',{job:f.job,source:f.source})).result;assert.equal(p.state,'prepared',JSON.stringify(p));
 await f.call('response_commit',{intentId:'intent',permit:f.permit(p),source:f.source});assert.equal(f.posts(),1);
});
test('a binding or runtime change while owner verification is pending invalidates the returned proof',async()=>{
 for(const mutate of [f=>{f.context.runtimeEpoch='new';},f=>{f.context.binding.userOpenId='other';}]){
  const f=await fixture();await f.authorize(f.policy);const original=f.endpoint.fetch;f.actor.env.QQ_RESPONSE_AUTHORITY={fetch:async request=>{const response=await original(request);mutate(f);return response;}};
  const r=await f.call('response_prepare',{job:f.job,source:f.source});assert.equal(r.result.state,'suppressed');assert.equal(f.posts(),0);
 }
});
test('a hanging authority request times out without sending',async()=>{
 const f=await fixture();await f.authorize(f.policy);f.actor.env.QQ_RESPONSE_AUTHORITY={fetch:()=>new Promise(()=>{})};
 const r=await f.call('response_prepare',{job:f.job,source:f.source});assert.equal(r.result.diagnostic.code,'response_consent_required');assert.equal(f.posts(),0);
});

import {DatabaseSync} from 'node:sqlite';
import {MessageBridge} from '../src/owner/message-bridge.mjs';
import {QQBridgeQueue} from '../src/owner/qq-integration.mjs';
import {QQResponseConsent,qqResponseAuthorityResponse} from '../src/owner/qq-response-consent.mjs';
async function pairedFixture(t){
 const f=await fixture(),db=new DatabaseSync(':memory:');t.after(()=>db.close());
 // Use real owner storage, bridge context/response rows, QQ projection and consent.
 db.exec(`CREATE TABLE branches(branch_key TEXT PRIMARY KEY,source_id TEXT,project_id TEXT,payload TEXT,archived INTEGER);CREATE TABLE events(revision INTEGER PRIMARY KEY AUTOINCREMENT,source_id TEXT,event_id TEXT,receipt TEXT,payload TEXT,decision TEXT);CREATE TABLE outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,receipt TEXT,intent TEXT,payload TEXT,status TEXT,message_id TEXT,last_error TEXT);INSERT INTO events(revision) VALUES(4);`);
 const storage={sql:{exec(sql,...args){if(sql.includes('CREATE TABLE')){db.exec(sql);return {toArray:()=>[]};}return {toArray:()=>db.prepare(sql).all(...args)};}},transaction:async fn=>{db.exec('BEGIN');try{const result=await fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}},transactionSync:fn=>fn(),sync:async()=>{}};
 const source={source_id:'source',enabled:true},bindings={ownerId:'owner',appId:'100',userId:'200',dmId:'300',allowedProjectIds:['project'],sources:[source]};
 const context={project_id:'project',task_id:'task',run_id:'run',branch_id:'main',thread_id:'thread'},event={source_id:'source',...context,kind:'progress',source_status:'running',sensitivity:'normal',summary:'Task progress'};
 db.prepare('INSERT INTO branches VALUES(?,?,?,?,0)').run(JSON.stringify(['source','task','run','main']),'source','project',JSON.stringify(event));
 const bridge=new MessageBridge({storage,bindings,sourceBinding:()=>1,now:f.actor.now,enqueueResponse:async(s,c,text,receipt,meta)=>{db.prepare('INSERT INTO events(source_id,event_id,receipt,payload,decision) VALUES(?,?,?,?,?)').run('source','response-event',receipt,JSON.stringify({...event,event_id:'response-event',kind:'response',summary:text,bridge_context_ref:meta.context_ref,bridge_consent_revision:meta.consent_revision}),'bridge_response');}});
 const env={QQ_ENABLED:'true',QQ_OWNER_ID:'owner',QQ_APP_ID:'123',QQ_DELIVERY_ENABLED:'true',QQ_ALLOWED_SOURCE_IDS:'["source"]',QQ_ALLOWED_PROJECT_IDS:'["project"]'};
 env.QQ_BRIDGE_SECRET=f.actor.env.QQ_BRIDGE_SECRET;env.QQ_GATEWAY={idFromName:n=>n,get:()=>({continuousRequest:packet=>continuousRequest(f.actor,packet)})};
 const queue=new QQBridgeQueue(storage,env,'owner',[source],()=>{throw Error('no public network');},f.actor.now);
 queue.attachAuthority(()=>({selectable:true,binding:'source-binding',connection_generation:1,last_verified_at:f.actor.now()}));queue.attachMessageBridge(bridge);await queue.initializeContinuous();
 queue.saveActivation({active:true,grantId:f.state.qqContinuous.grant.id,bindingFingerprint:'binding',startAfterRevision:4,expiresAt:f.actor.now()+600000});
 await bridge.setPreference(source,{mode:'every_response',commands_enabled:false,confirm:true,expected_revision:0});await bridge.registerContext(source,context);
 const consent=new QQResponseConsent({storage,bridge,now:f.actor.now});
 const target={active:true,ownerId:'owner',appId:'123',userOpenId:'recipient',bindingFingerprint:'binding',validUntil:f.actor.now()+30000};
 bridge.qqResponseAuthorized=(s,receipt)=>{const row=db.prepare('SELECT revision FROM events WHERE receipt=?').get(receipt);return !!row&&consent.authorized(s,target,row.revision)&&bridge.responseAuthority(s,receipt)!==null;};
 const enable=()=>consent.set(source,{enabled:true,expected_revision:consent.status(source).revision,confirm:true,target:{...target,validUntil:f.actor.now()+30000}});
 await enable();
 const published=await bridge.publishResponse(source,{...context,response_id:'response-event',text:'Real stored response',origin:'source',content_kind:'user_visible_response'});
 assert.equal(queue.enqueueResponse(source,published.receipt_id),true);
 const loadJob=receipt=>queue.currentJob(queue.rows('SELECT * FROM qq_continuous_outbox WHERE receipt=?',receipt)[0],queue.activation());
 const current=await loadJob(published.receipt_id);
 f.actor.env.QQ_RESPONSE_AUTHORITY_ENABLED='true';f.actor.env.QQ_RESPONSE_AUTHORITY={fetch:request=>qqResponseAuthorityResponse(request,{secret:f.actor.env.QQ_BRIDGE_SECRET,enabled:true,ownerId:'owner',appId:'123',consent,bridge,loadJob,now:f.actor.now})};
 return {...f,db,bridge,queue,consent,source,current,enable};
}
test('paired production gateway, real owner verifier, consent SQL, bridge and QQ queue deliver only exact approved response',async t=>{
 const f=await pairedFixture(t),{job,source}=f.current,before=f.db.prepare('SELECT payload FROM branches').get().payload;
 const p=(await f.call('response_prepare',{job,source})).result;assert.equal(p.state,'prepared',JSON.stringify(p));
 const permit={intentId:job.intentId,challenge:p.challenge,expiresAt:p.expiresAt,grantRevision:p.grantRevision,payloadHash:job.payloadHash};
 const result=(await f.call('response_commit',{intentId:job.intentId,permit,source})).result;assert.equal(result.reason,'provider_accepted');assert.equal(f.posts(),1);assert.equal(f.db.prepare('SELECT payload FROM branches').get().payload,before);
});
test('paired real owner consent revoked after preparation prevents provider send',async t=>{
 const f=await pairedFixture(t),{job,source}=f.current;const p=(await f.call('response_prepare',{job,source})).result;assert.equal(p.state,'prepared',JSON.stringify(p));
 await f.consent.set(f.source,{enabled:false,expected_revision:f.consent.status(f.source).revision,confirm:true});
 const result=(await f.call('response_commit',{intentId:job.intentId,permit:{intentId:job.intentId,challenge:p.challenge,expiresAt:p.expiresAt,grantRevision:p.grantRevision,payloadHash:job.payloadHash},source})).result;assert.equal(result.state,'suppressed');assert.equal(f.posts(),0);
});
test('paired owner rejects producer-signed altered response content despite a matching content hash',async t=>{
 const f=await pairedFixture(t),job={...f.current.job,content:'Producer fabricated content'};job.payloadHash=await hash(job.content);
 const result=(await f.call('response_prepare',{job,source:{...f.current.source,payloadHash:job.payloadHash}})).result;assert.equal(result.state,'suppressed');assert.equal(f.posts(),0);
});
test('paired owner rejects changed destination independently of producer source proof',async t=>{
 const f=await pairedFixture(t);f.db.prepare('UPDATE bridge_qq_response_consent SET target=?').run(JSON.stringify({ownerId:'owner',appId:'123',userOpenId:'different',bindingFingerprint:'binding'}));
 const result=(await f.call('response_prepare',f.current)).result;assert.equal(result.state,'suppressed');assert.equal(f.posts(),0);
});
test('paired consent off then on does not resurrect an old queued response',async t=>{
 const f=await pairedFixture(t);await f.consent.set(f.source,{enabled:false,expected_revision:f.consent.status(f.source).revision,confirm:true});await f.enable();
 const result=(await f.call('response_prepare',f.current)).result;assert.equal(result.state,'suppressed');assert.equal(f.posts(),0);
});
test('full production queue drain signs prepare/commit, verifies independent owner, and persists provider acceptance',async t=>{
 const f=await pairedFixture(t);const result=await f.queue.drain();assert.equal(result.state,'sent',JSON.stringify(result));assert.equal(result.reason,'provider_accepted');assert.equal(f.posts(),1);
 const row=f.db.prepare('SELECT status,result FROM qq_continuous_outbox').get();assert.equal(row.status,'sent');assert.equal(JSON.parse(row.result).reason,'provider_accepted');
 await f.queue.drain();assert.equal(f.posts(),1);
});
test('full queue unknown provider outcome persists uncertainty and cannot resend',async t=>{
 const f=await pairedFixture(t);let posts=0;f.ctl.post=async()=>{posts++;throw Error('network outcome unknown');};
 const result=await f.queue.drain();assert.equal(result.state,'uncertain');assert.equal(f.db.prepare('SELECT status FROM qq_continuous_outbox').get().status,'uncertain');assert.equal(f.queue.activation().active,false);
 await f.queue.drain();assert.equal(posts,1);
});
