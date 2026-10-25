import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
import {loadProductionWorker} from './helpers/production-worker.mjs';
import {conversationActions,conversationScope} from '../src/owner/conversation-source-contract.mjs';
const worker=await loadProductionWorker();
const code=readFileSync(new URL('../src/owner/worker.js',import.meta.url),'utf8');
const start=code.indexOf('apiHandler: { async fetch(req, e, context) {'),end=code.indexOf('\n            defaultHandler:',start);
assert.ok(start>0&&end>start);
function fixture(){
 const source={source_id:'pa',provider:'dot',display_name:'PA',enabled:true,allowed_hosts:[]};
 const config={bindings:{publicOrigin:'https://owner.test',ownerId:'owner',sources:[source]},resource:'https://owner.test/mcp/pa',ownerSubject:'subject',clients:[{client_id:'client',source_id:'pa'}],allowDynamicClients:false};
 const calls=[];let allowed=true;
 const owner={async conversation(principal,action,args){calls.push({principal,action,args});return allowed?{ok:true,result:{kind:'conversation',version:2,action}}:{ok:false,error:'conversation_operation_not_authorized',status:403};}};
 const scope=vm.createContext({mcpResponse:worker.mcpResponse,getOwner:()=>owner,loadOAuthConfig:()=>config,unwrap:r=>{if(!r.ok)throw Error(r.error);return r.result;},__name:f=>f,trace:undefined});
 vm.runInContext('globalThis.handler=({'+code.slice(start,end)+'}).apiHandler',scope);
 async function call(action,scopes=[conversationScope(action)],sourceId='pa'){
  const ctx={auth:{audience:config.resource,userId:'subject',expiresAt:Date.now()/1000+600,clientId:'client',scope:scopes},props:{version:1,owner_id:'owner',client_id:'client',source_id:sourceId}};
  const response=await scope.handler.fetch(new Request('https://owner.test/mcp/pa',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'bridge_conversation_'+action,arguments:{}}})}),{},ctx);return{status:response.status,body:await response.json()};
 }
 return{call,calls,deny(){allowed=false;}};
}
test('actual OAuth API handler facade routes all six conversation MCP calls to owner RPC',async()=>{
 const f=fixture();for(const action of conversationActions){const r=await f.call(action);assert.equal(r.status,200);assert.notEqual(r.body.result.isError,true,JSON.stringify(r.body));assert.equal(r.body.result.structuredContent.action,action);assert.equal(f.calls.at(-1).principal.source_id,'pa');assert.equal(f.calls.at(-1).action,action);}assert.equal(f.calls.length,6);
});
test('actual entrypoint retains old-scope and wrong-source denial before RPC; owner rejection never succeeds',async()=>{
 const f=fixture();for(const action of conversationActions){const r=await f.call(action,['pa:publish','pa:receipt']);assert.equal(r.body.result.isError,true);assert.match(r.body.result.content[0].text,/insufficient_scope/);}assert.equal(f.calls.length,0);
 assert.equal((await f.call('capabilities',['pa:conversation:read'],'other')).status,403);assert.equal(f.calls.length,0);f.deny();const denied=await f.call('register_context');assert.equal(denied.body.result.isError,true);assert.equal(f.calls.length,1);
});

// These are ephemeral offline OAuth fixtures in an in-memory KV only. No live
// credential is created, copied, inspected or sent anywhere.
import {DatabaseSync} from 'node:sqlite';
import {CONVERSATION_OPERATIONS} from '../src/owner/conversation-bridge.mjs';
test('full production gateway OAuth bearer verification → API facade → real OwnerTerminal SQLite registration',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let alarm=null;
 const storage={sql:{exec(q,...a){if(q.includes('CREATE TABLE')){db.exec(q);return{toArray:()=>[]};}return{toArray:()=>db.prepare(q).all(...a)};}},async transaction(fn){db.exec('BEGIN');try{const v=await fn(storage);db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}},getAlarm:async()=>alarm,setAlarm:async v=>{alarm=v;}};
 const source={source_id:'pa',provider:'dot',display_name:'PA',enabled:true,allowed_hosts:[],secret_name:'PA_SOURCE',auth_methods:['oauth']};
 const grant={source_id:'pa',provider_id:'dot',account_binding:'offline-owner-confirmed-mapping',generation:1,revision:1,operations:CONVERSATION_OPERATIONS,enabled:true};
 const kv=new Map();const env={SOURCES_JSON:JSON.stringify([source]),ALLOWED_PROJECT_IDS_JSON:'["task-project"]',PUBLIC_ORIGIN:'https://owner.test',OWNER_ID:'owner',APPLICATION_ID:'100',OWNER_DISCORD_ID:'200',DM_CHANNEL_ID:'300',DELIVERY_ENABLED:'false',OAUTH_ENABLED:'true',OAUTH_CLIENT_BINDINGS_JSON:JSON.stringify([{client_id:'client',source_id:'pa'}]),CONVERSATION_OPERATION_GRANTS_JSON:JSON.stringify([grant]),OAUTH_KV:{async put(k,v){kv.set(k,v);},async get(k,options){const v=kv.get(k);return v===undefined?null:options?.type==='json'?JSON.parse(v):v;}}};
 const owner=Object.create(worker.OwnerTerminal.prototype);owner.env=env;owner.ctx={storage,blockConcurrencyWhile:fn=>fn()};env.OWNERS={idFromName:n=>n,get:()=>owner};
 const issuer=Object.create(worker.OAuthProviderImpl.prototype);
 async function token(scopes,sourceId='pa'){
  const {encryptedData,key}=await worker.encryptProps({version:1,owner_id:'owner',client_id:'client',source_id:sourceId});
  return issuer.createAccessToken({userId:'owner',grantId:'offline-test',clientId:'client',scope:scopes,encryptedProps:encryptedData,encryptionKey:key,expiresIn:600,audience:'https://owner.test/mcp',env});
 }
 const args={kind:'conversation',version:2,conversation_id:'actual-owner-room',thread_id:'actual-owner-room'};
 async function send(bearer,action='register_context',arguments_=args){
  const req=new Request('https://owner.test/mcp/pa',{method:'POST',headers:{authorization:'Bearer '+bearer,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'bridge_conversation_'+action,arguments:arguments_}})});
  const r=await worker.gatewayCore(req,env,{}, {mark(){},binding(){},skip(){}});return{status:r.status,body:await r.json()};
 }
 const legacy=await send(await token(['pa:publish','pa:receipt']));assert.ok(legacy.body.result,JSON.stringify(legacy));assert.equal(legacy.body.result.isError,true);assert.match(legacy.body.result.content[0].text,/insufficient_scope/);assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n,0);
 const wrong=await send(await token(['pa:conversation:publish'],'other'));assert.equal(wrong.status,403);
 const bearer=await token(['pa:conversation:publish','pa:conversation:read']);env.CONVERSATION_OPERATION_GRANTS_JSON='[]';const ungranted=await send(bearer);assert.equal(ungranted.body.result.isError,true);assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='conversation_v2_contexts'").get().n,0);env.CONVERSATION_OPERATION_GRANTS_JSON=JSON.stringify([grant]);const success=await send(bearer);assert.equal(success.status,200);assert.notEqual(success.body.result?.isError,true,JSON.stringify(success.body));assert.equal(success.body.result.structuredContent.context.conversation_id,args.conversation_id);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM conversation_v2_contexts').get().n,1);assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('events','branches','outbox')").get().n,0);
 const cap=await send(bearer,'capabilities',{});assert.equal(cap.body.result.structuredContent.operation_authorized,true);
 env.CONVERSATION_OPERATION_GRANTS_JSON='[]';const revoked=await send(bearer);assert.equal(revoked.body.result.isError,true);assert.equal(db.prepare('SELECT COUNT(*) n FROM conversation_v2_contexts').get().n,1);
});
