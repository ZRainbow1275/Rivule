import {BridgeError} from './message-bridge.mjs';
const base='/dashboard/conversation/qq-review';
export const isConversationReviewPath=path=>['access','prepare','confirm','readback','cancel'].some(action=>path===base+'/'+action);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const fail=(code,status=403)=>{throw new BridgeError(code,status);};
export async function dashboardConversationReview(request,{session,sessionKey,storage,config,now=Date.now,manageConversation,headers}){
 const reply=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:headers()}),started=now(),action=new URL(request.url).pathname.slice(base.length+1);
 if(request.method!=='POST')return reply({error:'method_not_allowed'},405);
 const live=async()=>{const s=await storage.get(sessionKey);if(!s||s.binding!==session.binding||s.expires<=now()||s.csrf!==session.csrf)fail('dashboard_login_required',401);return s;};
 try{
  if(typeof manageConversation!=='function')fail('conversation_review_unavailable',503);await live();
  if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return reply({error:'json_required'},415);
  const reader=request.body?.getReader();if(!reader)fail('invalid_conversation_review',422);let size=0,chunks=[];for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2048){await reader.cancel();return reply({error:'body_too_large'},413);}chunks.push(value);}const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('invalid_conversation_review',422);}
  const keys={access:['csrf','source_id','confirm'],prepare:['csrf','source_id','access_token','receipt_id','confirm'],confirm:['csrf','source_id','access_token','review_id','scope','confirm'],readback:['csrf','source_id','access_token','review_id'],cancel:['csrf','source_id','access_token']}[action];
  if(!keys||!exact(data,keys)||data.csrf!==session.csrf||['access','prepare','confirm'].includes(action)&&data.confirm!==true)fail('explicit_conversation_review_required');
  const source=[config.source,...config.sources].find(s=>s.source_id===data.source_id);if(!source)fail('conversation_source_denied');
  if(action==='cancel'){await storage.transaction(async tx=>{const s=await live();if(s.conversationReviewAccess?.token===data.access_token&&s.conversationReviewAccess.source_id===source.source_id)await tx.put(sessionKey,{...s,conversationReviewAccess:null});});return reply({state:'closed',review_canceled:false});}
  const binding=await manageConversation(source,'review_binding',{});if(typeof binding!=='string'||!binding)fail('conversation_review_unavailable',409);
  if(action==='access'){
   let cap;await storage.transaction(async tx=>{const s=await live();if(now()>=started+300000||await manageConversation(source,'review_binding',{})!==binding)fail('conversation_review_access_changed',409);cap={token:crypto.randomUUID(),source_id:source.source_id,binding,expires:Math.min(s.expires,started+300000)};await tx.put(sessionKey,{...s,conversationReviewAccess:cap});});
   const pending=await manageConversation(source,'review_list',{}),latest=await live(),current=latest.conversationReviewAccess;if(!current||current.token!==cap.token||current.source_id!==source.source_id||current.expires<=now()||current.binding!==binding||await manageConversation(source,'review_binding',{})!==binding)fail('conversation_review_access_required');return reply({source_id:source.source_id,access_token:cap.token,expires_at:cap.expires,recipient_label:'本人 QQ · 已配置账户（账号隐藏）',pending,pending_limit:20});
  }
  const current=await live(),cap=current.conversationReviewAccess;
  const guard=async()=>{const s=await live(),c=s.conversationReviewAccess;if(!cap||!c||c.token!==cap.token||c.token!==data.access_token||c.source_id!==source.source_id||c.expires<=now()||c.binding!==binding||await manageConversation(source,'review_binding',{})!==binding)fail('conversation_review_access_required');};
  await guard();
  if(action==='prepare'){if(!uuid(data.receipt_id))fail('invalid_conversation_review',422);const result=await manageConversation(source,'review_prepare',{receipt_id:data.receipt_id},guard);await guard();return reply(result);}
  if(!uuid(data.review_id))fail('invalid_conversation_review',422);
  if(action==='confirm'){if(!/^[a-f0-9]{64}$/.test(data.scope??''))fail('invalid_conversation_review',422);const result=await manageConversation(source,'review_confirm',{review_id:data.review_id,scope:data.scope},guard);await guard();return reply(result);}
  const result=await manageConversation(source,'review_readback',{review_id:data.review_id},guard);await guard();return reply(result.state==='confirmation_required'?{...result,next_step:'new_owner_preview_required'}:result);
 }catch(error){const code=error instanceof BridgeError?error.code:/^conversation_review_[a-z_]+$/.test(error?.code??'')?error.code:'conversation_review_unavailable';return reply({error:code},error instanceof BridgeError?error.status:409);}
}
