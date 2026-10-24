import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const raw=readFileSync(new URL('../src/gateway/worker.mjs',import.meta.url),'utf8');
const sandbox=vm.createContext({structuredClone,TextEncoder,TextDecoder,EventTarget,URL,Response,Request,AbortSignal,setTimeout,clearTimeout,crypto:webcrypto,fetch(){throw Error('offline only');}});
vm.runInContext(raw.replace('import { DurableObject } from "cloudflare:workers";','class DurableObject {}').replace('export { QQGatewayObject, worker_default as default };','')+'\nglobalThis.subject={RivuleContinuous,continuousRequest,verifyConversationAuthority,verifyConversationReviewAuthority,GatewayActor,continuousController,hmac,check,hash};',sandbox);
const {RivuleContinuous:C,continuousRequest,verifyConversationAuthority,verifyConversationReviewAuthority,GatewayActor,continuousController,hmac,check,hash}=sandbox.subject;
async function fixture(){
 let now=400000,posts=0,reads=0,allowed=true;const state={};
 const binding={ownerId:'owner',appId:'123',userOpenId:'recipient',confirmedAt:100};
 const permission={kind:'authenticated_C2C_MSG_RECEIVE',eventKey:'permission',revision:1,confirmedAt:100,bindingFingerprint:'binding',sessionFingerprint:'session',eventAt:now,receivedAt:now};
 const context={enabled:true,running:true,ready:true,healthy:true,credentialsCurrent:true,ownerId:'owner',appId:'123',binding,bindingFingerprint:'binding',projectIds:[],remainingMs:7200000,runtimeLimitMs:7200000,budgetRevision:0,runtimeEpoch:'runtime',permission,permissionRevision:1,permissionSessionFingerprint:'session',probe:{kind:'isolated_active_probe_observation',bindingFingerprint:'binding',confirmedAt:100,permissionRevision:1,receipt:{state:'sent',messageId:'proof'},checkedAt:now,validUntil:now+300000}};
 const store={transaction:async fn=>fn(state)};
 const ctl=new C.ContinuousDeliveryController({store,command:async fn=>fn(),context:()=>context,acquireToken:async()=> 'token',post:async()=>{posts++;return {state:'sent',messageId:'provider-id'};},random:()=> 'challenge-012345678901234567890123456789',now:()=>now});
 const g=await ctl.enroll({ownerAuthenticated:true,interactionId:'approval',policyFingerprint:JSON.stringify(C.POLICY),policyRevision:C.POLICY.revision,budgetRevision:0,backlog:'new_only',startAfterRevision:999,expiresAt:now+300000});
 await ctl.acknowledgeProducer({approvalInteractionId:'approval',grantId:g.id,startAfterRevision:999});
 const job={kind:'conversation',version:2,intentId:'conversation-intent',sourceId:'source',sourceGeneration:1,sourceGrantRevision:2,sourceBindingDigest:await hash('source-binding'),receiptId:'11111111-1111-1111-1111-111111111111',contextRef:'22222222-2222-2222-2222-222222222222',contextDigest:await hash('exact context'),sequence:1,consentRevision:3,acceptedAt:now,expiresAt:now+86400000,payloadHash:await hash('Normal conversation reply'),content:'Normal conversation reply',grantId:g.id,bindingFingerprint:'binding'};
 const source={selectable:true,enabled:true,revoked:false,sourceId:job.sourceId,generation:1,bindingDigest:job.sourceBindingDigest,verifiedAt:now,kind:'conversation',version:2,sourceGrantRevision:2,receiptId:job.receiptId,contextRef:job.contextRef,contextDigest:job.contextDigest,sequence:1,consentRevision:3,payloadHash:job.payloadHash,sensitivity:'normal'};
 const actor={continuous:ctl,store,config:()=>({ownerId:'owner',appId:'123'}),env:{QQ_BRIDGE_SECRET:'offline-bridge-secret-abcdefghijklmnopqrstuvwxyz'},now:()=>now};
 const endpoint={async fetch(request){reads++;assert.equal(request.url,'https://rivule-owner.internal/internal/qq-conversation-authority');assert.equal(request.redirect,'manual');
  const packet=await request.json(),e=await check(actor.env.QQ_BRIDGE_SECRET,'rivule-qq-conversation-authority-request-v2',packet);assert.equal(e.version,2);assert.equal(e.userOpenId,'recipient');
  const body=JSON.stringify({version:2,nonce:e.nonce,requestHash:await hash(packet.body),authorized:allowed,validUntil:now+30000});
  return new Response(JSON.stringify({body,signature:await hmac(actor.env.QQ_BRIDGE_SECRET,'rivule-qq-conversation-authority-response-v2',body)}));
 }};
 ctl.verifyConversation=(job,context,grant)=>verifyConversationAuthority(actor,job,context,grant);
 const enable=()=>{actor.env.QQ_CONVERSATION_AUTHORITY_ENABLED='true';actor.env.QQ_RESPONSE_AUTHORITY=endpoint;};
 async function call(operation,payload,domain='rivule-qq-request-v2'){const body=JSON.stringify({version:2,timestamp:now,ownerId:'owner',appId:'123',operation,payload});return check(actor.env.QQ_BRIDGE_SECRET,'rivule-qq-response-v2',await continuousRequest(actor,{body,signature:await hmac(actor.env.QQ_BRIDGE_SECRET,domain,body)}));}
 const prepare=()=>call('conversation_prepare',{job,source});
 const commit=p=>call('conversation_commit',{intentId:job.intentId,permit:{intentId:job.intentId,challenge:p.challenge,expiresAt:p.expiresAt,grantRevision:p.grantRevision,payloadHash:job.payloadHash},source});
 return {state,context,ctl,actor,job,source,call,prepare,commit,enable,endpoint,posts:()=>posts,reads:()=>reads,revoke:()=>allowed=false,advance:n=>now+=n};
}
test('conversation requires separate owner authority and independent sequence, never a task grant alone',async()=>{
 const f=await fixture();assert.equal((await f.prepare()).result.diagnostic.code,'conversation_consent_required');assert.equal(f.posts(),0);
 f.actor.env.QQ_RESPONSE_AUTHORITY_ENABLED='true';f.actor.env.QQ_RESPONSE_AUTHORITY=f.endpoint;assert.equal((await f.prepare()).result.diagnostic.code,'conversation_consent_required');
 f.enable();const p=(await f.prepare()).result;assert.equal(p.state,'prepared',JSON.stringify(p));assert.equal(f.job.sequence,1);assert.equal(f.state.qqContinuous.grant.startAfterRevision,999);
 const result=(await f.commit(p)).result;assert.equal(result.reason,'provider_accepted');assert.equal(result.recipientConfirmed,undefined);assert.equal(f.reads(),2);assert.equal(f.posts(),1);await f.commit(p);assert.equal(f.posts(),1);
});
test('strict conversation job rejects task fields, missing context, malformed receipt/version and secrets',async()=>{
 for(const patch of [{projectId:null},{acceptedRevision:1000},{eventId:'fake-task'},{contentKind:'bridge_response'},{contextRef:null},{receiptId:'not-uuid'},{version:1},{sourceGrantRevision:0},{content:'api_key=secret'}]){
  const f=await fixture();f.enable();Object.assign(f.job,patch);f.job.payloadHash=await hash(f.job.content);const r=await f.prepare();assert.equal(r.result.state,'suppressed');assert.equal(f.posts(),0);
 }
});
test('strict source assertion cannot forge context, consent, revision, sequence, kind or sensitivity',async()=>{
 for(const patch of [{contextDigest:'a'.repeat(64)},{consentRevision:4},{sourceGrantRevision:3},{sequence:2},{kind:'task'},{sensitivity:'private'},{applied:true},{revoked:true},{generation:2}]){
  const f=await fixture();f.enable();Object.assign(f.source,patch);assert.equal((await f.prepare()).result.state,'suppressed');assert.equal(f.posts(),0);
 }
});
test('task and response protocols cannot prepare or commit conversation jobs',async()=>{
 const f=await fixture();f.enable();for(const operation of ['prepare','response_prepare'])assert.equal((await f.call(operation,{job:f.job,source:f.source})).result.diagnostic.code,'protocol_kind_mismatch');
 const p=(await f.prepare()).result,permit={intentId:f.job.intentId,challenge:p.challenge,expiresAt:p.expiresAt,grantRevision:p.grantRevision,payloadHash:f.job.payloadHash};
 for(const operation of ['commit','response_commit'])await assert.rejects(f.call(operation,{intentId:f.job.intentId,permit,source:f.source}),/protocol_kind_mismatch/);assert.equal(f.posts(),0);assert.equal((await f.commit(p)).result.state,'sent');
});
test('expired, future and previous-grant accepted responses cannot enter current runtime',async()=>{
 for(const patch of [{acceptedAt:399999},{acceptedAt:400001},{expiresAt:400000},{expiresAt:400000+86400001}]){
  const f=await fixture();f.enable();Object.assign(f.job,patch);assert.equal((await f.prepare()).result.state,'suppressed');assert.equal(f.posts(),0);
 }
});
test('revoke, runtime/destination changes, budget exhaustion and expiry before commit suppress send',async()=>{
 for(const mutate of [f=>f.revoke(),f=>{f.context.runtimeEpoch='new';},f=>{f.context.binding.userOpenId='other';},f=>{f.context.remainingMs=0;},f=>f.advance(30001)]){
  const f=await fixture();f.enable();const p=(await f.prepare()).result;assert.equal(p.state,'prepared');mutate(f);assert.equal((await f.commit(p)).result.state,'suppressed');assert.equal(f.posts(),0);
 }
});
test('conversation shares quota and uncertain-outcome no-auto-resend semantics',async()=>{
 const f=await fixture();f.enable();const p=(await f.prepare()).result;f.state.qqContinuous.quotas[0]={count:100,lastAt:null};assert.equal((await f.commit(p)).result.reason,'daily_quota_exhausted');assert.equal(f.posts(),0);
 const g=await fixture();g.enable();let posts=0;g.ctl.post=async()=>{posts++;throw Error('unknown network result');};const prepared=(await g.prepare()).result;assert.equal((await g.commit(prepared)).result.state,'uncertain');assert.equal(g.state.qqContinuous.grant.state,'paused');await g.commit(prepared);assert.equal(posts,1);
});
test('authority wrong domain, nonce/hash, oversized body, redirect and missing binding fail closed',async()=>{
 for(const mode of ['domain','nonce','hash','oversize','redirect','missing']){
  const f=await fixture();f.enable();f.actor.env.QQ_RESPONSE_AUTHORITY=mode==='missing'?undefined:{fetch:async request=>{
   if(mode==='redirect')return new Response(null,{status:302,headers:{location:'https://not-allowed.invalid'}});if(mode==='oversize')return new Response('x'.repeat(8193));
   const packet=await (await f.endpoint.fetch(request)).json(),body=JSON.parse(packet.body);if(mode==='nonce')body.nonce='wrong';if(mode==='hash')body.requestHash='0'.repeat(64);const raw=JSON.stringify(body);return new Response(JSON.stringify({body:raw,signature:await hmac(f.actor.env.QQ_BRIDGE_SECRET,mode==='domain'?'rivule-qq-response-authority-response-v1':'rivule-qq-conversation-authority-response-v2',raw)}));
  }};assert.equal((await f.prepare()).result.diagnostic.code,'conversation_consent_required');assert.equal(f.posts(),0);
 }
});
test('producer cannot mint conversation consent and command authority reports separate configured capability',async()=>{
 const f=await fixture();assert.equal((await f.call('command_authority',null)).result.conversationVerifierConfigured,false);f.enable();const a=(await f.call('command_authority',null)).result;assert.equal(a.conversationVerifierConfigured,true);assert.equal(a.grantIssuedAt,400000);
 await assert.rejects(f.call('conversation_policy',{enabled:true}),/continuous_operation_invalid/);assert.equal(f.posts(),0);
});
test('conversation receipt dedup rejects a second intent and forged permits cannot send',async()=>{
 const f=await fixture();f.enable();const p=(await f.prepare()).result;const second={...f.job,intentId:'second-intent'};assert.equal((await f.call('conversation_prepare',{job:second,source:f.source})).result.diagnostic.code,'event_already_reserved');
 const result=(await f.call('conversation_commit',{intentId:f.job.intentId,permit:{intentId:f.job.intentId,challenge:'forged',expiresAt:p.expiresAt,grantRevision:p.grantRevision,payloadHash:f.job.payloadHash},source:f.source})).result;assert.equal(result.reason,'permit_mismatch');assert.equal(f.posts(),0);
});
test('conversation owner-verifier timeout does not send or retry',async()=>{
 const f=await fixture();f.enable();let calls=0;f.actor.env.QQ_RESPONSE_AUTHORITY={fetch:()=>{calls++;return new Promise(()=>{});}};
 assert.equal((await f.prepare()).result.diagnostic.code,'conversation_consent_required');assert.equal(calls,1);assert.equal(f.posts(),0);
});
test('stopped gateway retains expiry alarm and erases expired conversation content without owner activity',async()=>{
 for(const uncertain of [false,true]){
  const f=await fixture();f.enable();const p=(await f.prepare()).result;const id=f.job.intentId,fingerprint=await hash(JSON.stringify(f.job));
  if(uncertain){f.ctl.post=async()=>{throw Error('provider outcome unknown');};assert.equal((await f.commit(p)).result.state,'uncertain');}
  let alarmAt=null,stops=0;
  const actor={store:f.actor.store,now:f.actor.now,ctx:{storage:{setAlarm:async at=>alarmAt=at,deleteAlarm:async()=>alarmAt=null}},command:async fn=>fn(),recordDiagnostic(){},runtime:{stop(){stops++;}},config(){throw Error('retention must not restart or inspect disabled transport');}};
  actor.unhealthy=(state,reason)=>GatewayActor.prototype.unhealthy.call(actor,state,reason);
  actor.arm=()=>GatewayActor.prototype.planAlarm.call(actor);
  await GatewayActor.prototype.stopInternal.call(actor,'owner_stopped');assert.equal(stops,1);assert.equal(alarmAt,f.job.expiresAt);
  f.advance(alarmAt-f.actor.now());await GatewayActor.prototype.alarm.call(actor);
  const attempt=f.state.qqContinuous.attempts[id];assert.equal(attempt.jobFingerprint,fingerprint);assert.equal(attempt.job.receiptId,f.job.receiptId);assert.equal(attempt.job.content,undefined);assert.equal(attempt.job.contextRef,undefined);assert.equal(attempt.job.contextDigest,undefined);assert.equal(attempt.challenge,undefined);assert.equal(attempt.contentErasedAt,f.actor.now());assert.equal(attempt.state,uncertain?'uncertain':'suppressed');assert.equal(alarmAt,null);
  assert.equal(Object.keys(f.state.qqContinuous.events).length,1);assert.ok(!JSON.stringify(f.state).includes('Normal conversation reply'));assert.ok(!JSON.stringify(f.state).includes(f.job.contextRef));assert.equal((await f.commit(p)).result.state,'suppressed');
 }
});

import {DatabaseSync} from 'node:sqlite';
import {ConversationBridge,CONVERSATION_OPERATIONS} from '../src/owner/conversation-bridge.mjs';
import {ConversationQQQueue} from '../src/owner/conversation-qq-queue.mjs';
import {qqConversationAuthorityResponse} from '../src/owner/conversation-qq-authority.mjs';
import {ConversationQQCommandAdapter} from '../src/owner/conversation-qq-command-adapter.mjs';
const ownerWorker=readFileSync(new URL('../src/owner/worker.js',import.meta.url),'utf8');
const webhookSandbox=vm.createContext({TextEncoder,TextDecoder,Response,Request,Headers,URL,crypto:webcrypto,__name:x=>x,qqHash:hash,qqReadBytes:async stream=>new Uint8Array(await new Response(stream).arrayBuffer())});
vm.runInContext(ownerWorker.slice(ownerWorker.indexOf('async function qqGateKey('),ownerWorker.indexOf('var response = ',ownerWorker.indexOf('var QQDurableInbox')))+'\nglobalThis.api={handleQQWebhook,qqSign,QQDurableInbox,qqGateKey};',webhookSandbox);
const {handleQQWebhook,qqSign,QQDurableInbox,qqGateKey}=webhookSandbox.api;
async function pairedFixture(t,text='An ordinary conversation reply'){
 const f=await fixture(),db=new DatabaseSync(':memory:');t.after(()=>db.close());const kv=new Map();
 const storage={sql:{exec(q,...a){if(q.includes('CREATE TABLE')){db.exec(q);return {toArray:()=>[]};}return {toArray:()=>db.prepare(q).all(...a)};}},transaction:async fn=>fn(storage),sync:async()=>{},get:async k=>kv.get(k),put:async(k,v)=>kv.set(k,v)};
 const source={source_id:'source',enabled:true},sourceGrant={enabled:true,provider_id:'dot',account_binding:'configured-account',generation:1,revision:2,operations:[...CONVERSATION_OPERATIONS]};
 const config={enabled:true,ownerId:'owner',appId:'123',userOpenId:'recipient',allowedSources:['source']};
 const activation={active:true,grantId:f.state.qqContinuous.grant.id,bindingFingerprint:'binding',expiresAt:f.actor.now()+86400000};
 const recipient=JSON.stringify(['owner','123','recipient','binding']);let queue;
 const bridge=new ConversationBridge({storage,sources:[source],authority:()=>sourceGrant,recipientBinding:channel=>channel==='qq'?recipient:null,recipient:t=>t.channel==='qq'&&t.owner_id==='owner'&&t.requester_id==='recipient'&&t.conversation_id==='recipient',enqueue:(channel,a)=>queue.enqueue(a),delivery:(receipt,channel)=>channel==='qq'?queue.delivery(receipt):null,eraseDelivery:r=>queue.erase(r),now:f.actor.now});
 const env={QQ_BRIDGE_SECRET:f.actor.env.QQ_BRIDGE_SECRET,QQ_GATEWAY:{idFromName:n=>n,get:()=>({continuousRequest:packet=>continuousRequest(f.actor,packet)})}};
 queue=new ConversationQQQueue({storage,bridge,env,ownerId:'owner',config:()=>config,sourceAuthority:()=>({selectable:true,verifiedAt:f.actor.now()}),activation:()=>activation,now:f.actor.now});
 f.actor.env.QQ_CONVERSATION_AUTHORITY_ENABLED='true';f.actor.env.QQ_RESPONSE_AUTHORITY={fetch:request=>qqConversationAuthorityResponse(request,{secret:env.QQ_BRIDGE_SECRET,enabled:true,ownerId:'owner',appId:'123',userOpenId:'recipient',bridge,loadJob:r=>queue.currentJob(r),now:f.actor.now})};
 const reg=await bridge.registerContext(source,{kind:'conversation',version:2,conversation_id:'actual-source-conversation',thread_id:'actual-source-thread'});
 const preference=enabled=>bridge.setPreference(source,{channel:'qq',enabled,commands_enabled:enabled,selection:{mode:enabled?'all_registered':'none',context_refs:[]},expected_revision:bridge.preference(source,'qq').revision,confirm:true});
 await preference(true);const receipt=await bridge.publishResponse(source,{context_ref:reg.context_ref,response_id:'response-1',text,content_kind:'user_visible_response',origin:'source',sensitivity:'normal',reviewed:true});
 const inbox=new QQDurableInbox(storage);const adapter=new ConversationQQCommandAdapter({bridge,inbox,rawInbox:inbox,config:()=>config,authority:()=>queue.commandAuthority(),revoked:async c=>!!await storage.get(await qqGateKey(c.appId,c.userOpenId)),now:f.actor.now});
 async function command({author='recipient',signature=true,text='Explain the second point',id='message-1'}={}){
  const raw=JSON.stringify({op:0,id:'event-'+id,t:'C2C_MESSAGE_CREATE',d:{id,author:{user_openid:author},content:'/rivule-chat '+receipt.receipt_id+' '+text,timestamp:new Date(f.actor.now()).toISOString()}}),stamp=String(f.actor.now()/1000),sig=signature?await qqSign('offline-app-secret',new TextEncoder().encode(stamp+raw)):'0'.repeat(128);
  return handleQQWebhook(new Request('https://owner.internal/qq/webhook',{method:'POST',headers:{'X-Bot-Appid':'123','X-Signature-Timestamp':stamp,'X-Signature-Ed25519':sig},body:raw}),{enabled:true,appId:'123',userOpenId:'recipient',appSecret:()=> 'offline-app-secret'},adapter,f.actor.now());
 }
 return {...f,db,storage,source,sourceGrant,config,activation,bridge,queue,reg,receipt,preference,command};
}
test('paired real owner consent, conversation core, queue, gateway and signed QQ reply return exact conversation',async t=>{
 const f=await pairedFixture(t);const result=await f.queue.drain();assert.equal(result.reason,'provider_accepted',JSON.stringify(result));assert.equal(f.posts(),1);assert.equal(f.queue.delivery(f.receipt.receipt_id).state,'provider_accepted');
 assert.equal((await f.command()).status,200);const claim=await f.bridge.claim(f.source,{context_ref:f.reg.context_ref,claim_id:'claim'});assert.equal(claim.text,'Explain the second point');assert.equal(claim.context.conversation_id,'actual-source-conversation');assert.equal(claim.context.thread_id,'actual-source-thread');assert.equal(claim.execution,'source_policy_required');
 assert.equal((await f.bridge.acknowledge(f.source,{command_id:claim.command_id,claim_token:claim.claim_token,outcome:'rejected'})).execution_confirmed_by,'source_report_only');assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('events','branches')").get().n,0);await f.queue.drain();assert.equal(f.posts(),1);
});
test('paired owner revocation between gateway prepare and commit prevents send',async t=>{
 const f=await pairedFixture(t),current=await f.queue.currentJob(f.receipt.receipt_id),p=(await f.call('conversation_prepare',current)).result;assert.equal(p.state,'prepared');await f.preference(false);
 const result=(await f.call('conversation_commit',{intentId:current.job.intentId,permit:{intentId:current.job.intentId,challenge:p.challenge,expiresAt:p.expiresAt,grantRevision:p.grantRevision,payloadHash:current.job.payloadHash},source:current.source})).result;assert.equal(result.state,'suppressed');assert.equal(f.posts(),0);
});
test('paired owner rejects forged content/context/sequence despite producer signature',async t=>{
 for(const mutation of [j=>{j.content='Invented text';},j=>{j.contextDigest='a'.repeat(64);},j=>{j.sequence++;}]){
  const f=await pairedFixture(t),current=await f.queue.currentJob(f.receipt.receipt_id);mutation(current.job);current.job.payloadHash=await hash(current.job.content);current.source.payloadHash=current.job.payloadHash;current.source.sequence=current.job.sequence;current.source.contextDigest=current.job.contextDigest;
  const result=(await f.call('conversation_prepare',current)).result;assert.equal(result.state,'suppressed');assert.equal(f.posts(),0);
 }
});
test('paired source operation grant revocation and re-enabled consent never resurrect queued response',async t=>{
 const f=await pairedFixture(t);f.sourceGrant.enabled=false;assert.equal((await f.queue.drain()).state,'suppressed');assert.equal(f.posts(),0);
 const g=await pairedFixture(t);await g.preference(false);await g.preference(true);assert.equal((await g.queue.drain()).state,'suppressed');assert.equal(g.posts(),0);
});
test('paired unknown provider outcome persists unknown receipt and blocks commands or resend',async t=>{
 const f=await pairedFixture(t);let posts=0;f.ctl.post=async()=>{posts++;throw Error('provider outcome unknown');};assert.equal((await f.queue.drain()).state,'uncertain');assert.equal(f.queue.delivery(f.receipt.receipt_id).state,'unknown');assert.equal((await f.command()).status,503);await f.queue.drain();assert.equal(posts,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM conversation_v2_commands').get().n,0);
});
async function reviewFixture(){
 const f=await fixture();f.enable();const p=(await f.prepare()).result;f.ctl.post=async()=>{throw Error('outcome unknown');};assert.equal((await f.commit(p)).result.state,'uncertain');f.advance(30001);
 f.ctl.verifyConversationReview=(scope,review)=>verifyConversationReviewAuthority(f.actor,scope,review);
 const target={intentId:f.job.intentId,receiptId:f.job.receiptId};const snapshot=(await f.call('conversation_review_status',target)).result;
 const review={...target,reviewId:'33333333-3333-3333-3333-333333333333',snapshotDigest:snapshot.snapshotDigest,sequenceFloor:2};let authorized=false,reads=0;
 const normal=f.actor.env.QQ_RESPONSE_AUTHORITY;
 f.actor.env.QQ_RESPONSE_AUTHORITY={fetch:async request=>{
  if(request.url!=='https://rivule-owner.internal/internal/qq-conversation-review-authority')return normal.fetch(request);
  reads++;const packet=await request.json(),e=await check(f.actor.env.QQ_BRIDGE_SECRET,'rivule-qq-conversation-review-authority-request-v1',packet);assert.equal(e.version,1);
  const body=JSON.stringify({version:1,nonce:e.nonce,requestHash:await hash(packet.body),authorized:authorized&&JSON.stringify(e.scope)===JSON.stringify(snapshot.scope)&&JSON.stringify(e.review)===JSON.stringify(review),validUntil:f.actor.now()+30000});
  return new Response(JSON.stringify({body,signature:await hmac(f.actor.env.QQ_BRIDGE_SECRET,'rivule-qq-conversation-review-authority-response-v1',body)}));
 }};
 return {...f,target,snapshot,review,authorize:()=>authorized=true,reviewReads:()=>reads};
}
test('independent owner review acknowledges only exact unknown and never resumes or resends',async()=>{
 const f=await reviewFixture(),original=f.state.qqContinuous.grant.state;assert.equal(f.snapshot.state,'reviewable');assert.equal(f.snapshot.scope.sequence,1);assert.equal(f.snapshot.delivery_resumed,false);
 await assert.rejects(f.call('conversation_review',f.review),/conversation_review_denied/);assert.equal(f.state.qqContinuous.attempts[f.job.intentId].reviewedAt,undefined);
 f.authorize();const r=(await f.call('conversation_review',f.review)).result;assert.equal(r.state,'reviewed');assert.equal(r.delivery_resumed,false);assert.equal(r.next_step,'existing_owner_qq_enable');assert.equal(f.state.qqContinuous.grant.state,original);assert.equal(original,'paused');assert.equal(f.state.qqContinuous.attempts[f.job.intentId].state,'uncertain');
 const reads=f.reviewReads();assert.equal((await f.call('conversation_review_status',f.target)).result.state,'reviewed');assert.equal(f.reviewReads(),reads);assert.equal((await f.call('conversation_review',f.review)).result.state,'reviewed');assert.equal(f.reviewReads(),reads);assert.equal((await f.prepare()).result.state,'suppressed');
 await assert.rejects(f.call('conversation_review',{...f.review,sequenceFloor:3}),/conversation_review_changed/);
});
test('review status is metadata-only, rejects changed runtime and can review expired-content tombstones',async()=>{
 const f=await reviewFixture();assert.ok(!JSON.stringify(f.snapshot).includes(f.job.content));assert.ok(!JSON.stringify(f.snapshot).includes(f.job.contextRef));f.context.runtimeEpoch='new';assert.equal((await f.call('conversation_review_status',f.target)).result.state,'unavailable');
 const g=await reviewFixture();g.advance(86400000);C.maintainHistory(g.state,g.actor.now());assert.equal(g.state.qqContinuous.attempts[g.job.intentId].job.content,undefined);const s=(await g.call('conversation_review_status',g.target)).result;assert.equal(s.state,'reviewable');assert.equal(s.scope.sourceId,'source');assert.equal(s.scope.jobFingerprint,await hash(JSON.stringify(g.job)));
});
test('manual pause while independent review proof is pending invalidates snapshot; all other unknowns remain blocked',async()=>{
 const f=await reviewFixture();f.authorize();const endpoint=f.actor.env.QQ_RESPONSE_AUTHORITY;f.actor.env.QQ_RESPONSE_AUTHORITY={fetch:async request=>{const reply=await endpoint.fetch(request);C.pause(f.state,'owner_paused',f.actor.now());return reply;}};
 await assert.rejects(f.call('conversation_review',f.review),/conversation_review_changed/);assert.equal(f.state.qqContinuous.attempts[f.job.intentId].reviewedAt,undefined);assert.equal(f.state.qqContinuous.grant.pauseReason,'owner_paused');
 const g=await reviewFixture();g.authorize();const a=g.state.qqContinuous.attempts[g.job.intentId];g.state.qqContinuous.attempts.other={...structuredClone(a),job:{...a.job,receiptId:'44444444-4444-4444-4444-444444444444'}};await g.call('conversation_review',g.review);const unresolved=C.unresolvedAttempts(g.state,'binding',g.actor.now());assert.equal(unresolved.keys.length,1);assert.equal(unresolved.keys[0],'normal:other');await assert.rejects(g.ctl.enroll({ownerAuthenticated:true,interactionId:'cannot-skip-other-unknown',policyFingerprint:JSON.stringify(C.POLICY),policyRevision:C.POLICY.revision,budgetRevision:0,backlog:'new_only',startAfterRevision:999,expiresAt:g.actor.now()+300000}),/unknown_outcome_requires_review/);
});
test('existing owner re-enrollment after review still blocks backlog and permits only newer conversation sequence',async()=>{
 const f=await reviewFixture();f.authorize();await f.call('conversation_review',f.review);
 const grant=await f.ctl.enroll({ownerAuthenticated:true,interactionId:'new-explicit-owner-enable',policyFingerprint:JSON.stringify(C.POLICY),policyRevision:C.POLICY.revision,budgetRevision:0,backlog:'new_only',startAfterRevision:999,expiresAt:f.actor.now()+300000});
 await f.ctl.acknowledgeProducer({approvalInteractionId:'new-explicit-owner-enable',grantId:grant.id,startAfterRevision:999});
 const job={...f.job,intentId:'new-conversation-intent',receiptId:'55555555-5555-5555-5555-555555555555',grantId:grant.id,sequence:2,acceptedAt:f.actor.now(),expiresAt:f.actor.now()+86400000},source={...f.source,receiptId:job.receiptId,sequence:2,verifiedAt:f.actor.now()};
 assert.equal((await f.call('conversation_prepare',{job,source})).result.diagnostic.code,'conversation_review_backlog');job.sequence=3;source.sequence=3;const p=(await f.call('conversation_prepare',{job,source})).result;assert.equal(p.state,'prepared',JSON.stringify(p));assert.equal(f.state.qqContinuous.attempts[f.job.intentId].state,'uncertain');
});
test('reviewed unknown metadata remains readable and deduplicated after new grant and history cleanup',async()=>{
 const f=await reviewFixture();f.authorize();await f.call('conversation_review',f.review);f.state.qqContinuous.grant.revision++;f.advance(73*3600000);C.maintainHistory(f.state,f.actor.now());
 const a=f.state.qqContinuous.attempts[f.job.intentId];assert.equal(a.state,'uncertain');assert.equal(a.job.content,undefined);assert.equal(a.conversationReview.reviewId,f.review.reviewId);assert.equal((await f.call('conversation_review_status',f.target)).result.state,'reviewed');assert.equal(Object.keys(f.state.qqContinuous.events).length,1);assert.equal(f.posts(),0);
});

import {ConversationQQReview} from '../src/owner/conversation-qq-review.mjs';
import {qqConversationReviewAuthorityResponse} from '../src/owner/conversation-qq-review-authority.mjs';
async function pairedReviewFixture(t,{loseReviewResponse=false}={}){
 const f=await pairedFixture(t);f.ctl.post=async()=>{throw Error('unknown provider outcome');};assert.equal((await f.queue.drain()).state,'uncertain');f.advance(30001);
 const review=new ConversationQQReview({storage:f.storage,queue:f.queue,now:f.actor.now,currentOwnerState:()=>{const p=f.bridge.preference(f.source,'qq');return {sourceId:f.source.source_id,providerId:f.sourceGrant.provider_id,accountBinding:f.sourceGrant.account_binding,generation:f.sourceGrant.generation,grantRevision:f.sourceGrant.revision,sourceBinding:f.bridge.binding(f.source),recipient:f.bridge.recipientBinding('qq'),consentRevision:p.revision,sourceEnabled:f.sourceGrant.enabled,consentEnabled:p.enabled,commandsEnabled:p.commands_enabled,verifiedAt:f.actor.now()};},gateway:async(operation,payload)=>{const result=(await f.call(operation,payload)).result;if(loseReviewResponse&&operation==='conversation_review')throw Error('reply lost after gateway applied');return result;}});
 const endpoint=f.actor.env.QQ_RESPONSE_AUTHORITY;f.actor.env.QQ_RESPONSE_AUTHORITY={fetch:request=>request.url==='https://rivule-owner.internal/internal/qq-conversation-review-authority'?qqConversationReviewAuthorityResponse(request,{enabled:true,secret:f.actor.env.QQ_BRIDGE_SECRET,ownerId:'owner',appId:'123',userOpenId:'recipient',authorize:(scope,payload)=>review.reviewAuthority(payload.reviewId,scope,payload),now:f.actor.now}):endpoint.fetch(request)};
 f.ctl.verifyConversationReview=(scope,payload)=>verifyConversationReviewAuthority(f.actor,scope,payload);
 const publish=(id,text='New response after explicit review')=>f.bridge.publishResponse(f.source,{context_ref:f.reg.context_ref,response_id:id,text,content_kind:'user_visible_response',origin:'source',sensitivity:'normal',reviewed:true});
 return {...f,review,publish};
}
test('paired real owner review record independently clears exact unknown blocker but does not resume',async t=>{
 const f=await pairedReviewFixture(t),original=f.db.prepare('SELECT status,result FROM conversation_qq_outbox WHERE receipt_id=?').get(f.receipt.receipt_id),preview=await f.review.preview(f.receipt.receipt_id);
 assert.equal(preview.state,'confirmation_required');assert.equal(f.state.qqContinuous.grant.state,'paused');assert.equal(f.state.qqContinuous.attempts[(await f.review.identity(f.receipt.receipt_id)).intentId].reviewedAt,undefined);
 let ownerConfirmations=0;const result=await f.review.confirm(preview.review_id,preview.scope,async()=>{ownerConfirmations++;});assert.equal(result.state,'reviewed',JSON.stringify(result));assert.equal(ownerConfirmations,1);assert.equal(result.delivery_resumed,false);assert.equal(result.next_step,'existing_owner_qq_enable');assert.equal(f.state.qqContinuous.grant.state,'paused');assert.deepEqual(f.db.prepare('SELECT status,result FROM conversation_qq_outbox WHERE receipt_id=?').get(f.receipt.receipt_id),original);assert.equal(f.queue.delivery(f.receipt.receipt_id).state,'unknown');assert.equal(f.queue.unknownReceipts().length,0);
 await f.publish('still-paused');assert.equal((await f.queue.drain()).state,'suppressed');
 // This explicit enrollment models the separate existing owner enable action, not review side effects.
 const grant=await f.ctl.enroll({ownerAuthenticated:true,interactionId:'owner-explicit-enable-after-review',policyFingerprint:JSON.stringify(C.POLICY),policyRevision:C.POLICY.revision,budgetRevision:0,backlog:'new_only',startAfterRevision:999,expiresAt:f.actor.now()+300000});await f.ctl.acknowledgeProducer({approvalInteractionId:'owner-explicit-enable-after-review',grantId:grant.id,startAfterRevision:999});f.activation.grantId=grant.id;
 let sends=0;f.ctl.post=async()=>{sends++;return {state:'sent',messageId:'new-message-only'};};const fresh=await f.publish('after-new-owner-enable');assert.equal((await f.queue.drain()).state,'sent');assert.equal(sends,1);assert.equal(f.queue.delivery(fresh.receipt_id).state,'provider_accepted');assert.equal(f.queue.delivery(f.receipt.receipt_id).state,'unknown');
});
test('paired lost review response resolves by readback only and never repeats gateway mutation',async t=>{
 const f=await pairedReviewFixture(t,{loseReviewResponse:true}),preview=await f.review.preview(f.receipt.receipt_id);let mutations=0;const gateway=f.review.gateway;f.review.gateway=async(op,payload)=>{if(op==='conversation_review')mutations++;return gateway(op,payload);};
 assert.equal((await f.review.confirm(preview.review_id,preview.scope,async()=>{})).state,'readback_required');assert.equal(mutations,1);f.advance(31000);assert.equal((await f.review.readback(preview.review_id)).state,'reviewed');assert.equal(mutations,1);assert.equal(f.state.qqContinuous.grant.state,'paused');assert.equal(f.queue.delivery(f.receipt.receipt_id).state,'unknown');
});
test('paired producer cannot self-clear review without committed owner confirmation',async t=>{
 const f=await pairedReviewFixture(t),preview=await f.review.preview(f.receipt.receipt_id),row=f.review.one(preview.review_id),saved=JSON.parse(row.snapshot),identity=await f.review.identity(f.receipt.receipt_id);
 const payload={...identity,reviewId:preview.review_id,snapshotDigest:saved.gatewayDigest,sequenceFloor:saved.maxSequence};await assert.rejects(f.call('conversation_review',payload),/conversation_review_denied/);assert.equal(f.state.qqContinuous.attempts[identity.intentId].reviewedAt,undefined);assert.equal(f.review.one(preview.review_id).state,'prepared');
});


test('paired QQ full boundary text reaches provider untruncated; exact whitespace command is preserved',async t=>{
 const text='*'.repeat(590)+'中文👩🏽‍💻\r\n\t'+'@'.repeat(580),f=await pairedFixture(t,text);let content,posts=0;f.ctl.post=async intent=>{posts++;content=intent.content;return {state:'sent',messageId:'full-text-receipt'};};const result=await f.queue.drain();assert.equal(result.reason,'provider_accepted');assert.ok(content.includes('\n'+text+'\n\n回复指令：'));assert.equal(f.queue.delivery(f.receipt.receipt_id).state,'provider_accepted');await f.queue.drain();assert.equal(posts,1);const command='  preserve\t中文👩🏽‍💻\n  ';assert.equal((await f.command({text:command})).status,200);const claim=await f.bridge.claim(f.source,{context_ref:f.reg.context_ref,claim_id:'spaces'});assert.equal(claim.text,command);
});


test('paired QQ actual provider HTTP length rejection is not sent and never silently split or retried',async t=>{
 const f=await pairedFixture(t,'中'.repeat(1200));let calls=0,body;const transport=await continuousController({...f.actor,continuous:null,network:async(url,options)=>{calls++;body=JSON.parse(options.body);return Response.json({code:40054007,message:'content exceeds provider length'}, {status:400});}});f.ctl.post=transport.post;
 assert.equal((await f.queue.drain()).state,'not_sent');assert.ok(body.content.includes('中'.repeat(1200)));assert.equal(f.queue.delivery(f.receipt.receipt_id).state,'not_sent');await f.queue.drain();assert.equal(calls,1);
});
test('QQ command final newline counts toward exact body bound and is never discarded',async t=>{
 const f=await pairedFixture(t);await f.queue.drain();assert.equal((await f.command({id:'over-bound',text:'x'.repeat(1200)+'\n'})).status,503);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM conversation_v2_commands').get().n,0);const text='x'.repeat(1199)+'\n';assert.equal((await f.command({id:'at-bound',text})).status,200);assert.equal((await f.bridge.claim(f.source,{context_ref:f.reg.context_ref,claim_id:'bound'})).text,text);
});
