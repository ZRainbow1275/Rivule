/** Existing BBBOT app as confidential OAuth identity provider: identify only. */
import type {DiagnosticTrace} from './diagnostics.ts';
import type {OAuthConfig,IdentityPort,UpstreamState} from './oauth.ts';
import {boundedJson} from './discord.ts';import {Rejected} from './contracts.ts';
export function createDiscordIdentity(env:Record<string,any>,config:OAuthConfig,transport:typeof fetch=fetch,trace?:DiagnosticTrace):IdentityPort{
 const secret=env.DISCORD_CLIENT_SECRET,appId=config.bindings.appId,owner=config.bindings.userId,callback=config.bindings.publicOrigin+'/callback';
 if(typeof secret!=='string'||secret.length<16||secret.length>2048||/[\s\r\n]/.test(secret))throw new Rejected('discord_oauth_secret_missing',503);
 return {
  formActionOrigin:'https://discord.com',
  allowedSubject:owner,
  async authorizationUrl(state:string,_proof:UpstreamState){
   if(typeof state!=='string'||!state||state.length>200)throw new Rejected('invalid_oauth_state',400);
   const url=new URL('https://discord.com/oauth2/authorize');url.search=new URLSearchParams({response_type:'code',client_id:appId,scope:'identify',state,redirect_uri:callback,prompt:'consent'}).toString();return url.toString();
  },
  async authenticate(code:string,_proof:UpstreamState){
   try{
    if(typeof code!=='string'||!code||code.length>4096||/[\r\n]/.test(code))throw new Error();
    const response=await transport('https://discord.com/api/v10/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',Authorization:'Basic '+btoa(appId+':'+secret)},body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:callback}).toString(),redirect:'manual',signal:AbortSignal.timeout(10000)});
    trace?.mark('discord_token_exchange',response.status===200?'ok':'upstream_http_rejected',response.status);if(response.status!==200)throw new Error();const data=await boundedJson(response,32768);
    if(typeof data.access_token!=='string'||!data.access_token||data.access_token.length>4096||/\s/.test(data.access_token)||typeof data.token_type!=='string'||data.token_type.toLowerCase()!=='bearer'||data.scope!=='identify'||!Number.isFinite(data.expires_in)||data.expires_in<=0)throw new Error();
    const check=await transport('https://discord.com/api/v10/oauth2/@me',{method:'GET',headers:{Authorization:'Bearer '+data.access_token},redirect:'manual',signal:AbortSignal.timeout(10000)});
    trace?.mark('discord_identity_check',check.status===200?'ok':'upstream_http_rejected',check.status);if(check.status!==200)throw new Error();const identity=await boundedJson(check,32768);
    if(identity.application?.id!==appId||identity.user?.id!==owner||identity.user?.bot===true||!Array.isArray(identity.scopes)||identity.scopes.length!==1||identity.scopes[0]!=='identify'||!Number.isFinite(Date.parse(identity.expires))||Date.parse(identity.expires)<=Date.now())throw new Error();
    // No refresh flow or credential persistence: upstream tokens die with this request.
    return {subject:owner};
   }catch{trace?.mark('discord_identity','discord_identity_not_verified',403);throw new Rejected('discord_identity_not_verified',403);}
  }
 };
}
