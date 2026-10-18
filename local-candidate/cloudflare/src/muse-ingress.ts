/** Muse ingress -> fixed owner's private DO fetch, with independent auth at DO.
 * No key, body, URL query or provider exception is logged or put in RPC results. */
import {museApiResponse} from './muse-api.ts';
import {loadBindings,safeError} from './auth.ts';
import {Rejected} from './contracts.ts';
import type {MuseOwnerPort} from './muse-api.ts';
import type {DiagnosticTrace} from './diagnostics.ts';
type OwnerFetch={fetch:(request:Request)=>Promise<Response>};
export async function museIngress(request:Request,env:Record<string,any>,getOwner:(name:string)=>OwnerFetch,trace?:DiagnosticTrace):Promise<Response>{
 // Credential validity probe must never instantiate/contact an owner or enqueue.
 if(new URL(request.url).pathname==='/v1/muse/health')trace?.skip();
 const forward=async(path:string,body:unknown)=>{
  const b=loadBindings(env);
  const response=await getOwner('owner:'+b.ownerId).fetch(new Request('https://owner.internal'+path,{
   method:'POST',headers:{'content-type':'application/json',authorization:request.headers.get('authorization')??''},body:JSON.stringify(body)
  }));
  // The DO returns only schema-constrained results/errors; never raw exceptions.
  const result:any=await response.json();
  if(!response.ok)throw new Rejected(typeof result?.error==='string'?result.error:'operation_result_unknown',response.status);
  return result;
 };
 return museApiResponse(request,env,{
  publish:async(_source,event,mode)=>forward('/v1/muse/events',{event,notification_mode:mode}),
  delivery:async(_source,receipt_id)=>forward('/v1/muse/receipt',{receipt_id})
 },trace);
}
export async function museOwnerRequest(request:Request,env:Record<string,any>,port:MuseOwnerPort):Promise<Response>{
 try{
  const u=new URL(request.url);
  if(u.origin!=='https://owner.internal'||u.search||u.hash||request.method!=='POST')throw new Rejected('internal_route_required',403);
  if(!['/v1/muse/events','/v1/muse/receipt'].includes(u.pathname))throw new Rejected('not_found',404);
  // Reconstruct only the fixed public origin. Same key, gate, source, body,
  // mode and per-source receipt are independently revalidated in this object.
  const b=loadBindings(env);
  return museApiResponse(new Request(b.publicOrigin+u.pathname,request),env,port);
 }catch(error){return safeError(error);}
}
