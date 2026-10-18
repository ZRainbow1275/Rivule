/** Default-off host wiring. Public surface accepts signed inbound QQ only, never send intents. */
import {projection,validateEvent} from './contracts.ts';
import type {Event,Source} from './contracts.ts';
import {QQC2CTransport,QQDurableLedger,qqReadBytes} from './qq-transport.ts';
import type {QQConfig,QQEvidence,QQReceipt,QQStorage} from './qq-transport.ts';
import {handleQQWebhook,QQDurableInbox} from './qq-webhook.ts';
export type QQEnvironment=Record<string,unknown>;
const response=(error:string,status:number)=>new Response(JSON.stringify({error}),{status,headers:{'content-type':'application/json'}});
function flag(v:unknown):boolean{if(v===undefined||v===''||v==='false')return false;if(v==='true')return true;throw Error('qq_flag_invalid');}
function required(env:QQEnvironment,name:string,pattern:RegExp){const v=env[name];if(typeof v!=='string'||!pattern.test(v))throw Error('qq_config_invalid');return v;}
function list(env:QQEnvironment,name:string):string[]{const v=env[name];if(v===undefined||v==='')return [];if(typeof v!=='string')throw Error('qq_config_invalid');const a=JSON.parse(v);if(!Array.isArray(a)||a.length>100||a.some(x=>typeof x!=='string'||!x||x.length>256)||new Set(a).size!==a.length)throw Error('qq_config_invalid');return a;}
const unknownEvidence=():QQEvidence=>({checkedAt:0,validUntil:0,identity:false,proactive:false,reply:false,image:false});
/** null means wholly disabled and does not inspect any credentials. No source payload reaches this loader. */
export function loadQQConfig(env:QQEnvironment,ownerId:string):QQConfig|null{
  if(!flag(env.QQ_ENABLED))return null;
  const configuredOwner=required(env,'QQ_OWNER_ID',/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/);
  if(configuredOwner!==ownerId)throw Error('qq_owner_mismatch');
  const appId=required(env,'QQ_APP_ID',/^\d{1,32}$/),userOpenId=required(env,'QQ_USER_OPENID',/^[A-Za-z0-9_-]{1,256}$/);
  const allowedImageOrigins=list(env,'QQ_ALLOWED_IMAGE_ORIGINS');
  for(const origin of allowedImageOrigins){const u=new URL(origin);if(u.protocol!=='https:'||u.origin!==origin||u.username||u.password)throw Error('qq_image_origin_invalid');}
  return {enabled:flag(env.QQ_DELIVERY_ENABLED),ownerId:configuredOwner,appId,userOpenId,
    allowedSources:list(env,'QQ_ALLOWED_SOURCE_IDS'),allowedProjects:list(env,'QQ_ALLOWED_PROJECT_IDS'),allowedImageOrigins,
    appSecret:()=>required(env,'QQ_APP_SECRET',/^[^\r\n\0]{1,1024}$/),
    evidence:()=>{const raw=env.QQ_CAPABILITIES_JSON;if(raw===undefined||raw==='')return unknownEvidence();if(typeof raw!=='string')return unknownEvidence();
      try{const e=JSON.parse(raw);if(!e||Object.keys(e).some(k=>!['checkedAt','validUntil','identity','proactive','reply','image'].includes(k)))return unknownEvidence();
        return {checkedAt:e.checkedAt,validUntil:e.validUntil,identity:e.identity===true,proactive:e.proactive===true,reply:e.reply===true,image:e.image===true};}catch{return unknownEvidence();}}
  };
}
export type QQOwnerStub={fetch:(request:Request)=>Promise<Response>};
/** Public gateway calls this only for /qq/webhook; target owner comes from server bindings. */
export async function routeQQWebhook(request:Request,env:QQEnvironment,ownerId:string,getOwner:(name:string)=>QQOwnerStub):Promise<Response>{
  const url=new URL(request.url),origin=request.headers.get('origin');
  if(url.pathname!=='/qq/webhook')return response('not_found',404);
  if(url.search||url.hash||typeof env.PUBLIC_ORIGIN!=='string'||url.origin!==env.PUBLIC_ORIGIN||(origin!==null&&origin!==env.PUBLIC_ORIGIN))return response('invalid_origin',403);
  if(request.method!=='POST')return response('method_not_allowed',405);
  let c:QQConfig|null;try{c=loadQQConfig(env,ownerId);}catch{return response('qq_config_unavailable',503);}if(!c)return response('qq_disabled',503);
  // Cheap app check does not replace signature verification in the durable owner.
  if(request.headers.get('X-Bot-Appid')!==c.appId)return response('wrong_app',401);
  let raw:Uint8Array<ArrayBuffer>;try{raw=await qqReadBytes(request.body,262144);}catch{return response('invalid_body',400);}
  const headers=new Headers();for(const name of ['X-Bot-Appid','X-Signature-Timestamp','X-Signature-Ed25519','content-type']){const v=request.headers.get(name);if(v!==null)headers.set(name,v);}
  try{return await getOwner('owner:'+ownerId).fetch(new Request('https://owner.internal/qq/webhook',{method:'POST',headers,body:raw}));}catch{return response('qq_owner_unavailable',503);}
}
/** Durable Object's own boundary rechecks config, AppID, signature, freshness and raw body. */
export async function handleQQOwnerWebhook(request:Request,env:QQEnvironment,ownerId:string,storage:QQStorage,now=Date.now()):Promise<Response>{
  const url=new URL(request.url);if(url.origin!=='https://owner.internal'||url.pathname!=='/qq/webhook'||url.search||url.hash||(request.headers.has('origin')&&request.headers.get('origin')!==env.PUBLIC_ORIGIN))return response('internal_route_required',403);
  let c:QQConfig|null;try{c=loadQQConfig(env,ownerId);}catch{return response('qq_config_unavailable',503);}if(!c)return response('qq_disabled',503);
  return handleQQWebhook(request,{enabled:true,appId:c.appId,userOpenId:c.userOpenId,appSecret:c.appSecret},new QQDurableInbox(storage),now);
}
export type QQAcceptedRecord={receiptId:string; decision:string; source:Source; event:Event};
/** Trusted owner-only bridge. Lookup must read the owner's durable accepted event table.
 * There is deliberately no HTTP route or PA tool for this function. It never selects a destination.
 * Calling it is an explicit channel-specific dispatch decision, NOT automatic cross-channel fallback.
 */
export async function sendQQAcceptedReceipt(env:QQEnvironment,ownerId:string,storage:QQStorage,receiptId:string,
  loadAccepted:(receiptId:string)=>Promise<QQAcceptedRecord|null>,transport:typeof fetch=fetch,now:()=>number=Date.now):Promise<QQReceipt>{
  let config:QQConfig|null;try{config=loadQQConfig(env,ownerId);}catch{return {state:'blocked',reason:'qq_config_unavailable'};}
  if(!config||!config.enabled)return {state:'blocked',reason:'disabled'};
  let accepted:QQAcceptedRecord|null;try{accepted=await loadAccepted(receiptId);}catch{return {state:'blocked',reason:'accepted_event_unavailable'};}
  if(!accepted||accepted.receiptId!==receiptId||accepted.decision!=='applied')return {state:'blocked',reason:'accepted_event_required'};
  let e:Event;try{e=projection(validateEvent(accepted.event,accepted.source,now()));}catch{return {state:'blocked',reason:'accepted_event_invalid'};}
  const content=[accepted.source.display_name+' · '+e.project_name,e.task_name+' · '+e.source_status,e.summary,
    e.action?'需要你决定：'+e.action.question+'\n请回原平台处理；QQ消息不代表批准。':null,e.source_url].filter(Boolean).join('\n');
  return new QQC2CTransport(config,new QQDurableLedger(storage),transport,now).send({ownerId,sourceId:e.source_id,projectId:e.project_id,eventId:e.event_id,content});
}

export interface QQQueueStorage extends QQStorage {sql:{exec:(query:string,...args:any[])=>{toArray:()=>Record<string,any>[]}};sync:()=>Promise<void>}
/** Independent QQ outbox. The owner calls enqueue inside its accepted-event SQL transaction.
 * No public send endpoint; no cross-channel fallback; this class does not schedule alarms itself.
 */
export class QQServiceQueue {
  private storage:QQQueueStorage;private env:QQEnvironment;private ownerId:string;private sources:Source[];
  private transport:typeof fetch;private now:()=>number;private busy=false;private client:QQC2CTransport|null=null;
  constructor(storage:QQQueueStorage,env:QQEnvironment,ownerId:string,sources:Source[],transport:typeof fetch=fetch,now:()=>number=Date.now){
    this.storage=storage;this.env=env;this.ownerId=ownerId;this.sources=structuredClone(sources);this.transport=transport;this.now=now;
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS qq_outbox(source_id TEXT NOT NULL,receipt_id TEXT NOT NULL,event_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,created_at REAL NOT NULL,result TEXT,PRIMARY KEY(source_id,receipt_id));CREATE TABLE IF NOT EXISTS qq_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  }
  private rows(query:string,...args:any[]){return this.storage.sql.exec(query,...args).toArray();}
  private config(){return loadQQConfig(this.env,this.ownerId);}
  async initialize(){
    const c=this.config();
    await this.storage.transaction(async()=>{
      if(c){const binding=JSON.stringify([c.ownerId,c.appId,c.userOpenId]),old=this.rows("SELECT value FROM qq_meta WHERE key='binding'")[0];if(old&&old.value!==binding)throw Error('qq_persisted_binding_mismatch');this.rows("INSERT OR IGNORE INTO qq_meta(key,value) VALUES('binding',?)",binding);}
      this.rows("UPDATE qq_outbox SET status='uncertain',result=? WHERE status='sending'",JSON.stringify({state:'uncertain',reason:'restart_during_dispatch'}));
    });
  }
  /** Returns false when QQ was not explicitly selected/configured for this source+project. */
  enqueue(event:Event,receiptId:string):boolean{
    const c=this.config();if(!c?.enabled||!c.allowedSources.includes(event.source_id)||!c.allowedProjects.includes(event.project_id))return false;
    const source=this.sources.find(s=>s.source_id===event.source_id&&s.enabled);if(!source)return false;
    const e=projection(validateEvent(event,source,this.now()));
    if(e.kind==='heartbeat')return false;
    if(typeof receiptId!=='string'||!/^rcpt_[a-f0-9]{32}$/.test(receiptId))throw Error('qq_accepted_receipt_invalid');
    const payload=JSON.stringify(e),prior=this.rows('SELECT payload FROM qq_outbox WHERE source_id=? AND receipt_id=?',e.source_id,receiptId)[0];
    if(prior){if(prior.payload!==payload)throw Error('qq_outbox_conflict');return false;}
    if(this.rows('SELECT COUNT(*) AS n FROM qq_outbox')[0].n>=10000)throw Error('qq_outbox_budget_reached');
    this.rows("INSERT INTO qq_outbox(source_id,receipt_id,event_id,payload,status,created_at) VALUES(?,?,?,?,'queued',?)",e.source_id,receiptId,e.event_id,payload,this.now());return true;
  }
  nextAlarmAt():number|null{
    const c=this.config();if(!c?.enabled)return null;
    const evidence=c.evidence();if(!evidence.identity||!evidence.proactive||!Number.isFinite(evidence.checkedAt)||!Number.isFinite(evidence.validUntil)||evidence.checkedAt>this.now()||evidence.validUntil<=this.now())return null;
    if(this.rows("SELECT 1 FROM qq_outbox WHERE status IN ('sending','uncertain','blocked','not_sent') LIMIT 1").length)return null;
    const first=this.rows("SELECT MIN(created_at) AS at FROM qq_outbox WHERE status='queued'")[0]?.at;if(first==null)return null;
    const pace=Number(this.rows("SELECT value FROM qq_meta WHERE key='next_send_at'")[0]?.value??0);return Math.max(first,pace);
  }
  receipt(source:Source,receiptId:string):QQReceipt|{state:'queued'|'sending';reason:string}|null{
    const configured=this.sources.find(s=>s.source_id===source.source_id&&s.enabled);
    if(!configured||JSON.stringify(configured)!==JSON.stringify(source))throw Error('qq_source_not_authorized');
    const row=this.rows('SELECT status,result FROM qq_outbox WHERE source_id=? AND receipt_id=?',source.source_id,receiptId)[0];
    if(!row)return null;return row.result?JSON.parse(row.result):{state:row.status,reason:row.status==='sending'?'reserved_before_send':'awaiting_dispatch'};
  }
  async drain():Promise<QQReceipt|{state:'idle'|'busy';reason:string}>{
    if(this.busy)return {state:'busy',reason:'already_running'};
    this.busy=true;let job:Record<string,any>|undefined;
    try{
      const due=this.nextAlarmAt();if(due===null||due>this.now())return {state:'idle',reason:'nothing_due'};
      await this.storage.transaction(async()=>{
        if(this.rows("SELECT 1 FROM qq_outbox WHERE status IN ('sending','uncertain','blocked','not_sent') LIMIT 1").length)return;
        job=this.rows("SELECT * FROM qq_outbox WHERE status='queued' ORDER BY created_at,receipt_id LIMIT 1")[0];
        if(job)this.rows("UPDATE qq_outbox SET status='sending' WHERE source_id=? AND receipt_id=? AND status='queued'",job.source_id,job.receipt_id);
      });
      if(!job)return {state:'idle',reason:'nothing_due'};
      await this.storage.sync();
      const c=this.config();const source=this.sources.find(s=>s.source_id===job!.source_id&&s.enabled);let result:QQReceipt;
      if(!c?.enabled||!source)result={state:'blocked',reason:'binding_not_authorized'};
      else{
        const e=projection(validateEvent(JSON.parse(job.payload),source,this.now()));
        const content=[source.display_name+' · '+e.project_name,e.task_name+' · '+e.source_status,e.summary,e.action?'需要你决定：'+e.action.question+'\n请回原平台处理；QQ消息不代表批准。':null,e.source_url].filter(Boolean).join('\n');
        // Cache the token only within this owner instance; never persist credentials in SQL/KV.
        this.client??=new QQC2CTransport(c,new QQDurableLedger(this.storage),this.transport,this.now);
        if(!c.allowedSources.includes(e.source_id)||!c.allowedProjects.includes(e.project_id))result={state:'blocked',reason:'binding_not_authorized'};
        else result=await this.client.send({ownerId:this.ownerId,sourceId:e.source_id,projectId:e.project_id,eventId:e.event_id,content});
      }
      await this.storage.transaction(async()=>{
        this.rows('UPDATE qq_outbox SET status=?,result=? WHERE source_id=? AND receipt_id=?',result.state,JSON.stringify(result),job!.source_id,job!.receipt_id);
        // Conservative one-message-per-3.1-seconds pacing, independent of upstream event rate.
        this.rows("INSERT INTO qq_meta(key,value) VALUES('next_send_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(this.now()+3100));
      });
      await this.storage.sync();return result;
    }catch{
      if(job){try{this.rows("UPDATE qq_outbox SET status='uncertain',result=? WHERE source_id=? AND receipt_id=?",JSON.stringify({state:'uncertain',reason:'queue_outcome_unknown'}),job.source_id,job.receipt_id);await this.storage.sync();}catch{}}
      return {state:'uncertain',reason:'queue_outcome_unknown'};
    }finally{this.busy=false;}
  }
}
