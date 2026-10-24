import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createSourceBridge,mcpBridgeTransport,httpBridgeTransport} from '../src/sdk/source-bridge.mjs';
import {MessageBridge} from '../src/owner/message-bridge.mjs';
import {bridgeSourceOperation,bridgeTools} from '../src/owner/bridge-source-contract.mjs';
const context={project_id:'p',task_id:'t',run_id:'r',branch_id:'main',thread_id:'thread'};
const message={response_id:'response1',text:'Ready for review',content_kind:'user_visible_response',origin:'source',sensitivity:'normal',reviewed_for_secrets:true};
test('mode, source identity and content gates run before upload; withheld never includes payload',async()=>{
 const calls=[];let cap={source_id:'pa',mode:'task_updates'};const sdk=createSourceBridge({source_id:'pa',call:async(a,b)=>{calls.push([a,b]);return cap;}});
 assert.equal((await sdk.reportResponse(context,message)).reason,'owner_mode_task_updates');assert.equal(calls.length,1);
 for(const change of [{origin:'relay'},{content_kind:'reasoning'},{content_kind:'tool_result'},{sensitivity:'restricted'},{reviewed_for_secrets:false},{text:'api_key=abcdefghijklmnop'},{text:'Bearer top-secret'}]){const r=await sdk.reportResponse(context,{...message,...change});assert.equal(r.state,'withheld');assert.equal(calls.length,1);assert.equal(JSON.stringify(r).includes('top-secret'),false);}
 cap={source_id:'other',mode:'every_response'};await assert.rejects(sdk.reportResponse(context,message),/identity/);
 await assert.rejects(sdk.reportResponse({},message),/real_task_context/);await assert.rejects(sdk.reportResponse(context,{...message,response_id:''}),/stable_response/);
});
test('SDK consumes actual bridge schema and registered context, stable retries deduplicate',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE branches(branch_key TEXT PRIMARY KEY,source_id TEXT,project_id TEXT,payload TEXT,archived INTEGER); CREATE TABLE outbox(receipt TEXT,status TEXT,message_id TEXT,last_error TEXT); CREATE TABLE qq_continuous_outbox(receipt TEXT,status TEXT,result TEXT)');
 const event={source_id:'pa',...context,sensitivity:'normal'};db.prepare('INSERT INTO branches VALUES(?,?,?,?,0)').run(JSON.stringify(['pa','t','r','main']),'pa','p',JSON.stringify(event));
 const storage={sql:{exec(q,...args){if(q.includes('CREATE TABLE')){db.exec(q);return{toArray:()=>[]};}return{toArray:()=>db.prepare(q).all(...args)};}},transaction:fn=>fn(storage)};
 const source={source_id:'pa',enabled:true};let sends=0;
 const bridge=new MessageBridge({storage,bindings:{ownerId:'o',appId:'a',userId:'u',dmId:'d',allowedProjectIds:['p'],sources:[source]},sourceBinding:()=>1,enqueueResponse:()=>{sends++;}});
 const call=async(action,args)=>{const schema=bridgeTools.find(t=>t.name==='bridge_'+action).inputSchema;assert.ok(Object.keys(args).every(key=>Object.hasOwn(schema.properties,key)));assert.ok(schema.required.every(key=>Object.hasOwn(args,key)));return bridgeSourceOperation(bridge,source,action,args);};
 const sdk=createSourceBridge({source_id:'pa',call});await bridge.setPreference(source,{mode:'every_response',commands_enabled:false,expected_revision:0,confirm:true});
 await assert.rejects(sdk.reportResponse(context,message),/not_registered/);await sdk.registerContext(context);const first=await sdk.reportResponse(context,message),second=await sdk.reportResponse(context,message);assert.equal(first.receipt_id,second.receipt_id);assert.equal(second.duplicate,true);assert.equal(sends,1);
 await assert.rejects(sdk.reportResponse(context,{...message,text:'changed'}),/conflict/);
});
test('task update preserves caller event IDs without inventing sequence or retry',async()=>{const sent=[],sdk=createSourceBridge({source_id:'pa',call:async()=>{},publishTaskUpdate:async e=>{sent.push(e);return {accepted:true};}}),event={source_id:'pa',event_id:'event1',sensitivity:'normal',summary:'Done'};
 assert.equal((await sdk.reportTaskUpdate(event)).state,'withheld');await sdk.reportTaskUpdate(event,{reviewed_for_secrets:true});assert.equal(sent[0],event);assert.equal((await sdk.reportTaskUpdate({...event,secret:'do-not-upload'},{reviewed_for_secrets:true})).state,'withheld');assert.equal((await sdk.reportTaskUpdate({...event,metadata:{reasoning:'private'}},{reviewed_for_secrets:true})).state,'withheld');assert.equal((await sdk.reportTaskUpdate({...event,metadata:{sensitivity:'restricted'}},{reviewed_for_secrets:true})).state,'withheld');assert.equal(sent.length,1);
});
test('HTTP signs exact bytes, forbids redirects and never retries uncertain transport',async()=>{let signed,request,calls=0;const call=httpBridgeTransport({origin:'https://example.invalid',sign:async bytes=>{signed=new TextDecoder().decode(bytes);return {'x-pa-source':'pa'};},fetch:async(url,options)=>{calls++;request={url,options};return{ok:true,json:async()=>({source_id:'pa'})};}});await call('capabilities',{});assert.equal(signed,request.options.body);assert.equal(request.options.redirect,'error');assert.equal(request.url,'https://example.invalid/v1/bridge');assert.equal(calls,1);assert.throws(()=>httpBridgeTransport({origin:'http://example.invalid',sign(){}}),/secure/);});
test('MCP respects tool errors and uses source action names; commands never autoexecute',async()=>{let request;const call=mcpBridgeTransport(async r=>{request=r;return{content:[{type:'text',text:'{"state":"empty"}'}]};});const sdk=createSourceBridge({source_id:'pa',call});assert.equal((await sdk.claim(context,'claim1')).state,'empty');assert.equal(request.name,'bridge_claim');assert.equal(request.arguments.claim_id,'claim1');assert.throws(()=>sdk.acknowledge({outcome:'started'}),/truthful/);await assert.rejects(mcpBridgeTransport(async()=>({isError:true}))('claim',{}),/rejected/);});
