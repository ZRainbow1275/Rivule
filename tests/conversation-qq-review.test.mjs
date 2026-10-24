import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ConversationBridge,CONVERSATION_OPERATIONS} from '../src/owner/conversation-bridge.mjs';
import {ConversationQQQueue} from '../src/owner/conversation-qq-queue.mjs';
import {ConversationQQReview} from '../src/owner/conversation-qq-review.mjs';
async function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let now=1800000000000,queue,review,loseAfter=false,remote=null,gatewayCalls=[],verifiedAt=now,configGeneration=1,sourceRevision=1;
 const storage={sql:{exec(q,...a){if(q.includes('CREATE TABLE')){db.exec(q);return {toArray:()=>[]};}return {toArray:()=>db.prepare(q).all(...a)};}},transaction:async fn=>fn(storage),sync:async()=>{}};
 const source={source_id:'pa',enabled:true},grant={enabled:true,provider_id:'dot',account_binding:'account',generation:1,revision:1,operations:[...CONVERSATION_OPERATIONS]};
 const recipient=JSON.stringify(['owner','123','openid','binding']),bridge=new ConversationBridge({storage,sources:[source],authority:()=>grant,recipientBinding:()=>recipient,recipient:()=>false,enqueue:(c,a)=>queue.enqueue(a),delivery:r=>queue.delivery(r),eraseDelivery:r=>queue.erase(r),now:()=>now});
 const activation={active:true,grantId:'grant',bindingFingerprint:'binding',expiresAt:now+86400000};
 queue=new ConversationQQQueue({storage,bridge,env:{},ownerId:'owner',config:()=>({enabled:true,ownerId:'owner',appId:'123',userOpenId:'openid',allowedSources:['pa']}),sourceAuthority:()=>({selectable:true,verifiedAt}),activation:()=>activation,now:()=>now});
 await bridge.setPreference(source,{channel:'qq',enabled:true,commands_enabled:true,selection:{mode:'all_registered',context_refs:[]},expected_revision:0,confirm:true});
 const reg=await bridge.registerContext(source,{kind:'conversation',version:2,conversation_id:'conversation',thread_id:'thread'});
 let response=0;const publish=async()=>bridge.publishResponse(source,{context_ref:reg.context_ref,response_id:'r'+(++response),text:'Response '+response,content_kind:'user_visible_response',origin:'source',sensitivity:'normal',reviewed:true});
 const receipt=await publish(),second=await publish(),job=(await queue.currentJob(receipt.receipt_id)).job;
 queue.rows("UPDATE conversation_qq_outbox SET status='uncertain',result=? WHERE receipt_id=?",JSON.stringify({state:'uncertain',reason:'provider_outcome_unknown'}),receipt.receipt_id);
 const scope={intentId:job.intentId,receiptId:job.receiptId,jobFingerprint:'a'.repeat(64),sourceId:'pa',sourceGeneration:1,sourceGrantRevision:1,sourceBindingDigest:job.sourceBindingDigest,consentRevision:1,sequence:job.sequence,grantId:'grant',grantRevision:1,runtimeEpoch:'runtime',bindingFingerprint:'binding',ownerId:'owner',appId:'123',userOpenId:'openid'};
 const ownerState=async()=>{const consent=bridge.one("SELECT * FROM conversation_v2_consents WHERE source_id='pa' AND channel='qq'");return {sourceId:'pa',providerId:'dot',accountBinding:'account',generation:configGeneration,grantRevision:sourceRevision,sourceBinding:JSON.stringify(['pa','dot','account',configGeneration,sourceRevision,grant.operations]),sourceEnabled:grant.enabled,consentRevision:consent.revision,consentEnabled:consent.enabled===1,commandsEnabled:consent.commands_enabled===1,recipient,verifiedAt};};
 const gateway=async(op,payload)=>{gatewayCalls.push(op);if(op==='conversation_review_status')return {state:remote?'reviewed':'reviewable',scope,snapshotDigest:'b'.repeat(64),reviewId:remote?.reviewId??null,sequenceFloor:remote?.sequenceFloor,validUntil:now+30000,delivery_resumed:false,next_step:'existing_owner_qq_enable'};
  assert.equal(op,'conversation_review');assert.equal(await review.reviewAuthority(payload.reviewId,scope,payload),true);remote=payload;if(loseAfter)throw Error('reply lost');return {state:'reviewed',scope,reviewId:payload.reviewId,snapshotDigest:payload.snapshotDigest,sequenceFloor:payload.sequenceFloor,delivery_resumed:false};};
 review=new ConversationQQReview({storage,queue,currentOwnerState:ownerState,gateway,now:()=>now});
 return {db,storage,queue,bridge,review,receipt:receipt.receipt_id,second:second.receipt_id,publish,grant,scope,gatewayCalls,advance:n=>now+=n,lose:()=>loseAfter=true,setGeneration:n=>configGeneration=n,setRevision:n=>sourceRevision=n,revoke:async()=>bridge.setPreference(source,{channel:'qq',enabled:false,commands_enabled:false,selection:{mode:'none',context_refs:[]},expected_revision:bridge.preference(source,'qq').revision,confirm:true})};
}
test('explicit exact owner review leaves uncertain tombstone, skips backlog, permits only later new receipts',async t=>{
 const f=await fixture(t),preview=await f.review.preview(f.receipt);assert.equal(f.queue.hasUnknown(),true);let confirmations=0;
 const result=await f.review.confirm(preview.review_id,preview.scope,async()=>{confirmations++;});assert.equal(confirmations,1);assert.equal(result.state,'reviewed');assert.equal(result.original_delivery,'unknown');assert.equal(result.delivery_resumed,false);assert.equal(f.queue.delivery(f.receipt).state,'unknown');assert.equal(f.queue.hasUnknown(),false);assert.equal(f.queue.delivery(f.second).state,'suppressed');
 const next=await f.publish();assert.equal(f.queue.delivery(next.receipt_id).state,'queued');assert.equal(f.gatewayCalls.filter(x=>x==='conversation_review').length,1);
 await f.review.confirm(preview.review_id,preview.scope,async()=>{throw Error('should not confirm again');});assert.equal(f.gatewayCalls.filter(x=>x==='conversation_review').length,1);
});
test('unknown gateway outcome uses readback only and never retries review mutation',async t=>{
 const f=await fixture(t),p=await f.review.preview(f.receipt);f.lose();const result=await f.review.confirm(p.review_id,p.scope,async()=>{});assert.equal(result.state,'readback_required');assert.equal(f.queue.hasUnknown(),true);
 await f.review.confirm(p.review_id,p.scope,async()=>{throw Error('no second mutation');});assert.equal((await f.review.readback(p.review_id)).state,'reviewed');assert.equal(f.gatewayCalls.filter(x=>x==='conversation_review').length,1);assert.equal(f.queue.delivery(f.receipt).state,'unknown');
});
test('expired body and revoked current operations/consent remain metadata-reviewable',async t=>{
 const f=await fixture(t);await f.revoke();f.grant.enabled=false;f.setRevision(2);f.advance(86400001);f.bridge.expire();assert.equal(f.bridge.one('SELECT body FROM conversation_v2_responses WHERE receipt_id=?',f.receipt).body,null);
 const p=await f.review.preview(f.receipt),r=await f.review.confirm(p.review_id,p.scope,async()=>{});assert.equal(r.state,'reviewed');assert.equal(r.delivery_resumed,false);assert.equal(f.queue.delivery(f.receipt).state,'unknown');
});
test('changed generation, consent or unknown-set/max sequence invalidates pending confirmation',async t=>{
 for(const change of [f=>f.setGeneration(2),f=>f.setRevision(2),f=>f.revoke(),f=>f.publish(),f=>f.queue.rows("UPDATE conversation_qq_outbox SET status='uncertain' WHERE receipt_id=?",f.second)]){
  const f=await fixture(t),p=await f.review.preview(f.receipt);await change(f);await assert.rejects(f.review.confirm(p.review_id,p.scope,async()=>{}));assert.equal(f.queue.hasUnknown(),true);assert.equal(f.gatewayCalls.filter(x=>x==='conversation_review').length,0);
 }
});
test('new responses while unknown are suppressed, another unknown still blocks after exact review',async t=>{
 const f=await fixture(t);const next=await f.publish();assert.equal(next.channels.qq.state,'suppressed');f.queue.rows("UPDATE conversation_qq_outbox SET status='uncertain' WHERE receipt_id=?",f.second);
 const p=await f.review.preview(f.receipt);assert.equal((await f.review.confirm(p.review_id,p.scope,async()=>{})).state,'reviewed');assert.equal(f.queue.hasUnknown(),true);assert.equal(f.queue.delivery(f.receipt).state,'unknown');assert.equal(f.queue.delivery(f.second).state,'unknown');
});
test('no guard, stale confirmation, mismatched scope or producer-like verifier request cannot authorize',async t=>{
 const f=await fixture(t),p=await f.review.preview(f.receipt);assert.equal(await f.review.reviewAuthority(p.review_id,f.scope,{reviewId:p.review_id}),false);
 await assert.rejects(f.review.confirm(p.review_id,p.scope),/confirmation_required/);await assert.rejects(f.review.confirm(p.review_id,'x',async()=>{}));f.advance(30001);await assert.rejects(f.review.confirm(p.review_id,p.scope,async()=>{}));assert.equal(f.gatewayCalls.filter(x=>x==='conversation_review').length,0);
});
test('authorization window never extends on readback; verified settlement can occur after it expires',async t=>{
 const f=await fixture(t),p=await f.review.preview(f.receipt);f.lose();await f.review.confirm(p.review_id,p.scope,async()=>{});
 const stored=f.review.one(p.review_id),payload=JSON.parse(stored.payload);assert.equal(await f.review.reviewAuthority(p.review_id,f.scope,payload),true);
 f.advance(30001);assert.equal(await f.review.reviewAuthority(p.review_id,f.scope,payload),false);
 assert.equal((await f.review.readback(p.review_id)).state,'reviewed');assert.equal(f.review.one(p.review_id).authorized_until,stored.authorized_until);assert.equal(f.gatewayCalls.filter(x=>x==='conversation_review').length,1);
});
test('messages admitted during remote review remain suppressed, final cutoff includes them',async t=>{
 const f=await fixture(t),p=await f.review.preview(f.receipt),originalGateway=f.review.gateway;let admitted;
 f.review.gateway=async(op,payload)=>{if(op==='conversation_review')admitted=await f.publish();return originalGateway(op,payload);};
 assert.equal((await f.review.confirm(p.review_id,p.scope,async()=>{})).state,'reviewed');assert.equal(f.queue.delivery(admitted.receipt_id).state,'suppressed');const marker=f.review.rows('SELECT * FROM conversation_qq_reviewed')[0];assert.equal(marker.sequence_floor,3);assert.equal(f.queue.delivery(f.receipt).state,'unknown');
});
test('owner scope change after confirmed gateway review blocks local settlement without retry',async t=>{
 const f=await fixture(t),p=await f.review.preview(f.receipt),originalGateway=f.review.gateway;
 f.review.gateway=async(op,payload)=>{const r=await originalGateway(op,payload);if(op==='conversation_review')f.setRevision(2);return r;};
 const blocked=await f.review.confirm(p.review_id,p.scope,async()=>{});assert.equal(blocked.state,'blocked');assert.equal(blocked.next_step,'manual_reconciliation_required');assert.equal((await f.review.readback(p.review_id)).state,'blocked');assert.equal(f.queue.hasUnknown(),true);assert.equal(f.review.rows('SELECT * FROM conversation_qq_reviewed').length,0);assert.equal(f.gatewayCalls.filter(x=>x==='conversation_review').length,1);
});

test('gateway original source generation/revision/binding digest must match immutable queued receipt',async t=>{
 for(const field of ['sourceGeneration','sourceGrantRevision','sourceBindingDigest']){const f=await fixture(t);f.scope[field]=field==='sourceBindingDigest'?'0'.repeat(64):999;await assert.rejects(f.review.preview(f.receipt),/original_binding_mismatch/);}
});

test('signed gateway result must correlate exact committed snapshot and sequence floor',async t=>{
 for(const field of ['snapshotDigest','sequenceFloor']){const f=await fixture(t),p=await f.review.preview(f.receipt),originalGateway=f.review.gateway;f.review.gateway=async(op,input)=>{const r=await originalGateway(op,input);if(op==='conversation_review')r[field]=field==='snapshotDigest'?'0'.repeat(64):999;return r;};assert.equal((await f.review.confirm(p.review_id,p.scope,async()=>{})).state,'readback_required');assert.equal(f.queue.hasUnknown(),true);assert.equal((await f.review.readback(p.review_id)).state,'reviewed');}
});

test('concurrent owner tabs cannot confirm a second intent while first review is awaiting gateway',async t=>{
 const f=await fixture(t),first=await f.review.preview(f.receipt),second=await f.review.preview(f.receipt),originalGateway=f.review.gateway;
 let release,started;const waiting=new Promise(r=>release=r),entered=new Promise(r=>started=r);
 f.review.gateway=async(op,input)=>{if(op==='conversation_review'){started();await waiting;}return originalGateway(op,input);};
 const flight=f.review.confirm(first.review_id,first.scope,async()=>{});await entered;
 await assert.rejects(f.review.confirm(second.review_id,second.scope,async()=>{}),/already_pending/);
 await assert.rejects(f.review.preview(f.receipt),/already_pending/);
 assert.equal(f.review.one(first.review_id).state,'confirmed');assert.equal(f.review.one(second.review_id).state,'prepared');
 release();assert.equal((await flight).state,'reviewed');assert.equal(f.gatewayCalls.filter(x=>x==='conversation_review').length,1);
});
test('readback or blocked review prevents creating a replacement remote review ID',async t=>{
 const f=await fixture(t),first=await f.review.preview(f.receipt),second=await f.review.preview(f.receipt);f.lose();
 assert.equal((await f.review.confirm(first.review_id,first.scope,async()=>{})).state,'readback_required');
 for(const state of ['readback','blocked']){f.review.rows('UPDATE conversation_qq_reviews SET state=? WHERE review_id=?',state,first.review_id);await assert.rejects(f.review.preview(f.receipt),/already_pending/);await assert.rejects(f.review.confirm(second.review_id,second.scope,async()=>{}),/already_pending/);}
 assert.equal(f.gatewayCalls.filter(x=>x==='conversation_review').length,1);
});

test('preview mutation reclaims only expired never-confirmed drafts, retaining all durable intent tombstones',async t=>{
 const f=await fixture(t),draft=await f.review.preview(f.receipt),row=f.review.one(draft.review_id);
 for(const [index,state] of ['confirmed','readback','blocked','reviewed','prepared'].entries()){const id='00000000-0000-0000-0000-'+String(index+1).padStart(12,'0');f.review.rows('INSERT INTO conversation_qq_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,'different-receipt-'+index,row.scope_hash,row.snapshot,state,row.expires_at,null,null,row.created_at,row.updated_at,row.created_at,row.expires_at);}
 f.advance(30001);assert.equal(f.review.one(draft.review_id).state,'prepared','read helper must not clean storage');
 const fresh=await f.review.preview(f.receipt);assert.equal(f.review.one(draft.review_id),null);assert.equal(f.review.one(fresh.review_id).state,'prepared');
 for(let index=0;index<5;index++)assert.ok(f.review.one('00000000-0000-0000-0000-'+String(index+1).padStart(12,'0')),'every once-confirmed record remains, including an inconsistent prepared tombstone');
 await assert.rejects(f.review.confirm(draft.review_id,draft.scope,async()=>{}),/not_found/);assert.equal(f.gatewayCalls.filter(x=>x==='conversation_review').length,0);
});
