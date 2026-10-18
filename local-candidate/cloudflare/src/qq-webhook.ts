/** QQ's documented Ed25519 webhook protocol; never interprets messages as PA authority. */
import {qqGateKey,qqHash,qqReadBytes} from './qq-transport.ts';
import type {QQStorage} from './qq-transport.ts';
export type QQInbound = {channel:'qq_c2c'; appId:string; userOpenId:string; eventId:string; dedupeId:string;
  type:'message'|'proactive_rejected'|'proactive_enabled'|'friend_removed'|'friend_added';
  messageId?:string; timestamp?:string; content?:string; attachments?:{url:string; contentType:string}[]};
export const QQ_INBOX_LIMIT=1000;
export interface QQInbox {enqueueOnce(event:QQInbound):Promise<'stored'|'duplicate'|'conflict'|'full'>}
/** Durable inbox, consumed separately by the owner. ACK never waits on a PA or external send. */
export class QQDurableInbox implements QQInbox {
  private storage:QQStorage;
  constructor(storage:QQStorage){this.storage=storage;}
  async enqueueOnce(event:QQInbound):Promise<'stored'|'duplicate'|'conflict'|'full'>{
    const key='qq:in:'+await qqHash(JSON.stringify([event.appId,event.userOpenId,event.dedupeId]));
    const {eventId:_eventId,...stable}=event;
    const fingerprint=await qqHash(JSON.stringify(stable));
    const gateKey=await qqGateKey(event.appId,event.userOpenId);
    const countKey='qq:in-count:'+await qqHash(JSON.stringify([event.appId,event.userOpenId]));
    return this.storage.transaction(async tx=>{
      const old=await tx.get<{fingerprint:string}>(key);if(old)return old.fingerprint===fingerprint?'duplicate':'conflict';
      if(event.type==='proactive_rejected'||event.type==='friend_removed')await tx.put(gateKey,true);
      // A full inbox must still honor a signed refusal, even though no new event gets an ACK.
      const count=(await tx.get<number>(countKey))??0;
      if(!Number.isSafeInteger(count)||count<0||count>=QQ_INBOX_LIMIT)return 'full';
      // Enable/add events are evidence only; they never silently restore approved capability.
      await tx.put(key,{fingerprint,event,status:'pending'});await tx.put(countKey,count+1);return 'stored';
    });
  }
}
export type QQWebhookConfig={enabled:boolean; appId:string; userOpenId:string; appSecret:()=>string; maxClockSkewSeconds?:number};
const enc=new TextEncoder();
const str=(v:unknown,max=1024):v is string=>typeof v==='string'&&v.length>0&&v.length<=max;
const result=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function fromHex(value:string){if(!/^[0-9a-fA-F]{128}$/.test(value))throw Error('bad_signature');return Uint8Array.from(value.match(/../g)!,n=>parseInt(n,16));}
function hex(bytes:ArrayBuffer){return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');}
async function privateKey(secret:string){
  if(!str(secret,1024))throw Error('missing_secret');const bytes=enc.encode(secret),seed=new Uint8Array(32);for(let i=0;i<32;i++)seed[i]=bytes[i%bytes.length];
  const prefix=Uint8Array.from([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
  const der=new Uint8Array(48);der.set(prefix);der.set(seed,16);
  return crypto.subtle.importKey('pkcs8',der,{name:'Ed25519'},true,['sign']);
}
export async function qqSign(secret:string,message:Uint8Array):Promise<string>{return hex(await crypto.subtle.sign('Ed25519',await privateKey(secret),message));}
export async function qqVerify(secret:string,timestamp:string,body:Uint8Array<ArrayBuffer>,signature:string):Promise<boolean>{
  try{
    const jwk=await crypto.subtle.exportKey('jwk',await privateKey(secret)) as JsonWebKey;
    const publicKey=await crypto.subtle.importKey('jwk',{kty:'OKP',crv:'Ed25519',x:jwk.x,ext:true},{name:'Ed25519'},false,['verify']);
    const prefix=enc.encode(timestamp),message=new Uint8Array(prefix.length+body.length);message.set(prefix);message.set(body,prefix.length);
    return await crypto.subtle.verify('Ed25519',publicKey,fromHex(signature),message);
  }catch{return false;}
}
export function normalizeQQEvent(payload:any,config:QQWebhookConfig):QQInbound|null{
  if(payload?.op!==0||!str(payload.id)||!str(payload.t))throw Error('invalid_event');
  const d=payload.d;
  if(payload.t==='C2C_MESSAGE_CREATE'){
    if(d?.author?.user_openid!==config.userOpenId)return null;
    if(!str(d.id)||typeof d.content!=='string'||d.content.length>16000||!str(d.timestamp,100)||!Number.isFinite(Date.parse(d.timestamp)))throw Error('invalid_message');
    const index=Array.isArray(d.message_scene?.ext)?d.message_scene.ext.find((v:unknown)=>typeof v==='string'&&v.startsWith('msg_idx=')):undefined;
    const attachments:{url:string;contentType:string}[]=[];
    if(d.attachments!==undefined){if(!Array.isArray(d.attachments)||d.attachments.length>20)throw Error('invalid_attachments');
      for(const a of d.attachments){if(!str(a?.url,8192)||!str(a?.content_type,100))continue;try{const u=new URL(a.url.startsWith('//')?'https:'+a.url:a.url);if(u.protocol==='https:'&&!u.username&&!u.password)attachments.push({url:u.href,contentType:a.content_type});}catch{}}
    }
    return {channel:'qq_c2c',appId:config.appId,userOpenId:config.userOpenId,eventId:payload.id,dedupeId:JSON.stringify(['message',d.id,index??d.msg_seq??null]),type:'message',messageId:d.id,timestamp:d.timestamp,content:d.content,attachments};
  }
  const kinds:Record<string,QQInbound['type']>={C2C_MSG_REJECT:'proactive_rejected',C2C_MSG_RECEIVE:'proactive_enabled',FRIEND_DEL:'friend_removed',FRIEND_ADD:'friend_added'};
  if(!kinds[payload.t])return null;
  if(d?.openid!==config.userOpenId&&d?.user_openid!==config.userOpenId)return null;
  return {channel:'qq_c2c',appId:config.appId,userOpenId:config.userOpenId,eventId:payload.id,dedupeId:JSON.stringify([payload.t,payload.id]),type:kinds[payload.t]};
}
export async function handleQQWebhook(request:Request,config:QQWebhookConfig,inbox:QQInbox,now=Date.now()):Promise<Response>{
  if(!config.enabled)return result({error:'qq_disabled'},503);
  if(request.method!=='POST')return result({error:'method_not_allowed'},405);
  if(request.headers.get('X-Bot-Appid')!==config.appId)return result({error:'wrong_app'},401);
  let raw:Uint8Array<ArrayBuffer>,payload:any;
  try{raw=await qqReadBytes(request.body,262144);payload=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(raw));}catch{return result({error:'invalid_body'},400);}
  const skew=config.maxClockSkewSeconds??300;
  if(!Number.isFinite(now)||!Number.isFinite(skew)||skew<1||skew>900)return result({error:'invalid_config'},503);
  const fresh=(v:unknown)=>typeof v==='string'&&/^\d{1,12}$/.test(v)&&Math.abs(now/1000-Number(v))<=skew;
  // QQ's registration probe has no request signature. Only this narrow challenge is exempt.
  if(payload?.op===13){
    if(!str(payload.d?.plain_token,256)||!/^[A-Za-z0-9_+\/=-]+$/.test(payload.d.plain_token)||!fresh(payload.d?.event_ts))return result({error:'invalid_challenge'},400);
    try{return result({plain_token:payload.d.plain_token,signature:await qqSign(config.appSecret(),enc.encode(payload.d.event_ts+payload.d.plain_token))});}catch{return result({error:'credentials_unavailable'},503);}
  }
  const ts=request.headers.get('X-Signature-Timestamp'),signature=request.headers.get('X-Signature-Ed25519');
  let valid=false;try{valid=fresh(ts)&&str(signature,128)&&await qqVerify(config.appSecret(),ts!,raw,signature);}catch{}
  if(!valid)return result({error:'invalid_signature'},401);
  let event:QQInbound|null;try{event=normalizeQQEvent(payload,config);}catch{return result({error:'invalid_event'},400);}
  if(event){try{const state=await inbox.enqueueOnce(event);if(state==='conflict')return result({error:'event_conflict'},409);if(state==='full')return result({error:'inbox_capacity_reached'},503);}catch{return result({error:'inbox_unavailable'},503);}}
  return result({op:12});
}
