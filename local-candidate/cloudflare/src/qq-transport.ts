/** Official QQ C2C REST transport. Server-owned configuration only; no selfbot or fallback. */
export const QQ_API_ORIGIN = 'https://api.bot.qq.com';
export type QQReceipt = {state:'sent'|'not_sent'|'uncertain'|'blocked'; reason:string; messageId?:string; providerCode?:number; retryAfterSeconds?:number};
export type QQIntent = {ownerId:string; sourceId:string; projectId:string; eventId:string; content:string;
  image?:{url:string}; reply?:{messageId:string; validUntil:number; sequence:number}};
export type QQEvidence = {checkedAt:number; validUntil:number; identity:boolean; proactive:boolean; reply:boolean; image:boolean};
export type QQConfig = {enabled:boolean; appId:string; appSecret:()=>string; ownerId:string; userOpenId:string;
  allowedSources:readonly string[]; allowedProjects:readonly string[]; allowedImageOrigins:readonly string[];
  evidence:()=>QQEvidence};
export interface QQLedger {
  /** Atomic durable insert-before-send. Existing reservations MUST never be automatically reclaimed. */
  reserve(key:string, fingerprint:string, replySlot?:string, gateKey?:string):Promise<'new'|QQReceipt>;
  finish(key:string, fingerprint:string, receipt:QQReceipt):Promise<void>;
  isRevoked(gateKey:string):Promise<boolean>;
}
export interface QQTransaction {get<T>(key:string):Promise<T|undefined>; put(key:string,value:unknown):Promise<unknown>}
export interface QQStorage {transaction<T>(fn:(tx:QQTransaction)=>Promise<T>):Promise<T>}
type Stored = {fingerprint:string; receipt:QQReceipt};
/** Works with Durable Object transactional storage. Lost process => durable uncertain fence. */
export class QQDurableLedger implements QQLedger {
  private storage:QQStorage;
  constructor(storage:QQStorage){this.storage=storage;}
  reserve(key:string,fingerprint:string,replySlot?:string,gateKey?:string):Promise<'new'|QQReceipt>{
    return this.storage.transaction(async tx=>{
      if(gateKey&&await tx.get(gateKey))return {state:'blocked',reason:'permission_revoked'};
      const old=await tx.get<Stored>(key);
      if(old)return old.fingerprint===fingerprint?old.receipt:{state:'blocked',reason:'idempotency_conflict'};
      if(replySlot&&await tx.get(replySlot))return {state:'blocked',reason:'reply_sequence_used'};
      await tx.put(key,{fingerprint,receipt:{state:'uncertain',reason:'reserved_before_send'}});
      if(replySlot)await tx.put(replySlot,true);
      return 'new';
    });
  }
  async isRevoked(gateKey:string){return this.storage.transaction(async tx=>Boolean(await tx.get(gateKey)));}
  async finish(key:string,fingerprint:string,receipt:QQReceipt){
    await this.storage.transaction(async tx=>{const old=await tx.get<Stored>(key);if(!old||old.fingerprint!==fingerprint)throw Error('qq_ledger_conflict');await tx.put(key,{fingerprint,receipt});});
  }
}
const text=(v:unknown,max=256):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\r\n\0]/.test(v);
const blocked=(reason:string):QQReceipt=>({state:'blocked',reason});
export async function qqReadBytes(body:ReadableStream<Uint8Array>|null,limit:number):Promise<Uint8Array<ArrayBuffer>>{
  if(!body)throw Error('empty_body');const reader=body.getReader(),parts:Uint8Array[]=[];let size=0;
  try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>limit)throw Error('body_too_large');parts.push(r.value);}}
  catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
  const out=new Uint8Array(size);let p=0;for(const part of parts){out.set(part,p);p+=part.length;}return out;
}
async function json(r:Response){return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(await qqReadBytes(r.body,262144)));}
export async function qqHash(s:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');}
/** No background timer: every API call refreshes inside QQ's documented 60-second overlap. */
export class QQC2CTransport {
  private config:QQConfig; private token?:{value:string; expiresAt:number}; private refreshing?:Promise<string>;
  private ledger:QQLedger; private transport:typeof fetch; private now:()=>number;
  constructor(config:QQConfig,ledger:QQLedger,transport:typeof fetch=fetch,now:()=>number=Date.now){
    this.ledger=ledger;this.transport=(input,init)=>transport(input,init);this.now=now;
    this.config={...config,allowedSources:[...config.allowedSources],allowedProjects:[...config.allowedProjects],allowedImageOrigins:[...config.allowedImageOrigins]};
    if(!/^\d{1,32}$/.test(config.appId)||!/^[A-Za-z0-9_-]{1,256}$/.test(config.userOpenId)||!text(config.ownerId))throw Error('qq_invalid_config');
  }
  private async accessToken():Promise<string>{
    if(this.token&&this.token.expiresAt-this.now()>60000)return this.token.value;
    if(this.refreshing)return this.refreshing;
    this.refreshing=(async()=>{
      const secret=this.config.appSecret();if(!text(secret,1024))throw Error('qq_credentials_missing');
      const r=await this.transport(QQ_API_ORIGIN+'/app/getAppAccessToken',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({appId:this.config.appId,clientSecret:secret}),redirect:'manual',signal:AbortSignal.timeout(10000)});
      if(!r.ok)throw Error('qq_token_failed');const d=await json(r),seconds=Number(d?.expires_in);
      if(d?.code!==undefined&&d.code!==0||!text(d?.access_token,8192)||!Number.isFinite(seconds)||seconds<=0||seconds>7200)throw Error('qq_token_failed');
      this.token={value:d.access_token,expiresAt:this.now()+seconds*1000};return d.access_token;
    })();
    try{return await this.refreshing;}finally{this.refreshing=undefined;}
  }
  private async post(path:string,payload:unknown){
    const send=async(token:string)=>this.transport(QQ_API_ORIGIN+path,{method:'POST',headers:{Authorization:'QQBot '+token,'content-type':'application/json','X-Union-Appid':this.config.appId},body:JSON.stringify(payload),redirect:'manual',signal:AbortSignal.timeout(15000)});
    const token=await this.accessToken();let r=await send(token);
    // Only explicit HTTP 401 proves this request was rejected before sending. Never retry timeouts/5xx.
    if(r.status===401){await r.body?.cancel();if(this.token?.value===token)this.token=undefined;r=await send(await this.accessToken());}
    return r;
  }
  async send(intent:QQIntent):Promise<QQReceipt>{
    // Freeze the caller's intent before the first await, including nested reply/image fields.
    try{intent=structuredClone(intent);}catch{return blocked('invalid_intent');}
    const c=this.config,now=this.now();
    if(c.enabled!==true)return blocked('disabled');
    if(!intent||intent.ownerId!==c.ownerId||!c.allowedSources.includes(intent.sourceId)||!c.allowedProjects.includes(intent.projectId))return blocked('binding_not_authorized');
    if(!text(intent.eventId)||!text(intent.sourceId)||!text(intent.projectId)||typeof intent.content!=='string'||intent.content.length>4000||(!intent.content.trim()&&!intent.image))return blocked('invalid_intent');
    let e:QQEvidence;try{e=c.evidence();}catch{return blocked('evidence_unavailable');}if(!e||!Number.isFinite(e.checkedAt)||!Number.isFinite(e.validUntil)||e.checkedAt>now||e.validUntil<=now||e.checkedAt>=e.validUntil)return blocked('evidence_expired');
    if(e.identity!==true)return blocked('identity_unverified');
    if(intent.reply){const r=intent.reply;if(e.reply!==true||!text(r.messageId)||!Number.isFinite(r.validUntil)||r.validUntil<=now||!Number.isSafeInteger(r.sequence)||r.sequence<1||r.sequence>4)return blocked('reply_unverified');}
    else if(e.proactive!==true)return blocked('proactive_unverified');
    let imageUrl:string|undefined;
    if(intent.image){if(e.image!==true)return blocked('image_unverified');try{const u=new URL(intent.image.url);if(u.protocol!=='https:'||u.username||u.password||u.hash||!c.allowedImageOrigins.includes(u.origin))return blocked('image_origin_not_authorized');imageUrl=u.href;}catch{return blocked('invalid_image');}}
    const gateKey=await qqGateKey(c.appId,c.userOpenId);
    const key='qq:out:'+await qqHash(JSON.stringify([c.ownerId,c.appId,c.userOpenId,intent.sourceId,intent.projectId,intent.eventId]));
    const fingerprint=await qqHash(JSON.stringify([intent.content,imageUrl??null,intent.reply??null]));
    const replySlot=intent.reply?'qq:reply:'+await qqHash(JSON.stringify([c.appId,c.userOpenId,intent.reply.messageId,intent.reply.sequence])):undefined;
    let reserved:'new'|QQReceipt;try{reserved=await this.ledger.reserve(key,fingerprint,replySlot,gateKey);}catch{return blocked('ledger_unavailable');}if(reserved!=='new')return reserved;
    let receipt:QQReceipt={state:'not_sent',reason:'preflight_failed'};
    let sending=false;
    try{
      await this.accessToken();
      const payload:Record<string,unknown>={msg_type:0,content:intent.content};
      if(intent.reply){payload.msg_id=intent.reply.messageId;payload.msg_seq=intent.reply.sequence;}
      const path='/v2/users/'+encodeURIComponent(c.userOpenId);
      if(imageUrl){const upload=await this.post(path+'/files',{file_type:1,url:imageUrl,srv_send_msg:false});
        const d=await json(upload);if(!upload.ok||d?.code!==undefined&&d.code!==0||!text(d?.file_info,65536)||!Number.isFinite(d.ttl)||d.ttl<0)throw Error('qq_upload_failed');
        payload.msg_type=7;payload.media={file_info:d.file_info};
      }
      // Capability expiry/revocation during upload cannot open a stale send window.
      const latest=c.evidence();if(!latest||!Number.isFinite(latest.checkedAt)||!Number.isFinite(latest.validUntil)||latest.checkedAt>this.now()||latest.checkedAt>=latest.validUntil||latest.validUntil<=this.now()||latest.identity!==true||(!intent.reply&&latest.proactive!==true)||(intent.reply&&(latest.reply!==true||intent.reply.validUntil<=this.now()))||(imageUrl&&latest.image!==true))throw Error('qq_evidence_changed');
      if(await this.ledger.isRevoked(gateKey))throw Error('qq_permission_revoked');
      sending=true;const r=await this.post(path+'/messages',payload);
      let d:any;try{d=await json(r);}catch{d=null;}
      const code=Number.isSafeInteger(d?.code)?d.code:undefined;
      if(r.ok&&(d?.code===undefined||d.code===0)&&text(d?.id,1024))receipt={state:'sent',reason:'provider_accepted',messageId:d.id};
      else if(r.status===401||r.status===403||r.status===429||knownRejections.has(code??-1))receipt={state:'not_sent',reason:qqRejectionReason(r.status,code),...(code!==undefined?{providerCode:code}:{}),...(r.status===429&&/^\d+$/.test(r.headers.get('retry-after')??'')?{retryAfterSeconds:Number(r.headers.get('retry-after'))}:{})};
      else receipt={state:'uncertain',reason:'provider_outcome_unknown',...(code!==undefined?{providerCode:code}:{})};
    }catch{receipt={state:sending?'uncertain':'not_sent',reason:sending?'network_outcome_unknown':'preflight_failed'};}
    try{await this.ledger.finish(key,fingerprint,receipt);}catch{return {state:'uncertain',reason:'receipt_persistence_failed'};}return receipt;
  }
}
// Documented definitive validation/permission/quota failures; dedup and unknown errors stay uncertain.
const knownRejections=new Set([22006,50059,304004,304061,304062,304064,304080,304103,40034005,40034006,40034008,40034009,40034010,40034011,40034024,40034025,40034026,40034027,40034029,40034100,40034105,40034106,40034108,40034109,40034122,40034123,40034124,40034127,40034128,40054004,40054007,40054013,40054016,40054018]);

export async function qqGateKey(appId:string,userOpenId:string){return 'qq:gate:'+await qqHash(JSON.stringify([appId,userOpenId]));}

/** Official C2C errors are distinct actionable outcomes, never a fallback-send trigger. */
export function qqRejectionReason(status:number,code?:number):string {
 if(status===429||code===40034100)return 'rate_limited';
 return ({40034105:'proactive_permission_denied',40054004:'friendship_missing',40054013:'recipient_refused',40054016:'bot_offline'} as Record<number,string>)[code??-1]??'provider_rejected';
}
