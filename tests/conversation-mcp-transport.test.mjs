import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {loadProductionWorker} from './helpers/production-worker.mjs';
import {ConversationBridge,CONVERSATION_OPERATIONS} from '../src/owner/conversation-bridge.mjs';
import {conversationSourceOperation,conversationActions,conversationScope} from '../src/owner/conversation-source-contract.mjs';
const worker=await loadProductionWorker();
function fixture(t){
 const source={source_id:'pa',provider:'dot',display_name:'PA',enabled:true,allowed_hosts:[]};
 const config={bindings:{publicOrigin:'https://owner.test',ownerId:'owner',sources:[source]},resource:'https://owner.test/mcp/pa',ownerSubject:'subject',clients:[{client_id:'client',source_id:'pa'}],allowDynamicClients:false};
 let grant=null,calls=0;const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const storage={sql:{exec(q,...a){if(q.includes('CREATE TABLE')){db.exec(q);return {toArray:()=>[]};}return{toArray:()=>db.prepare(q).all(...a)};}},async transaction(fn){db.exec('BEGIN');try{const r=await fn(storage);db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const bridge=new ConversationBridge({storage,sources:[source],authority:()=>grant,recipientBinding:()=>null});
 const owner={async conversation(principal,action,args){calls++;assert.equal(principal.source_id,'pa');return conversationSourceOperation(bridge,source,action,args);}};
 const rpc=async(method,params={},scopes=['pa:publish','pa:receipt'],overrides={})=>{
  const ctx={auth:{audience:config.resource,userId:'subject',expiresAt:Date.now()/1000+600,clientId:'client',scope:scopes},props:{version:1,owner_id:'owner',client_id:'client',source_id:'pa'},...overrides};
  const response=await worker.mcpResponse(new Request('https://owner.test/mcp/pa',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),ctx,config,owner);
  return {status:response.status,body:await response.json()};
 };
 return{rpc,db,bridge,source,calls:()=>calls,enable(){grant={enabled:true,provider_id:'dot',account_binding:'explicit-test-account',generation:1,revision:1,operations:CONVERSATION_OPERATIONS};}};
}
test('production MCP tools/list advertises all six conversation tools even to legacy task scope; no grant or writes',async t=>{
 const f=fixture(t),r=await f.rpc('tools/list');assert.equal(r.status,200);
 assert.deepEqual(r.body.result.tools.filter(t=>t.name.startsWith('bridge_conversation_')).map(t=>t.name),conversationActions.map(a=>'bridge_conversation_'+a));
 for(const tool of r.body.result.tools.filter(t=>t.name.startsWith('bridge_conversation_')))assert.deepEqual(tool.securitySchemes[0].scopes,[conversationScope(tool.name.slice(20))]);
 assert.equal(f.calls(),0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n,0);
});
test('production MCP legacy token cannot call any conversation action; wrong source identity fails before core',async t=>{
 const f=fixture(t);for(const action of conversationActions){const r=await f.rpc('tools/call',{name:'bridge_conversation_'+action,arguments:{}});assert.equal(r.body.result.isError,true);assert.match(r.body.result.content[0].text,/insufficient_scope/);}assert.equal(f.calls(),0);
 const r=await f.rpc('tools/list',{},['pa:conversation:read'],{props:{version:1,owner_id:'owner',client_id:'client',source_id:'other'}});assert.equal(r.status,403);assert.equal(f.calls(),0);
});
test('production MCP scoped register routes to real durable conversation core; independent grant still required',async t=>{
 const f=fixture(t),params={name:'bridge_conversation_register_context',arguments:{kind:'conversation',version:2,conversation_id:'real-chat',thread_id:'real-thread'}};
 const denied=await f.rpc('tools/call',params,['pa:conversation:publish']);assert.equal(denied.body.result.isError,true);assert.equal(f.calls(),1);
 f.enable();const registered=await f.rpc('tools/call',params,['pa:conversation:publish']);assert.notEqual(registered.body.result?.isError,true,JSON.stringify(registered.body));assert.equal(registered.body.result.structuredContent.context.conversation_id,'real-chat');
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('events','branches')").get().n,0);
 const readDenied=await f.rpc('tools/call',{name:'bridge_conversation_capabilities',arguments:{}},['pa:conversation:publish']);assert.match(readDenied.body.result.content[0].text,/insufficient_scope/);
});
test('production MCP initialize explains direct conversation tools without claiming installed automation',async t=>{
 const f=fixture(t),r=await f.rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'offline-audit',version:'1'}});
 assert.equal(r.status,200);assert.match(r.body.result.instructions,/bridge_conversation_register_context/);assert.match(r.body.result.instructions,/Call the MCP tools directly/);assert.match(r.body.result.instructions,/Tool discovery is not authorization/);
});
