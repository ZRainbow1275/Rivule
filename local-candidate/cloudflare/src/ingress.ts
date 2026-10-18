import {Rejected} from './contracts.ts';
import {loadBindings,boundedBody,authenticate,checkOrigin,jsonResponse,safeError} from './auth.ts';
export async function ingress(request:Request,env:Record<string,any>,getOwner:(name:string)=>{fetch:(r:Request)=>Promise<Response>}){
 try{
  const b=loadBindings(env);checkOrigin(request,b);const path=new URL(request.url).pathname;
  if(request.method==='GET'&&path==='/healthz')return jsonResponse({status:'milestone1',mcp:'not_configured',oauth:'not_configured',discord_delivery:'disabled',pa_connectivity:'not_claimed',sankey:'python_reference_only'});
  if(path==='/mcp')return jsonResponse({error:'mcp_oauth_not_configured'},503);
  if(request.method!=='POST'||!['/v1/events','/v1/receipt'].includes(path))return jsonResponse({error:'not_found'},404);
  const body=await boundedBody(request);await authenticate(request,body,b,env,Date.now());
  const owner=getOwner('owner:'+b.ownerId);
  // No caller-selected object ID or destination. DO independently rechecks HMAC.
  return owner.fetch(new Request('https://owner.internal'+path,{method:'POST',headers:request.headers,body}));
 }catch(error){return safeError(error);}
}
export async function ownerRequest(request:Request,env:Record<string,any>,core:any){
 try{
  const b=loadBindings(env),u=new URL(request.url);
  if(u.origin!=='https://owner.internal'||request.method!=='POST')throw new Rejected('internal_route_required',403);
  const body=await boundedBody(request);const source=await authenticate(request,body,b,env,Date.now());
  let data:any;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(body));}catch{throw new Rejected('invalid_json',400);}
  if(u.pathname==='/v1/events')return jsonResponse(await core.ingest(source,data),202);
  if(u.pathname==='/v1/receipt'){
   if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).join(',')!=='receipt_id'||typeof data.receipt_id!=='string')throw new Rejected('invalid_receipt',422);
   return jsonResponse(core.receipt(source,data.receipt_id));
  }
  return jsonResponse({error:'not_found'},404);
 }catch(error){return safeError(error);}
}
