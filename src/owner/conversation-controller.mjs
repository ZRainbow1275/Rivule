import { dashboardConversationReview, isConversationReviewPath } from './conversation-review-controller.mjs';
import {dashboardConversationDisplay,isConversationDisplayPath} from './conversation-display-controller.mjs';
import {BridgeError} from './message-bridge.mjs';
const base='/dashboard/conversation';
export const isConversationSettingsPath=path=>[base,base+'/access',base+'/preference',base+'/cancel'].includes(path)||isConversationDisplayPath(path)||isConversationReviewPath(path);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const fail=(code,status=403)=>{throw new BridgeError(code,status);};
/** Called only after existing dashboard owner identity and same-origin checks.
 * Session capability is management-only, never source-operation authority. */
export async function dashboardConversation(request,{session,sessionKey,storage,config,now=Date.now,manageConversation,headers}){
 if(isConversationReviewPath(new URL(request.url).pathname))return dashboardConversationReview(request,{session,sessionKey,storage,config,now,manageConversation,headers});
 if(isConversationDisplayPath(new URL(request.url).pathname))return dashboardConversationDisplay(request,{session,sessionKey,storage,config,now,manageConversation,headers});
 const reply=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:headers()});
 const path=new URL(request.url).pathname;
 if(!isConversationSettingsPath(path))return reply({error:'not_found'},404);
 if(request.method!==(path===base?'GET':'POST'))return reply({error:'method_not_allowed'},405);
 if(typeof manageConversation!=='function')return reply({error:'conversation_unavailable'},503);
 const liveSession=async()=>{const live=await storage.get(sessionKey);if(!live||live.binding!==session.binding||live.expires<=now()||typeof live.csrf!=='string'||live.csrf!==session.csrf)fail('dashboard_login_required',401);return live;};
 try{
  await liveSession();const sources=[config.source,...(config.sources||[])];
  if(path===base){const values=sources.map(s=>({source_id:s.source_id,kind:'conversation',version:2,scope:'general_conversation'}));await liveSession();return reply({csrf:session.csrf,sources:values});}
  if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return reply({error:'json_required'},415);
  const reader=request.body?.getReader();if(!reader)fail('invalid_conversation_preference',422);let size=0,chunks=[];
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192){await reader.cancel();return reply({error:'body_too_large'},413);}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('invalid_conversation_preference',422);}
  const access=path.endsWith('/access'),cancel=path.endsWith('/cancel');
  if(cancel){if(!exact(data,['csrf','source_id','channel','access_token'])||data.csrf!==session.csrf)fail('conversation_access_required');await storage.transaction(async tx=>{const live=await liveSession(),cap=live.conversationAccess;if(cap?.token===data.access_token&&cap.source_id===data.source_id&&cap.channel===data.channel){delete live.conversationAccess;await tx.put(sessionKey,live);}});return reply({state:'closed'});}
  if(!exact(data,access?['csrf','source_id','channel','confirm']:['csrf','source_id','channel','access_token','enabled','commands_enabled','selection','expected_revision','confirm']))fail('invalid_conversation_preference',422);
  if(data.csrf!==session.csrf||data.confirm!==true)fail('explicit_conversation_confirmation_required');
  const source=sources.find(s=>s.source_id===data.source_id);if(!source||!['discord','qq'].includes(data.channel))fail('conversation_source_or_channel_denied');
  const binding=await manageConversation(source,'binding',{channel:data.channel});
  if(!binding||typeof binding.binding!=='string'||!binding.binding||!(binding.recipient_label===null||typeof binding.recipient_label==='string'))fail('conversation_channel_unavailable',409);
  if(access){
   const cap={token:crypto.randomUUID(),source_id:source.source_id,channel:data.channel,binding:binding.binding,expires:Math.min(session.expires,now()+300000)};
   await storage.transaction(async tx=>{await liveSession();const current=await manageConversation(source,'binding',{channel:data.channel});if(current.binding!==cap.binding)fail('conversation_authority_changed',409);const live=await tx.get(sessionKey);await tx.put(sessionKey,{...live,conversationAccess:cap});});
   const guard=async()=>{const live=await liveSession(),current=live.conversationAccess;if(!current||current.token!==cap.token||current.expires<=now()||current.binding!==cap.binding||current.source_id!==source.source_id||current.channel!==data.channel)fail('conversation_access_required');const fresh=await manageConversation(source,'binding',{channel:data.channel});if(fresh.binding!==cap.binding)fail('conversation_authority_changed',409);};
   await guard();const {preference,observation}=await manageConversation(source,'settings',{channel:data.channel},guard);await guard();
   if(!preference||!Number.isSafeInteger(preference.revision))fail('conversation_unavailable',503);
   return reply({state:'authorized',source_id:source.source_id,channel:data.channel,category:'general_conversation_response',access_token:cap.token,expires_at:cap.expires,recipient_label:binding.recipient_label,can_enable:binding.can_enable===true,preference,observation});
  }
  if(typeof data.enabled!=='boolean'||typeof data.commands_enabled!=='boolean'||!Number.isSafeInteger(data.expected_revision)||data.expected_revision<0||!exact(data.selection,['mode','context_refs'])||!['none','all_registered','selected'].includes(data.selection.mode)||!Array.isArray(data.selection.context_refs)||data.selection.context_refs.length>100||!data.selection.context_refs.every(v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v))||new Set(data.selection.context_refs).size!==data.selection.context_refs.length||(data.selection.mode!=='selected'&&data.selection.context_refs.length)||data.enabled&&(data.selection.mode==='none'||data.selection.mode==='selected'&&!data.selection.context_refs.length)||data.commands_enabled&&!data.enabled)fail('invalid_conversation_preference',422);
  if(data.enabled&&(binding.can_enable!==true||!binding.recipient_label))fail('conversation_channel_unavailable',409);
  const cap=(await liveSession()).conversationAccess;
  const admissionGuard=async()=>{const live=await liveSession(),current=live.conversationAccess;if(!cap||!current||current.token!==cap.token||data.access_token!==cap.token||current.source_id!==source.source_id||current.channel!==data.channel||current.expires<=now()||current.binding!==binding.binding)fail('conversation_access_required');const fresh=await manageConversation(source,'binding',{channel:data.channel});if(fresh.binding!==current.binding||data.enabled&&fresh.can_enable!==true)fail('conversation_authority_changed',409);};
  await admissionGuard();
  const result=await manageConversation(source,'preference',{channel:data.channel,enabled:data.enabled,commands_enabled:data.commands_enabled,selection:data.selection,expected_revision:data.expected_revision,confirm:true},admissionGuard);
  await admissionGuard();return reply(result);
 }catch(error){return reply({error:error instanceof BridgeError?error.code:'conversation_unavailable'},error instanceof BridgeError?error.status:503);}
}
