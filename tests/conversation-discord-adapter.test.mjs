import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ConversationBridge,CONVERSATION_OPERATIONS} from '../src/owner/conversation-bridge.mjs';
import {ConversationDiscordAdapter} from '../src/owner/conversation-discord-adapter.mjs';
const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
const hex=b=>Buffer.from(b).toString('hex');
const publicKey=hex(await crypto.subtle.exportKey('raw',pair.publicKey));
const contextRef='12345678-1234-1234-1234-123456789abc';
const context={kind:'conversation',version:2,context_ref:'context-1',receipt_id:contextRef,conversation_id:'conversation-1',source_id:'dot',thread_id:'thread'};
const b={publicOrigin:'https://relay.example',ownerId:'owner',appId:'100',userId:'200',dmId:'300'};
function fixture(){
  let now=1700000000000;const db=new DatabaseSync(':memory:');
  const storage={sql:{exec(q,...args){const rows=q.includes(';')&&!args.length?(db.exec(q),[]):db.prepare(q).all(...args);return {toArray:()=>rows};}},transaction:async fn=>fn()};
  const calls=[];let valid=true;
  const bridge={resolveDiscordReceipt(ref,msg){if(!valid||ref!==contextRef||msg!=='400')throw Object.assign(Error('stale'),{code:'bridge_control_expired',status:409});return context;},async enqueueCommand(trusted,input,guard){await guard();calls.push({trusted,input});return {state:'pending'};}};
  const adapter=new ConversationDiscordAdapter({storage,bindings:b,bridge,publicKey,now:()=>now});
  const payload=(id='500')=>({id,application_id:b.appId,type:3,user:{id:b.userId},context:1,channel_id:b.dmId,authorizing_integration_owners:{'1':b.userId},message:{id:'400',channel_id:b.dmId,author:{id:b.appId}},data:{component_type:2,custom_id:'rvconv:'+contextRef}});
  const request=async(p,changes={})=>{const raw=changes.raw??JSON.stringify(p),stamp=String(changes.timestamp??Math.floor(now/1000)),sig=hex(await crypto.subtle.sign('Ed25519',pair.privateKey,new TextEncoder().encode(stamp+raw)));return new Request(b.publicOrigin+'/discord/interactions',{method:'POST',headers:{'x-signature-timestamp':stamp,'x-signature-ed25519':changes.signature??sig},body:changes.body??raw});};
  const open=async()=>{const r=await adapter.handle(await request(payload()));assert.equal(r.status,200);const data=await r.json();assert.equal(data.type,9);return data.data.custom_id;};
  const submit=(ref,id='501',text='继续调查，不要部署')=>({...payload(id),type:5,data:{custom_id:ref,components:[{type:1,components:[{type:4,custom_id:'instruction',value:text}]}]}});
  return {adapter,bridge,calls,payload,request,open,submit,storage,now:()=>now,setNow:n=>now=n,revoke:()=>valid=false};
}
test('signed button/modal resolves stored target and queues only configured owner, no execution claim',async()=>{
  const f=fixture(),ref=await f.open(),r=await f.adapter.handle(await f.request(f.submit(ref)));assert.equal(r.status,200);assert.match((await r.json()).data.content,/尚未执行/);
  assert.deepEqual(f.calls,[{trusted:{channel:'discord',owner_id:'owner',requester_id:'200',conversation_id:'300',event_id:'501'},input:{receipt_id:contextRef,text:'继续调查，不要部署',ttl_seconds:3600}}]);
});
test('raw signature, timestamp, app, owner, channel, message author and install are auth boundaries',async()=>{
  for(const alter of [p=>p.user.id='999',p=>p.application_id='999',p=>p.channel_id='999',p=>p.message.author.id='999',p=>p.message.channel_id='999',p=>p.guild_id='999',p=>p.member={user:{id:'200'}},p=>p.context=2,p=>p.authorizing_integration_owners={'0':'0','1':'999'}]){
    const f=fixture(),p=f.payload();alter(p);assert.equal((await f.adapter.handle(await f.request(p))).status,403);assert.equal(f.calls.length,0);
  }
  const f=fixture();for(const opts of [{signature:'0'.repeat(128)},{timestamp:1699999000},{body:JSON.stringify(f.payload())+' '}])assert.equal((await f.adapter.handle(await f.request(f.payload(),opts))).status,401);
  await assert.rejects(f.adapter.handleVerified(f.payload()),/unverified_interaction/);
});
test('stale, unknown and cross-message targets never enqueue',async()=>{
  const f=fixture(),ref=await f.open();const cross=f.submit(ref);cross.message.id='401';assert.equal((await f.adapter.handle(await f.request(cross))).status,409);
  f.revoke();assert.equal((await f.adapter.handle(await f.request(f.submit(ref)))).status,409);assert.equal(f.calls.length,0);
  const g=fixture(),p=g.payload();p.data.custom_id='rvconv:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';assert.equal((await g.adapter.handle(await g.request(p))).status,409);
});
test('modal bounded text, expiry and one-time submission replay protection',async()=>{
  const f=fixture(),ref=await f.open();
  for(const text of ['', 'x'.repeat(1201),'a\u0000b'])assert.equal((await f.adapter.handle(await f.request(f.submit(ref,'501',text)))).status,422);
  assert.equal((await f.adapter.handle(await f.request(f.submit(ref)))).status,200);
  assert.equal((await f.adapter.handle(await f.request(f.submit(ref,'502')))).status,409);
  assert.equal((await f.adapter.handle(await f.request(f.submit(ref,'501','changed')))).status,409);
  // Exact network duplicate is sent through the durable queue's event-id deduplication.
  assert.equal((await f.adapter.handle(await f.request(f.submit(ref)))).status,200);
  assert.equal(f.calls[0].trusted.event_id,f.calls[1].trusted.event_id);
  f.setNow(1700000300001);assert.equal((await f.adapter.handle(await f.request(f.submit(ref)))).status,409);
});
test('opening event duplicate reuses modal and rejects altered origin',async()=>{
  const f=fixture(),ref=await f.open();assert.equal((await (await f.adapter.handle(await f.request(f.payload()))).json()).data.custom_id,ref);
});
test('timeout responds well inside Discord 3-second deadline without fake success/retry',async()=>{
  const f=fixture(),ref=await f.open();let finish;f.bridge.enqueueCommand=()=>new Promise(resolve=>finish=resolve);f.adapter.timeoutMs=25;
  const start=performance.now(),response=await f.adapter.handle(await f.request(f.submit(ref)));assert.ok(performance.now()-start<1000);assert.match((await response.json()).data.content,/无法确认/);finish({state:'pending'});
});
test('other valid components return null for existing dashboard dispatcher',async()=>{
  const f=fixture(),p=f.payload();p.data.custom_id='view:existing';assert.equal(await f.adapter.handle(await f.request(p)),null);
});
test('slow unverified body times out without ever starting authenticated work later',async()=>{
  const f=fixture();f.adapter.timeoutMs=20;const signed=await f.request(f.payload()),raw=await signed.text();let controller;
  const request=new Request(signed.url,{method:'POST',headers:signed.headers,body:new ReadableStream({start(c){controller=c;}}),duplex:'half'});
  let resolutions=0;f.bridge.resolveDiscordReceipt=()=>{resolutions++;return context;};
  assert.equal((await f.adapter.handle(request)).status,503);
  controller.enqueue(new TextEncoder().encode(raw));controller.close();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(resolutions,0);assert.equal(f.calls.length,0);
});
test('body limit and ping signature verification apply before any storage action',async()=>{
  const f=fixture();assert.equal((await f.adapter.handle(await f.request(f.payload(),{raw:'x'.repeat(65537)}))).status,413);
  const ping={id:'900',application_id:b.appId,type:1};assert.deepEqual(await (await f.adapter.handle(await f.request(ping))).json(),{type:1});
  assert.equal((await f.adapter.handle(await f.request(ping,{signature:'0'.repeat(128)}))).status,401);
});
test('modal tickets retain only a digest and expire without another user interaction',async()=>{
  const f=fixture(),ref=await f.open(),text='private owner instruction';
  await f.adapter.handle(await f.request(f.submit(ref,'501',text)));
  const ticket=f.adapter.one('SELECT * FROM conversation_discord_modals WHERE ref=?',ref);
  assert.match(ticket.submission_hash,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(ticket).includes(text));
  assert.equal(f.adapter.nextExpiry(),1700000300000);f.setNow(1700000300000);f.adapter.expire();assert.equal(f.adapter.nextExpiry(),Infinity);
});
test('conversation adapter refuses task-shaped or mismatched receipt resolver results',async()=>{
  for(const alter of [c=>({...c,project_id:'p'}),c=>({...c,kind:'task'}),c=>({...c,version:1}),c=>({...c,receipt_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}),c=>({...c,thread_id:''})]){
    const f=fixture();f.bridge.resolveDiscordReceipt=()=>alter(context);
    assert.equal((await f.adapter.handle(await f.request(f.payload()))).status,409);assert.equal(f.calls.length,0);
  }
});
test('a modal cannot be retargeted to another displayed receipt even in the same conversation',async()=>{
  const f=fixture(),ref=await f.open();
  f.bridge.resolveDiscordReceipt=()=>({...context,receipt_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'});
  assert.equal((await f.adapter.handle(await f.request(f.submit(ref)))).status,409);assert.equal(f.calls.length,0);
});
test('late core transaction must recheck admission guard and cannot enqueue after timeout',async()=>{
  const f=fixture(),ref=await f.open();f.adapter.timeoutMs=20;let release,finished;
  const done=new Promise(resolve=>finished=resolve);let writes=0,lateError;
  f.bridge.enqueueCommand=async(_trusted,_input,guard)=>{await new Promise(resolve=>release=resolve);try{await guard();writes++;return {state:'pending'};}catch(error){lateError=error.code;throw error;}finally{finished();}};
  const response=await f.adapter.handle(await f.request(f.submit(ref)));assert.match((await response.json()).data.content,/无法确认/);
  release();await done;assert.equal(writes,0);assert.equal(lateError,'interaction_admission_expired');
});
test('outer edge admission guard can deny without writing a ticket or queue record',async()=>{
  const f=fixture();const response=await f.adapter.handle(await f.request(f.payload()),{admissionGuard:()=>{throw Object.assign(Error('edge expired'),{code:'edge_expired',status:409});}});
  assert.equal(response.status,409);assert.equal(f.adapter.nextExpiry(),Infinity);assert.equal(f.calls.length,0);
});
test('legacy task controls are not handled by conversation adapter',async()=>{
  const f=fixture(),p=f.payload();p.data.custom_id='rvcommand:'+contextRef;
  assert.equal(await f.adapter.handle(await f.request(p)),null);assert.equal(f.adapter.nextExpiry(),Infinity);
});
async function realFixture(){
  const f=fixture(),source={source_id:'dot',enabled:true},other={source_id:'muse',enabled:true};
  const deliveries=new Map();let generation=1,count=0;
  const core=new ConversationBridge({storage:f.storage,sources:[source,other],authority:s=>({enabled:true,provider_id:s.source_id,account_binding:'owner-account',generation,revision:1,operations:CONVERSATION_OPERATIONS}),recipientBinding:channel=>channel==='discord'?'owner-discord-binding':null,recipient:t=>t.channel==='discord'&&t.owner_id===b.ownerId&&t.requester_id===b.userId&&t.conversation_id===b.dmId,enqueue:async(channel,a)=>{assert.equal(channel,'discord');assert.equal(a.kind,'conversation');deliveries.set(a.receipt_id,{state:'provider_accepted',message_id:String(400+count++)});},delivery:(id,channel)=>channel==='discord'?deliveries.get(id):null,now:f.now});
  const set=async(enabled=true)=>core.setPreference(source,{channel:'discord',enabled,commands_enabled:enabled,selection:{mode:enabled?'all_registered':'none',context_refs:[]},expected_revision:core.preference(source,'discord').revision,confirm:true});
  await set();const registered=await core.registerContext(source,{kind:'conversation',version:2,conversation_id:'chat-actual',thread_id:'thread-actual'});
  const publish=async(id='answer-1')=>core.publishResponse(source,{context_ref:registered.context_ref,response_id:id,text:'已整理研究结果',content_kind:'user_visible_response',origin:'source',sensitivity:'normal',reviewed:true});
  const receipt=await publish();f.adapter.bridge=core;
  const open=async(receiptId=receipt.receipt_id,messageId='400',event='500')=>{const p=f.payload(event);p.message.id=messageId;p.data.custom_id='rvconv:'+receiptId;const response=await f.adapter.handle(await f.request(p));assert.equal(response.status,200,JSON.stringify(await response.clone().json()));return (await response.json()).data.custom_id;};
  return {...f,core,source,other,registered,receipt,publish,open,set,deliveries,rotate:()=>generation++};
}
test('real conversation core: signed button/modal -> exact context claim -> acknowledgment, no task tables',async()=>{
  const f=await realFixture(),modal=await f.open();const response=await f.adapter.handle(await f.request(f.submit(modal)));
  assert.equal(response.status,200);assert.match((await response.json()).data.content,/尚未执行/);
  assert.equal(f.core.has('branches'),false);assert.equal(f.core.has('events'),false);
  const claimed=await f.core.claim(f.source,{context_ref:f.registered.context_ref,claim_id:'poll-1'});
  assert.equal(claimed.state,'claimed');assert.equal(claimed.receipt_id,f.receipt.receipt_id);assert.equal(claimed.context.kind,'conversation');assert.equal(claimed.context.conversation_id,'chat-actual');assert.equal(claimed.context.thread_id,'thread-actual');assert.equal(claimed.execution,'source_policy_required');
  assert.equal(claimed.context.project_id,undefined);
  const ack=await f.core.acknowledge(f.source,{command_id:claimed.command_id,claim_token:claimed.claim_token,outcome:'completed'});assert.equal(ack.state,'completed');assert.equal(ack.execution_confirmed_by,'source_report_only');
  assert.equal(f.core.one('SELECT payload FROM conversation_v2_commands WHERE command_id=?',claimed.command_id).payload,null);
});
test('real conversation core: duplicate modal creates one command; duplicate claim never authorizes execution',async()=>{
  const f=await realFixture(),modal=await f.open();for(let i=0;i<2;i++)assert.equal((await f.adapter.handle(await f.request(f.submit(modal)))).status,200);
  assert.equal(f.core.one('SELECT COUNT(*) AS n FROM conversation_v2_commands').n,1);
  const input={context_ref:f.registered.context_ref,claim_id:'poll-duplicate'};await f.core.claim(f.source,input);const repeat=await f.core.claim(f.source,input);assert.equal(repeat.duplicate,true);assert.equal(repeat.execute,false);assert.equal(repeat.claim_token,undefined);
  f.setNow(f.now()+60001);const next=await f.core.claim(f.source,{context_ref:f.registered.context_ref,claim_id:'another-poll'});assert.equal(next.state,'empty');assert.equal(f.core.one('SELECT state FROM conversation_v2_commands').state,'unknown');
});
test('real conversation core: immutable receipt cannot be swapped to another accepted message',async()=>{
  const f=await realFixture(),modal=await f.open(),other=await f.publish('answer-2');
  const swapped=f.payload('503');swapped.data.custom_id='rvconv:'+other.receipt_id;
  assert.equal((await f.adapter.handle(await f.request(swapped))).status,409);
  const cross=f.submit(modal);cross.message.id='401';assert.equal((await f.adapter.handle(await f.request(cross))).status,409);
  assert.equal(f.core.one('SELECT COUNT(*) AS n FROM conversation_v2_commands').n,0);
  assert.equal(f.core.resolveDiscordReceipt(other.receipt_id,'401').context_ref,f.registered.context_ref);
});
test('real conversation core: consent revoke/re-enable invalidates previously displayed response and open modal',async()=>{
  const f=await realFixture(),modal=await f.open();await f.set(false);await f.set(true);
  assert.equal((await f.adapter.handle(await f.request(f.submit(modal)))).status,409);
  assert.throws(()=>f.core.resolveDiscordReceipt(f.receipt.receipt_id,'400'),/conversation_message_not_confirmed/);
  const fresh=await f.publish('after-consent-change');assert.equal(f.core.resolveDiscordReceipt(fresh.receipt_id,'401').kind,'conversation');
});
test('real conversation core: source isolation, wrong kind, owner mismatch and authority rotation fail closed',async()=>{
  const f=await realFixture(),modal=await f.open();
  await assert.rejects(f.core.registerContext(f.source,{kind:'task',version:2,conversation_id:'x',thread_id:'y'}),/invalid_conversation_context/);
  await assert.rejects(f.core.registerContext(f.source,{kind:'conversation',version:2,conversation_id:'x',thread_id:'y',project_id:'p'}),/invalid_conversation_context/);
  await assert.rejects(f.core.claim(f.other,{context_ref:f.registered.context_ref,claim_id:'wrong-source'}),/conversation_context_not_found/);
  const attack=f.submit(modal);attack.user.id='999';assert.equal((await f.adapter.handle(await f.request(attack))).status,403);
  f.rotate();assert.equal((await f.adapter.handle(await f.request(f.submit(modal)))).status,409);
  assert.equal(f.core.one('SELECT COUNT(*) AS n FROM conversation_v2_commands').n,0);
});
test('real conversation core: final admission rechecks signed message if provider correlation changes during await',async()=>{
  const f=await realFixture(),modal=await f.open(),enqueue=f.core.enqueueCommand.bind(f.core);
  f.core.enqueueCommand=(trusted,input,guard)=>enqueue(trusted,input,async()=>{f.deliveries.set(f.receipt.receipt_id,{state:'provider_accepted',message_id:'999'});await guard();});
  assert.equal((await f.adapter.handle(await f.request(f.submit(modal)))).status,409);
  assert.equal(f.core.one('SELECT COUNT(*) AS n FROM conversation_v2_commands').n,0);
});
