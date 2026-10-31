// Owner DO route: all session/capability/policy checks share one storage transaction.
import {createUnboundUsagePreferenceController,UsagePreferenceError} from './usage-preference-draft.mjs';
const BASE='/dashboard/usage-preference',TTL=300000;
const hex=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');
export const isUsagePreferencePath=path=>[BASE,BASE+'/access'].includes(path);
export async function dashboardUsagePreference(request,{storage,session,sessionKey,binding,ownerBinding,now,headers}){
 const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:headers()});
 const fail=(code,status=403)=>{throw new UsagePreferenceError(code,status);};
 try{
  const path=new URL(request.url).pathname,read=request.method==='GET'&&path===BASE;
  if(!read&&request.method!=='POST')fail('method_not_allowed',405);
  let body;
  if(!read){
   if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')fail('json_required',415);
   const reader=request.body?.getReader();if(!reader)fail('invalid_request',422);
   try{let raw='',size=0;const decoder=new TextDecoder('utf-8',{fatal:true});for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2048){await reader.cancel();fail('body_too_large',413);}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();body=JSON.parse(raw);}catch(e){if(e instanceof UsagePreferenceError)throw e;fail('invalid_request',422);}
   if(!exact(body,path===BASE+'/access'?['csrf','confirm']:['csrf','capability_id','expected_revision','threshold_percent']))fail('invalid_request',422);
   if(body.csrf!==session.csrf)fail('csrf_required');
   if(path===BASE+'/access'&&body.confirm!==true)fail('explicit_access_required');
   if(path===BASE&&!hex(body.capability_id))fail('management_authorization_required');
  }
  const sessionId=sessionKey.replace(/^dashboard:session:/,''),capKey='dashboard:usage-preference-capability:'+sessionId;
  const result=await storage.transaction(async tx=>{
   const requireSession=async()=>{const s=await tx.get(sessionKey);if(!s||s.binding!==binding||s.csrf!==session.csrf||!hex(s.csrf)||!Number.isSafeInteger(s.expires)||s.expires<=now())fail('dashboard_login_required',401);return s;};
   let active=await requireSession(),cap=await tx.get(capKey);
   const validCap=c=>exact(c,['id','binding','expires'])&&hex(c.id)&&c.binding===binding&&Number.isSafeInteger(c.expires)&&c.expires>now()&&c.expires<=active.expires;
   if(path===BASE+'/access'){
    // Bound retention even if sessions expire without logout. Never reuse QQ access.
    const all=await tx.list({prefix:'dashboard:usage-preference-capability:',limit:65});let live=0;
    for(const [key,value] of all){if(!Number.isSafeInteger(value?.expires)||value.expires<=now())await tx.delete(key);else live++;}
    if(live>=32&&!cap)fail('management_capacity',409);
    cap={id:random(),binding,expires:Math.min(active.expires,now()+TTL)};await tx.put(capKey,cap);
    active=await requireSession();if(!validCap(cap))fail('management_authorization_required');
   }
   const save=!read&&path===BASE;
   const getContext=async()=>{
    const s=await requireSession();let expires=s.expires;
    if(save){const current=await tx.get(capKey);if(!validCap(current)||current.id!==body.capability_id)fail('management_authorization_required');expires=Math.min(expires,current.expires);}
    return {authorized:true,authorization_expires_at:expires,owner_binding:ownerBinding,session_binding:sessionId};
   };
   const controller=createUnboundUsagePreferenceController({storage:{get:key=>tx.get(key),transaction:fn=>fn(tx)},getContext,now});
   const value=save?await controller.saveDraft({expected_revision:body.expected_revision,threshold_percent:body.threshold_percent}):await controller.read();
   await requireSession();
   const current=await tx.get(capKey);
   if(save&&(!validCap(current)||current.id!==body.capability_id))fail('management_authorization_required');
   return {...value,csrf:active.csrf,access:validCap(current)?{capability_id:current.id,expires_at:current.expires}:null};
  });
  return reply(result);
 }catch(e){const known=e instanceof UsagePreferenceError&&/^[a-z_]{1,80}$/.test(e.code);return reply({error:known?e.code:'preference_outcome_unknown',monitoring:'not_connected',notifications_enabled:false},known?e.status:503);}
}
