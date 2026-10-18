/** Persistent, single-owner outbox core. Uses DO SQL APIs, not MCP session state. */
import {Rejected,canonical,digest,branchKey,projection,terminal,validateEvent} from './contracts.ts';
import {notificationMode} from './notification-policy.ts';
import type {NotificationMode} from './notification-policy.ts';
import type {Event,Source} from './contracts.ts';
import type {Bindings} from './auth.ts';
import {validateAllowedProjectIds} from './auth.ts';
import {recordSourceVerification,verificationBindingDigest} from './source-verification.ts';
import type {VerificationBinding,VerificationKind,VerificationStatus} from './source-verification.ts';
import {sourceVerificationPresentation} from './source-verification.ts';
import {nativeStatus} from './status-style.ts';
import {DiagnosticStore} from './diagnostic-store.ts';
export type SQL={exec:(query:string,...args:any[])=>{toArray:()=>Record<string,any>[]}};
export type Storage={sql:SQL;transaction:<T>(callback:()=>Promise<T>)=>Promise<T>;setAlarm:(at:number)=>Promise<void>;getAlarm?:()=>Promise<number|null>|number|null;deleteAlarm:()=>Promise<void>;sync:()=>Promise<void>};
export type ReceiptResponse={status:number;body?:any;retryAfter?:number;notSent?:boolean;reason?:string};
export type Dispatch={ownerId:string;appId:string;dmId:string;messageId:string|null;viewKey:string;nonce:string;payload:any};
export type Sender=(dispatch:Dispatch)=>Promise<ReceiptResponse>;
/** Optional, host-owned channel hooks. onAccepted runs inside the event SQL
 * transaction; it must only enqueue durable work, never perform network I/O. */
export type OwnerChannelHooks={
 qqSetupEnabled?:boolean;
 onAccepted?:(event:Event,receiptId:string)=>void;
 nextAlarmAt?:()=>number|null;
 receipt?:(source:Source,receiptId:string)=>unknown;
};
const schema=`
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(revision INTEGER PRIMARY KEY AUTOINCREMENT,source_id TEXT NOT NULL,event_id TEXT NOT NULL,receipt TEXT UNIQUE NOT NULL,branch_key TEXT NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL,decision TEXT NOT NULL,received_at REAL NOT NULL,UNIQUE(source_id,event_id));
CREATE TABLE IF NOT EXISTS branches(branch_key TEXT PRIMARY KEY,source_id TEXT NOT NULL,project_id TEXT NOT NULL,payload TEXT NOT NULL,seq INTEGER,state_version INTEGER NOT NULL,revision INTEGER NOT NULL,last_confirmed REAL NOT NULL,archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS requests(request_key TEXT PRIMARY KEY,branch_key TEXT NOT NULL,request_id TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS milestones(node_key TEXT PRIMARY KEY,branch_key TEXT NOT NULL,phase_id TEXT NOT NULL,label TEXT NOT NULL,event_id TEXT NOT NULL,occurred_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS source_verification(source_id TEXT PRIMARY KEY,binding_digest TEXT NOT NULL,revocation INTEGER NOT NULL,kind TEXT NOT NULL,verified_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS source_verification_revocations(source_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS source_health(source_id TEXT PRIMARY KEY,last_seen REAL NOT NULL);
CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,receipt TEXT NOT NULL,view_key TEXT NOT NULL,intent TEXT NOT NULL,payload TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,next_at REAL NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,message_id TEXT,last_error TEXT,UNIQUE(receipt,view_key));
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status,next_at,id);
CREATE TABLE IF NOT EXISTS controls(ref TEXT PRIMARY KEY,view_key TEXT NOT NULL,revision INTEGER NOT NULL,action TEXT NOT NULL,payload TEXT NOT NULL,expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS overview_refresh(singleton INTEGER PRIMARY KEY CHECK(singleton=1),ref TEXT NOT NULL,origin_interaction TEXT NOT NULL,message_id TEXT NOT NULL,revision INTEGER NOT NULL,generation TEXT NOT NULL,expires REAL NOT NULL,consumed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS interactions(interaction_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS maps(view_key TEXT PRIMARY KEY,message_id TEXT NOT NULL,last_revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,at REAL NOT NULL,kind TEXT NOT NULL,job_id INTEGER,detail TEXT NOT NULL);
`;
const numericId=(v:any)=>typeof v==='string'&&/^[0-9]{1,25}$/.test(v)&&v!=='0';
export class OwnerCore {
 storage:Storage;b:Bindings;clock:()=>number;sender:Sender|null;enabled:boolean;synthetic:boolean;busy=false;readonly allowedProjectIds:ReadonlySet<string>;diagnostics:DiagnosticStore;channels:OwnerChannelHooks;
 verificationRefresh=0;verificationBindings=new Map<string,VerificationBinding>();verificationDigests=new Map<string,string>();verificationResolver?:((source:Source)=>Promise<VerificationBinding>);
 constructor(storage:Storage,b:Bindings,options:{clock?:()=>number;sender?:Sender;enabled?:boolean;synthetic?:boolean;channels?:OwnerChannelHooks;verificationBinding?:(source:Source)=>Promise<VerificationBinding>}={}){
  this.storage=storage;this.b=b;this.clock=options.clock??Date.now;this.sender=options.sender??null;this.enabled=options.enabled??false;this.synthetic=options.synthetic??true;
  this.allowedProjectIds=new Set(validateAllowedProjectIds(b.allowedProjectIds));
  this.channels=options.channels??{};this.verificationResolver=options.verificationBinding;
  if(this.enabled&&!this.sender)throw new Rejected('sender_not_configured',503);
  storage.sql.exec(schema);
  this.diagnostics=new DiagnosticStore(storage.sql,new Set(b.sources.map(s=>s.source_id)));
 }
 rows(q:string,...args:any[]){return this.storage.sql.exec(q,...args).toArray();}
 one(q:string,...args:any[]){return this.rows(q,...args)[0]??null;}
 log(kind:string,job:number|null,detail:string){this.rows('INSERT INTO audit(at,kind,job_id,detail) VALUES(?,?,?,?)',this.clock(),kind,job,detail);}
 projectAllowed(project:any){return typeof project==='string'&&this.allowedProjectIds.has(project);}
 canNotify(event:any){return this.projectAllowed(event.project_id)&&this.b.sources.some(s=>s.source_id===event.source_id&&s.enabled);}
 suppressDisallowedJobs(){
  // Only definitely unsent work can be suppressed. Unknown sends keep their
  // owner-global fence, even when the associated project is no longer allowed.
  for(const job of this.rows("SELECT id,payload,view_key,intent FROM outbox WHERE status IN ('queued','retry_wait')")){
   const request=job.intent==='request'?this.one('SELECT payload FROM requests WHERE request_key=?',job.view_key.slice('request:'.length)):null;
   if(!this.projectAllowed(JSON.parse(job.payload).project_id)||request&&!this.projectAllowed(JSON.parse(request.payload).project_id)){
    this.rows("UPDATE outbox SET status='suppressed',last_error='project_not_authorized' WHERE id=?",job.id);this.log('suppressed',job.id,'project_not_authorized');
   }
  }
 }
 async refreshVerificationBindings(){
  const generation=++this.verificationRefresh;
  for(const source of this.b.sources){
   try{const binding=this.verificationResolver?await this.verificationResolver(source):this.synthetic?{owner_id:this.b.ownerId,source_id:source.source_id,enabled:source.enabled,config_revision:await digest(canonical([this.b,source])),auth_revision:'synthetic',revocation_revision:'0'}:null;
   if(binding){const fingerprint=await verificationBindingDigest(binding);if(generation===this.verificationRefresh){this.verificationBindings.set(source.source_id,binding);this.verificationDigests.set(source.source_id,fingerprint);}}}catch{if(generation===this.verificationRefresh){this.verificationBindings.delete(source.source_id);this.verificationDigests.delete(source.source_id);}}
  }
 }
 async initialize(options:{readOnly?:boolean}={}){
  await this.refreshVerificationBindings();
  await this.storage.transaction(async()=>{
   const fingerprint=canonical([this.b.ownerId,this.b.appId,this.b.userId,this.b.dmId]);
   const old=this.one("SELECT value FROM meta WHERE key='identity'");
   if(old&&old.value!==fingerprint)throw new Rejected('persisted_destination_mismatch',503);
   this.rows("INSERT OR IGNORE INTO meta VALUES('identity',?)",fingerprint);
   if(!options.readOnly){this.quarantineSending('restart_during_dispatch');await this.schedule();}
  });
 }
 verificationStatus(source:Source):VerificationStatus{
  if(!source.enabled)return 'disabled';
  const proof=this.one('SELECT * FROM source_verification WHERE source_id=?',source.source_id);
  if(!proof)return 'unverified';
  const revision=this.one('SELECT revision FROM source_verification_revocations WHERE source_id=?',source.source_id)?.revision??0;
  return proof.binding_digest===this.verificationDigests.get(source.source_id)&&proof.revocation===revision&&['accepted_event','mcp_initialize','mcp_tools_list','mcp_read','muse_own_receipt'].includes(proof.kind)&&Number.isSafeInteger(proof.verified_at)&&proof.verified_at>=0&&proof.verified_at<=this.clock()?'verified':'needs_reverification';
 }
 verifiedSources(){return this.b.sources.filter(s=>this.verificationStatus(s)==='verified');}
 verificationContext(source:Source){const fingerprint=this.verificationDigests.get(source.source_id);if(!fingerprint)return null;return fingerprint+':'+(this.one('SELECT revision FROM source_verification_revocations WHERE source_id=?',source.source_id)?.revision??0);}
 async storeVerification(source:Source,kind:VerificationKind,expected=this.verificationContext(source)){
  const registered=this.b.sources.find(s=>s.source_id===source.source_id);
  if(!registered||canonical(registered)!==canonical(source)||!source.enabled)throw new Rejected('source_not_authorized',403);
  const binding=this.verificationBindings.get(source.source_id);if(!binding)throw new Rejected('verification_unavailable',503);
  const proof=await recordSourceVerification(binding,kind,this.clock());
  if(!expected||expected!==this.verificationContext(source)||proof.binding_digest!==expected.split(':')[0])throw new Rejected('verification_changed',409);
  const revision=this.one('SELECT revision FROM source_verification_revocations WHERE source_id=?',source.source_id)?.revision??0;
  this.rows('INSERT INTO source_verification VALUES(?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET binding_digest=excluded.binding_digest,revocation=excluded.revocation,kind=excluded.kind,verified_at=excluded.verified_at',source.source_id,proof.binding_digest,revision,proof.kind,proof.verified_at);
 }
 async verifySource(source:Source,kind:VerificationKind,expected=this.verificationContext(source)){
  // Host-only authenticated success hook. No scheduling, health, controls or outbox writes.
  await this.storage.transaction(async()=>{await this.storeVerification(source,kind,expected);});return {stored:true};
 }
 async revokeVerification(source:Source){
  // Private host hook for credential/grant revocation; never a user-selectable public RPC.
  if(!this.b.sources.some(s=>s.source_id===source.source_id))throw new Rejected('source_not_authorized',403);
  await this.storage.transaction(async()=>{this.rows('INSERT INTO source_verification_revocations VALUES(?,1) ON CONFLICT(source_id) DO UPDATE SET revision=revision+1',source.source_id);});
 }
 quarantineSending(reason:string){
  for(const job of this.rows("SELECT id FROM outbox WHERE status='sending'")){
   this.rows("UPDATE outbox SET status='uncertain',last_error=? WHERE id=?",reason,job.id);this.log('uncertain',job.id,reason);
  }
 }
 pendingExpiries():any[]{return this.rows("SELECT * FROM requests WHERE state='pending'").filter(r=>this.canNotify(JSON.parse(r.payload))).map(r=>({...r,expires:Date.parse(JSON.parse(r.payload).action?.expires_at??'')})).filter(r=>Number.isFinite(r.expires));}
 expireRequests(){
  for(const r of this.pendingExpiries().filter(r=>r.expires<=this.clock())){
   this.rows("UPDATE requests SET state='expired' WHERE request_key=? AND state='pending' AND version=?",r.request_key,r.version);
   const payload=JSON.parse(r.payload),revision=this.one('SELECT revision FROM branches WHERE branch_key=?',r.branch_key)?.revision??0;
   const receipt='expiry:'+r.request_key+':'+r.version;
   this.enqueue(receipt,'request:'+r.request_key,'request',payload,revision);
   this.enqueue(receipt,'overview','overview',payload,revision);this.log('request_expired',null,canonical({request_key:r.request_key,version:r.version}));
  }
 }
 freshness(){return this.rows('SELECT branch_key,source_id,payload,revision,last_confirmed FROM branches').filter(r=>this.canNotify(JSON.parse(r.payload))&&!terminal.has(JSON.parse(r.payload).source_status)).filter(r=>this.one('SELECT value FROM meta WHERE key=?','stale:'+r.branch_key)?.value!==String(r.last_confirmed));}
 expireFreshness(){for(const r of this.freshness().filter(r=>r.last_confirmed+1800000<=this.clock())){this.rows('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value','stale:'+r.branch_key,String(r.last_confirmed));this.enqueue('stale:'+r.revision+':'+r.branch_key,'overview','overview',JSON.parse(r.payload),r.revision);this.log('freshness_expired',null,r.branch_key);}}
 async schedule(){
  this.diagnostics.prune(this.clock());
  this.suppressDisallowedJobs();
  const quarantine=this.one("SELECT id FROM outbox WHERE status IN ('uncertain','sending','blocked') LIMIT 1");
  const next=this.one("SELECT MIN(next_at) AS next_at FROM outbox WHERE status IN ('queued','retry_wait')");
  const expiry=Math.min(...this.pendingExpiries().map(r=>r.expires));
  const rateUntil=Number(this.one("SELECT value FROM meta WHERE key='rate_until'")?.value??0);
  const dispatchAt=!this.enabled||quarantine||next?.next_at==null?Infinity:Math.max(next.next_at,rateUntil);
  const freshnessAt=this.enabled&&!quarantine?Math.min(...this.freshness().map(r=>r.last_confirmed+1800000)):Infinity;
  const extra=this.channels.nextAlarmAt?.();
  const workAt=Math.min(expiry,dispatchAt,freshnessAt,typeof extra==='number'&&Number.isFinite(extra)?extra:Infinity);
  if(Number.isFinite(workAt))this.rows("DELETE FROM meta WHERE key='retention_alarm_only'");else this.rows("INSERT INTO meta VALUES('retention_alarm_only','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  const at=Math.min(this.diagnostics.nextExpiry(),expiry,dispatchAt,freshnessAt,typeof extra==='number'&&Number.isFinite(extra)?extra:Infinity);
  if(!Number.isFinite(at)){this.rows("DELETE FROM meta WHERE key='retention_alarm_only'");await this.storage.deleteAlarm();return;}
  await this.storage.setAlarm(Math.max(this.clock()+1,at));
 }
 enqueue(receipt:string,view:string,intent:string,payload:Event,revision:number){
  if(!this.projectAllowed(payload.project_id))throw new Rejected('project_not_authorized',403);
  // Coalesce only unsent overview updates. Critical reminders remain distinct.
  if(view==='overview'||view.startsWith('request:'))this.rows("UPDATE outbox SET status='coalesced' WHERE view_key=? AND status IN ('queued','retry_wait')",view);
  this.rows("INSERT OR IGNORE INTO outbox(receipt,view_key,intent,payload,revision,status,next_at) VALUES(?,?,?,?,?,'queued',?)",receipt,view,intent,canonical(payload),revision,this.clock());
 }
 async ingest(source:Source,raw:any,requestedMode:NotificationMode='standard',expectedVerification=this.verificationContext(source)){
  const mode=notificationMode(requestedMode);
  const registered=this.b.sources.find(s=>s.source_id===source.source_id);
  if(!registered||canonical(registered)!==canonical(source)||!source.enabled)throw new Rejected('source_not_authorized',403);
  const event=validateEvent(raw,source,this.clock());
  // Shared HMAC and MCP boundary: reject before any event, health or queue write.
  if(!this.projectAllowed(event.project_id))throw new Rejected('project_not_authorized',403);
  // Keep legacy standard-event hashes byte-for-byte compatible. A mode change
  // is an idempotency conflict, never a reason to send the same event again.
  const hash=await digest(canonical(mode==='standard'?event:{event,notification_mode:mode}));
  const receipt='rcpt_'+(await digest(canonical([this.b.ownerId,event.source_id,event.event_id]))).slice(0,32);
  const key=branchKey(event),payload=projection(event),now=this.clock();
  return this.storage.transaction(async()=>{
   const prior=this.one('SELECT * FROM events WHERE source_id=? AND event_id=?',source.source_id,event.event_id);
   if(prior){if(prior.hash!==hash)throw new Rejected('event_id_conflict',409);if(expectedVerification&&this.verificationBindings.has(source.source_id))await this.storeVerification(source,'accepted_event',expectedVerification);await this.schedule();return this.eventReceipt(prior,true);}
   if(this.one('SELECT COUNT(*) AS n FROM events').n>=10000)throw new Rejected('event_storage_budget_reached',429);
   const old=this.one('SELECT * FROM branches WHERE branch_key=?',key);
   if(!old&&event.kind!=='heartbeat'&&this.one('SELECT COUNT(*) AS n FROM branches').n>=250)throw new Rejected('branch_budget_reached',429);const oldPayload=old?JSON.parse(old.payload):null;
   if(old&&old.project_id!==event.project_id)throw new Rejected('project_changed',409);
   let decision='applied';
   if(event.kind==='heartbeat')decision='heartbeat_only';
   else if(old){
    if(event.source_seq===null)decision='unsequenced_needs_review';
    else if(old.seq!==null&&event.source_seq<=old.seq)decision='stale_ignored';
    else if(terminal.has(oldPayload.source_status)&&event.kind!=='correction')decision='terminal_guard';
   }
   if(mode==='overview_only'&&(event.action||decision!=='applied'||this.one("SELECT request_key FROM requests WHERE branch_key=? AND state='pending'",key)))throw new Rejected('overview_only_requires_unambiguous_nonapproval_update',409);
   if(event.kind==='correction'){
    const corrected=this.one('SELECT branch_key FROM events WHERE source_id=? AND event_id=?',source.source_id,event.correction_of);
    if(!corrected||corrected.branch_key!==key||event.source_seq===null)throw new Rejected('invalid_correction_target',409);
   }
   this.rows('INSERT INTO events(source_id,event_id,receipt,branch_key,hash,payload,decision,received_at) VALUES(?,?,?,?,?,?,?,?)',source.source_id,event.event_id,receipt,key,hash,canonical(payload),decision,now);
   const row=this.one('SELECT * FROM events WHERE receipt=?',receipt),revision=row.revision;
   if(expectedVerification&&this.verificationBindings.has(source.source_id))await this.storeVerification(source,'accepted_event',expectedVerification);
   this.rows('INSERT INTO source_health VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET last_seen=excluded.last_seen',source.source_id,now);
   if(decision==='applied'){
    const version=(old?.state_version??0)+1;
    this.rows('INSERT INTO branches(branch_key,source_id,project_id,payload,seq,state_version,revision,last_confirmed) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(branch_key) DO UPDATE SET payload=excluded.payload,seq=excluded.seq,state_version=excluded.state_version,revision=excluded.revision,last_confirmed=excluded.last_confirmed',key,source.source_id,event.project_id,canonical(payload),event.source_seq,version,revision,Date.parse(event.occurred_at));
    if(event.phase_id){const node=canonical([key,event.phase_id]);this.rows('INSERT INTO milestones VALUES(?,?,?,?,?,?) ON CONFLICT(node_key) DO UPDATE SET label=excluded.label,event_id=excluded.event_id,occurred_at=excluded.occurred_at',node,key,event.phase_id,payload.phase_label,event.event_id,event.occurred_at);}
    for(const previous of this.rows("SELECT * FROM requests WHERE branch_key=? AND state='pending'",key)){
     if(!event.action||previous.request_id!==event.action.request_id){
      const state=terminal.has(event.source_status)||event.source_status==='running'?'resolved_by_source':'changed';
      this.rows('UPDATE requests SET state=?,version=? WHERE request_key=?',state,version,previous.request_key);
      this.enqueue(receipt,'request:'+previous.request_key,'request',payload,revision);
     }
    }
    if(event.action){
     const requestKey=canonical([key,event.action.request_id]);const previous=this.one('SELECT state FROM requests WHERE request_key=?',requestKey);
     if(previous&&previous.state!=='pending')throw new Rejected('closed_request_reused',409);
     this.rows("INSERT INTO requests VALUES(?,?,?,?,'pending',?) ON CONFLICT(request_key) DO UPDATE SET payload=excluded.payload,version=excluded.version",requestKey,key,event.action.request_id,canonical(payload),version);
     this.enqueue(receipt,'request:'+requestKey,'request',payload,revision);
    }else if(mode==='standard'&&terminal.has(event.kind))this.enqueue(receipt,'event:'+receipt,'terminal',payload,revision);
    this.enqueue(receipt,'overview','overview',payload,revision);
    this.channels.onAccepted?.(payload,receipt);
   }else if(decision==='unsequenced_needs_review'||decision==='terminal_guard'&&event.kind==='needs_input')this.enqueue(receipt,'review:'+receipt,'review',payload,revision);
   this.log('event_accepted',null,canonical({source_id:source.source_id,event_id:event.event_id,decision,notification_mode:mode}));
   // Durable queue + wake-up are one storage transaction; no network in transaction.
   this.expireRequests();this.expireFreshness();await this.schedule();return this.eventReceipt(row,false);
  });
 }
 eventReceipt(row:any,duplicate=false){return {receipt_id:row.receipt,duplicate,projection_action:row.decision,revision:row.revision,delivery:'queued_or_not_required'};}
 receipt(source:Source,id:string){
  const current=this.b.sources.find(s=>s.source_id===source.source_id);
  if(!current?.enabled||canonical(current)!==canonical(source))throw new Rejected('source_not_authorized',403);
  const row=this.one('SELECT * FROM events WHERE receipt=? AND source_id=?',id,source.source_id);
  if(!row)throw new Rejected('receipt_not_found',404);
  const deliveries=this.rows('SELECT status,intent,attempts,last_error FROM outbox WHERE receipt=?',id),states=new Set(deliveries.map(d=>d.status));
  const delivery=states.size===0?'not_required':states.has('uncertain')?'uncertain':states.has('blocked')||states.has('dead_letter')||states.has('suppressed')?'blocked_or_partial':[...states].every(s=>s==='sent')?'sent':[...states].every(s=>s==='sent'||s==='coalesced')?'coalesced_not_individually_confirmed':'pending_or_partial';
  const channels=this.channels.receipt?.(source,id);
  return {...this.eventReceipt(row),delivery,deliveries,...(channels===undefined||channels===null?{}:{channels})};
 }
 snapshot(){
  return {owner_id:this.b.ownerId,mode:this.synthetic?'local_synthetic':'configured_relay',real_pa_connections:'not_claimed',delivery_enabled:this.enabled,
   branches:this.rows('SELECT * FROM branches ORDER BY branch_key').map(r=>({...JSON.parse(r.payload),branch_key:r.branch_key,state_version:r.state_version,revision:r.revision,last_confirmed_at:new Date(r.last_confirmed).toISOString(),archived:!!r.archived,stale:this.clock()-r.last_confirmed>1800000,nodes:this.rows('SELECT phase_id,label,event_id,occurred_at FROM milestones WHERE branch_key=? ORDER BY occurred_at DESC LIMIT 3',r.branch_key).reverse()})),
   sources:this.b.sources.map(s=>({...s,secret_name:undefined,last_seen:this.one('SELECT last_seen FROM source_health WHERE source_id=?',s.source_id)?.last_seen??null,connection_status:'not_claimed',verification_status:this.verificationStatus(s),...sourceVerificationPresentation(this.verificationStatus(s),this.rows('SELECT branch_key FROM branches WHERE source_id=?',s.source_id).length>0)})),
   requests:this.rows('SELECT request_key,branch_key,state,version FROM requests ORDER BY request_key'),
   outbox:this.rows('SELECT id,view_key,status,attempts,message_id,last_error FROM outbox ORDER BY id'),
   mappings:this.rows('SELECT * FROM maps ORDER BY view_key')};
 }
 selection(){
  const row=this.one("SELECT value FROM meta WHERE key='selection'"),selection=row?JSON.parse(row.value):{source_id:null,branch_key:null,page:0};
  if(selection.source_id&&!this.b.sources.some(s=>s.source_id===selection.source_id&&this.verificationStatus(s)==='verified')){selection.source_id=null;selection.branch_key=null;selection.selected_node_id=null;selection.page=0;}
  if(selection.branch_key){const branch=this.one('SELECT payload,archived FROM branches WHERE branch_key=?',selection.branch_key);if(!branch||branch.archived||!this.canNotify(JSON.parse(branch.payload))||selection.source_id&&JSON.parse(branch.payload).source_id!==selection.source_id){selection.branch_key=null;selection.selected_node_id=null;}}
  return selection;
 }
 control(view:string,revision:number,action:string,payload:any){
  const ref='view:'+crypto.randomUUID();this.rows('INSERT INTO controls VALUES(?,?,?,?,?,?)',ref,view,revision,action,canonical(payload),this.clock()+1800000);return ref;
 }
 controls(revision:number){
  this.rows('DELETE FROM controls WHERE expires<?',this.clock()-3600000);
  const selection=this.selection(),snapshot=this.snapshot();const order:Record<string,number>={dot:0,spark:1,muse:2};const compare=(a:any,b:any)=>a<b?-1:a>b?1:0;
  const branches=snapshot.branches.filter((r:any)=>!r.archived&&this.canNotify(r)&&(!selection.source_id||r.source_id===selection.source_id)).sort((a:any,b:any)=>(order[this.b.sources.find(s=>s.source_id===a.source_id)!.provider]??9)-(order[this.b.sources.find(s=>s.source_id===b.source_id)!.provider]??9)||compare(a.source_id,b.source_id)||compare(a.project_id,b.project_id)||compare(a.task_id,b.task_id)||compare(a.run_id,b.run_id)||compare(a.branch_id,b.branch_id));
  const pages=Math.max(1,Math.ceil(branches.length/3)),page=Math.min(selection.page,pages-1);
  const sources=[{label:'全部来源',value:'all',source_id:null},...this.verifiedSources().map(s=>({label:s.display_name,description:'已验证 · '+branches.filter((r:any)=>r.source_id===s.source_id).length+' 条路线',default:selection.source_id===s.source_id,value:s.source_id,source_id:s.source_id}))];
  const routes=[{label:'全部路线',value:'all',branch_key:null},...branches.slice(page*3,page*3+3).map((r:any,i:number)=>({label:[...r.task_name+' · '+r.branch_name].slice(0,90).join(''),description:nativeStatus(r).symbol+' '+nativeStatus(r).label,default:selection.branch_key===r.branch_key,value:'route'+i,branch_key:r.branch_key}))];
  const select=(items:any[],action:string,placeholder:string)=>({type:1,components:[{type:3,custom_id:this.control('overview',revision,action,items),placeholder,min_values:1,max_values:1,options:items.map(({label,value,description,default:selected})=>({label,value,...(description?{description}:{}),...(selected?{default:true}:{})}))}]});
  const result:any[]=[select(sources,'source','来源 · 已验证'),select(routes,'route','任务 · 查看详情'),{type:1,components:[{type:2,style:2,label:'上一组',custom_id:this.control('overview',revision,'page',Math.max(0,page-1)),disabled:page===0},{type:2,style:2,label:'下一组',custom_id:this.control('overview',revision,'page',Math.min(pages-1,page+1)),disabled:page===pages-1}]}];
  if(this.channels.qqSetupEnabled)result[2].components.push({type:2,style:2,label:'QQ 设置',custom_id:'qqsetup:open'});
  const focused=branches.find((r:any)=>r.branch_key===selection.branch_key);
  if(focused?.nodes?.length)result.push(select(focused.nodes.map((n:any,i:number)=>({label:[...n.label].slice(0,45).join(''),value:'node'+i,node_id:n.phase_id,branch_key:focused.branch_key})),'node','选择阶段节点'));
  return result;
 }
 // These helpers are reachable only through the signed interaction boundary.
 // Recheck the owner binding here so a refresh cannot use an internal shortcut.
 refreshOwner(interaction:any){
  const install=interaction.authorizing_integration_owners;
  return interaction.application_id===this.b.appId&&interaction.type===3&&interaction.user?.id===this.b.userId&&interaction.user?.bot!==true&&interaction.context===1&&interaction.channel_id===this.b.dmId&&!interaction.guild_id&&interaction.message?.author?.id===this.b.appId&&(!interaction.message.channel_id||interaction.message.channel_id===this.b.dmId)&&install&&(install['0']==='0'||install['1']===this.b.userId)&&Object.keys(install).every(k=>['0','1'].includes(k));
 }
 refreshGeneration(){return this.one("SELECT value FROM meta WHERE key='overview_generation'")?.value??'legacy';}
 offerOverviewRefresh(interaction:any){
  const map=this.one("SELECT * FROM maps WHERE view_key='overview'");
  if(!this.refreshOwner(interaction)||!map||map.message_id!==interaction.message?.id||!/^view:[a-f0-9-]{36}$/.test(interaction.data?.custom_id??''))throw new Rejected('view_expired',409);
  if(!this.enabled||this.one("SELECT id FROM outbox WHERE status IN ('sending','uncertain','blocked') LIMIT 1"))throw new Rejected('view_expired',409);
  const generation=this.refreshGeneration(),old=this.one('SELECT * FROM overview_refresh WHERE singleton=1');
  // One outstanding ticket globally, independent of the number of expired clicks.
  if(old&&old.origin_interaction===interaction.id){
   if(old.consumed||old.expires<=this.clock()||old.message_id!==map.message_id||old.revision!==map.last_revision||old.generation!==generation)throw new Rejected('view_expired',409);
   return {expired:true,refresh_custom_id:old.ref};
  }
  const ref='refresh:'+crypto.randomUUID();
  this.rows('INSERT INTO overview_refresh VALUES(1,?,?,?,?,?,?,0) ON CONFLICT(singleton) DO UPDATE SET ref=excluded.ref,origin_interaction=excluded.origin_interaction,message_id=excluded.message_id,revision=excluded.revision,generation=excluded.generation,expires=excluded.expires,consumed=0',ref,interaction.id,map.message_id,map.last_revision,generation,this.clock()+300000);
  return {expired:true,refresh_custom_id:ref};
 }
 async refreshOverview(interaction:any,payload:string){
  const ticket=this.one('SELECT * FROM overview_refresh WHERE singleton=1'),map=this.one("SELECT * FROM maps WHERE view_key='overview'");
  if(!this.refreshOwner(interaction)||interaction.data?.component_type!==2||interaction.data?.values!==undefined||!ticket||ticket.ref!==interaction.data.custom_id||ticket.consumed||ticket.expires<=this.clock()||!map||map.message_id!==ticket.message_id||map.last_revision!==ticket.revision||this.refreshGeneration()!==ticket.generation||!(interaction.message.flags&64)||interaction.message.interaction_metadata?.id!==ticket.origin_interaction||interaction.message.interaction_metadata?.type!==3||interaction.message.interaction_metadata?.user?.id!==this.b.userId||interaction.message.interaction_metadata?.interacted_message_id!==ticket.message_id)throw new Rejected('view_expired',409);
  if(!this.enabled||this.one("SELECT id FROM outbox WHERE status IN ('sending','uncertain','blocked') LIMIT 1"))throw new Rejected('view_expired',409);
  const latest=this.rows("SELECT * FROM events WHERE decision='applied' ORDER BY revision DESC").find(r=>this.canNotify(JSON.parse(r.payload)));
  if(!latest)throw new Rejected('view_expired',409);
  this.rows('UPDATE overview_refresh SET consumed=1 WHERE singleton=1');
  this.rows('INSERT INTO interactions VALUES(?,?)',interaction.id,payload);
  const receipt='refresh:'+interaction.id;
  this.enqueue(receipt,'overview','overview',JSON.parse(latest.payload),latest.revision);
  // Pin this job to an existing message. A disappeared/replaced map must never
  // turn an owner refresh into a message-create request.
  this.rows("UPDATE outbox SET message_id=? WHERE receipt=? AND view_key='overview'",map.message_id,receipt);
  await this.schedule();this.log('overview_refresh_requested',null,'existing_message_only');return {refreshed:true};
 }
 async select(interaction:any){
  return this.storage.transaction(async()=>{
   const id=interaction.id,payload=canonical({data:interaction.data,message_id:interaction.message?.id});
   const old=this.one('SELECT payload FROM interactions WHERE interaction_id=?',id);if(old){if(old.payload!==payload)throw new Rejected('interaction_conflict',409);return {duplicate:true};}
   if(typeof interaction.data?.custom_id==='string'&&interaction.data.custom_id.startsWith('refresh:'))return this.refreshOverview(interaction,payload);
   const ref=this.one('SELECT * FROM controls WHERE ref=?',interaction.data?.custom_id),map=ref&&this.one('SELECT * FROM maps WHERE view_key=?',ref.view_key);
   if(!ref||ref.expires<=this.clock()||!map||map.message_id!==interaction.message?.id||map.last_revision!==ref.revision)return this.offerOverviewRefresh(interaction);
   const selection=this.selection(),options=JSON.parse(ref.payload);
   if(ref.action==='page'){if(interaction.data.component_type!==2)throw new Rejected('invalid_view_control');selection.page=options;selection.branch_key=null;selection.selected_node_id=null;}
   else{
    if(interaction.data.component_type!==3||!Array.isArray(interaction.data.values)||interaction.data.values.length!==1)throw new Rejected('invalid_view_control');
    const chosen=options.find((o:any)=>o.value===interaction.data.values[0]);if(!chosen)throw new Rejected('invalid_view_control');
    if(ref.action==='source'){if(chosen.source_id&&!this.b.sources.some(s=>s.source_id===chosen.source_id&&this.verificationStatus(s)==='verified'))throw new Rejected('source_disabled',403);selection.source_id=chosen.source_id;selection.branch_key=null;selection.selected_node_id=null;selection.page=0;}
    else if(ref.action==='route'){const branch=chosen.branch_key&&this.one('SELECT source_id,project_id,archived FROM branches WHERE branch_key=?',chosen.branch_key);if(chosen.branch_key&&(!branch||branch.archived||selection.source_id&&branch.source_id!==selection.source_id))throw new Rejected('view_expired',409);if(branch&&!this.projectAllowed(branch.project_id))throw new Rejected('project_not_authorized',403);if(branch&&!this.b.sources.some(s=>s.source_id===branch.source_id&&s.enabled))throw new Rejected('source_disabled',403);selection.branch_key=chosen.branch_key;selection.selected_node_id=null;}
    else if(ref.action==='node'){if(selection.branch_key!==chosen.branch_key)throw new Rejected('view_expired',409);selection.selected_node_id=chosen.node_id;}
    else throw new Rejected('invalid_view_control');
   }
   this.rows("INSERT INTO meta VALUES('selection',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",canonical(selection));
   this.rows('INSERT INTO interactions VALUES(?,?)',id,payload);
   const latest=this.rows("SELECT * FROM events WHERE decision='applied' ORDER BY revision DESC").find(r=>this.canNotify(JSON.parse(r.payload)));
   if(latest){this.enqueue('interaction:'+id,'overview','overview',JSON.parse(latest.payload),latest.revision);await this.schedule();}
   this.log('view_selected',null,canonical({interaction_id:id,selection}));return {accepted:true};
  });
 }
 async registrationAttempt(){return this.storage.transaction(async()=>{
  const now=this.clock(),day=Math.floor(now/86400000),window=Math.floor(now/600000),keys=['dcr-day:'+day,'dcr-window:'+window];
  const counts=keys.map(key=>Number(this.one('SELECT value FROM meta WHERE key=?',key)?.value??0));
  if(counts[0]>=30||counts[1]>=5)return {allowed:false,retry_after:Math.ceil(((counts[0]>=30?(day+1)*86400000:(window+1)*600000)-now)/1000)};
  for(let i=0;i<keys.length;i++)this.rows('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',keys[i],String(counts[i]+1));
  this.rows("DELETE FROM meta WHERE key LIKE 'dcr-window:%' AND key<>?",keys[1]);this.rows("DELETE FROM meta WHERE key LIKE 'dcr-day:%' AND key<>?",keys[0]);return {allowed:true};
 });}
 isRetentionAlarm(){return this.one("SELECT value FROM meta WHERE key='retention_alarm_only'")?.value==='1';}
 async scheduleRetentionOnly(){
  this.diagnostics.prune(this.clock());const at=this.diagnostics.nextExpiry();
  const current=this.storage.getAlarm?await this.storage.getAlarm():null;
  if(!Number.isFinite(at))return;
  if(current===null){this.rows("INSERT INTO meta VALUES('retention_alarm_only','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value");await this.storage.setAlarm(Math.max(this.clock()+1,at));}
  else if(at<current)await this.storage.setAlarm(Math.max(this.clock()+1,at));
 }
 async recordDiagnostic(record:unknown){return this.storage.transaction(async()=>{const result=this.diagnostics.insert(record,this.clock());await this.scheduleRetentionOnly();return result;});}
 async connectionDiagnostics(query:unknown){return this.storage.transaction(async()=>{const result=this.diagnostics.query(query,this.clock());return result;});}
 async alarm(){
  if(this.busy)return {status:'already_running'};
  if(this.isRetentionAlarm()){await this.storage.transaction(async()=>{await this.storage.deleteAlarm();this.rows("DELETE FROM meta WHERE key='retention_alarm_only'");await this.scheduleRetentionOnly();});return {status:'retention_only'};}
  this.busy=true;
  try{
   let job:any=null;
   await this.storage.transaction(async()=>{
    // This instance has no active sender (busy guards overlap). A previous alarm
    // may have failed to commit its result; preserve an explicit unknown state.
    this.quarantineSending('previous_dispatch_uncommitted');this.suppressDisallowedJobs();this.expireRequests();this.expireFreshness();
    if(!this.enabled||!this.sender){await this.schedule();return;}
    if(this.one("SELECT id FROM outbox WHERE status IN ('sending','uncertain','blocked') LIMIT 1")){await this.schedule();return;}
    const rateUntil=Number(this.one("SELECT value FROM meta WHERE key='rate_until'")?.value??0);
    if(rateUntil>this.clock()){await this.schedule();return;}
    job=this.one("SELECT * FROM outbox WHERE status IN ('queued','retry_wait') AND next_at<=? ORDER BY CASE WHEN intent='overview' THEN 1 ELSE 0 END,id LIMIT 1",this.clock());
    if(!job){await this.schedule();return;}
    const source=JSON.parse(job.payload).source_id;
    if(!this.b.sources.some(s=>s.source_id===source&&s.enabled)){
     this.rows("UPDATE outbox SET status='blocked',last_error='source_disabled' WHERE id=?",job.id);this.log('blocked',job.id,'source_disabled');job=null;await this.schedule();return;
    }
    const map=this.one('SELECT message_id FROM maps WHERE view_key=?',job.view_key);
    if(job.receipt.startsWith('refresh:')&&(!job.message_id||map?.message_id!==job.message_id)){this.rows("UPDATE outbox SET status='suppressed',last_error='view_expired' WHERE id=?",job.id);job=null;await this.schedule();return;}
    job.message_id=map?.message_id??null;
    this.rows("UPDATE outbox SET status='sending',attempts=attempts+1,message_id=? WHERE id=?",job.message_id,job.id);job.attempts+=1;
    this.log('dispatch_started',job.id,job.message_id?'edit_existing':'create_once');await this.storage.deleteAlarm();
   });
   if(!job)return !this.enabled||!this.sender?{status:'held',reason:'delivery_not_enabled'}:{status:'no_dispatch'};
   // Explicit sync before external side-effect: a crash must leave a durable sending marker.
   await this.storage.sync();
   const request=job.intent==='request'?this.one('SELECT * FROM requests WHERE request_key=?',job.view_key.slice('request:'.length)):null;
   const event=request?JSON.parse(request.payload):JSON.parse(job.payload);
   const dispatch:Dispatch={ownerId:this.b.ownerId,appId:this.b.appId,dmId:this.b.dmId,messageId:job.message_id,viewKey:job.view_key,nonce:'job-'+job.id,
     payload:{test_only:this.synthetic,revision:job.revision,intent:job.intent,event,selection:this.selection(),components:job.intent==='overview'?this.controls(job.revision):[],sources:this.snapshot().sources.filter(s=>s.enabled&&s.visible),request:request?{request_key:request.request_key,request_id:request.request_id,state:request.state,version:request.version}:undefined,overview:job.intent==='overview'?this.snapshot().branches.filter((r:any)=>this.canNotify(r)):undefined,allowed_mentions:{parse:[]}}};
   let status='uncertain',error='send_result_unknown',messageId=job.message_id,nextAt=this.clock();
   try{
    const result=await this.sender!(dispatch);
    if(result.notSent===true){status='blocked';error=['preflight_configuration','preflight_bot_identity','preflight_guild_bot','preflight_guild_owner','preflight_dm_identity','preflight_render'].includes(result.reason??'')?result.reason!:'preflight_or_render_failed';}
    else if(result.status===200){
     const data=result.body;
     if(data&&numericId(data.id)&&data.channel_id===this.b.dmId&&data.author?.id===this.b.appId&&(!job.message_id||data.id===job.message_id)){
      status='sent';error='';messageId=data.id;
     }else error='invalid_delivery_receipt';
    }else if(result.status===429&&Number.isFinite(result.retryAfter)&&result.retryAfter!>0&&result.retryAfter!<=86400){
     status=job.attempts>=8?'dead_letter':'retry_wait';error='rate_limited';nextAt=this.clock()+Math.max(1,result.retryAfter!)*1000;
    }else if([400,401,403,404].includes(result.status)){status='blocked';error='http_'+result.status;}
   }catch{ /* No safe proof that fetch did not dispatch: quarantine. */ }
   await this.storage.transaction(async()=>{
    const active=this.one('SELECT status FROM outbox WHERE id=?',job.id);
    if(active?.status!=='sending')throw new Rejected('dispatch_state_conflict',409);
    this.rows('UPDATE outbox SET status=?,last_error=?,message_id=?,next_at=? WHERE id=?',status,error||null,messageId,nextAt,job.id);
    if(status==='sent'){
     this.rows('INSERT INTO maps VALUES(?,?,?) ON CONFLICT(view_key) DO UPDATE SET message_id=excluded.message_id,last_revision=excluded.last_revision',job.view_key,messageId,job.revision);
     if(job.intent==='overview'){
      this.rows("INSERT INTO meta VALUES('overview_generation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(job.id));
      this.rows('DELETE FROM overview_refresh');
      // Navigation changes can render the same event revision. Only controls on
      // the receipt-confirmed message remain valid; preserve the previous set
      // on an unknown/failed send so a visible message is not retired early.
      const refs=dispatch.payload.components.flatMap((row:any)=>row.components??[]).map((component:any)=>component.custom_id).filter((ref:any)=>typeof ref==='string');
      this.rows('DELETE FROM controls WHERE view_key=?'+(refs.length?' AND ref NOT IN ('+refs.map(()=>'?').join(',')+')':''),job.view_key,...refs);
     }
    }
    if(error==='rate_limited')this.rows("INSERT INTO meta VALUES('rate_until',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(nextAt));
    this.log(status,job.id,error||'matching_receipt');await this.schedule();
   });
   return {status,job_id:job.id};
  }catch(error){
   // Never retry an uncertain external action. Best-effort terminal marker does
   // not schedule another dispatch; if storage itself is down, next alarm or
   // constructor repeats quarantine before any sender can run.
   try{await this.storage.transaction(async()=>{this.quarantineSending('dispatch_finalization_failed');await this.schedule();});}catch{}
   throw error;
  }finally{this.busy=false;}
 }
}
