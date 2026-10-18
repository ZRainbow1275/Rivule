/** One hosting boundary: official OAuthProvider + fixed owner Durable Object. */
import {withScopeGuidance} from './oauth-challenge.ts';
import {createDiagnosticTrace} from './diagnostics.ts';
import type {DiagnosticTrace,DiagnosticRecord} from './diagnostics.ts';
import OAuthProvider from '@cloudflare/workers-oauth-provider';
import {loadBindings,boundedBody,jsonResponse,safeError} from './auth.ts';
import {ingress} from './ingress.ts';
import {museIngress} from './muse-ingress.ts';
import {appendMuseConfiguration} from './muse-config-diagnostic.ts';
import {routeQQWebhook} from './qq-service.ts';
import {loadOAuthConfig,handleOAuthAuthorization,PA_SCOPES,withScopePolicyMetadata} from './oauth.ts';
import type {OAuthContext,OAuthProps} from './oauth.ts';
import {createDiscordIdentity} from './oauth-discord.ts';
import {mcpResponse} from './mcp.ts';
import {qqInteractionResponse} from '../qq-cloudflare/admin-route.mjs';
import {Rejected} from './contracts.ts';
const getOwner=(env:any)=>env.OWNERS.get(env.OWNERS.idFromName('owner:'+loadBindings(env).ownerId));
const unwrap=(r:any)=>{if(!r||r.ok!==true)throw new Rejected(typeof r?.error==='string'?r.error:'owner_result_unknown',r?.status??503);return r.result;};
export async function gateway(request:Request,env:any,ctx:any):Promise<Response>{
 let record:DiagnosticRecord|undefined;
 const trace=createDiagnosticTrace(request,env,{sink:r=>{record=r;if(!env.DIAGNOSTIC_READER_SOURCE_ID)console.log(r);}});let response:Response;
 if(new URL(request.url).pathname==='/healthz')trace.skip();
 try{response=await gatewayCore(request,env,ctx,trace);}catch(error){response=safeError(error);trace.mark('request',error instanceof Rejected?error.code:'unclassified_error',response.status);}
 const completed=trace.finish(response);
 // latency_ms describes response preparation, excluding best-effort telemetry.
 // Discord must receive its ACK within three seconds; diagnostics cannot gate it.
 if(record&&env.DIAGNOSTICS_ENABLED==='true'&&env.DIAGNOSTIC_READER_SOURCE_ID){
  if(new URL(request.url).pathname==='/discord/interactions'){
   const captured=record;
   const background=(async()=>{let timer:any;try{
    await Promise.race([Promise.resolve().then(()=>getOwner(env).recordDiagnostic(captured)),new Promise<void>(resolve=>{timer=setTimeout(resolve,1500);})]);
   }catch{}finally{clearTimeout(timer);}})();
   // A missing/rejected execution context degrades to best effort, never an
   // awaited response dependency or an unhandled rejected diagnostic promise.
   try{ctx?.waitUntil?.(background);}catch{}
  }else{try{await getOwner(env).recordDiagnostic(record);}catch{}}
 }
 return completed;
}
async function gatewayCore(request:Request,env:any,ctx:any,trace:DiagnosticTrace):Promise<Response>{
 try{
  const b=loadBindings(env),url=new URL(request.url);
  if(url.origin!==b.publicOrigin)throw new Rejected('origin_not_accepted',403);
  if(url.pathname==='/healthz')return jsonResponse({status:'configured_candidate',delivery_enabled:env.DELIVERY_ENABLED==='true',oauth_configured:env.OAUTH_ENABLED==='true',pa_connectivity:'not_claimed',real_deployment_acceptance:'pending'});
  if(url.pathname==='/discord/interactions')return qqInteractionResponse(request,b,env.DISCORD_PUBLIC_KEY??'',env.GUILD_ID??'',async p=>unwrap(await getOwner(env).selectView(p)),env,trace);
  if(url.pathname==='/qq/webhook')return routeQQWebhook(request,env,b.ownerId,name=>env.OWNERS.get(env.OWNERS.idFromName(name)));
  if(url.pathname.startsWith('/v1/muse/'))return museIngress(request,env,name=>env.OWNERS.get(env.OWNERS.idFromName(name)),trace);
  if(env.OAUTH_ENABLED!=='true')return ingress(request,env,(name)=>env.OWNERS.get(env.OWNERS.idFromName(name)));
  const config=loadOAuthConfig(env,b);
  if(!env.OAUTH_KV)throw new Rejected('oauth_storage_missing',503);
  if(url.pathname==='/oauth/register'&&request.method==='POST'){
   if(!config.allowDynamicClients||url.search)throw new Rejected('registration_not_enabled',403);
   const body=await boundedBody(request);if(body.length>16384)throw new Rejected('registration_body_too_large',413);
   const quota=unwrap(await getOwner(env).registrationAttempt());
   if(!quota.allowed)return new Response(JSON.stringify({error:'registration_temporarily_limited'}),{status:429,headers:{'content-type':'application/json','cache-control':'no-store','retry-after':String(quota.retry_after)}});
   request=new Request(request.url,{method:'POST',headers:request.headers,body});
  }
  const provider=new OAuthProvider<any>({
   clientRegistrationEndpoint:config.allowDynamicClients?'/oauth/register':undefined,
   apiRoute:'/mcp',authorizeEndpoint:'/authorize',tokenEndpoint:'/oauth/token',
   resourceMetadata:{resource:config.resource,authorization_servers:[b.publicOrigin]},
   scopesSupported:[...PA_SCOPES],requiredScopes:[],clientIdMetadataDocumentEnabled:false,
   accessTokenTTL:3600,refreshTokenTTL:2592000,
   apiHandler:{async fetch(req:any,e:any,context:any){
    const owner=getOwner(e);let verificationContext:string|null=null;try{verificationContext=unwrap(await owner.verificationContext(context.props));}catch{}return mcpResponse(req,context as OAuthContext,loadOAuthConfig(e),{
     publish:async(principal:OAuthProps,event:any,mode)=>{const token=await e.OAUTH_PROVIDER.unwrapToken(context.auth.token);if(!token||token.userId!==context.auth.userId||token.grant.clientId!==context.auth.clientId)throw new Rejected('verification_changed',409);return unwrap(await owner.publish(principal,event,mode,verificationContext));},
     delivery:async(principal:OAuthProps,id:string)=>unwrap(await owner.delivery(principal,id)),
     diagnostics:async(principal:OAuthProps,query:any)=>appendMuseConfiguration(async()=>unwrap(await owner.connectionDiagnostics(principal,query)),e),
     verify:async kind=>{if(!verificationContext)return;const token=await e.OAUTH_PROVIDER.unwrapToken(context.auth.token);if(!token||token.userId!==context.auth.userId||token.grant.clientId!==context.auth.clientId)throw new Rejected('verification_changed',409);return unwrap(await owner.verifySource((context as OAuthContext).props as OAuthProps,kind,verificationContext));}
    },trace);
   }},
   defaultHandler:{async fetch(req:any,e:any){const path=new URL(req.url).pathname;
    if(path==='/authorize'||path==='/callback')return handleOAuthAuthorization(req,loadOAuthConfig(e),e.OAUTH_PROVIDER,createDiscordIdentity(e,loadOAuthConfig(e),fetch,trace),trace);
    return ingress(req,e,(name)=>e.OWNERS.get(e.OWNERS.idFromName(name)));
   }},
   onError:(error)=>{trace.mark('oauth_provider','oauth_'+error.code,error.status);}, // Allowlist drops unknown codes; never descriptions, headers or SDK internals.
  });
  const response=withScopeGuidance(request,await withScopePolicyMetadata(request,await provider.fetch(request,env,ctx)));trace.mark('request_complete','http_'+response.status,response.status);return response;
 }catch(error){const response=safeError(error);trace.mark('request',error instanceof Rejected?error.code:'unclassified_error',response.status);return response;}
}
