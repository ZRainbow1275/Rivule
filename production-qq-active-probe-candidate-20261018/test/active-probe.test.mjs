import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { root,hash,clean,source,ownerSource,gateway,owner,forbiddenCalls,NOW,KEY,Socket,adminEvent,button,buttons,deferred,harness,signedHarness } from './harness.mjs';

const manifest=JSON.parse(readFileSync(path.join(root,'PATCH_MANIFEST.json'),'utf8'));
const record=s=>Object.values(s.qqActiveProbes??{}).flatMap(x=>Object.values(x))[0];
const section=(s,start,end)=>s.slice(s.indexOf(start),s.indexOf(end,s.indexOf(start)+start.length));

test('exact inverse returns production gateway bytes; existing owner, passive proof, ordinary transport, bridge and RPC ABI preserved',()=>{
  const base=readFileSync(path.join(root,'reference/gateway-base.mjs'),'utf8');
  assert.equal(hash(base),'cc94f479fab39dac1351638e6fb51bb8f695789c34e93473a45ef3122084c0c8');
  assert.equal(hash(source),manifest.candidateGatewaySha256);
  const reverse=readFileSync(path.join(root,'reverse-patch.json'),'utf8');assert.equal(hash(reverse),manifest.reversePatchSha256);
  let restored=source;for(const e of JSON.parse(reverse).reverse()){assert.equal(restored.split(e.after).length,2);restored=restored.replace(e.after,()=>e.before);}assert.equal(restored,base);
  for(const [start,end] of [['// src/qq-transport.ts','// qq-cloudflare/proof.mjs'],['// qq-cloudflare/proof.mjs','// qq-cloudflare/active-probe.mjs']]){
    const expectedEnd=end==='// qq-cloudflare/active-probe.mjs'?'// qq-cloudflare/admin.mjs':end;assert.equal(section(source,start,end),section(base,start,expectedEnd));
  }
  assert.equal(section(source,'// qq-cloudflare/bridge.mjs','// qq-cloudflare/actor.mjs'),section(base,'// qq-cloudflare/bridge.mjs','// qq-cloudflare/actor.mjs'));
  const rpc=s=>s.slice(s.lastIndexOf('// qq-cloudflare/worker.mjs'));assert.equal(rpc(source),rpc(base));
  assert.equal(hash(ownerSource),'3c19b4634a0d2a100afbe1e12e5687ca9851901ae0f3d67e6e0da56ebf17730c');
  assert.equal(manifest.deployed,false);assert.equal(manifest.runtimeFlagsChanged,false);assert.equal(manifest.configurationFilesCreated,false);
  assert.equal(source.match(/evidence\(\) \{[\s\S]*?\n  \}/)[0],base.match(/evidence\(\) \{[\s\S]*?\n  \}/)[0]);
});

test('real Ed25519 signed owner button sends exact fixed active body only once, with no caller target or reply fields',async t=>{
  const h=await harness(t),signed=await signedHarness(h);
  const p=await (await signed.invoke(adminEvent(101))).json(),ref=button(p);assert.ok(ref);assert.equal(p.data.flags,64);
  assert.equal(h.messages().length,0);
  const action=adminEvent(102,ref);action.token='SYNTHETIC-DISCORD-CALLBACK-TOKEN';Object.assign(action.data,{recipient:'evil',content:'evil',msg_id:'evil',sourceId:'evil',projectId:'evil'});
  const answer=await (await signed.invoke(action)).json();assert.match(answer.data.content,/已提交 QQ/);
  const calls=h.messages();assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.bot.qq.com/v2/users/fixed-user/messages');
  assert.deepEqual(JSON.parse(calls[0].init.body),{msg_type:0,content:'Rivule 主动通知测试：主动消息通道验证。'});
  assert.equal(calls[0].init.redirect,'manual');assert.equal(calls[0].init.headers['X-Union-Appid'],'123');
  for(const field of ['msg_id','event_id','msg_seq','is_wakeup','media'])assert.equal(field in JSON.parse(calls[0].init.body),false);
  assert.equal(button(answer),undefined);assert.equal(signed.calls(),2);assert.equal(h.env.QQ_DELIVERY_ENABLED,'false');assert.equal(h.env.QQ_CAPABILITIES_JSON,'{}');
  const s=await h.snapshot();assert.equal(record(s).receipt.reason,'provider_accepted');assert.equal(s.qqActiveObservedCapability.kind,'isolated_active_probe_observation');
  assert.equal(s.qqActiveObservedCapability.checkedAt,NOW);assert.equal(s.qqActiveObservedCapability.validUntil,NOW+300000);assert.equal(s.qqActiveObservedCapability.confirmedAt,NOW-10000);
  assert.equal(s.qqActiveObservedCapability.proactive,undefined);assert.equal(s.qqActiveObservedCapability.identity,undefined);
  const duplicate=await (await signed.invoke(action)).json();assert.match(duplicate.data.content,/已经处理/);assert.equal(h.messages().length,1);
});

const rejectedIdentity=[['wrong owner',{user:{id:'999'}}],['bot owner',{user:{id:'222',bot:true}}],['wrong app',{application_id:'999'}],['wrong DM',{channel_id:'999'}],['guild context',{context:0,guild_id:'444'}],['group DM context',{context:2}],['wrong message author',{message:{id:'9001',author:{id:'999'}}}],['wrong embedded message channel',{message:{id:'9001',author:{id:'111'},channel_id:'999'}}],['mismatched member',{member:{user:{id:'999'}}}],['wrong installation',{authorizing_integration_owners:{'1':'999'}}],['unknown install type',{authorizing_integration_owners:{'0':'0','9':'222'}}],['missing install',{authorizing_integration_owners:null}],['bad interaction id',{id:'not-digits'}]];
for(const [name,changes] of rejectedIdentity)test('signed boundary rejects '+name,async t=>{
  const h=await harness(t),signed=await signedHarness(h);const r=await signed.invoke(adminEvent(101,'qqsetup:open',changes));assert.ok(r.status>=400);assert.equal(signed.calls(),0);assert.equal(h.messages().length,0);
});
for(const [name,options] of [['tampered signature',{tamper:true}],['expired signature',{age:301}],['future signature',{age:-301}],['wrong origin',{url:'https://other.example/discord/interactions'}],['query string',{url:'https://synthetic.example/discord/interactions?test=1'}],['authorization header',{headers:{authorization:'synthetic'}}]])test('signed boundary rejects '+name,async t=>{
  const h=await harness(t),signed=await signedHarness(h);assert.ok((await signed.invoke(adminEvent(101),options)).status>=400);assert.equal(signed.calls(),0);assert.equal(h.messages().length,0);
});
for(const [name,change] of [['wrong component',p=>p.data.component_type=3],['invented control',p=>p.data.custom_id='qqsetup:active_probe'],['public magic control',p=>p.data.custom_id='qqsetup:test'],['foreign control',p=>p.data.custom_id='qqsetup:00000000-0000-0000-0000-000000000000']])test('gateway rejects '+name,async t=>{
  const h=await harness(t),p=adminEvent(101);change(p);await assert.rejects(gateway.ownerSetup(h.actor,p));assert.equal(h.messages().length,0);
});
test('public Worker and DurableObject fetch remain 404 with no active probe route',async t=>{
  const h=await harness(t);assert.equal((await gateway.worker_default.fetch(new Request('https://example.test/active-probe'))).status,404);
  const object=new gateway.QQGatewayObject(h.ctx,h.env);assert.equal((await object.fetch(new Request('https://example.test/active-probe'))).status,404);assert.equal(typeof object.activeProbe,'undefined');assert.equal(h.messages().length,0);
});

test('replacement panel, expiry and old binding controls cannot approve a send',async t=>{
  const h=await harness(t);const first=await h.approve();await h.panel(103);await assert.rejects(gateway.ownerSetup(h.actor,adminEvent(104,first.ref)),/expired/);
  const next=await h.approve(106);h.advance(300000);await assert.rejects(gateway.ownerSetup(h.actor,adminEvent(107,next.ref)),/expired/);assert.equal(h.messages().length,0);
});
for(const [name,mutate] of [['generation',s=>s.binding.confirmedAt++],['recipient',s=>s.binding.userOpenId='other'],['owner',s=>s.binding.ownerId='other'],['app',s=>s.binding.appId='456']])test('displayed control blocks changed binding '+name,async t=>{
  const h=await harness(t),approval=await h.approve();await h.actor.store.transaction(mutate);const r=await gateway.ownerSetup(h.actor,adminEvent(102,approval.ref));assert.match(r.data.content,/绑定已变化|请先确认 QQ 绑定/);assert.equal(h.messages().length,0);assert.equal(record(await h.snapshot()),undefined);
});

const ineligible=[['stopped',s=>s.control.running=false],['unhealthy',s=>s.qqIngestionHealth.healthy=false],['exhausted',s=>s.activeBudget.usedMs=7200000],['invalid budget ledger',s=>s.activeBudget.usedMs=-1],['unbound',s=>delete s.binding],['missing generation',s=>delete s.binding.confirmedAt],['future generation',s=>s.binding.confirmedAt=NOW+1],['revoked',s=>s.qqRevoked=true]];
for(const [name,mutate] of ineligible)test('no button or message for '+name,async t=>{
  const h=await harness(t);await h.actor.store.transaction(mutate);const p=await h.panel();assert.equal(button(p),undefined);assert.equal(h.messages().length,0);
});
for(const [name,env] of [['ordinary delivery enabled',{QQ_DELIVERY_ENABLED:'true'}],['budget changed',{QQ_DAILY_ACTIVE_BUDGET_MS:'7200001'}],['missing setup flag',{QQ_SETUP_ENABLED:'false'}]])test('no button or message for '+name,async t=>{const h=await harness(t,{env});assert.equal(button(await h.panel()),undefined);assert.equal(h.messages().length,0);});
test('disconnected and in-memory ingestion fault block UI',async t=>{const h=await harness(t);h.actor.runtime.client.ready=false;assert.equal(button(await h.panel()),undefined);h.actor.runtime.client.ready=true;h.actor.store.qqIngestionFault=true;assert.equal(button(await h.panel(103)),undefined);assert.equal(h.messages().length,0);});

test('Discord components remain within five rows/five buttons and include fixed-text approval',async t=>{
  const h=await harness(t),p=await h.panel();assert.ok(p.data.components.length<=5);assert.ok(p.data.components.every(row=>row.components.length<=5));assert.equal(buttons(p).filter(x=>x.label==='发送一次主动测试').length,1);assert.match(p.data.content,/Rivule 主动通知测试：主动消息通道验证。/);assert.ok(p.data.content.length<2000);for(const c of buttons(p))assert.ok(c.custom_id.length<=100);
});

for(const [name,mutate] of [['revocation',s=>s.qqRevoked=true],['generation',s=>s.binding.confirmedAt++],['recipient',s=>s.binding.userOpenId='other'],['health',s=>s.qqIngestionHealth.healthy=false],['stop',s=>s.control.running=false],['budget',s=>s.activeBudget.usedMs=7200000]])test('rechecks '+name+' after token acquisition; reservation stays consumed',async t=>{
  const h=await harness(t),approval=await h.approve();h.actor.runtime.client.tokenValue=async()=>{await h.actor.store.transaction(mutate);return 'SYNTHETIC';};
  const r=await gateway.fixedActiveProbe(h.actor,approval.action,approval.id);assert.equal(r.state,'not_sent');assert.equal(h.messages().length,0);assert.ok(record(await h.snapshot()));if(!['generation','recipient'].includes(name))assert.equal(button(await h.panel(104)),undefined);else { assert.ok(button(await h.panel(104))); assert.equal((await gateway.fixedActiveProbe(h.actor,approval.action,'106')).state,'blocked');assert.equal(h.messages().length,0); }
});
test('token failure consumes the one-shot reservation and does not send or retry',async t=>{
  const h=await harness(t),approval=await h.approve();let tokens=0;h.actor.runtime.client.tokenValue=async()=>{tokens++;throw Error('synthetic');};const r=await gateway.fixedActiveProbe(h.actor,approval.action,approval.id);assert.equal(r.state,'not_sent');assert.equal(tokens,1);assert.equal(h.messages().length,0);assert.equal((await gateway.fixedActiveProbe(h.actor,approval.action,'103')).state,'not_sent');assert.equal(tokens,1);
});

test('20 concurrent executions share one durable reservation and exactly one POST',async t=>{
  const h=await harness(t),approval=await h.approve(),pending=deferred();let tokens=0;h.actor.runtime.client.tokenValue=()=>{tokens++;return pending.promise;};
  const executions=Array.from({length:20},(_,i)=>gateway.fixedActiveProbe(h.actor,approval.action,String(200+i)));
  await sleep(20);assert.equal(tokens,1);assert.equal(h.messages().length,0);assert.equal(record(await h.snapshot()).receipt.reason,'reserved_before_send');pending.resolve('SYNTHETIC');const results=await Promise.all(executions);assert.equal(results.filter(x=>x.reason==='provider_accepted').length,1);assert.equal(h.messages().length,1);
});
test('simultaneous genuine button clicks cannot bypass single-use control',async t=>{
  const h=await harness(t),approval=await h.approve();const results=await Promise.allSettled([gateway.ownerSetup(h.actor,adminEvent(102,approval.ref)),gateway.ownerSetup(h.actor,adminEvent(103,approval.ref))]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(h.messages().length,1);
});
test('new panel opened during pending POST cannot offer another active attempt',async t=>{
  const pending=deferred(),h=await harness(t,{message:()=>pending.promise});const send=h.send();await sleep(20);assert.equal(h.messages().length,1);assert.equal(button(await h.panel(105)),undefined);pending.resolve(Response.json({id:'accepted'}));await send;assert.equal(h.messages().length,1);
});

test('durable reservation survives reconstruction before POST and remains consumed',async t=>{
  const h=await harness(t),approval=await h.approve(),pending=deferred();h.actor.runtime.client.tokenValue=()=>pending.promise;const flight=gateway.fixedActiveProbe(h.actor,approval.action,approval.id);await sleep(20);
  const restarted=new gateway.GatewayActor(h.ctx,h.env,{fetch:h.network,WebSocket:Socket,now:h.now});restarted.runtime={client:{ready:true,tokenValue:async()=>{throw Error('must_not_fetch_token');}}};
  const duplicate=await gateway.fixedActiveProbe(restarted,approval.action,'105');assert.equal(duplicate.reason,'reserved_before_send');assert.equal(button(await gateway.ownerSetup(restarted,adminEvent(106))),undefined);assert.equal(h.messages().length,0);
  h.actor.runtime.client.ready=false;pending.resolve('SYNTHETIC');await flight;assert.equal(h.messages().length,0);
});
test('accepted response loss stays uncertain across restart and never resends',async t=>{
  const h=await harness(t,{message:()=>{throw Error('provider_accepted_but_response_lost');}}),approval=await h.approve();const r=await gateway.fixedActiveProbe(h.actor,approval.action,approval.id);assert.equal(r.reason,'network_outcome_unknown');assert.equal(h.messages().length,1);
  const restarted=new gateway.GatewayActor(h.ctx,h.env,{fetch:h.network,WebSocket:Socket,now:h.now});restarted.runtime={client:{ready:true,tokenValue:async()=> 'SYNTHETIC'}};assert.equal((await gateway.fixedActiveProbe(restarted,approval.action,'106')).reason,'network_outcome_unknown');assert.equal(h.messages().length,1);
});

const outcomes=[['success',{id:'accepted'},200,'sent','provider_accepted'],['401',{code:1},401,'not_sent','provider_rejected'],['403',{code:1},403,'not_sent','provider_rejected'],['429',{code:1},429,'not_sent','rate_limited'],['permission denied',{code:40034105},400,'not_sent','proactive_permission_denied'],['recipient refused',{err_code:40054013},400,'not_sent','recipient_refused'],['friend missing',{code:40054004},400,'not_sent','friendship_missing'],['unknown code',{code:9876543},400,'uncertain','provider_outcome_unknown'],['500',{code:0},500,'uncertain','provider_outcome_unknown'],['missing id',{},200,'uncertain','provider_outcome_unknown'],['numeric id',{id:42},200,'uncertain','provider_outcome_unknown'],['invalid id',{id:'bad\n'},200,'uncertain','provider_outcome_unknown'],['nonzero business code with id',{id:'accepted',code:40034105},200,'not_sent','proactive_permission_denied'],['nonzero err code with id',{id:'accepted',err_code:40054013},200,'not_sent','recipient_refused'],['redirect',{},302,'uncertain','provider_outcome_unknown']];
for(const [name,body,status,state,reason] of outcomes)test('provider '+name+' gives one POST and a permanently consumed receipt',async t=>{
  const h=await harness(t,{message:()=>Response.json(body,{status,headers:{'retry-after':'1'}})}),approval=await h.approve();let tokens=0;h.actor.runtime.client.tokenValue=async()=>{tokens++;return 'SYNTHETIC';};const r=await gateway.fixedActiveProbe(h.actor,approval.action,approval.id);assert.equal(r.state,state);assert.equal(r.reason,reason);assert.equal(tokens,1);assert.equal(h.messages().length,1);assert.equal((await gateway.fixedActiveProbe(h.actor,approval.action,'103')).reason,reason);assert.equal(h.messages().length,1);assert.equal(button(await h.panel(105)),undefined);assert.equal(Boolean((await h.snapshot()).qqActiveObservedCapability),reason==='provider_accepted');
});
for(const [name,message] of [['malformed JSON',()=>new Response('{')],['oversized response',()=>new Response('x'.repeat(65537))],['invalid UTF-8',()=>new Response(Uint8Array.from([255]))],['network timeout',()=>{throw new DOMException('synthetic','TimeoutError');}]])test(name+' remains consumed, with no observation or retry',async t=>{
  const h=await harness(t,{message}),approval=await h.approve();assert.equal((await gateway.fixedActiveProbe(h.actor,approval.action,approval.id)).state,'uncertain');assert.equal(h.messages().length,1);assert.equal(button(await h.panel(105)),undefined);assert.equal((await h.snapshot()).qqActiveObservedCapability,undefined);
});

test('reservation commit failure sends zero messages',async t=>{
  const h=await harness(t),approval=await h.approve();h.db.failCommit=()=>{const rows=h.db.sql.exec('SELECT v FROM qq_gateway_state').toArray();if(rows.some(row=>row.v.includes('reserved_before_send'))){h.db.failCommit=null;return true;}return false;};
  const r=await gateway.fixedActiveProbe(h.actor,approval.action,approval.id);assert.equal(r.reason,'active_probe_reservation_unavailable');assert.equal(h.messages().length,0);assert.equal(record(await h.snapshot()),undefined);
});
test('receipt commit failure keeps reserved uncertainty and cannot retry after restart',async t=>{
  const h=await harness(t),approval=await h.approve();h.db.failCommit=()=>{const rows=h.db.sql.exec('SELECT v FROM qq_gateway_state').toArray();if(rows.some(row=>row.v.includes('provider_accepted'))){h.db.failCommit=null;return true;}return false;};
  assert.equal((await gateway.fixedActiveProbe(h.actor,approval.action,approval.id)).reason,'receipt_persistence_failed');assert.equal(h.messages().length,1);assert.equal(record(await h.snapshot()).receipt.reason,'reserved_before_send');assert.equal((await h.snapshot()).qqActiveObservedCapability,undefined);
  const restarted=new gateway.GatewayActor(h.ctx,h.env,{fetch:h.network,WebSocket:Socket,now:h.now});restarted.runtime={client:{ready:true,tokenValue:async()=> 'SYNTHETIC'}};assert.equal((await gateway.fixedActiveProbe(restarted,approval.action,'106')).reason,'reserved_before_send');assert.equal(h.messages().length,1);
});

test('signed route ACKs within callback budget while token waits; late receipt is durable and no second control appears',async t=>{
  const h=await harness(t),signed=await signedHarness(h),pending=deferred();const panel=await (await signed.invoke(adminEvent(101))).json();h.actor.runtime.client.tokenValue=()=>pending.promise;
  const started=performance.now(),response=await signed.invoke(adminEvent(102,button(panel)));assert.ok(performance.now()-started<2200);assert.equal(response.status,200);assert.match((await response.json()).data.content,/尚未确认/);assert.equal(h.messages().length,0);assert.equal(record(await h.snapshot()).receipt.reason,'reserved_before_send');
  assert.equal(button(await h.panel(104)),undefined);pending.resolve('SYNTHETIC');await h.flush();assert.equal(h.messages().length,1);assert.equal(record(await h.snapshot()).receipt.reason,'provider_accepted');assert.match((await h.panel(105)).data.content,/已提交 QQ/);
});

test('normal delivery remains disabled and observed capability cannot authorize any source/project',async t=>{
  const h=await harness(t);await h.send();const observation=(await h.snapshot()).qqActiveObservedCapability;assert.ok(observation);assert.deepEqual(clean(h.actor.evidence()),{});
  for(const [sourceId,projectId] of [['source','project'],['other','project'],['source','other']]){
    const packet=await owner.signBridgeRequest({job:{ownerId:'owner',appId:'123',sourceId,projectId,eventId:'event',receiptId:'rcpt_'+'1'.repeat(32),content:'not authorized by diagnostic'},nonce:'synthetic_nonce_12345',now:NOW},KEY);
    if(sourceId==='source'&&projectId==='project'){const result=await owner.verifyBridgeResponse(await h.actor.receiveBridge(packet),packet,KEY);assert.equal(result.reason,'disabled');}else await assert.rejects(h.actor.receiveBridge(packet));
  }
  h.env.QQ_DELIVERY_ENABLED='true';const packet=await owner.signBridgeRequest({job:{ownerId:'owner',appId:'123',sourceId:'source',projectId:'project',eventId:'event2',receiptId:'rcpt_'+'2'.repeat(32),content:'still forbidden'},nonce:'synthetic_nonce_67890',now:NOW},KEY);const r=await owner.verifyBridgeResponse(await h.actor.receiveBridge(packet),packet,KEY);assert.equal(r.reason,'capability_unverified');assert.equal(h.messages().length,1);
});
test('isolated observation expires and is removed from later panel without reopening reservation',async t=>{const h=await harness(t);await h.send();h.advance(300000);assert.equal(button(await h.panel(105)),undefined);assert.equal((await h.snapshot()).qqActiveObservedCapability,undefined);assert.ok(record(await h.snapshot()));assert.equal(h.messages().length,1);});
test('passive proof unchanged and remains an independent one-shot reply test',async t=>{const h=await harness(t);const r=await gateway.fixedReplyProof(h.actor);assert.equal(r.reason,'reply_provider_accepted');assert.deepEqual(JSON.parse(h.messages()[0].init.body),{msg_type:0,content:'Rivule QQ 连接测试，不代表真实项目进度',msg_id:'passive-reply',msg_seq:1});assert.equal((await h.snapshot()).qqActiveObservedCapability,undefined);assert.ok(button(await h.panel()));});

test('all external network entrypoints stayed mocked',()=>assert.equal(forbiddenCalls,0));

test('active receipt panel uses concise human states without protocol lecture',async t=>{
 const h=await harness(t); await h.send();const text=(await h.panel(106)).data.content;
 assert.match(text,/主动测试：已提交 QQ/);assert.doesNotMatch(text,/provider_accepted|不代表已显示|一次机会已使用/);
});
