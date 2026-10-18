/** Source-bound single-key HTTPS API. Production rollout is explicitly gated. */
import {loadBindings,boundedBody,jsonResponse,safeError} from './auth.ts';
import {Rejected,validateEvent,sourceAllows} from './contracts.ts';
import type {Source} from './contracts.ts';
import {notificationMode} from './notification-policy.ts';
import type {SourceAdapterPort} from './source-adapter.ts';
import type {DiagnosticTrace} from './diagnostics.ts';
import type {VerificationKind} from './source-verification.ts';
export type MuseOwnerPort=SourceAdapterPort&{verify?:(kind:VerificationKind)=>Promise<unknown>};
export const MUSE_PATHS=['/v1/muse/health','/v1/muse/events','/v1/muse/receipt'] as const;
const keyPattern=/^[A-Za-z0-9._~+/=-]{32,512}$/;
export async function authenticateMuseApi(request:Request,env:Record<string,any>):Promise<Source>{
 if(env.MUSE_API_ENABLED!=='true'){
  if(env.MUSE_API_ENABLED!==undefined&&env.MUSE_API_ENABLED!=='false')throw new Rejected('muse_api_config_invalid',503);
  throw new Rejected('not_found',404);
 }
 const b=loadBindings(env),url=new URL(request.url);
 // Credentials belong in one HTTPS Authorization header, never query or cookies.
 if(url.origin!==b.publicOrigin||url.search||request.headers.has('cookie')||request.headers.has('x-api-key')||request.headers.has('x-rivule-api-key'))throw new Rejected('request_not_accepted',403);
 if(request.headers.has('origin')&&request.headers.get('origin')!==b.publicOrigin)throw new Rejected('request_not_accepted',403);
 const expected=env.PA_MUSE_API_KEY;
 if(typeof expected!=='string'||!keyPattern.test(expected))throw new Rejected('muse_api_not_configured',503);
 const header=request.headers.get('authorization')??'',match=/^Bearer ([A-Za-z0-9._~+/=-]{32,512})$/i.exec(header);
 if(!match)throw new Rejected('unauthorized',401);
 const hashes=await Promise.all([expected,match[1]].map(k=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(k))));
 const left=new Uint8Array(hashes[0]),right=new Uint8Array(hashes[1]);let difference=0;
 for(let i=0;i<left.length;i++)difference|=left[i]^right[i];
 if(difference!==0)throw new Rejected('unauthorized',401);
 const source=b.sources.find(s=>s.source_id==='muse-main'&&s.provider==='muse'&&s.enabled&&sourceAllows(s,'api_key'));
 if(!source)throw new Rejected('muse_source_not_configured',503);
 return source;
}
export async function museApiResponse(request:Request,env:Record<string,any>,owner:MuseOwnerPort,trace?:DiagnosticTrace):Promise<Response>{
 try{
  const path=new URL(request.url).pathname;
  if(!(MUSE_PATHS as readonly string[]).includes(path))throw new Rejected('not_found',404);
  const source=await authenticateMuseApi(request,env);
  trace?.source(source.source_id);trace?.binding(source.source_id);trace?.mark('source_api_auth');
  if(path==='/v1/muse/health'){
   if(request.method!=='GET')throw new Rejected('method_not_allowed',405);
   // No DO call, event/health/queue write or Discord request. Verifies this key only.
   return jsonResponse({status:'authenticated',source_id:source.source_id,delivery_enabled:env.DELIVERY_ENABLED==='true',task_discovery:'not_supported',upstream_approval:'return_to_source',probe_side_effects:'none'});
  }
  if(request.method!=='POST')throw new Rejected('method_not_allowed',405);
  const bytes=await boundedBody(request);let args:any;
  try{args=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));}catch{throw new Rejected('invalid_json',400);}
  if(!args||typeof args!=='object'||Array.isArray(args))throw new Rejected('invalid_api_arguments');
  if(path==='/v1/muse/events'){
   if(!Object.hasOwn(args,'event')||Object.keys(args).some(k=>!['event','notification_mode'].includes(k)))throw new Rejected('invalid_api_arguments');
   const event=validateEvent(args.event,source,Date.now()),mode=notificationMode(args.notification_mode);
   const result=await owner.publish(source,event,mode);trace?.mark('source_api_publish');return jsonResponse(withDiagnosticId(result,trace),202);
  }
  if(Object.keys(args).join(',')!=='receipt_id'||typeof args.receipt_id!=='string'||!/^rcpt_[a-f0-9]{32}$/.test(args.receipt_id))throw new Rejected('invalid_api_arguments');
  const result=await owner.delivery(source,args.receipt_id);trace?.mark('source_api_receipt');
  // delivery enforces receipt ownership; authentication or a missing/foreign
  // receipt is never evidence. This proof has no notification side effects.
  try{await owner.verify?.('muse_own_receipt');}catch{}
  return jsonResponse(withDiagnosticId(result,trace));
 }catch(error){const response=safeError(error);trace?.mark('source_api',error instanceof Rejected?error.code:'unclassified_error',response.status);if(response.status===401)response.headers.set('www-authenticate','Bearer realm="rivule-muse"');return response;}
}

/** JSON-only connectors may discard headers; never echo caller correlation or keys. */
function withDiagnosticId(result:unknown,trace?:DiagnosticTrace):unknown {
 return trace?.publicId&&result&&typeof result==='object'&&!Array.isArray(result)?{...result,request_id:trace.publicId.request_id}:result;
}
