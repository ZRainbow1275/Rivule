/** Official SDK stateless Streamable HTTP, with source-bound OAuth policy. */
import type {DiagnosticTrace} from './diagnostics.ts';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {authorizeOAuthContext,isDiagnosticReader} from './oauth.ts';
import {validateDiagnosticQuery} from './diagnostic-store.ts';
import type {OAuthConfig,OAuthContext,OAuthProps} from './oauth.ts';
import {boundedBody,safeError,jsonResponse} from './auth.ts';
import {Rejected,validateEvent} from './contracts.ts';
import {notificationMode} from './notification-policy.ts';
import type {NotificationMode} from './notification-policy.ts';
import type {VerificationKind} from './source-verification.ts';
import {eventSchema} from './event-schema.ts';
// JSON Pointer refs in the generated contract are rooted at the full tool schema.
// Hoist definitions when embedding Event, retaining every validation constraint.
const {$defs:eventDefinitions,...embeddedEventSchema}=eventSchema;
export type McpOwnerPort={publish:(principal:OAuthProps,event:any,mode:NotificationMode)=>Promise<any>;delivery:(principal:OAuthProps,receipt:string)=>Promise<any>;diagnostics?:(principal:OAuthProps,query:unknown)=>Promise<any>;verify?:(kind:VerificationKind)=>Promise<unknown>};
export async function mcpResponse(request:Request,ctx:OAuthContext,config:OAuthConfig,owner:McpOwnerPort,trace?:DiagnosticTrace):Promise<Response>{
 try{
  trace?.binding((ctx.props as OAuthProps)?.source_id);const source=authorizeOAuthContext(request,ctx,config);trace?.mark('mcp_auth');
  if(request.method!=='POST')return jsonResponse({error:'stateless_post_only'},405);
  const body=await boundedBody(request);let parsed:any;
  try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(body));}catch{throw new Rejected('invalid_json',400);}
  if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw new Rejected('invalid_rpc',400);
  const rpcStage=parsed.method==='initialize'?'mcp_initialize':parsed.method==='tools/list'?'mcp_list':parsed.method==='tools/call'?'mcp_call':null;if(rpcStage)trace?.mark(rpcStage);
  const server=new Server({name:'rivule',version:'0.2.0-cf'},{capabilities:{tools:{}},instructions:'Explicitly report this source’s task updates only. Do not put secrets or recipient IDs in event data. Tool acceptance is not proof of Discord delivery. No global task discovery or upstream approval is provided.'});
  server.onerror=()=>trace?.mark('mcp_sdk','mcp_sdk_error',500);
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
   {name:'publish_task_update',description:'Publish one explicitly selected PA task update to the owner notification relay. This is a write which may send Discord DMs. standard may update the overview and send a separate critical card. overview_only updates only the single Discord overview, and rejects approval or review-required updates. A separately authorized QQ channel may also deliver its own notification; notification_mode does not select or authorize channels. Does not approve or resume upstream actions.',inputSchema:{type:'object',$defs:eventDefinitions,properties:{event:embeddedEventSchema,notification_mode:{type:'string',enum:['standard','overview_only'],default:'standard',description:'overview_only creates or edits just the overview; standard may also send a separate terminal or approval card. Reusing an event_id with a different mode conflicts.'}},required:['event'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true},securitySchemes:[{type:'oauth2',scopes:['pa:publish']}],_meta:{securitySchemes:[{type:'oauth2',scopes:['pa:publish']}] }},
   {name:'get_delivery_status',description:'Read the delivery status of a receipt created by this authenticated source. The top-level delivery and deliveries describe Discord; optional channels contains independently configured channel receipts. Unknown outcomes remain unknown.',inputSchema:{type:'object',properties:{receipt_id:{type:'string',pattern:'^rcpt_[a-f0-9]{32}$'}},required:['receipt_id'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},securitySchemes:[{type:'oauth2',scopes:['pa:receipt']}],_meta:{securitySchemes:[{type:'oauth2',scopes:['pa:receipt']}]}},
   ...(isDiagnosticReader(source,config)?[{name:'get_connection_diagnostics',description:'Read this owner’s bounded connection-stage diagnostics across configured PA sources. Only the explicitly configured Zot identity may use this tool. Stored in this owner’s database and retained across instance restart or eviction. No message content, credentials or raw requests are stored. Normal queries retain at most 72 hours and 1000 records; Cloudflare platform recovery history can extend to 30 days. This read does not create another diagnostic record. Cannot recover requests before diagnostics were enabled.',inputSchema:{type:'object',properties:{source_id:{type:'string',enum:config.bindings.sources.map(s=>s.source_id)},request_id:{type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'},before:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:50,default:20}},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},securitySchemes:[{type:'oauth2',scopes:['pa:receipt']}],_meta:{securitySchemes:[{type:'oauth2',scopes:['pa:receipt']}]}}]:[])
  ] as any}));
  server.setRequestHandler(CallToolRequestSchema,async call=>{
   try{
    const args=call.params.arguments,principal=ctx.props as OAuthProps;let result:any;
    if(!args||typeof args!=='object')throw new Rejected('invalid_tool_arguments');
    if(call.params.name==='publish_task_update'){
     authorizeOAuthContext(request,ctx,config,['pa:publish']);
     if(!Object.hasOwn(args,'event')||Object.keys(args).some(k=>!['event','notification_mode'].includes(k)))throw new Rejected('invalid_tool_arguments');
     const mode=notificationMode(args.notification_mode);const event=validateEvent(args.event,source,Date.now());result=await owner.publish(principal,event,mode);trace?.mark('mcp_publish');
    }else if(call.params.name==='get_delivery_status'){
     authorizeOAuthContext(request,ctx,config,['pa:receipt']);
     if(Object.keys(args).join(',')!=='receipt_id'||typeof args.receipt_id!=='string'||!/^rcpt_[a-f0-9]{32}$/.test(args.receipt_id))throw new Rejected('invalid_tool_arguments');
     result=await owner.delivery(principal,args.receipt_id);trace?.mark('mcp_receipt');if(trace?.publicId)result={...result,diagnostic:trace.publicId};
    }else if(call.params.name==='get_connection_diagnostics'){
     authorizeOAuthContext(request,ctx,config,['pa:receipt']);
     if(!isDiagnosticReader(source,config)||!owner.diagnostics)throw new Rejected('diagnostics_not_authorized',403);
     const query=validateDiagnosticQuery(args,new Set(config.bindings.sources.map(s=>s.source_id)));
     trace?.skip();result=await owner.diagnostics(principal,query);
    }else throw new Rejected('unknown_tool',404);
    return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};
   }catch(error){trace?.mark('mcp_call',error instanceof Rejected?error.code:'unclassified_error',error instanceof Rejected?error.status:503);return {isError:true,content:[{type:'text',text:JSON.stringify({error:error instanceof Rejected?error.code:'operation_result_unknown',...(call.params.name==='get_delivery_status'&&trace?.publicId?{diagnostic:trace.publicId}:{})})}]};}
  });
  const transport=new WebStandardStreamableHTTPServerTransport({enableJsonResponse:true});
  await server.connect(transport);
  try{
   const response=await transport.handleRequest(new Request(request.url,{method:'POST',headers:request.headers,body}),{parsedBody:parsed});
   trace?.mark('mcp_transport','http_'+response.status,response.status);
   await recordSuccessfulProbe(response,parsed,owner);return response;
  }
  finally{await transport.close();await server.close();}
 }catch(error){const response=safeError(error);trace?.mark('mcp_auth',error instanceof Rejected?error.code:'unclassified_error',response.status);return response;}
}

/** Only completed authenticated probes count; an HTTP 200 may still be an RPC
 * or tool error. Proof persistence never changes the caller's operation result,
 * and it must not enqueue notifications or trigger an owner delivery alarm. */
async function recordSuccessfulProbe(response:Response,request:any,owner:McpOwnerPort):Promise<void>{
 if(!owner.verify||!response.ok||!Object.hasOwn(request,'id'))return;
 const kind:VerificationKind|undefined=request.method==='initialize'?'mcp_initialize':request.method==='tools/list'?'mcp_tools_list':request.method==='tools/call'&&['get_delivery_status','get_connection_diagnostics'].includes(request.params?.name)?'mcp_read':undefined;
 if(!kind)return;
 try{
  const rpc:any=await response.clone().json();
  if(rpc?.jsonrpc!=='2.0'||rpc.id!==request.id||Object.hasOwn(rpc,'error')||!rpc.result||typeof rpc.result!=='object'||Array.isArray(rpc.result)||rpc.result.isError===true)return;
  await owner.verify(kind);
 }catch{} // Read/probe success survives unavailable verification storage.
}
