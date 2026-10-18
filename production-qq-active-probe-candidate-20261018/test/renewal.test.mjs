import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { clean,gateway,NOW,adminEvent,button,deferred,harness } from './harness.mjs';

async function revokedHarness(t) {
  const h=await harness(t,{realRuntime:true});await h.frame('C2C_MSG_REJECT');assert.equal((await h.snapshot()).qqRevoked,true);assert.equal(button(await h.panel()),undefined);h.advance(2000);return h;
}

test('authenticated live C2C_MSG_RECEIVE permits only one explicit probe, preserving latch and rejection history',async t=>{
  const h=await revokedHarness(t);const previous=(await h.snapshot()).qqActivePermission.history;
  await h.frame('C2C_MSG_RECEIVE');const s=await h.snapshot();assert.equal(s.qqRevoked,true);assert.deepEqual(s.qqActivePermission.history,previous);assert.equal(s.qqActivePermission.renewal.kind,'authenticated_C2C_MSG_RECEIVE');assert.equal(s.qqActivePermission.renewal.eventAt,h.now());assert.equal(h.messages().length,0);
  const p=await h.panel(110);assert.ok(button(p));await gateway.ownerSetup(h.actor,adminEvent(111,button(p)));assert.equal(h.messages().length,1);const after=await h.snapshot();assert.equal(after.qqRevoked,true);assert.deepEqual(after.qqActivePermission.history,previous);assert.equal(after.qqActiveObservedCapability.permissionRevision,1);assert.ok(after.qqActiveObservedCapability.renewalEventKey);assert.deepEqual(clean(h.actor.evidence()),{});assert.equal(h.env.QQ_DELIVERY_ENABLED,'false');
});
test('legacy latch establishes persisted conservative barrier before any positive renewal',async t=>{
  const h=await harness(t,{realRuntime:true,state:{qqRevoked:true}});await h.frame('C2C_MSG_RECEIVE');let s=await h.snapshot();assert.equal(s.qqActivePermission.history[0].type,'legacy_revocation_latch');assert.equal(s.qqActivePermission.renewal,undefined);assert.equal(button(await h.panel()),undefined);
  h.advance(2000);await h.frame('C2C_MSG_RECEIVE');assert.ok((await h.snapshot()).qqActivePermission.renewal);assert.ok(button(await h.panel(103)));assert.equal((await h.snapshot()).qqRevoked,true);
});
for(const [name,data] of [['friend re-add',{type:'FRIEND_ADD'}],['wrong recipient',{openid:'other'}],['stale positive',{timestamp:Math.floor((NOW-300000)/1000)}],['future positive',{timestamp:Math.floor((NOW+60000)/1000)}],['ISO string timestamp',{timestamp:new Date(NOW).toISOString()}],['numeric string timestamp',{timestamp:String(NOW/1000)}],['fractional timestamp',{timestamp:NOW/1000+0.5}],['missing timestamp',{timestamp:null}],['before binding',{timestamp:(NOW-20000)/1000}],['alias-only recipient',{openid:'other',user_openid:'fixed-user'}]])test(name+' cannot renew revoked permission',async t=>{
  const h=await revokedHarness(t),{type='C2C_MSG_RECEIVE',...fields}=data;await h.frame(type,fields);assert.equal((await h.snapshot()).qqActivePermission.renewal,undefined);assert.equal(button(await h.panel(110)),undefined);assert.equal(h.messages().length,0);
});
test('same-second receive cannot overcome a rejection',async t=>{const h=await harness(t,{realRuntime:true});await h.frame('C2C_MSG_REJECT');await h.frame('C2C_MSG_RECEIVE');assert.equal((await h.snapshot()).qqActivePermission.renewal,undefined);assert.equal(button(await h.panel()),undefined);});
test('raw callback injection and forged authentication object cannot create renewal',async t=>{
  const h=await revokedHarness(t),c=h.actor.runtime.client,event={op:0,s:10,t:'C2C_MSG_RECEIVE',d:{openid:'fixed-user',timestamp:h.now()/1000}};
  await c.onDispatch(event);await c.onDispatch({...event,s:11},{session:c.session,generation:c.generation,phase:'live'});assert.equal((await h.snapshot()).qqActivePermission.renewal,undefined);assert.equal(button(await h.panel(110)),undefined);
});
test('wrong socket is ignored and unauthenticated before READY cannot renew',async t=>{
  const h=await revokedHarness(t),c=h.actor.runtime.client,raw=JSON.stringify({op:0,s:10,t:'C2C_MSG_RECEIVE',d:{openid:'fixed-user',timestamp:h.now()/1000}});await c.receive({},raw);c.ready=false;c.resumePending=null;await assert.rejects(c.receive(c.ws,raw),/ready_required/);assert.equal((await h.snapshot()).qqActivePermission.renewal,undefined);
});
test('authenticated RESUMED replay remains ineligible for scoped renewal',async t=>{
  const h=await revokedHarness(t),c=h.actor.runtime.client;c.ready=false;c.deadline=h.now()+15000;c.resumePending={ws:c.ws,generation:c.generation,session:c.session,last:c.sequence,bytes:0,events:[]};
  await h.frame('C2C_MSG_RECEIVE',{seq:10});assert.equal((await h.snapshot()).qqActivePermission.renewal,undefined);
  await c.receive(c.ws,JSON.stringify({op:0,s:11,t:'RESUMED',d:{}}));assert.equal(c.ready,true);assert.equal((await h.snapshot()).qqActivePermission.renewal,undefined);assert.equal(button(await h.panel(110)),undefined);
  h.advance(1000);await h.frame('C2C_MSG_RECEIVE',{seq:12});assert.ok((await h.snapshot()).qqActivePermission.renewal);
});
test('gateway sequence and provider event ID dedup reject duplicate positives even with changed timestamp',async t=>{
  const h=await revokedHarness(t);await h.frame('C2C_MSG_RECEIVE',{}, {id:'positive-event'});const initial=(await h.snapshot()).qqActivePermission.renewal;
  h.advance(1000);await h.frame('C2C_MSG_RECEIVE',{seq:initial.sequence}, {id:'another-event'});assert.deepEqual((await h.snapshot()).qqActivePermission.renewal,initial);
  await h.frame('C2C_MSG_RECEIVE',{}, {id:'positive-event'});assert.deepEqual((await h.snapshot()).qqActivePermission.renewal,initial);
});
test('timestamp fallback deduplicates a repeated event across sessions',async t=>{
  const h=await revokedHarness(t);await h.frame('C2C_MSG_RECEIVE');const initial=(await h.snapshot()).qqActivePermission.renewal;h.actor.runtime.client.session='different-synthetic-session';await h.frame('C2C_MSG_RECEIVE');assert.deepEqual((await h.snapshot()).qqActivePermission.renewal,initial);
});
test('new rejection invalidates pending positive and every earlier observation without erasing history',async t=>{
  const h=await revokedHarness(t);await h.frame('C2C_MSG_RECEIVE');await h.send(111);assert.ok((await h.snapshot()).qqActiveObservedCapability);h.advance(1000);await h.frame('FRIEND_DEL');const s=await h.snapshot();assert.equal(s.qqRevoked,true);assert.equal(s.qqActivePermission.history.length,2);assert.equal(s.qqActivePermission.renewal,undefined);assert.equal(s.qqActiveObservedCapability,undefined);assert.equal(button(await h.panel(114)),undefined);assert.equal(h.messages().length,1);
});
test('positive cannot renew while ingestion health is false',async t=>{const h=await revokedHarness(t);await h.actor.store.transaction(s=>s.qqIngestionHealth={healthy:false,reason:'synthetic'});await h.frame('C2C_MSG_RECEIVE');assert.equal((await h.snapshot()).qqActivePermission.renewal,undefined);assert.equal(button(await h.panel(110)),undefined);});
test('positive candidate cannot authorize different binding generation',async t=>{const h=await revokedHarness(t);await h.frame('C2C_MSG_RECEIVE');await h.actor.store.transaction(s=>s.binding.confirmedAt++);assert.equal(button(await h.panel(110)),undefined);assert.equal(h.messages().length,0);});
test('positive expires before click and before post without consuming a new permission',async t=>{
  const h=await revokedHarness(t);await h.frame('C2C_MSG_RECEIVE');const approval=await h.approve(111);h.actor.runtime.client.tokenValue=async()=>{h.advance(300000);return 'SYNTHETIC';};const r=await gateway.fixedActiveProbe(h.actor,approval.action,approval.id);assert.equal(r.state,'not_sent');assert.equal(h.messages().length,0);assert.equal((await h.snapshot()).qqRevoked,true);
});
test('revocation queued during token await is ingested before final send gate',async t=>{
  const h=await revokedHarness(t);await h.frame('C2C_MSG_RECEIVE');const approval=await h.approve(111),pending=deferred();h.actor.runtime.client.tokenValue=()=>pending.promise;const flight=gateway.fixedActiveProbe(h.actor,approval.action,approval.id);await sleep(20);h.advance(1000);await h.frame('C2C_MSG_REJECT');pending.resolve('SYNTHETIC');assert.equal((await flight).state,'not_sent');assert.equal(h.messages().length,0);
});
test('revocation during POST preserves accepted receipt but prevents observed capability',async t=>{
  const pending=deferred(),h=await harness(t,{realRuntime:true,message:()=>pending.promise});const send=h.send();await sleep(20);assert.equal(h.messages().length,1);await h.frame('C2C_MSG_REJECT');pending.resolve(Response.json({id:'synthetic-accepted'}));await send;const s=await h.snapshot();assert.equal(s.qqRevoked,true);assert.equal(s.qqActiveObservedCapability,undefined);assert.equal(Object.values(s.qqActiveProbes)[0]['qq-active-fixed-v1'].receipt.reason,'provider_accepted');
});
test('permission history capacity fails closed while retaining existing history',async t=>{
  const h=await harness(t,{realRuntime:true});await h.actor.store.transaction(s=>s.qqActivePermission={revision:128,history:Array.from({length:128},(_,i)=>({type:'C2C_MSG_REJECT',revision:i+1,recordedAt:NOW-10000+i})),seen:{}});await h.frame('C2C_MSG_REJECT');const s=await h.snapshot();assert.equal(s.qqRevoked,true);assert.equal(s.qqIngestionHealth.healthy,false);assert.equal(s.qqActivePermission.history.length,128);assert.equal(button(await h.panel()),undefined);
});
test('permission event commit failure latches unhealthy and cannot grant renewal',async t=>{
  const h=await revokedHarness(t);h.db.failCommit=()=>{if(h.db.sql.exec('SELECT v FROM qq_gateway_state').toArray().some(row=>row.v.includes('authenticated_C2C_MSG_RECEIVE'))){h.db.failCommit=null;return true;}return false;};await assert.rejects(h.frame('C2C_MSG_RECEIVE'));const s=await h.snapshot();assert.equal(s.qqActivePermission.renewal,undefined);assert.equal(s.qqIngestionHealth.healthy,false);assert.equal(h.actor.store.qqIngestionFault,true);assert.equal(button(await h.panel(110)),undefined);
});
test('session persistence failure after positive commit keeps permission unusable',async t=>{
  const h=await revokedHarness(t),seq=h.actor.runtime.client.sequence+1;h.db.failCommit=()=>{const row=h.db.sql.exec('SELECT v FROM qq_gateway_state WHERE k=?',JSON.stringify(['gatewaySession'])).toArray()[0];if(row&&JSON.parse(row.v).sequence===seq){h.db.failCommit=null;return true;}return false;};await assert.rejects(h.frame('C2C_MSG_RECEIVE',{seq}));const s=await h.snapshot();assert.ok(s.qqActivePermission.renewal);assert.equal(s.qqIngestionHealth.healthy,false);assert.equal(s.qqIngestionHealth.reason,'session_persistence_failed');assert.equal(h.actor.store.qqIngestionFault,true);assert.equal(button(await h.panel(110)),undefined);
});
