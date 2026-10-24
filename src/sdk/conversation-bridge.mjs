import { validBridgeText } from '../owner/bridge-text.mjs';
/** Conversation-v2 only. Does not fall back to task routes or invent contexts. */
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const secret=v=>/(?:-----BEGIN[\s\S]*PRIVATE KEY|\bBearer\s+\S+|\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}|(?:password|api[_-]?key|authorization|secret|token)["']?\s*[:=])/i.test(v);
const messageFields=['response_id','text','content_kind','origin','sensitivity','reviewed'];
const safe=v=>v&&Object.keys(v).length===messageFields.length&&messageFields.every(key=>Object.hasOwn(v,key))&&v.content_kind==='user_visible_response'&&v.origin==='source'&&v.sensitivity==='normal'&&v.reviewed===true&&validBridgeText(v.text)&&!secret(v.text);
export function createConversationBridge({source_id,call,ownerBinding,recipientBinding,resolveConversationOwner}){
 if(!id(source_id)||typeof call!=='function')throw Error('source_transport_required');
 if(typeof ownerBinding!=='string'||!ownerBinding||ownerBinding.length>1024||typeof recipientBinding!=='string'||!recipientBinding||recipientBinding.length>1024||typeof resolveConversationOwner!=='function')throw Error('trusted_provider_ownership_resolver_required');
 const registeredContexts=new Map();
 async function verifyOwnership(context){
  let resolved;try{resolved=await resolveConversationOwner(Object.freeze({...context}));}catch{throw Error('provider_ownership_unavailable');}
  if(!resolved||resolved.owner_binding!==ownerBinding||resolved.recipient_binding!==recipientBinding||resolved.source_id!==source_id||resolved.conversation_id!==context.conversation_id||resolved.thread_id!==context.thread_id)throw Error('provider_conversation_ownership_mismatch');
 }
 const invoke=(action,args)=>call(action,args);
 const matchingContext=(actual,expected)=>actual?.kind==='conversation'&&actual.version===2&&actual.source_id===source_id&&actual.conversation_id===expected.conversation_id&&actual.thread_id===expected.thread_id;
 return Object.freeze({
  capabilities:()=>invoke('capabilities',{}),
  registerContext:async context=>{if(!context||context.kind!=='conversation'||context.version!==2||Object.keys(context).sort().join(',')!=='conversation_id,kind,thread_id,version'||!id(context.conversation_id)||!id(context.thread_id))throw Error('explicit_conversation_context_required');const exact={...context};await verifyOwnership(exact);const result=await invoke('register_context',exact);if(!uuid(result?.context_ref)||!matchingContext(result.context,exact)||result.registered!==true||result.evidence_kind!=='source_assertion')throw Error('invalid_conversation_registration');await verifyOwnership(exact);registeredContexts.set(result.context_ref,Object.freeze(exact));return result;},
  async reportResponse(context,message){
   context=Object.freeze({...context});message=Object.freeze({...message});
   if(!context||context.kind!=='conversation'||context.version!==2||Object.keys(context).sort().join(',')!=='context_ref,kind,version'||!uuid(context.context_ref))throw Error('explicit_conversation_reference_required');
   const registered=registeredContexts.get(context.context_ref);if(!registered)throw Error('locally_verified_conversation_reference_required');
   await verifyOwnership(registered);
   if(!safe(message))return {state:'withheld',reason:'content_not_approved'};
   if(!id(message.response_id))throw Error('stable_response_id_required');
   const cap=await invoke('capabilities',{});if(cap.source_id!==source_id||cap.kind!=='conversation'||cap.version!==2)throw Error('source_context_mismatch');
   if(cap.operation_authorized!==true)return {state:'withheld',reason:'source_operation_not_authorized'};
   if(!Object.values(cap.channels||{}).some(p=>p.enabled&&(p.selection?.mode==='all_registered'||p.selection?.mode==='selected'&&p.selection.context_refs?.includes(context.context_ref))))return {state:'withheld',reason:'owner_conversation_consent_required'};
   await verifyOwnership(registered);
   return invoke('publish_response',{context_ref:context.context_ref,response_id:message.response_id,text:message.text,content_kind:'user_visible_response',origin:'source',sensitivity:'normal',reviewed:true});
  },
  receipt:receipt_id=>{if(!uuid(receipt_id))throw Error('conversation_receipt_required');return invoke('response_receipt',{receipt_id});},
  claim:async(context_ref,claim_id)=>{if(!uuid(context_ref)||!id(claim_id))throw Error('stable_conversation_claim_required');const context=registeredContexts.get(context_ref);if(!context)throw Error('locally_verified_conversation_reference_required');await verifyOwnership(context);const result=await invoke('claim',{context_ref,claim_id});await verifyOwnership(context);if((Object.hasOwn(result||{},'text')||Object.hasOwn(result||{},'context')||result?.state!=='empty'&&result?.duplicate!==true)&&(!matchingContext(result?.context,context)||result.context_ref!==context_ref))throw Error('conversation_command_context_mismatch');return result;},
  acknowledge:({command_id,claim_token,outcome})=>{if(typeof command_id!=='string'||!uuid(claim_token)||!['completed','rejected','unknown'].includes(outcome))throw Error('truthful_conversation_outcome_required');return invoke('acknowledge',{command_id,claim_token,outcome});}
 });
}
export function conversationMcpTransport(callTool){return async(action,args)=>{const result=await callTool({name:'bridge_conversation_'+action,arguments:args});if(result?.isError)throw Error('conversation_operation_rejected');if(result?.structuredContent)return result.structuredContent;try{return JSON.parse(result?.content?.find(c=>c.type==='text')?.text);}catch{throw Error('invalid_conversation_result');}};}
export function conversationHttpTransport({origin,sign,fetch:request=globalThis.fetch}){
 const url=new URL('/v2/bridge',origin);if(url.protocol!=='https:'||url.username||url.password||typeof sign!=='function')throw Error('secure_runtime_transport_required');
 return async(action,args)=>{const body=JSON.stringify({version:2,kind:'conversation',action,arguments:args}),headers=await sign(new TextEncoder().encode(body));const response=await request(url.href,{method:'POST',redirect:'error',headers:{...headers,'content-type':'application/json'},body});if(!response.ok)throw Error('conversation_http_'+response.status);return response.json();};
}
/** Exactly one route per explicit kind. Unknown/mixed contexts fail, never fallback. */
export function createResponseRouter({task,conversation}){return(context,message)=>{if(context?.kind==='conversation'&&context.version===2)return conversation.reportResponse(context,message);if(context?.kind==='task'&&context.version===1){const {kind,version,...fields}=context;if(Object.keys(fields).some(k=>!['project_id','task_id','run_id','branch_id','thread_id'].includes(k)))throw Error('mixed_response_context');return task.reportResponse(fields,message);}throw Error('explicit_response_kind_required');};}
