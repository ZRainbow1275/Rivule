import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
import {configuredConversationGrant,conversationTools,conversationScope,conversationSourceOperation} from '../src/owner/conversation-source-contract.mjs';
const source={source_id:'pa',provider:'dot'},grant={source_id:'pa',provider_id:'dot',account_binding:'explicit-account-binding',enabled:true,generation:2,revision:1,operations:['register_context','publish_response','response_receipt']};
test('task credentials do not imply conversation source operations; configured grant binds exact source/provider/generation',()=>{
 assert.equal(configuredConversationGrant(undefined,source,{selectable:true,generation:2}),null);assert.equal(configuredConversationGrant(JSON.stringify([grant]),source,{selectable:false,generation:2}),null);assert.equal(configuredConversationGrant(JSON.stringify([grant]),source,{selectable:true,generation:3}),null);assert.equal(configuredConversationGrant(JSON.stringify([{...grant,provider_id:'unverified-other'}]),source,{selectable:true,generation:2}),null);assert.equal(configuredConversationGrant(JSON.stringify([grant,grant]),source,{selectable:true,generation:2}),null);assert.deepEqual(configuredConversationGrant(JSON.stringify([grant]),source,{selectable:true,generation:2}),grant);
});
test('every conversation tool requires a distinct scope and strict non-task schema',()=>{
 for(const tool of conversationTools){assert.equal(tool.inputSchema.additionalProperties,false);assert.ok(tool.securitySchemes[0].scopes.every(s=>s.startsWith('pa:conversation:')));assert.ok(!JSON.stringify(tool.inputSchema).includes('project_id'));}
 assert.equal(conversationScope('claim'),'pa:conversation:commands');assert.equal(conversationScope('publish_response'),'pa:conversation:publish');assert.equal(conversationScope('response_receipt'),'pa:conversation:read');
});
test('actual OAuth default remains legacy scope pair; general conversation scope is explicit',()=>{
 const code=readFileSync(new URL('../src/owner/worker.js',import.meta.url),'utf8'),start=code.indexOf('function withDefaultAuthorizationScope'),end=code.indexOf('async function handleOAuthAuthorization',start);const box=vm.createContext({URL,Request,Response,Rejected:Error,validatePaScopes:s=>s});vm.runInContext(code.slice(start,end)+';globalThis.defaults=withDefaultAuthorizationScope;',box);
 assert.equal(new URL(box.defaults(new Request('https://owner.test/authorize')).url).searchParams.get('scope'),'pa:publish pa:receipt');assert.equal(new URL(box.defaults(new Request('https://owner.test/authorize?scope=pa%3Aconversation%3Apublish')).url).searchParams.get('scope'),'pa:conversation:publish');
});
test('operation dispatch rejects unknown action, mixed kinds and non-object body before invoking core',async()=>{
 const bridge={capabilities:()=>({version:2})};assert.deepEqual(await conversationSourceOperation(bridge,source,'capabilities',{}),{version:2});await assert.rejects(conversationSourceOperation(bridge,source,'capabilities',{project_id:'p'}),/invalid/);await assert.rejects(conversationSourceOperation(bridge,source,'set_preference',{}),/invalid/);await assert.rejects(conversationSourceOperation(bridge,source,'publish_response',[]),/invalid/);
});

import {DatabaseSync} from 'node:sqlite';
import {ConversationOperationAuthority} from '../src/owner/conversation-operation-authority.mjs';
test('durable grant tombstone rejects observed disable/remove/config-change then identical revision restore; proof freshness refresh is independent',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const storage={sql:{exec(q,...a){if(q.startsWith('CREATE TABLE')){db.exec(q);return{toArray:()=>[]};}return{toArray:()=>db.prepare(q).all(...a)};}}};let current=structuredClone(grant),proof={selectable:true,generation:2};const authority=new ConversationOperationAuthority({storage,raw:()=>JSON.stringify(current?[current]:[]),sources:[{...source,enabled:true}],proof:()=>proof});
 assert.equal(authority.resolve(source),null);assert.equal(authority.has(),false);authority.reconcile();assert.ok(authority.resolve(source));
 proof.selectable=false;assert.equal(authority.resolve(source),null);authority.reconcile();proof.selectable=true;assert.ok(authority.resolve(source),'same-generation refreshed proof keeps standing authority');
 current={...current,enabled:false};authority.reconcile();current={...current,enabled:true};authority.reconcile();assert.equal(authority.resolve(source),null,'same revision never resurrects');current.revision++;authority.reconcile();assert.ok(authority.resolve(source));
 const saved=current;current=null;authority.reconcile();current=saved;authority.reconcile();assert.equal(authority.resolve(source),null,'remove/restore tombstone');current={...current,revision:current.revision+1};authority.reconcile();assert.ok(authority.resolve(source));
 current={...current,account_binding:'another-account'};authority.reconcile();current={...current,account_binding:grant.account_binding};authority.reconcile();assert.equal(authority.resolve(source),null,'same revision identity revert denied');current={...current,revision:current.revision+1};authority.reconcile();assert.ok(authority.resolve(source));
});

test('actual owner Discord route subtracts conversation probe time before legacy fallback and rejects exhausted deadline',async()=>{
 const code=readFileSync(new URL('../src/owner/worker.js',import.meta.url),'utf8'),start=code.indexOf("        if (new URL(request.url).pathname === '/bridge/discord')"),end=code.indexOf("        if (new URL(request.url).pathname === '/v2/bridge')",start);assert.ok(start>0&&end>start);
 let now=1800000000000,delay=1700,timeout=null,constructions=0;const fakeDate=class extends Date{static now(){return now;}};
 const context=vm.createContext({URL,Request,Response,Date:fakeDate,Math,Number,BridgeError:Error,loadBindings:()=>({publicOrigin:'https://owner.test'}),jsonResponse:(v,status)=>Response.json(v,{status}),ConversationDiscordAdapter:class{async handle(){now+=delay;return null;}nextExpiry(){return Infinity;}},DiscordCommandAdapter:class{constructor(c){timeout=c.timeoutMs;constructions++;}async handle(){return Response.json({accepted:true});}nextExpiry(){return Infinity;}}});vm.runInContext('globalThis.Route=class {async fetch(request){'+code.slice(start,end)+'}}',context);
 const route=new context.Route();route.env={};route.ctx={storage:{getAlarm:async()=>null,setAlarm:async()=>{}}};route.ensureMessageBridge=async()=>({nextExpiry:()=>Infinity});route.ensureConversationBridge=async()=>route.conversationBridge={nextExpiry:()=>Infinity};
 const request=()=>new Request('https://owner.internal/bridge/discord',{method:'POST',headers:{'x-rivule-bridge-deadline':String(now+2400)},body:'{}'});
 assert.equal((await route.fetch(request())).status,200);assert.equal(timeout,700);assert.equal(constructions,1);delay=2500;assert.equal((await route.fetch(request())).status,503);assert.equal(constructions,1,'exhausted edge request never starts legacy verification');
});
