import test from 'node:test';
import assert from 'node:assert/strict';
import {readDashboardSourceProof,dashboardProducerStatus,SOURCE_PROOF_MAX_AGE_MS} from '../src/owner/dashboard-connection.mjs';
import {QQBridgeQueue} from '../src/owner/qq-integration.mjs';
const now=1800000000000,source={source_id:'zot-main',enabled:true};
function fixture(){const calls=[],row={binding:'expected-private-binding',generation:2,revoked:0,evidence_kind:'initialize',last_verified_at:now-10};let exists=true;const storage={sql:{exec(sql,...args){calls.push([sql,args]);assert.match(sql,/^SELECT /);return {toArray:()=>sql.includes('sqlite_master')?(exists?[{name:'source_connections'}]:[]):sql.includes('pragma_table_info')?['source_id','binding','generation','evidence_kind','last_verified_at','revoked'].map(name=>({name})):row?[row]:[]};}}};return {row,calls,storage,missing(){exists=false;},read(){return readDashboardSourceProof(storage,source,'expected-private-binding',now);}};}
test('connection proof reads exact Zot only and strips binding/generation identifiers',()=>{const f=fixture(),value=f.read();assert.equal(value.status,'verified');assert.deepEqual(f.calls.at(-1)[1],['zot-main']);assert.equal(f.calls.length,3);assert.doesNotMatch(f.calls.at(-1)[0],/CAST/i);assert.deepEqual(Object.keys(value).sort(),['evidence_kind','last_verified_at','proof_max_age_ms','status']);assert.equal(JSON.stringify(value).includes('private-binding'),false);assert.throws(()=>readDashboardSourceProof(f.storage,{...source,source_id:'other'},'',now));});
test('binding changes, malformed generations, future evidence and missing schema never imply connected',()=>{for(const change of [f=>f.missing(),f=>{f.row.binding='old';},f=>{f.row.generation=0;},f=>{f.row.generation=1.2;},f=>{f.row.generation='2junk';},f=>{f.row.generation='2';},f=>{f.row.revoked='garbage';},f=>{f.row.revoked='0';},f=>{f.row.revoked=new Uint8Array([0]);},f=>{f.row.last_verified_at=now+1;},f=>{f.row.last_verified_at=-1;},f=>{f.row.evidence_kind='historical_task';},f=>{f.row.revoked=3;}]){const f=fixture();change(f);assert.equal(f.read().status,'unknown');}});
test('proof status distinguishes exact freshness boundary, revocation and disabled source',()=>{const f=fixture();f.row.last_verified_at=now-SOURCE_PROOF_MAX_AGE_MS;assert.equal(f.read().status,'stale');f.row.revoked=1;assert.equal(f.read().status,'revoked');assert.equal(readDashboardSourceProof(f.storage,{...source,enabled:false},'expected-private-binding',now).status,'disabled');});
test('QQ producer read touches only activation metadata, never event/capacity/history or expiry writes',()=>{let activation={active:true,expiresAt:now+100};const calls=[];const storage={sql:{exec(sql,...args){calls.push(sql);assert.match(sql,/^SELECT /);assert.doesNotMatch(sql,/events|capacity|source_connections|outbox/);return {toArray:()=>sql.includes('sqlite_master')?[{name:'qq_continuous_meta'}]:[{v:JSON.stringify(activation)}]};}}};assert.equal(dashboardProducerStatus(QQBridgeQueue.producerSnapshot(storage,now)).status,'active');activation.expiresAt=now;assert.deepEqual(dashboardProducerStatus(QQBridgeQueue.producerSnapshot(storage,now)),{status:'paused',reason:'grant_expired',scope:'owner_producer_only'});activation={active:false,pauseReason:'private message'};assert.equal(dashboardProducerStatus(QQBridgeQueue.producerSnapshot(storage,now)).reason,'state_unavailable');assert.equal(calls.length,6);});
test('cold or missing proof reads do not initialize storage or schedule alarms',()=>{
 const columns=['source_id','binding','generation','evidence_kind','last_verified_at','revoked'];let calls=0;
 const storage={put(){throw Error('write forbidden');},setAlarm(){throw Error('alarm forbidden');},sql:{exec(sql){calls++;assert.match(sql,/^SELECT /);return {toArray:()=>sql.includes('sqlite_master')?[{name:'source_connections'}]:sql.includes('pragma_table_info')?columns.map(name=>({name})):[]};}}};
 assert.equal(readDashboardSourceProof(storage,source,'binding',now).status,'unknown');assert.equal(calls,3);
});

import {readFileSync} from 'node:fs';
import {readQQSourceConfiguration} from '../src/owner/qq-source-diagnostics.mjs';
test('actual dashboard readConnection adds source membership behind identity gates with no extra SQL',async()=>{
 const text=readFileSync(new URL('../src/owner/worker.js',import.meta.url),'utf8'),a=text.lastIndexOf('                readConnection: async source => {'),b=text.indexOf('\n                manageConversation:',a);
 const callback=text.slice(a,b).trim().replace(/^readConnection: /,'').replace(/,$/,'');
 const f=fixture();let configReads=0,identityChecks=0;
 const env=new Proxy({}, {get(_t,k){assert.equal(k,'QQ_ALLOWED_SOURCE_IDS');configReads++;return '[]';}});
 const source={source_id:'zot-main',enabled:true},bindings={sources:[source]};
 const owner={env,ctx:{storage:f.storage}};
 const read=new Function('readonlySource','readonlyIdentity','readonlyTables','bindings','__ownerUiOverlay','canonical','dashboardProducerStatus','readDashboardSourceProof','QQBridgeQueue','readQQSourceConfiguration','return ('+callback+');').call(owner,
  (_b,s)=>{if(s.source_id!=='zot-main')throw Error('not authorized');},()=>{identityChecks++;},()=>new Set(),bindings,{sourceBindingContexts:async()=>({})},()=> 'expected-private-binding',dashboardProducerStatus,
  (storage,s,binding,_now,authorized)=>readDashboardSourceProof(storage,s,binding,now,authorized),{producerSnapshot:()=>({active:true})},readQQSourceConfiguration);
 const value=await read(source);assert.equal(value.source.status,'verified');assert.equal(value.qq.status,'active');assert.equal(value.qq_source_configuration.source_allowed_in_configuration,false);assert.equal(value.qq_source_configuration.reason,'source_not_in_allowlist');assert.equal(f.calls.length,3);assert.equal(configReads,1);assert.equal(identityChecks,1);
 await assert.rejects(read({source_id:'other',enabled:true}));assert.equal(configReads,1);assert.equal(f.calls.length,3);assert.doesNotMatch(JSON.stringify(value),/private-binding/);
});
