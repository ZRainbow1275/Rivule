import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const source=readFileSync(new URL('../src/gateway/worker.mjs',import.meta.url),'utf8');
const sandbox=vm.createContext({structuredClone,TextEncoder,TextDecoder,EventTarget,URL,Response,Request,Headers,AbortSignal,crypto:webcrypto,fetch(){throw Error('offline only');}});
vm.runInContext(source.replace('import { DurableObject } from "cloudflare:workers";','class DurableObject {}').replace('export { QQGatewayObject, worker_default as default };','')+'\nglobalThis.testWeb={webSettingsRequest,continuousRequest,GatewayActor,hmac,check,qqHash,reviewContinuousOutcome,ownerSetup,RivuleContinuous,continuousController};',sandbox);
const {webSettingsRequest,continuousRequest,GatewayActor,hmac,check,qqHash,reviewContinuousOutcome,ownerSetup,RivuleContinuous,continuousController}=sandbox.testWeb;
function fixture(){
 let time=1_800_000_000_000,posts=0,networkHook=null,tail=Promise.resolve();
 const state={binding:{ownerId:'owner',appId:'123',userOpenId:'secret-recipient',confirmedAt:time-1000},control:{running:true},activeBudget:{day:Math.floor(time/86400000),usedMs:0,lastAt:time},qqIngestionHealth:{healthy:true}};
 const env={QQ_ENABLED:'true',QQ_OWNER_ID:'owner',OWNER_ID:'owner',QQ_APP_ID:'123',QQ_DAILY_ACTIVE_BUDGET_MS:'7200000',QQ_ALLOWED_SOURCE_IDS:'["zot-main"]',QQ_ALLOWED_PROJECT_IDS:'["p"]',QQ_DELIVERY_ENABLED:'true',DASHBOARD_QQ_SETTINGS_ENABLED:'true',QQ_BRIDGE_SECRET:'test-only-secret-abcdefghijklmnopqrstuvwxyz',QQ_APP_SECRET:'offline'};
 const actor=Object.create(GatewayActor.prototype);Object.assign(actor,{env,now:()=>time,commands:Promise.resolve(),runtime:{client:{ready:true,generation:1,tokenValue:async()=> 'offline-token'}},continuousSessionFingerprint:'session',ctx:{waitUntil(){},storage:{async setAlarm(){},async getAlarm(){return null;},async deleteAlarm(){}}},network:async()=>{posts++;if(networkHook)return networkHook();return new Response(JSON.stringify({id:'msg-1'}),{status:200});}});
 actor.store={transaction(fn){const p=tail.then(async()=>{const draft=structuredClone(state);const result=await fn(draft);for(const k of Object.keys(state))delete state[k];Object.assign(state,draft);return result;});tail=p.catch(()=>{});return p;}};
 actor.arm=async()=>{};actor.stopInternal=async()=>{state.control.running=false;};
 let counter=0;
 async function packet(operation,payload,overrides={}){const e={version:1,timestamp:time,requestId:(++counter).toString(16).padStart(64,'0'),ownerId:'owner',appId:'123',operation,payload,...overrides},body=JSON.stringify(e);return {body,signature:await hmac(env.QQ_BRIDGE_SECRET,'rivule-qq-web-request-v1',body)};}
 async function call(operation,payload=null,overrides){const p=await packet(operation,payload,overrides);const response=await webSettingsRequest(actor,p);return (await check(env.QQ_BRIDGE_SECRET,'rivule-qq-web-response-v1',response)).result;}
 async function prepare(operation,extra={}){const snap=await call('inspect');return {operation,scope:snap.scope,guard:snap.guard,expiresAt:time+300000,operationId:(++counter).toString(16).padStart(64,'0'),...extra};}
 return {actor,state,env,call,prepare,packet,posts:()=>posts,setNetwork:fn=>networkHook=fn,advance:n=>time+=n};
}
test('gateway management reads are side-effect free and expose no recipient identifier',async()=>{
 const f=fixture(),before=JSON.stringify(f.state);const s=await f.call('inspect');assert.equal(JSON.stringify(f.state),before);assert.equal(f.posts(),0);assert.equal(s.settings.budget.mode,'warn');assert.equal(s.settings.budget.minutes,120);assert.equal(s.settings.can_enable,true);assert.ok(!JSON.stringify(s).includes('secret-recipient'));
});
test('budget strict bounds/CAS persist mode and always pause the grant without sending',async()=>{
 const f=fixture();const p=await f.prepare('budget',{mode:'stop',minutes:1,revision:0});assert.equal((await f.call('commit',p)).state,'saved');assert.equal(f.state.qqRuntimeBudgetPolicy.limitMs,60000);assert.equal(f.state.qqRuntimeBudgetPolicy.mode,'stop');assert.equal(f.posts(),0);
 assert.equal((await f.call('commit',p)).state,'saved');assert.equal(f.state.qqRuntimeBudgetPolicy.revision,1);
 const stale={...p,operationId:'f'.repeat(64)};assert.equal((await f.call('commit',stale)).state,'blocked');
 await assert.rejects(f.call('commit',{...p,minutes:0}),/settings_budget_invalid/);
});
test('enable sends exactly one probe, requires producer ACK before completion, and is idempotent',async()=>{
 const f=fixture(),p=await f.prepare('enable');const result=await f.call('commit',p);assert.equal(result.state,'gateway_ready');assert.equal(f.posts(),1);assert.equal(f.state.qqContinuous.grant.producerReady,false);
 assert.equal((await f.call('commit',p)).state,'gateway_ready');assert.equal(f.posts(),1);
 assert.equal((await f.call('inspect')).settings.can_enable,false);
 await assert.rejects(f.call('complete',{operationId:p.operationId,grantId:result.grant_id}),/settings_activation_changed/);
 const ctl=await continuousController(f.actor);await ctl.acknowledgeProducer({grantId:result.grant_id,approvalInteractionId:result.approval_id,startAfterRevision:3});
 assert.equal((await ctl.status()).enabled,false,'web ACK alone cannot dispatch before final complete');
 assert.equal((await f.call('complete',{operationId:p.operationId,grantId:result.grant_id})).state,'active');assert.equal(f.state.qqWebPending,undefined);assert.equal(f.posts(),1);
});
test('unknown probe prevents all future prepare/enable until reviewed, even with a new operation',async()=>{
 const f=fixture();f.setNetwork(()=>{throw Error('timeout');});const p=await f.prepare('enable');assert.equal((await f.call('commit',p)).state,'uncertain');assert.equal(f.posts(),1);
 const second=await f.prepare('enable');assert.equal((await f.call('commit',second)).state,'blocked');assert.equal(f.posts(),1);assert.equal((await f.call('inspect')).settings.can_enable,false);
});
test('concurrent enables reserve one owner-wide flight; concurrent pause invalidates enrollment',async()=>{
 const f=fixture(),p=await f.prepare('enable'),p2=await f.prepare('enable');let release;const waiting=new Promise(r=>release=r);f.setNetwork(async()=>{await waiting;return new Response(JSON.stringify({id:'msg'}),{status:200});});
 const first=f.call('commit',p);while(!f.posts())await new Promise(r=>setTimeout(r,1));assert.equal((await f.call('commit',p2)).state,'blocked');
 const pause=await f.prepare('pause');assert.equal((await f.call('commit',pause)).state,'paused');release();assert.equal((await first).state,'uncertain');assert.notEqual(f.state.qqContinuous?.grant?.state,'active');assert.equal(f.posts(),1);
});
test('binding/revision changes reject stale confirmation; disabled/invalid signed messages fail',async()=>{
 const f=fixture(),p=await f.prepare('enable');f.state.binding.userOpenId='changed';assert.equal((await f.call('commit',p)).state,'blocked');assert.equal(f.posts(),0);
 await assert.rejects(f.call('inspect',null,{ownerId:'other'}),/settings_envelope_invalid/);await assert.rejects(f.call('inspect',null,{timestamp:0}),/settings_envelope_invalid/);
 f.env.DASHBOARD_QQ_SETTINGS_ENABLED='false';await assert.rejects(f.call('inspect'),/qq_settings_disabled/);
});
test('offline enable cannot start a connection and ACK abort pauses only its own grant',async()=>{
 const f=fixture();f.actor.runtime.client.ready=false;const p=await f.prepare('enable');assert.equal((await f.call('commit',p)).state,'blocked');assert.equal(f.posts(),0);
 f.actor.runtime.client.ready=true;const p2=await f.prepare('enable'),result=await f.call('commit',p2);assert.equal(result.state,'gateway_ready');
 assert.equal((await f.call('abort',{operationId:p2.operationId,producerPaused:true})).state,'uncertain');assert.equal(f.state.qqContinuous.grant.state,'paused');assert.equal(f.posts(),1);
});

// End-to-end: production Owner broker and real queue SQL ↔ signed production Gateway handlers.
import {DatabaseSync} from 'node:sqlite';
import {qqWebSettingsBridge,QQBridgeQueue} from '../src/owner/qq-integration.mjs';
function ownerBridgeFixture(t,f,{dropAck=false,dropCommit=false,beforeAck=null}={}) {
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE events(revision INTEGER,receipt TEXT,source_id TEXT,payload TEXT,decision TEXT); INSERT INTO events(revision) VALUES(42)');
 let tail=Promise.resolve(),writes=0;
 const storage={sql:{exec(sql,...args){if(!/^\s*(SELECT|PRAGMA)/i.test(sql))writes++;if(sql.split(';').filter(x=>x.trim()).length>1){db.exec(sql);return {toArray:()=>[]};}const rows=db.prepare(sql).all(...args);return {toArray:()=>rows};}},transaction(fn){const run=tail.then(async()=>{db.exec('BEGIN');try{const r=await fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}});tail=run.catch(()=>{});return run;}};
 const env={...f.env,QQ_GATEWAY:{idFromName:n=>n,get:()=>({webSettingsRequest:async p=>{const r=await webSettingsRequest(f.actor,p);if(dropCommit&&JSON.parse(p.body).operation==='commit')throw Error('lost gateway reply');return r;},continuousRequest:async p=>{const e=JSON.parse(p.body);if(e.operation==='acknowledge_producer'&&beforeAck)await beforeAck();const r=await continuousRequest(f.actor,p);if(dropAck&&e.operation==='acknowledge_producer')throw Error('lost ACK reply');return r;}})}};
 const bindings={ownerId:'owner',sources:[{source_id:'zot-main',enabled:true}]};
 const run=(operation,payload)=>qqWebSettingsBridge(env,storage,bindings,operation,payload,f.actor.now);
 return {db,storage,env,run,writes:()=>writes,producer:()=>QQBridgeQueue.producerSnapshot(storage,f.actor.now())};
}
test('end-to-end signed owner/gateway reads write nothing; enable ACK cursor and budget pause both ends',async t=>{
 const f=fixture(),o=ownerBridgeFixture(t,f);const before=JSON.stringify(f.state),writes=o.writes();const snap=await o.run('inspect',null);assert.equal(o.writes(),writes);assert.equal(JSON.stringify(f.state),before);assert.equal(f.posts(),0);
 const p={operation:'enable',operationId:'1'.repeat(64),scope:snap.scope,guard:snap.guard,expiresAt:f.actor.now()+300000};assert.equal((await o.run('commit',p)).state,'active');assert.equal(f.posts(),1);assert.equal(o.producer().active,true);assert.equal(f.state.qqContinuous.grant.startAfterRevision,42);assert.equal(f.state.qqContinuous.grant.producerReady,true);
 const current=await o.run('inspect',null);assert.equal(current.settings.notification.state,'active');
 const budget={operation:'budget',operationId:'2'.repeat(64),scope:current.scope,guard:current.guard,expiresAt:f.actor.now()+300000,mode:'stop',minutes:30,revision:current.settings.budget.revision};assert.equal((await o.run('commit',budget)).state,'saved');assert.equal(o.producer().active,false);assert.equal(f.state.qqContinuous.grant.state,'paused');assert.equal(f.state.qqRuntimeBudgetPolicy.limitMs,1800000);assert.equal(f.posts(),1);
});
test('end-to-end ACK lost after execution stays paused, replay never probes again',async t=>{
 const f=fixture(),o=ownerBridgeFixture(t,f,{dropAck:true}),s=await o.run('inspect',null),p={operation:'enable',operationId:'3'.repeat(64),scope:s.scope,guard:s.guard,expiresAt:f.actor.now()+300000};
 assert.equal((await o.run('commit',p)).state,'uncertain');assert.equal(f.posts(),1);assert.equal(o.producer().active,false);assert.equal(f.state.qqContinuous.grant.state,'paused');
 assert.equal((await o.run('commit',p)).state,'uncertain');assert.equal(f.posts(),1);assert.equal((await o.run('inspect',null)).settings.can_enable,true);
});
test('end-to-end lost gateway grant reply aborts instead of replaying a successful probe',async t=>{
 const f=fixture(),o=ownerBridgeFixture(t,f,{dropCommit:true}),s=await o.run('inspect',null),p={operation:'enable',operationId:'4'.repeat(64),scope:s.scope,guard:s.guard,expiresAt:f.actor.now()+300000};assert.equal((await o.run('commit',p)).state,'uncertain');assert.equal(f.posts(),1);assert.equal(f.state.qqContinuous.grant.state,'paused');assert.equal(o.producer().active,false);await o.run('commit',p);assert.equal(f.posts(),1);
});
test('end-to-end budget revision changed before producer ACK fails closed on both ends',async t=>{
 const f=fixture(),o=ownerBridgeFixture(t,f,{beforeAck:async()=>{f.state.qqRuntimeBudgetPolicy={version:1,mode:'stop',limitMs:60000,revision:1};}}),s=await o.run('inspect',null),p={operation:'enable',operationId:'5'.repeat(64),scope:s.scope,guard:s.guard,expiresAt:f.actor.now()+300000};assert.equal((await o.run('commit',p)).state,'uncertain');assert.equal(f.posts(),1);assert.equal(o.producer().active,false);assert.equal(f.state.qqContinuous.grant.state,'paused');
});
test('pause, budget changes, scope changes, flag revocation and confirmation expiry while token pending prevent the probe itself',async()=>{
 for(const change of ['pause','budget','scope','expiry','flag']){
  const f=fixture();let tokenRequested=false,release;const wait=new Promise(r=>release=r);f.actor.runtime.client.tokenValue=async()=>{tokenRequested=true;await wait;return 'offline-token';};
  const p=await f.prepare('enable'),flight=f.call('commit',p);while(!tokenRequested)await new Promise(r=>setTimeout(r,1));
  if(change==='pause'){const pause=await f.prepare('pause');assert.equal((await f.call('commit',pause)).state,'paused');}
  if(change==='budget'){const budget=await f.prepare('budget',{mode:'warn',minutes:60,revision:0});assert.equal((await f.call('commit',budget)).state,'saved');}
  if(change==='scope')f.state.binding.userOpenId='other';
  if(change==='expiry')f.advance(300001);
  if(change==='flag')f.env.DASHBOARD_QQ_SETTINGS_ENABLED='false';
  release();const result=await flight;assert.notEqual(result.state,'gateway_ready',change);assert.equal(f.posts(),0,change);assert.notEqual(f.state.qqContinuous?.grant?.state,'active',change);
 }
});
test('real DurableStateStore cold actor performs no business writes or initialization during inspect',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let writes=0,alarms=0,tail=Promise.resolve();
 const storage={sql:{exec(sql,...args){if(!/^\s*(SELECT|PRAGMA)/i.test(sql))writes++;const rows=db.prepare(sql).all(...args);return {toArray:()=>rows};}},transaction(fn){const p=tail.then(fn);tail=p.catch(()=>{});return p;},async setAlarm(){alarms++;},async deleteAlarm(){alarms++;}};
 const f=fixture(),actor=new GatewayActor({storage,waitUntil(){}},f.env,{fetch:()=>{throw Error('network forbidden');},WebSocket:class{},now:f.actor.now});const baseline=writes;
 const packet=await f.packet('inspect',null);const response=await webSettingsRequest(actor,packet),result=(await check(f.env.QQ_BRIDGE_SECRET,'rivule-qq-web-response-v1',response)).result;
 assert.equal(result.settings.bound,false);assert.equal(result.settings.can_enable,false);assert.equal(writes,baseline);assert.equal(alarms,0);assert.equal(actor.runtime,null);
});
async function reviewAction(f){const id=f.state.qqWebPending,op=f.state.qqWebOperations[id],fingerprint=op.bindingFingerprint,pending=RivuleContinuous.unresolvedAttempts(f.state,fingerprint,f.actor.now());return {bindingFingerprint:fingerprint,confirmedAt:f.state.binding.confirmedAt,reviewDigest:await qqHash(JSON.stringify(pending.keys))};}
async function nativeDiscordReview(f,action,id='123456'){
 Object.assign(f.env,{QQ_SETUP_ENABLED:'true',APPLICATION_ID:'456',OWNER_DISCORD_ID:'789',DM_CHANNEL_ID:'1234'});
 const ref='qqsetup:offline-review';f.state.adminControls={[ref]:{...action,action:'continuous_review',expires:f.actor.now()+300000}};
 return ownerSetup(f.actor,{type:3,application_id:'456',user:{id:'789'},context:1,channel_id:'1234',message:{author:{id:'456'}},data:{component_type:2,custom_id:ref},id,authorizing_integration_owners:{'1':'789'}});
}
test('end-to-end unknown probe recovers only through exact existing Discord review; old operation never replays',async t=>{
 const f=fixture(),o=ownerBridgeFixture(t,f);f.setNetwork(()=>{throw Error('timeout');});const s=await o.run('inspect',null),p={operation:'enable',operationId:'6'.repeat(64),scope:s.scope,guard:s.guard,expiresAt:f.actor.now()+300000};assert.equal((await o.run('commit',p)).state,'uncertain');assert.equal(f.posts(),1);
 f.advance(31000);const action=await reviewAction(f);
 await assert.rejects(reviewContinuousOutcome(f.actor,{...action,bindingFingerprint:'wrong'},'123'),/review_changed/);
 await assert.rejects(reviewContinuousOutcome(f.actor,{...action,reviewDigest:'wrong'},'123'),/review_changed/);assert.equal(f.state.qqWebPending,p.operationId);
 const response=await nativeDiscordReview(f,action);assert.equal(response.type,4);assert.equal(f.state.qqWebPending,undefined);assert.equal(f.state.qqWebOperations[p.operationId].result.state,'uncertain');
 await assert.rejects(reviewContinuousOutcome(f.actor,action,'123457'),/review_changed/);
 assert.equal((await o.run('commit',p)).state,'uncertain');assert.equal(f.posts(),1);assert.equal(f.state.qqWebPending,undefined);
 assert.equal((await o.run('inspect',null)).settings.can_enable,true);
});
test('review of a different operation cannot release the pending operation lock',async()=>{
 const f=fixture();f.setNetwork(()=>{throw Error('timeout');});const p=await f.prepare('enable');await f.call('commit',p);f.advance(31000);
 const action=await reviewAction(f),other='7'.repeat(64);f.state.qqWebOperations[other]={...structuredClone(f.state.qqWebOperations[p.operationId])};f.state.qqWebPending=other;
 await reviewContinuousOutcome(f.actor,action,'123458');assert.equal(f.state.qqWebPending,other);assert.equal(f.state.qqWebOperations[other].reviewedAt,undefined);assert.equal(f.posts(),1);
});
test('explicit pause cancels a durably reserved but not started web probe and permits a new confirmation',async t=>{
 const f=fixture(),o=ownerBridgeFixture(t,f);let tokenRequested=false,release;const wait=new Promise(r=>release=r);f.actor.runtime.client.tokenValue=async()=>{tokenRequested=true;await wait;return 'offline';};
 const s=await o.run('inspect',null),p={operation:'enable',operationId:'8'.repeat(64),scope:s.scope,guard:s.guard,expiresAt:f.actor.now()+300000},flight=o.run('commit',p);while(!tokenRequested)await new Promise(r=>setTimeout(r,1));
 const now=await o.run('inspect',null),pause={operation:'pause',operationId:'9'.repeat(64),scope:now.scope,guard:now.guard,expiresAt:f.actor.now()+300000};assert.equal((await o.run('commit',pause)).state,'paused');assert.equal(f.state.qqWebPending,undefined);
 release();assert.notEqual((await flight).state,'active');assert.equal(f.posts(),0);assert.equal((await o.run('inspect',null)).settings.can_enable,true);
});
test('in-flight web network is neither released by pause nor review even after 30s; orphan after restart can be explicitly reviewed',async t=>{
 const f=fixture(),o=ownerBridgeFixture(t,f);let release;const wait=new Promise(r=>release=r);f.setNetwork(async()=>{await wait;throw Error('timeout');});
 const s=await o.run('inspect',null),p={operation:'enable',operationId:'a'.repeat(64),scope:s.scope,guard:s.guard,expiresAt:f.actor.now()+300000},flight=o.run('commit',p);while(!f.posts())await new Promise(r=>setTimeout(r,1));
 f.advance(31000);const now=await o.run('inspect',null),pause={operation:'pause',operationId:'b'.repeat(64),scope:now.scope,guard:now.guard,expiresAt:f.actor.now()+300000};assert.equal((await o.run('commit',pause)).state,'paused');assert.equal(f.state.qqWebPending,p.operationId);
 await assert.rejects(reviewContinuousOutcome(f.actor,await reviewAction(f),'123459'),/review_changed/);assert.equal(f.posts(),1);
 // A new actor has no surviving execution promise. Persisted dispatching remains unknown, never auto-replayed.
 const restarted=fixture();restarted.advance(31000);for(const k of Object.keys(restarted.state))delete restarted.state[k];Object.assign(restarted.state,structuredClone(f.state));
 await nativeDiscordReview(restarted,await reviewAction(restarted),'123460');assert.equal(restarted.state.qqWebPending,undefined);assert.equal(restarted.posts(),0);assert.equal(restarted.state.qqWebOperations[p.operationId].result.state,'uncertain');
 release();assert.equal((await flight).state,'uncertain');assert.equal(f.state.qqWebPending,p.operationId);assert.equal(f.posts(),1);
});
