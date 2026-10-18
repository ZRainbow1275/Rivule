/** Fixed-destination REST transport. No gateway, history reads or retry loop. */
import type {Bindings} from './auth.ts';
import type {Dispatch,ReceiptResponse,Sender} from './owner.ts';
import {Rejected} from './contracts.ts';
export type DiscordConfig={bindings:Bindings;guildId:string;token:()=>string;prepare:(dispatch:Dispatch)=>Promise<{payload:any;png?:Uint8Array}>};
const API='https://discord.com/api/v10';
export async function boundedJson(response:Response,limit=262144){
 const reader=response.body?.getReader();if(!reader)throw new Rejected('invalid_remote_receipt');
 const pieces:Uint8Array[]=[];let length=0;
 while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>limit){await reader.cancel();throw new Rejected('invalid_remote_receipt');}pieces.push(value);}
 const bytes=new Uint8Array(length);let offset=0;for(const piece of pieces){bytes.set(piece,offset);offset+=piece.length;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));}catch{throw new Rejected('invalid_remote_receipt');}
}
export function createDiscordSender(config:DiscordConfig,transport:typeof fetch=fetch):Sender{
 const {bindings:b}=config;
 if(!/^[0-9]{1,25}$/.test(config.guildId)||config.guildId==='0')throw new Rejected('guild_config_invalid',503);
 return async(dispatch:Dispatch):Promise<ReceiptResponse>=>{
  let stage='configuration';let token:string,prepared:{payload:any;png?:Uint8Array};
  try{
   if(dispatch.ownerId!==b.ownerId||dispatch.appId!==b.appId||dispatch.dmId!==b.dmId||dispatch.messageId!==null&&!/^[0-9]{1,25}$/.test(dispatch.messageId))throw new Rejected('destination_mismatch');
   token=config.token();if(typeof token!=='string'||token.length<20||/[\s\r\n]/.test(token))throw new Rejected('token_not_configured');
   const get=async(path:string)=>{const r=await transport(API+path,{method:'GET',headers:{Authorization:'Bot '+token},redirect:'manual',signal:AbortSignal.timeout(10000)});if(r.status!==200)throw new Rejected('identity_unverified');return boundedJson(r);};
   stage='bot_identity';const bot=await get('/users/@me');if(bot.id!==b.appId||bot.bot!==true)throw new Rejected('identity_mismatch');
   for(const id of [b.appId,b.userId]){stage=id===b.appId?'guild_bot':'guild_owner';const member=await get('/guilds/'+config.guildId+'/members/'+id);if(member.user?.id!==id||(id===b.appId&&member.user.bot!==true))throw new Rejected('member_mismatch');}
   stage='dm_identity';const channel=await get('/channels/'+b.dmId);if(channel.id!==b.dmId||channel.type!==1||!Array.isArray(channel.recipients)||channel.recipients.length!==1||channel.recipients[0]?.id!==b.userId)throw new Rejected('dm_mismatch');
   stage='render';prepared=await config.prepare(dispatch);
   // The builder is private code; validate mention and size safeguards once more.
   if(!prepared.payload||JSON.stringify(prepared.payload.allowed_mentions)!==JSON.stringify({parse:[]})||JSON.stringify(prepared.payload).length>30000||prepared.png&&prepared.png.byteLength>4*1024*1024)throw new Rejected('render_payload_invalid');
  }catch{return {status:0,notSent:true,reason:'preflight_'+stage};}
  const payload={...prepared.payload};
  if(!dispatch.messageId){payload.nonce=dispatch.nonce;payload.enforce_nonce=true;}
  let body:BodyInit;const headers:Record<string,string>={Authorization:'Bot '+token};
  if(prepared.png){
   payload.attachments=[{id:'0',filename:'progress.png',description:'来源任务与并行路线进展；静态图片，通过下方组件选择'}];
   const form=new FormData();form.set('payload_json',JSON.stringify(payload));form.set('files[0]',new Blob([prepared.png as Uint8Array<ArrayBuffer>],{type:'image/png'}),'progress.png');body=form;
  }else{headers['content-type']='application/json';body=JSON.stringify(payload);}
  // No catch-and-retry here. A rejected/lost fetch may already have sent its body.
  const result=await transport(API+'/channels/'+b.dmId+'/messages'+(dispatch.messageId?'/'+dispatch.messageId:''),{method:dispatch.messageId?'PATCH':'POST',headers,body,redirect:'manual',signal:AbortSignal.timeout(15000)});
  let data:any;try{data=await boundedJson(result);}catch{return {status:result.status===200?0:result.status};}
  if(result.status===429)return {status:429,retryAfter:typeof data.retry_after==='number'?data.retry_after:undefined};
  return {status:result.status,body:result.status===200?data:undefined};
 };
}
