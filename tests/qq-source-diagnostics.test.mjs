import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readQQSourceConfiguration} from '../src/owner/qq-source-diagnostics.mjs';

test('empty/missing allowlist explains exclusion independently of fresh verified proof',()=>{
 for(const env of [{},{QQ_ALLOWED_SOURCE_IDS:'[]'}]) {
  const result=readQQSourceConfiguration(env,'zot-main');
  assert.equal(result.source_allowed_in_configuration,false);assert.equal(result.reason,'source_not_in_allowlist');
  assert.match(result.scope,/allowlist_only_not_delivery_authorization_or_historical_cause/);
 }
});
test('membership is exact and does not expose other source identifiers or confer delivery authorization',()=>{
 const env={QQ_ALLOWED_SOURCE_IDS:'["zot-main","private-other-source"]',QQ_ENABLED:'false',QQ_DELIVERY_ENABLED:'false'};
 const result=readQQSourceConfiguration(env,'zot-main');assert.equal(result.source_allowed_in_configuration,true);assert.equal(result.reason,'source_in_allowlist');assert.doesNotMatch(JSON.stringify(result),/private-other-source|provider_accepted|verified|delivered/);
 assert.equal(readQQSourceConfiguration(env,'zot').source_allowed_in_configuration,false);
 assert.equal(readQQSourceConfiguration(env,'ZOT-main').source_allowed_in_configuration,false);
});
test('malformed, duplicate, nonstring and oversized configuration stays unknown, never falsely excluded',()=>{
 for(const raw of ['{','{}','null','[1]','["zot-main","zot-main"]',42,' '.repeat(65537)]) {
  const result=readQQSourceConfiguration({QQ_ALLOWED_SOURCE_IDS:raw},'zot-main');assert.equal(result.source_allowed_in_configuration,null);assert.equal(result.reason,'configuration_unavailable');
 }
});
test('pure observation reads exactly one configuration field, no secrets, storage, gateway or proof',()=>{
 const reads=[];const env=new Proxy({}, {get(_t,k){reads.push(k);if(k==='QQ_ALLOWED_SOURCE_IDS')return '["zot-main"]';throw Error('private-secret');},set(){assert.fail('configuration mutation');}});
 assert.equal(readQQSourceConfiguration(env,'zot-main').source_allowed_in_configuration,true);assert.deepEqual(reads,['QQ_ALLOWED_SOURCE_IDS']);
 const broken={get QQ_ALLOWED_SOURCE_IDS(){throw Error('private-token-recipient');}};assert.doesNotMatch(JSON.stringify(readQQSourceConfiguration(broken,'zot-main')),/private-token|recipient/);
});
test('production integration is additive behind unchanged existing diagnostic and source gates',()=>{
 const text=readFileSync(new URL('../src/owner/worker.js',import.meta.url),'utf8');const start=text.lastIndexOf('    async connectionDiagnostics(principal, query) {'),end=text.indexOf('    async selectView',start),method=text.slice(start,end);
 assert.ok(method.indexOf('isDiagnosticReader')<method.indexOf('readQQSourceConfiguration'));
 assert.ok(method.includes('if (source) result.current_qq_source_configuration = readQQSourceConfiguration(this.env, sourceId);'));
 assert.ok(method.includes('query.source_id ?? this.source(principal).source_id'));assert.ok(method.includes('s.source_id === sourceId && s.enabled'));
 assert.doesNotMatch(method,/setAlarm|initializeLegacy|\.drain\(|\.enqueue\(/);
 const qq=readFileSync(new URL('../src/owner/qq-integration.mjs',import.meta.url),'utf8');assert.ok(qq.includes("return skip('source_unverified')"),'legacy receipt code preserved');
});
