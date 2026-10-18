/** Deployable adapter; repository defaults keep OAuth and real delivery disabled. */
import {DurableObject} from 'cloudflare:workers';
import wasmModule from '../node_modules/@resvg/resvg-wasm/index_bg.wasm';
import font from '../assets/fonts/NotoSansCJKSC-Regular.otf';
import {loadBindings} from './auth.ts';
import type {NotificationMode} from './notification-policy.ts';
import {getOAuthApi} from '@cloudflare/workers-oauth-provider';
import {oauthGrantRevision} from './source-verification-oauth.ts';
import {currentVerificationBinding} from './source-verification-binding.ts';
import type {VerificationKind} from './source-verification.ts';
import {OwnerCore} from './owner.ts';
import {ownerRequest} from './ingress.ts';
import {museOwnerRequest} from './muse-ingress.ts';
import {handleQQOwnerWebhook} from './qq-service.ts';
import {QQBridgeQueue} from '../qq-cloudflare/owner-queue.ts';
import {gateway} from './gateway.ts';
import {loadOAuthConfig,sourceForOAuthClient,isDiagnosticReader} from './oauth.ts';
import type {OAuthProps} from './oauth.ts';
import {Rejected,sourceAllows} from './contracts.ts';
import {createDiscordSender} from './discord.ts';
import {createMessagePreparer} from './messages.ts';
import {createPngRenderer} from './render.ts';
const pngRenderer=createPngRenderer({wasmModule,fontBuffers:[font]});
export class OwnerTerminal extends DurableObject<any> {
 core:OwnerCore;qq:QQBridgeQueue;recovery:Promise<void>|null=null;
 constructor(ctx:any,env:any){
  super(ctx,env);const b=loadBindings(env);
  const prepare=createMessagePreparer(pngRenderer,{utcOffsetMinutes:env.DISPLAY_UTC_OFFSET_MINUTES===undefined?0:Number(env.DISPLAY_UTC_OFFSET_MINUTES)});
  if(ctx.id.toString()!==env.OWNERS.idFromName('owner:'+b.ownerId).toString())throw new Rejected('owner_object_mismatch',503);
  if(!['true','false'].includes(env.DELIVERY_ENABLED))throw new Rejected('delivery_config_invalid',503);
  this.core=new OwnerCore(ctx.storage,b,{synthetic:false,verificationBinding:async source=>currentVerificationBinding(b,source,env,await oauthGrantRevision(source,env,getOAuthApi({resourceMetadata:{resource:b.publicOrigin+'/mcp'},apiRoute:'/mcp',authorizeEndpoint:'/authorize',tokenEndpoint:'/oauth/token',apiHandler:{fetch:async()=>new Response(null,{status:404})},defaultHandler:{fetch:async()=>new Response(null,{status:404})}},env))),enabled:env.DELIVERY_ENABLED==='true',sender:createDiscordSender({bindings:b,guildId:env.GUILD_ID,token:()=>env.DISCORD_BOT_TOKEN,prepare}),channels:{
   qqSetupEnabled:env.QQ_SETUP_ENABLED==='true',
   onAccepted:(event,id)=>{this.qq.enqueue(event,id);},
   nextAlarmAt:()=>this.qq.nextAlarmAt(),
   receipt:(source,id)=>{const qq=this.qq.receipt(source,id);return qq?{qq}:undefined;}
  }});
  this.qq=new QQBridgeQueue(ctx.storage,env,b.ownerId,b.sources);
  ctx.blockConcurrencyWhile(async()=>{await this.qq.initialize({readOnly:true});await this.core.initialize({readOnly:true});});
 }
 async recoverForWrite(){if(!this.recovery){this.recovery=(async()=>{await this.qq.initialize();await this.core.initialize();})().catch(error=>{this.recovery=null;throw error;});}await this.recovery;}
 async fetch(request:Request){
  await this.core.refreshVerificationBindings();
  if(new URL(request.url).pathname==='/qq/webhook')return handleQQOwnerWebhook(request,this.env,loadBindings(this.env).ownerId,this.ctx.storage);
  if(new URL(request.url).pathname.startsWith('/v1/muse/'))return museOwnerRequest(request,this.env,{
   publish:async(source,event,mode)=>{await this.recoverForWrite();return this.core.ingest(source,event,mode);},
   delivery:async(source,id)=>this.core.receipt(source,id),
   verify:async(kind)=>{const source=this.core.b.sources.find(s=>s.source_id==='muse-main');if(!source)throw new Rejected('source_not_authorized',403);await this.core.verifySource(source,kind);}
  });
  return ownerRequest(request,this.env,{ingest:async(source:any,event:any)=>{await this.recoverForWrite();return this.core.ingest(source,event);},receipt:(source:any,id:string)=>this.core.receipt(source,id)});
 }
 async alarm(){if(this.core.isRetentionAlarm()){await this.core.alarm();return;}await this.recoverForWrite();await this.core.refreshVerificationBindings();await this.qq.drain();await this.core.alarm();}
 source(principal:OAuthProps){const c=loadOAuthConfig(this.env);if(!principal||principal.version!==1||principal.owner_id!==c.bindings.ownerId||typeof principal.client_id!=='string'||!/^[A-Za-z0-9_.:-]{1,200}$/.test(principal.client_id))throw new Rejected('invalid_owner_binding',403);const source=c.clients.some(v=>v.client_id===principal.client_id)?sourceForOAuthClient(c,principal.client_id):c.allowDynamicClients?c.bindings.sources.find(v=>v.source_id===principal.source_id&&v.enabled&&sourceAllows(v,'oauth')):null;if(!source||source.source_id!==principal.source_id)throw new Rejected('source_not_authorized',403);return source;}
 async result(operation:()=>Promise<any>|any){try{await this.core.refreshVerificationBindings();return {ok:true,result:await operation()};}catch(e){return {ok:false,error:e instanceof Rejected?e.code:'operation_result_unknown',status:e instanceof Rejected?e.status:503};}}
 // RPC is private to this Worker's namespace binding; no public owner-selected URL.
 async publish(principal:OAuthProps,event:any,mode:NotificationMode='standard',expectedVerification:string|null=null){return this.result(async()=>{const source=this.source(principal);await this.recoverForWrite();return this.core.ingest(source,event,mode,expectedVerification);});}
 async delivery(principal:OAuthProps,id:string){return this.result(()=>this.core.receipt(this.source(principal),id));}
 async verificationContext(principal:OAuthProps){return this.result(()=>this.core.verificationContext(this.source(principal)));}
 async verifySource(principal:OAuthProps,kind:VerificationKind,expected:string){return this.result(()=>{if(typeof expected!=='string'||!expected)throw new Rejected('verification_changed',409);return this.core.verifySource(this.source(principal),kind,expected);});}
 async registrationAttempt(){return this.result(()=>this.core.registrationAttempt());}
 async recordDiagnostic(record:unknown){return this.result(()=>{if(this.env.DIAGNOSTICS_ENABLED!=='true'||!loadOAuthConfig(this.env).diagnosticReaderSourceId)return {stored:false,reason:'disabled'};return this.core.recordDiagnostic(record);});}
 async connectionDiagnostics(principal:OAuthProps,query:unknown){return this.result(()=>{if(!isDiagnosticReader(this.source(principal),loadOAuthConfig(this.env)))throw new Rejected('diagnostics_not_authorized',403);return this.core.connectionDiagnostics(query);});}
 async selectView(interaction:any){return this.result(async()=>{await this.recoverForWrite();return this.core.select(interaction);});}
}
export default {fetch:gateway};
