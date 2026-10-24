/** Source-side hooks. Transport authenticates one configured PA; never logs payloads. */
const fields = ['project_id','task_id','run_id','branch_id','thread_id'];
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
const withheld = reason => ({state:'withheld',reason});
function blockedStructure(value, depth=0) {
  if(depth>20)return true;
  if(!value || typeof value!=='object')return false;
  return Object.entries(value).some(([key,item])=>
    /(?:password|secret|token|api.?key|reasoning|chain.?of.?thought|tool.?traffic)/i.test(key)
    || (key==='sensitivity' && item!=='normal')
    || (key==='content_kind' && item!=='user_visible_response')
    || blockedStructure(item,depth+1));
}
function context(value) {
  if (!value || !fields.every(key=>identifier(value[key]))) throw Error('real_task_context_required');
  return Object.fromEntries(fields.map(key=>[key,value[key]]));
}
function safe(message) {
  // Classification is mandatory, not inferred by a regex. The caller must run its
  // own content policy/DLP before setting these fields. Unknown is withheld.
  return message?.content_kind === 'user_visible_response' && message.origin === 'source'
    && message.sensitivity === 'normal' && message.reviewed_for_secrets === true
    && typeof message.text === 'string' && message.text.trim() && message.text.length<=1200
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(message.text)
    && !/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[a-zA-Z0-9_-]{16,}|Bearer\s+\S+)|(?:password|api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S+)/i.test(message.text);
}
export function createSourceBridge({source_id,call, publishTaskUpdate}) {
  if(!identifier(source_id)||typeof call!=='function')throw Error('source_transport_required');
  const invoke=(action,args)=>call(action,args);
  return Object.freeze({
    capabilities:()=>invoke('capabilities',{}),
    registerContext:task=>invoke('register_context',context(task)),
    async reportResponse(task,message) {
      if(!safe(message))return withheld('content_not_approved');
      if(!identifier(message.response_id))throw Error('stable_response_id_required');
      const taskContext=context(task),cap=await invoke('capabilities',{});
      if(cap.source_id!==source_id)throw Error('source_identity_mismatch');
      if(cap.mode!=='every_response')return withheld('owner_mode_task_updates');
      // Registration is explicit; do not invent contexts or silently re-register
      // after consent or binding changes. Server revalidates on every publish.
      return invoke('publish_response',{...taskContext,response_id:message.response_id,text:message.text,content_kind:'user_visible_response',origin:'source'});
    },
    async reportTaskUpdate(event,{reviewed_for_secrets=false}={}) {
      if(!event || event.sensitivity!=='normal' || reviewed_for_secrets!==true || event.source_id!==source_id)return withheld('content_not_approved');
      if(blockedStructure(event))return withheld('content_not_approved');
      if(!identifier(event.event_id))throw Error('stable_event_id_required');
      // Reuse the established task-event transport/schema rather than pretending
      // task updates are bridge responses. Review the ENTIRE event before upload.
      if(!safe({text:JSON.stringify(event),content_kind:'user_visible_response',origin:'source',sensitivity:'normal',reviewed_for_secrets:true}))return withheld('content_not_approved');
      if(typeof publishTaskUpdate!=='function')throw Error('task_update_transport_required');
      return publishTaskUpdate(event);
    },
    receipt:receipt_id=>invoke('response_receipt',{receipt_id}),
    claim:(task,claim_id)=>{if(!identifier(claim_id))throw Error('stable_claim_id_required');return invoke('claim',{...context(task),claim_id});},
    acknowledge:({command_id,claim_token,outcome})=>{if(!['completed','rejected','unknown'].includes(outcome))throw Error('truthful_outcome_required');return invoke('acknowledge',{command_id,claim_token,outcome});}
  });
}
/** Pass the already authenticated MCP client's callTool method. */
export function mcpBridgeTransport(callTool) {
  return async(action,args)=>{
    const result=await callTool({name:'bridge_'+action,arguments:args});
    if(result?.isError)throw Error('bridge_operation_rejected');
    if(result?.structuredContent)return result.structuredContent;
    const text=result?.content?.find(item=>item.type==='text')?.text;
    try{return JSON.parse(text);}catch{throw Error('invalid_bridge_result');}
  };
}
/** sign receives exact bytes and returns current HMAC headers. Keep keys in the
 * runtime's secret store. No retries, redirects, logging or credential storage. */
export function httpBridgeTransport({origin,sign,fetch:request=globalThis.fetch}) {
  const url=new URL('/v1/bridge',origin);
  if(url.protocol!=='https:'||url.username||url.password)throw Error('secure_origin_required');
  if(typeof sign!=='function')throw Error('runtime_signer_required');
  return async(action,args)=>{
    const body=JSON.stringify({version:1,action,arguments:args});
    const headers=await sign(new TextEncoder().encode(body));
    const response=await request(url.href,{method:'POST',redirect:'error',headers:{...headers,'content-type':'application/json'},body});
    if(!response.ok)throw Error('bridge_http_'+response.status);
    return response.json();
  };
}
