import {isSourceProvider,MAX_SOURCES} from './source-registry.ts';
import {Rejected,identifier,safeUrl,text,sourceAllows} from './contracts.ts';
import type {Source} from './contracts.ts';
export type Bindings={publicOrigin:string;ownerId:string;appId:string;userId:string;dmId:string;sources:Source[];allowedProjectIds:string[]};
export function validateAllowedProjectIds(value:unknown):string[]{
 if(!Array.isArray(value)||value.length<1||value.length>3||new Set(value).size!==value.length)throw new Rejected('project_config_invalid',503);
 try{return value.map(identifier);}catch{throw new Rejected('project_config_invalid',503);}
}
export function loadBindings(env:Record<string,any>):Bindings{
 let sources:any;try{sources=JSON.parse(env.SOURCES_JSON);}catch{throw new Rejected('source_config_missing',503);}
 let projects:unknown;try{projects=JSON.parse(env.ALLOWED_PROJECT_IDS_JSON);}catch{throw new Rejected('project_config_missing',503);}
 const allowedProjectIds=validateAllowedProjectIds(projects);
 safeUrl(env.PUBLIC_ORIGIN);
 if(typeof env.PUBLIC_ORIGIN!=='string'||new URL(env.PUBLIC_ORIGIN).pathname!=='/'||env.PUBLIC_ORIGIN.endsWith('/'))throw new Rejected('origin_config_invalid',503);
 if(!Array.isArray(sources)||sources.length<1||sources.length>MAX_SOURCES)throw new Rejected('source_config_invalid',503);
 const ownerId=identifier(env.OWNER_ID);
 for(const key of ['APPLICATION_ID','OWNER_DISCORD_ID','DM_CHANNEL_ID'])if(typeof env[key]!=='string'||!/^\d{1,25}$/.test(env[key])||env[key]==='0')throw new Rejected('binding_config_invalid',503);
 const ids=new Set(),keys=new Set();
 for(const s of sources){
  if(!s||typeof s!=='object'||Object.keys(s).some(k=>!['source_id','provider','display_name','enabled','allowed_hosts','secret_name','auth_methods'].includes(k)))throw new Rejected('source_config_invalid',503);
  if(s.auth_methods!==undefined&&(!Array.isArray(s.auth_methods)||s.auth_methods.length<1||s.auth_methods.length>3||new Set(s.auth_methods).size!==s.auth_methods.length||s.auth_methods.some((m:unknown)=>!['oauth','hmac','api_key'].includes(m as string))))throw new Rejected('source_config_invalid',503);
  identifier(s.source_id);text(s.display_name,80,1);
  if(ids.has(s.source_id)||keys.has(s.secret_name)||!isSourceProvider(s.provider)||typeof s.display_name!=='string'||typeof s.enabled!=='boolean'||!Array.isArray(s.allowed_hosts)||!/^PA_[A-Z0-9_]{1,64}$/.test(s.secret_name))throw new Rejected('source_config_invalid',503);
  for(const host of s.allowed_hosts){safeUrl('https://'+host);if(new URL('https://'+host).hostname!==host)throw new Rejected('host_config_invalid',503);}
  ids.add(s.source_id);keys.add(s.secret_name);
 }
 return {publicOrigin:env.PUBLIC_ORIGIN,ownerId,appId:env.APPLICATION_ID,userId:env.OWNER_DISCORD_ID,dmId:env.DM_CHANNEL_ID,sources,allowedProjectIds};
}
export async function boundedBody(request:Request):Promise<Uint8Array>{
 if(request.headers.get('content-type')?.split(';')[0]!=='application/json')throw new Rejected('json_required',415);
 const reader=request.body?.getReader();if(!reader)return new Uint8Array();
 const chunks:Uint8Array[]=[];let length=0;
 while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>65536){await reader.cancel();throw new Rejected('body_too_large',413);}chunks.push(value);}
 const all=new Uint8Array(length);let offset=0;for(const c of chunks){all.set(c,offset);offset+=c.length;}return all;
}
export async function authenticate(request:Request,body:Uint8Array,b:Bindings,env:Record<string,any>,now:number):Promise<Source>{
 const source=b.sources.find(s=>s.source_id===request.headers.get('x-pa-source'));
 if(!source?.enabled||!sourceAllows(source,'hmac'))throw new Rejected('unauthorized_source',403);
 const ts=request.headers.get('x-pa-timestamp')??'',sig=request.headers.get('x-pa-signature')??'';
 if(!/^\d{1,14}$/.test(ts)||Math.abs(now/1000-Number(ts))>300||!/^[0-9a-f]{64}$/.test(sig))throw new Rejected('invalid_signature',403);
 const secret=env[source.secret_name];if(typeof secret!=='string'||new TextEncoder().encode(secret).length<32)throw new Rejected('source_not_configured',503);
 const prefix=new TextEncoder().encode(ts+'.'),signed=new Uint8Array(prefix.length+body.length);signed.set(prefix);signed.set(body,prefix.length);
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 const bytes=new Uint8Array(sig.match(/.{2}/g)!.map(x=>parseInt(x,16)));
 if(!await crypto.subtle.verify('HMAC',key,bytes,signed))throw new Rejected('invalid_signature',403);
 return source;
}
export function checkOrigin(request:Request,b:Bindings){const u=new URL(request.url);
 if(u.origin!==b.publicOrigin||u.search||request.headers.get('authorization')||request.headers.get('origin')&&request.headers.get('origin')!==b.publicOrigin)throw new Rejected('origin_not_accepted',403);
}
export function jsonResponse(value:any,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});}
export function safeError(error:any){return error instanceof Rejected?jsonResponse({error:error.code},error.status):jsonResponse({error:'request_result_unknown'},500);}
