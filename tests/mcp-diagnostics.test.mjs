import test from 'node:test';
import assert from 'node:assert/strict';
import {loadProductionWorker} from './helpers/production-worker.mjs';
const json=value=>JSON.parse(JSON.stringify(value));
const headers={'content-type':'application/json',accept:'application/json, text/event-stream'};
const init={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'offline-test',version:'1'}}};
const notification={jsonrpc:'2.0',method:'notifications/initialized'};
const rpc=method=>({jsonrpc:'2.0',id:1,method});
async function fixture(options={}){
 const worker=await loadProductionWorker(options);
 const source={source_id:'pa',provider:'dot',display_name:'PA',enabled:true,allowed_hosts:[]};
 const config={bindings:{publicOrigin:'https://owner.test',ownerId:'owner',sources:[source]},resource:'https://owner.test/mcp/pa',ownerSubject:'subject',clients:[{client_id:'client',source_id:'pa'}],allowDynamicClients:false,diagnosticReaderSourceId:'pa'};
 const ctx={auth:{audience:config.resource,userId:'subject',expiresAt:Date.now()/1000+600,clientId:'client',scope:['pa:receipt']},props:{version:1,owner_id:'owner',client_id:'client',source_id:'pa'}};
 const env={DIAGNOSTICS_ENABLED:'true',SOURCES_JSON:JSON.stringify([source])};
 let handshakes=[];
 const owner={async diagnostics(){return {offline:true};},async handshake(principal,kind){handshakes.push(kind);},async publish(){throw Error('no publications permitted');}};
 async function call(body,customHeaders={},options={}){
  let record=null;
  const request=new Request(config.resource,{method:'POST',headers:{...headers,...customHeaders},body:typeof body==='string'?body:JSON.stringify(body)});
  const trace=worker.createDiagnosticTrace(request,env,{sink:value=>record=value});
  if(options.suppress)await worker.suppressTaskSnapshotTrace(request,trace);
  const response=await worker.mcpResponse(request,ctx,config,owner,options.withoutTrace?undefined:trace);
  trace.mark('request_complete','http_'+response.status,response.status);trace.finish(response);
  const text=await response.text();return {status:response.status,text,body:text?JSON.parse(text):null,record:record?json(worker.sanitizeDiagnosticRecord(record,new Set(['pa']))):null};
 }
 return {worker,call,owner,handshakes};
}
function stage(result,name){return result.record?.stages.find(s=>s.stage===name);}
function assertStatus(result,status,code){assert.equal(result.status,status);assert.equal(result.record.http_status,status);assert.equal(stage(result,'request_complete').http_status,status);if(code){assert.equal(stage(result,'mcp_sdk').code,code);assert.equal(stage(result,'mcp_sdk').http_status,null);}assert.equal(result.record.stages.some(s=>s.http_status===500),status===500);}

test('actual malformed RPC and unsupported version rejection retain 400, not an invented SDK 500',async()=>{
 const f=await fixture();
 for(const body of [{...notification,params:null},{...notification,id:null},{...notification,extra:true},{...rpc('ping'),id:null}]){
  const result=await f.call(body);assertStatus(result,400,'mcp_invalid_rpc_envelope');assert.equal(result.body.error.code,-32700);assert.equal(stage(result,'mcp_transport').http_status,400);
 }
 const result=await f.call(notification,{'mcp-protocol-version':'private-unrecognized-version'});assertStatus(result,400,'mcp_protocol_version_unsupported');assert.equal(result.body.error.code,-32000);assert.doesNotMatch(JSON.stringify(result.record),/private-unrecognized-version/);
});

test('406 Accept and 415 content-type keep their real status without false SDK 500',async()=>{
 const f=await fixture();const accept=await f.call(rpc('ping'),{accept:'application/json'});assertStatus(accept,406,'mcp_accept_not_supported');assert.equal(accept.body.error.code,-32000);
 const content=await f.call(rpc('ping'),{'content-type':'text/plain'});assertStatus(content,415);assert.equal(stage(content,'mcp_sdk'),undefined);assert.equal(content.body.error,'json_required');
 // The production body guard rejects 415 before the SDK. Exercise the actual
 // SDK branch too, without replacing its parser or acceptance rules.
 const errors=[],transport=new f.worker.WebStandardStreamableHTTPServerTransport({enableJsonResponse:true});transport.onerror=error=>errors.push(f.worker.mcpSdkDiagnosticCode(error));
 const response=await transport.handleRequest(new Request('https://owner.test/mcp/pa',{method:'POST',headers:{...headers,'content-type':'text/plain'},body:'{}'}));
 assert.equal(response.status,415);assert.deepEqual(errors,['mcp_content_type_not_supported']);await transport.close();
});

test('normal notifications, stateless repeat initialization and stale session headers retain behavior',async()=>{
 const f=await fixture();for(const body of [notification,notification]){const r=await f.call(body);assertStatus(r,202);assert.equal(r.text,'');assert.equal(stage(r,'mcp_sdk'),undefined);}
 for(const body of [init,init,{...init,params:{...init.params,protocolVersion:'2099-01-01'}}]){const r=await f.call(body);assertStatus(r,200);assert.equal(r.body.result.protocolVersion,'2025-11-25');assert.equal(stage(r,'mcp_sdk'),undefined);}
 const stale=await f.call(notification,{'mcp-session-id':'unused-offline-session'});assertStatus(stale,202);assert.equal(stage(stale,'mcp_sdk'),undefined);
});

test('unexpected response errors classify without persisting body or inventing 500',async()=>{
 const f=await fixture();const r=await f.call({jsonrpc:'2.0',id:1,result:{private:'private-body-sentinel'}});assertStatus(r,202,'mcp_unexpected_response');assert.equal(r.text,'');assert.doesNotMatch(JSON.stringify(r.record),/private-body-sentinel/);
 for(const error of [null,{},new Error('private-error-sentinel'),{message:4},{get message(){throw Error('private-getter-sentinel');}}])assert.equal(f.worker.mcpSdkDiagnosticCode(error),'mcp_sdk_error');
});

test('real unexpected owner failure still returns and records HTTP 500 without exposing its message',async()=>{
 const f=await fixture();f.owner.handshake=async()=>{throw Error('private-storage-sentinel');};const r=await f.call(init);assertStatus(r,500);assert.equal(r.body.error,'request_result_unknown');assert.equal(stage(r,'mcp_transport').http_status,200);assert.doesNotMatch(JSON.stringify(r),/private-storage-sentinel/);
});

test('actual transport response is authoritative even when SDK emits an unclassified error',async()=>{
 const f=await fixture();const original=f.worker.WebStandardStreamableHTTPServerTransport.prototype.handleRequest;
 try{
  // Fault injection checks the wrapper's real Response handling, not SDK parser behavior.
  f.worker.WebStandardStreamableHTTPServerTransport.prototype.handleRequest=async function(){this.onerror?.(new Error('private-runtime-sentinel'));return Response.json({jsonrpc:'2.0',id:null,error:{code:-32603,message:'Internal error'}},{status:500});};
  const r=await f.call(rpc('ping'));assertStatus(r,500,'mcp_sdk_error');assert.equal(stage(r,'mcp_transport').http_status,500);assert.doesNotMatch(JSON.stringify(r),/private-runtime-sentinel/);
 }finally{f.worker.WebStandardStreamableHTTPServerTransport.prototype.handleRequest=original;}
});

test('diagnostic annotation leaves HTTP statuses and bodies unchanged and respects read suppression',async()=>{
 const f=await fixture();for(const [body,custom] of [[{...notification,params:null},{}],[notification,{'mcp-protocol-version':'2099-01-01'}],[rpc('ping'),{accept:'application/json'}],[rpc('ping'),{'content-type':'text/plain'}],[notification,{}],[rpc('resources/list'),{}]]){
  const traced=await f.call(body,custom),untraced=await f.call(body,custom,{withoutTrace:true});assert.equal(traced.status,untraced.status);assert.equal(traced.text,untraced.text);
 }
 for(const [body,custom] of [[init,{}],[rpc('tools/list'),{}],[rpc('tools/list'),{'mcp-protocol-version':'2099-01-01'}],[{...rpc('tools/call'),params:{name:'get_connection_diagnostics',arguments:{}}},{}]]){
  const r=await f.call(body,custom,{suppress:true});assert.equal(r.record,null);
 }
 assert.ok(f.handshakes.includes('initialize'));assert.ok(f.handshakes.includes('tools/list'));assert.ok(f.handshakes.includes('read_probe'));
});

test('failure observations strictly whitelist fields and poisoned codes; disabled and throwing sink never affect requests',async()=>{
 const worker=await loadProductionWorker(),records=[];const poison='Bearer private-token https://private.invalid/recipient';
 worker.reportMcpFailure(true,poison,poison,503,r=>records.push(r));worker.reportMcpFailure(false,'proof_refresh','operation_result_unknown',503,r=>records.push(r));worker.reportMcpFailure(true,'proof_refresh','operation_result_unknown',503,()=>{throw Error(poison);});
 assert.deepEqual(json(records),[{component:'rivule_mcp_failure',stage:'unknown',code:'unknown',http_status:503}]);assert.doesNotMatch(JSON.stringify(records),/Bearer|private|recipient/);
});
test('actual diagnostic failure observation preserves response semantics and skip without DB diagnostic record',async()=>{
 const logs=[];const f=await fixture({warn:r=>{if(r?.component==='rivule_mcp_failure')logs.push(json(r));}});const call={...rpc('tools/call'),params:{name:'get_connection_diagnostics',arguments:{source_id:'pa'}}};
 const normal=await f.call(call,{}, {suppress:true});assert.equal(normal.status,200);assert.equal(normal.record,null);assert.deepEqual(logs,[]);
 f.owner.diagnostics=async()=>{throw Error('Bearer private-token https://private.invalid/recipient');};const rejected=await f.call(call,{}, {suppress:true});assert.equal(rejected.status,200);assert.equal(rejected.body.result.isError,true);assert.equal(rejected.record,null);assert.deepEqual(logs,[{component:'rivule_mcp_failure',stage:'tool_call',code:'unknown',http_status:200}]);
 logs.length=0;f.owner.diagnostics=async()=>({offline:true});f.owner.handshake=async()=>{throw new f.worker.Rejected('operation_result_unknown',503);};const failed=await f.call(call,{}, {suppress:true});assert.equal(failed.status,503);assert.equal(failed.body.error,'operation_result_unknown');assert.equal(failed.record,null);assert.deepEqual(logs,[{component:'rivule_mcp_failure',stage:'proof_refresh',code:'operation_result_unknown',http_status:503}]);assert.doesNotMatch(JSON.stringify(logs),/source|token|https|recipient/);
});
test('actual transport rejection remains HTTP400 with only fixed category observation',async()=>{
 const logs=[];const f=await fixture({warn:r=>{if(r?.component==='rivule_mcp_failure')logs.push(json(r));}});const r=await f.call({...notification,params:null});assert.equal(r.status,400);assert.equal(r.body.error.code,-32700);assert.deepEqual(logs,[{component:'rivule_mcp_failure',stage:'mcp_transport',code:'unknown',http_status:400}]);
});

test('unknown failure status is null rather than an invented HTTP500',async()=>{
 const worker=await loadProductionWorker(),records=[];for(const status of [undefined,null,'private-status',{},201,NaN])worker.reportMcpFailure(true,'oauth_wrapper','unknown',status,r=>records.push(r));assert.ok(records.every(r=>r.http_status===null));
});
