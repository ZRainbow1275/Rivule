import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto,createHmac,createHash} from 'node:crypto';
import {ConversationBridge,CONVERSATION_OPERATIONS} from '../src/owner/conversation-bridge.mjs';
import {ConversationQQQueue} from '../src/owner/conversation-qq-queue.mjs';
import {ConversationQQCommandAdapter} from '../src/owner/conversation-qq-command-adapter.mjs';
const worker=readFileSync(new URL('../src/owner/worker.js',import.meta.url),'utf8');
const sandbox=vm.createContext({TextEncoder,TextDecoder,Response,Request,Headers,URL,crypto:webcrypto,__name:x=>x,qqHash:async v=>createHash('sha256').update(v).digest('hex'),qqReadBytes:async stream=>new Uint8Array(await new Response(stream).arrayBuffer())});
vm.runInContext(worker.slice(worker.indexOf('async function qqGateKey('),worker.indexOf('var response = ',worker.indexOf('var QQDurableInbox')))+'\nglobalThis.api={handleQQWebhook,qqSign,QQDurableInbox,qqGateKey};',sandbox);
const {handleQQWebhook,qqSign,QQDurableInbox,qqGateKey}=sandbox.api;
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let now=1800000000000,bridge,queue,active=true,network=[],afterPrepare=null,commitFailure=false,authorityActive=true,localBeforeGuard=null;
 const kv=new Map(),storage={sql:{exec(q,...a){if(q.includes('CREATE TABLE')){db.exec(q);return {toArray:()=>[]};}return {toArray:()=>db.prepare(q).all(...a)};}},transaction:async fn=>fn(storage),sync:async()=>{},get:async k=>kv.get(k),put:async(k,v)=>kv.set(k,v)};
 const source={source_id:'pa',enabled:true},grant={enabled:true,provider_id:'dot',account_binding:'real-account',generation:1,revision:1,operations:[...CONVERSATION_OPERATIONS]},config={enabled:true,ownerId:'owner',appId:'123',userOpenId:'openid',allowedSources:['pa']};
 const runtime={active:true,grantId:'grant',bindingFingerprint:'destination-binding',expiresAt:now+86400000};
 const env={QQ_BRIDGE_SECRET:'test-only-qq-bridge-secret-abcdefghijklmnopqrstuvwxyz',QQ_GATEWAY:{idFromName:n=>n,get:()=>({continuousRequest:async packet=>{
  assert.equal(packet.signature,createHmac('sha256',env.QQ_BRIDGE_SECRET).update('rivule-qq-request-v2\n'+packet.body).digest('hex'));
  const e=JSON.parse(packet.body);network.push(e);let result;
  if(e.operation==='conversation_prepare'){if(afterPrepare)await afterPrepare();result={state:'prepared',challenge:'a'.repeat(64),expiresAt:now+30000,grantRevision:1};}
  else if(e.operation==='conversation_commit'){if(commitFailure)throw Error('lost after possible commit');result={state:'sent',reason:'provider_accepted',messageId:'provider-message'};}
  else throw Error('unexpected operation');
  const body=JSON.stringify({version:2,requestHash:createHash('sha256').update(packet.body).digest('hex'),result});return {body,signature:createHmac('sha256',env.QQ_BRIDGE_SECRET).update('rivule-qq-response-v2\n'+body).digest('hex')};
 }})}};
 bridge=new ConversationBridge({storage,sources:[source],authority:()=>grant,recipientBinding:c=>c==='qq'?'owner:123:openid:destination-binding':null,recipient:v=>v.channel==='qq'&&v.owner_id==='owner'&&v.requester_id==='openid'&&v.conversation_id==='openid',enqueue:(channel,a)=>queue.enqueue(a),delivery:(r,c)=>queue.delivery(r),eraseDelivery:r=>queue.erase(r),now:()=>now});
 queue=new ConversationQQQueue({storage,bridge,env,ownerId:'owner',config:()=>config,sourceAuthority:async()=>({selectable:true,verifiedAt:now}),activation:()=>({...runtime,active}),now:()=>now});
 const rawInbox=new QQDurableInbox(storage);let delegated=0;const inbox={enqueueOnce:async e=>{delegated++;return rawInbox.enqueueOnce(e);}};
 const adapter=new ConversationQQCommandAdapter({bridge,inbox,rawInbox,config:()=>config,authority:async()=>({active:authorityActive,conversationVerifierConfigured:true,ownerId:'owner',appId:'123',userOpenId:'openid',generation:'runtime-generation',validUntil:now+10000}),revoked:async c=>await storage.get(await qqGateKey(c.appId,c.userOpenId))===true,now:()=>now});
 const original=bridge.enqueueCommand.bind(bridge);bridge.enqueueCommand=(trusted,input,guard)=>original(trusted,input,async()=>{if(localBeforeGuard)await localBeforeGuard();await guard();});
 const preference=()=>bridge.setPreference(source,{channel:'qq',enabled:true,commands_enabled:true,selection:{mode:'all_registered',context_refs:[]},expected_revision:bridge.preference(source,'qq').revision,confirm:true});
 const revoke=()=>bridge.setPreference(source,{channel:'qq',enabled:false,commands_enabled:false,selection:{mode:'none',context_refs:[]},expected_revision:bridge.preference(source,'qq').revision,confirm:true});
 async function publish(){await preference();const reg=await bridge.registerContext(source,{kind:'conversation',version:2,conversation_id:'conversation',thread_id:'thread'}),receipt=await bridge.publishResponse(source,{context_ref:reg.context_ref,response_id:'response',text:'An ordinary response, not a task update.',content_kind:'user_visible_response',origin:'source',sensitivity:'normal',reviewed:true});return {reg,receipt};}
 async function send({receipt,content='/rivule-chat '+receipt+' Explain the second point',author='openid',signature=true,id='message-1',eventId='event-1',type='C2C_MESSAGE_CREATE',timestamp=now,extra={}}){const raw=JSON.stringify({op:0,id:eventId,t:type,d:{id,author:{user_openid:author},content,timestamp:new Date(timestamp).toISOString(),...extra}}),stamp=String(now/1000),sig=signature?await qqSign('test-secret',new TextEncoder().encode(stamp+raw)):'0'.repeat(128);return handleQQWebhook(new Request('https://owner.internal/qq/webhook',{method:'POST',headers:{'X-Bot-Appid':'123','X-Signature-Timestamp':stamp,'X-Signature-Ed25519':sig},body:raw}),{enabled:true,appId:'123',userOpenId:'openid',appSecret:()=> 'test-secret'},adapter,now);}
 return {db,storage,kv,bridge,queue,source,grant,config,publish,send,revoke,network,delegated:()=>delegated,setActive:v=>active=v,setRemote:v=>authorityActive=v,setAfterPrepare:fn=>afterPrepare=fn,setCommitFailure:()=>commitFailure=true,setBeforeGuard:fn=>localBeforeGuard=fn,advance:n=>now+=n};
}
test('real conversation core + signed queue + verified webhook command returns exact source context without task artifacts',async t=>{
 const f=fixture(t),{reg,receipt}=await f.publish();assert.equal(receipt.channels.qq.state,'queued');const job=await f.queue.currentJob(receipt.receipt_id);assert.equal(job.job.kind,'conversation');for(const k of ['projectId','taskId','eventId','acceptedRevision'])assert.ok(!Object.hasOwn(job.job,k));
 assert.equal((await f.queue.drain()).state,'sent');assert.equal(f.queue.delivery(receipt.receipt_id).state,'provider_accepted');assert.match(f.network[0].payload.job.content,/\/rivule-chat/);assert.equal(f.network[1].operation,'conversation_commit');
 assert.equal((await f.send({receipt:receipt.receipt_id})).status,200);assert.equal((await f.send({receipt:receipt.receipt_id,eventId:'redelivered-event'})).status,200);assert.equal(f.delegated(),0);
 const claim=await f.bridge.claim(f.source,{context_ref:reg.context_ref,claim_id:'claim'});assert.equal(claim.text,'Explain the second point');assert.equal(claim.context.conversation_id,'conversation');assert.equal(claim.context.thread_id,'thread');assert.equal(claim.execution,'source_policy_required');assert.ok(!Object.hasOwn(claim.context,'project_id'));assert.equal((await f.bridge.claim(f.source,{context_ref:reg.context_ref,claim_id:'claim'})).execute,false);
 assert.equal((await f.bridge.acknowledge(f.source,{command_id:claim.command_id,claim_token:claim.claim_token,outcome:'rejected'})).execution_confirmed_by,'source_report_only');assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('events','branches')").get().n,0);
});
test('paused channel records suppressed receipt, never backfills when runtime resumes',async t=>{
 const f=fixture(t);f.setActive(false);const {receipt}=await f.publish();assert.equal(receipt.channels.qq.state,'suppressed');f.setActive(true);assert.equal((await f.queue.drain()).state,'idle');assert.equal(f.network.length,0);
});
test('consent revoked during prepare prevents commit, unknown commit never replays',async t=>{
 const f=fixture(t),{receipt}=await f.publish();f.setAfterPrepare(()=>f.revoke());assert.equal((await f.queue.drain()).state,'suppressed');assert.equal(f.network.length,1);assert.equal(f.queue.delivery(receipt.receipt_id).state,'suppressed');
 const g=fixture(t),published=await g.publish();g.setCommitFailure();assert.equal((await g.queue.drain()).state,'uncertain');assert.equal(g.queue.delivery(published.receipt.receipt_id).state,'unknown');assert.equal((await g.queue.drain()).state,'idle');assert.equal(g.network.length,2);
});
test('foreign/badly signed callbacks and unsent/unknown receipts never create commands',async t=>{
 const f=fixture(t),{receipt}=await f.publish();assert.equal((await f.send({receipt:receipt.receipt_id,signature:false})).status,401);assert.equal((await f.send({receipt:receipt.receipt_id,author:'other'})).status,200);assert.equal((await f.send({receipt:receipt.receipt_id})).status,503);assert.equal((await f.send({receipt:'00000000-0000-0000-0000-000000000000',id:'unknown'})).status,503);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM conversation_v2_commands').get().n,0);
});
test('local authenticated revoke at transaction guard blocks command despite lagging remote authority',async t=>{
 const f=fixture(t),{receipt}=await f.publish();await f.queue.drain();f.setBeforeGuard(()=>f.send({type:'FRIEND_DEL',id:'revocation',eventId:'revoke',extra:{openid:'openid'}}));assert.equal((await f.send({receipt:receipt.receipt_id})).status,503);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM conversation_v2_commands').get().n,0);
});
test('plain/task commands delegate unchanged, namespace cannot be guessed from quoted text',async t=>{
 const f=fixture(t);for(const content of ['please tell pa to continue','/rivule abc command','/rivule-chatty fake'])assert.equal((await f.send({content,id:content})).status,200);assert.equal(f.delegated(),3);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='conversation_v2_commands'").get().n,0);
});
test('source grant revocation, receipt expiry and restart-in-flight fence future sends',async t=>{
 const f=fixture(t),{receipt}=await f.publish();f.grant.enabled=false;assert.equal((await f.queue.drain()).state,'suppressed');assert.equal(f.network.length,0);
 const g=fixture(t),r=await g.publish();g.db.prepare("UPDATE conversation_qq_outbox SET status='sending' WHERE receipt_id=?").run(r.receipt.receipt_id);await g.queue.recover();assert.equal(g.queue.delivery(r.receipt.receipt_id).state,'unknown');assert.equal((await g.queue.drain()).state,'idle');
 const h=fixture(t),p=await h.publish();h.advance(86400001);h.bridge.expire();assert.equal(h.queue.delivery(p.receipt.receipt_id).state,'expired');assert.equal(h.db.prepare('SELECT body FROM conversation_v2_responses').get().body,null);assert.ok(!JSON.stringify(h.db.prepare('SELECT * FROM conversation_qq_outbox').all()).includes('ordinary response'));
});

test('same-binding source proof refresh is allowed, stale/future/revoked refreshed proof is not',async t=>{
 const f=fixture(t),{receipt}=await f.publish();let reads=0;f.queue.sourceAuthority=async()=>({selectable:true,verifiedAt:1800000000000-(reads++?0:1000)});
 assert.equal((await f.queue.currentJob(receipt.receipt_id)).source.verifiedAt,1800000000000);
 for(const value of [{selectable:true,verifiedAt:1800000000001},{selectable:true,verifiedAt:1800000000000-86400000},{selectable:false,verifiedAt:1800000000000}]){
  reads=0;f.queue.sourceAuthority=async()=>reads++?value:{selectable:true,verifiedAt:1800000000000};await assert.rejects(f.queue.currentJob(receipt.receipt_id),/conversation_source_unverified/);
 }
});

test('verified command inbox stores no instruction plaintext yet preserves conflict/replay identity',async t=>{
 const f=fixture(t),{receipt}=await f.publish();await f.queue.drain();
 assert.equal((await f.send({receipt:receipt.receipt_id})).status,200);
 const persisted=[...f.kv.values()].find(v=>v?.event?.type==='message');assert.equal(persisted.event.content,null);assert.ok(!JSON.stringify([...f.kv.values()]).includes('Explain the second point'));
 assert.equal((await f.send({receipt:receipt.receipt_id,eventId:'provider-replay'})).status,200);
 assert.equal((await f.send({receipt:receipt.receipt_id,content:'/rivule-chat '+receipt.receipt_id+' Changed instruction'})).status,409);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM conversation_v2_commands').get().n,1);
});
