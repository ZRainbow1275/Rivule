import { validBridgeText } from './bridge-text.mjs';
// Durable, owner-scoped PA bridge. Authentication belongs to the calling adapter;
// identities and configuration are revalidated here before every state transition.
export const BRIDGE_MODES = ['task_updates', 'every_response'];
export const BRIDGE_CONTEXT_FIELDS = ['project_id','task_id','run_id','branch_id','thread_id'];
const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(v);
const exact = (v, names) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => names.includes(k));
const canonical = v => JSON.stringify(v, Object.keys(v).sort());
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');
export class BridgeError extends Error { constructor(code, status=422) { super(code); this.code=code;this.status=status; } }
const fail = (code,status) => {throw new BridgeError(code,status);};
const text = validBridgeText;
export const bridgeSchema = `
CREATE TABLE IF NOT EXISTS bridge_contexts(source_id TEXT NOT NULL,context TEXT NOT NULL,binding TEXT NOT NULL,context_ref TEXT UNIQUE NOT NULL,consent_revision INTEGER NOT NULL,context_kind TEXT NOT NULL DEFAULT 'task' CHECK(context_kind='task'),PRIMARY KEY(source_id,context));
CREATE TABLE IF NOT EXISTS bridge_preferences(source_id TEXT PRIMARY KEY,binding TEXT NOT NULL,mode TEXT NOT NULL,commands_enabled INTEGER NOT NULL,revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bridge_task_receipts(receipt TEXT PRIMARY KEY,source_id TEXT NOT NULL,binding TEXT NOT NULL,context TEXT NOT NULL,context_ref TEXT NOT NULL,consent_revision INTEGER NOT NULL,created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS bridge_responses(source_id TEXT NOT NULL,response_id TEXT NOT NULL,binding TEXT NOT NULL,receipt TEXT UNIQUE NOT NULL,hash TEXT NOT NULL,context TEXT NOT NULL,consent_revision INTEGER NOT NULL,accepted_at REAL NOT NULL,PRIMARY KEY(source_id,response_id));
CREATE TABLE IF NOT EXISTS bridge_commands(command_id TEXT PRIMARY KEY,source_id TEXT NOT NULL,binding TEXT NOT NULL,context TEXT NOT NULL,fingerprint TEXT NOT NULL,text_digest TEXT NOT NULL,consent_revision INTEGER NOT NULL,payload TEXT,state TEXT NOT NULL,expires_at REAL NOT NULL,claim_id TEXT,claim_token TEXT,claim_until REAL,ack TEXT,created_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS bridge_commands_source ON bridge_commands(source_id,state,created_at);
`;
export class MessageBridge {
  constructor({storage,bindings,sourceBinding,enqueueResponse,enqueueTask,onResponseAccepted,responseChannelReceipt,now=Date.now,random=()=>crypto.randomUUID(),recipient}) {
    Object.assign(this,{storage,bindings,sourceBinding,enqueueResponse,enqueueTask,onResponseAccepted,responseChannelReceipt,now,random,recipient});

  }
  has(table){return !!this.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name=?",table).toArray().length;}
  initialize(){this.storage.sql.exec(bridgeSchema);}
  async bindingToken(source){return digest(this.binding(source));}
  rows(q,...args){return this.storage.sql.exec(q,...args).toArray();}
  one(q,...args){return this.rows(q,...args)[0]??null;}
  source(source){const current=this.bindings.sources.find(s=>s.source_id===source?.source_id);if(!current?.enabled||JSON.stringify(current)!==JSON.stringify(source))fail('source_not_authorized',403);return current;}
  binding(source){this.source(source);return JSON.stringify([this.bindings.ownerId,this.bindings.appId,this.bindings.userId,this.bindings.dmId,this.bindings.allowedProjectIds,source,this.sourceBinding(source)]);}
  context(source,input){
    this.source(source);
    if(!BRIDGE_CONTEXT_FIELDS.every(k=>id(input[k])))fail('invalid_bridge_context');
    if(!this.bindings.allowedProjectIds.includes(input.project_id))fail('project_not_authorized',403);
    if(!this.has('branches'))fail('bridge_task_unavailable',409);
    const branch=this.one('SELECT payload,archived FROM branches WHERE source_id=? AND project_id=? AND branch_key=?',source.source_id,input.project_id,JSON.stringify([source.source_id,input.task_id,input.run_id,input.branch_id]));
    if(!branch||branch.archived)fail('bridge_task_unavailable',409);
    const payload=JSON.parse(branch.payload);
    if(['project_id','task_id','run_id','branch_id'].some(k=>payload[k]!==input[k])||payload.source_id!==source.source_id||payload.sensitivity!=='normal')fail('bridge_task_unavailable',409);
    return {source_id:source.source_id,...Object.fromEntries(BRIDGE_CONTEXT_FIELDS.map(k=>[k,input[k]]))};
  }
  async registerContext(source,input){
    this.initialize();
    if(!exact(input,BRIDGE_CONTEXT_FIELDS))fail('invalid_bridge_context');
    const context=JSON.stringify(this.context(source,input)),binding=this.binding(source);
    return this.storage.transaction(async()=>{
      const old=this.one('SELECT * FROM bridge_contexts WHERE source_id=? AND context=?',source.source_id,context);
      if(!old&&this.one('SELECT COUNT(*) AS n FROM bridge_contexts').n>=1000)fail('bridge_context_capacity',429);
      const revision=this.preference(source).revision,ref=old?.binding===binding&&old.consent_revision===revision?old.context_ref:this.random();
      this.rows('INSERT INTO bridge_contexts(source_id,context,binding,context_ref,consent_revision) VALUES(?,?,?,?,?) ON CONFLICT(source_id,context) DO UPDATE SET binding=excluded.binding,context_ref=excluded.context_ref,consent_revision=excluded.consent_revision',source.source_id,context,binding,ref,revision);
      return {context:JSON.parse(context),context_ref:ref,registered:true,wake_supported:false};
    });
  }
  requireContext(source,input){const context=this.context(source,input);const row=this.one('SELECT * FROM bridge_contexts WHERE source_id=? AND context=?',source.source_id,JSON.stringify(context));if(row?.context_kind!=='task'||row?.binding!==this.binding(source)||row.consent_revision!==this.preference(source).revision)fail('bridge_context_not_registered',409);return context;}
  preference(source){const binding=this.binding(source),row=this.has('bridge_preferences')?this.one('SELECT * FROM bridge_preferences WHERE source_id=?',source.source_id):null;return {source_id:source.source_id,mode:row?.binding===binding?row.mode:'task_updates',commands_enabled:row?.binding===binding?row.commands_enabled===1:false,revision:row?.revision??0};}
  capabilities(source){return {...this.preference(source),context_kinds:['task'],context_support:'registered_existing_task_only',general_conversation_responses:'unsupported',transport:'source_initiated_pull',global_response_interception:false,wake_paused_source:false,source_executes_under_own_policy:true,inbound_channels:{discord:'adapter_required',qq:'adapter_required'},response_channels:{discord:'existing_authorized_outbox',qq:'unsupported'},...this.extraCapabilities?.(source),instructions:'Only explicitly published user-visible text is relayed. Every-response requires this PA opt-in and a supported source hook; never forward reasoning, secrets, raw tool traffic, or received relay messages. Poll and claim commands only in their exact source/project/task/run/branch/thread context. Claim is not approval to execute; apply your own policy. Never execute duplicate claims.'};}
  async setPreference(source,input,admissionGuard){
    this.initialize();
    if(!exact(input,['mode','commands_enabled','expected_revision','confirm'])||!BRIDGE_MODES.includes(input.mode)||typeof input.commands_enabled!=='boolean'||!Number.isSafeInteger(input.expected_revision)||input.confirm!==true)fail('invalid_bridge_preference');
    const binding=this.binding(source);
    return this.storage.transaction(async()=>{if(admissionGuard)await admissionGuard();if(binding!==this.binding(source))fail('bridge_authority_changed',409);const current=this.preference(source);if(current.revision!==input.expected_revision)fail('bridge_preference_conflict',409);const revision=current.revision+1;this.rows('INSERT INTO bridge_preferences VALUES(?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET binding=excluded.binding,mode=excluded.mode,commands_enabled=excluded.commands_enabled,revision=excluded.revision',source.source_id,this.binding(source),input.mode,input.commands_enabled?1:0,revision);return {...current,mode:input.mode,commands_enabled:input.commands_enabled,revision};});
  }
  async publishResponse(source,input){
    this.initialize();
    if(!exact(input,[...BRIDGE_CONTEXT_FIELDS,'response_id','text','content_kind','origin'])||!id(input.response_id)||!text(input.text)||input.content_kind!=='user_visible_response'||input.origin!=='source')fail('invalid_bridge_response');
    if(/(?:-----BEGIN[\s\S]*PRIVATE KEY|\bBearer\s+\S+|\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}|(?:password|api[_-]?key|authorization|secret|token)[\"']?\s*[:=])/i.test(input.text))fail('bridge_sensitive_content_rejected');
    const context=this.requireContext(source,input),binding=this.binding(source),hash=await digest(canonical(input)),textDigest=await digest(input.text);
    return this.storage.transaction(async()=>{
      if(binding!==this.binding(source))fail('bridge_authority_changed',409);
      this.requireContext(source,input);
      const prior=this.one('SELECT * FROM bridge_responses WHERE source_id=? AND response_id=?',source.source_id,input.response_id);
      if(prior){if(prior.hash!==hash||prior.binding!==binding)fail('bridge_response_conflict',409);return this.responseReceipt(source,prior.receipt,true);}
      if(this.one('SELECT command_id FROM bridge_commands WHERE source_id=? AND context=? AND text_digest=? AND created_at>?',source.source_id,JSON.stringify(context),textDigest,this.now()-86400000))fail('bridge_relay_echo_rejected',409);
      if(this.preference(source).mode!=='every_response')fail('every_response_not_enabled',403);
      if(this.one('SELECT COUNT(*) AS n FROM bridge_responses').n>=10000)fail('bridge_response_capacity',429);
      const receipt='bridge_'+this.random(),consent=this.preference(source).revision;
      const registered=this.one('SELECT context_ref FROM bridge_contexts WHERE source_id=? AND context=?',source.source_id,JSON.stringify(context));
      // This callback must enqueue in this same durable transaction, never send.
      await this.enqueueResponse(source,context,input.text,receipt,{context_ref:registered.context_ref,consent_revision:consent});
      this.rows('INSERT INTO bridge_responses VALUES(?,?,?,?,?,?,?,?)',source.source_id,input.response_id,binding,receipt,hash,JSON.stringify(context),consent,this.now());
      this.onResponseAccepted?.(source,receipt);
      return this.responseReceipt(source,receipt,false);
    });
  }
  recordTask(event,receipt,{discord=true}={}){
    const source=this.bindings.sources.find(s=>s.source_id===event.source_id);
    if(!source||!this.preference(source).commands_enabled||event.sensitivity!=='normal')return null;
    this.initialize();
    const revision=this.preference(source).revision,binding=this.binding(source);
    const registered=this.rows('SELECT * FROM bridge_contexts WHERE source_id=? AND binding=? AND consent_revision=?',source.source_id,binding,revision).filter(r=>['project_id','task_id','run_id','branch_id'].every(k=>JSON.parse(r.context)[k]===event[k]));
    if(registered.length!==1)return null; // Never guess which source conversation owns the task.
    const r=registered[0];this.requireContext(source,JSON.parse(r.context));
    if(this.one('SELECT COUNT(*) AS n FROM bridge_task_receipts').n>=10000)return null;
    this.rows('INSERT OR IGNORE INTO bridge_task_receipts VALUES(?,?,?,?,?,?,?)',receipt,source.source_id,binding,r.context,r.context_ref,revision,this.now());
    if(discord)this.enqueueTask?.(source,event,receipt,{context_ref:r.context_ref,consent_revision:revision});
    return this.taskAuthority(source,receipt);
  }
  taskAuthority(source,receipt){
    if(!this.has('bridge_task_receipts'))return null;
    const row=this.one('SELECT * FROM bridge_task_receipts WHERE source_id=? AND receipt=?',this.source(source).source_id,receipt);
    if(!row)return null;
    try{
      if(row.binding!==this.binding(source)||!this.preference(source).commands_enabled||row.consent_revision!==this.preference(source).revision)return null;
      const context=this.requireContext(source,JSON.parse(row.context));
      const event=this.one("SELECT * FROM events WHERE source_id=? AND receipt=? AND decision='applied'",source.source_id,receipt);
      if(!event)return null;
      return {event:JSON.parse(event.payload),revision:event.revision,context,context_ref:row.context_ref,consent_revision:row.consent_revision,receiptId:receipt};
    }catch{return null;}
  }
  resolveDiscordContext(ref,messageId){
    const registered=this.one('SELECT * FROM bridge_contexts WHERE context_ref=?',ref);
    if(!registered)fail('bridge_context_not_registered',404);
    const source=this.bindings.sources.find(s=>s.source_id===registered.source_id),context=JSON.parse(registered.context);
    if(!this.preference(source).commands_enabled)fail('bridge_commands_not_enabled',403);
    this.requireContext(source,context);
    const found=this.one("SELECT r.receipt FROM bridge_responses r JOIN outbox o ON o.receipt=r.receipt WHERE r.source_id=? AND r.context=? AND r.consent_revision=? AND o.message_id=? AND o.status='sent' AND r.accepted_at>?",source.source_id,registered.context,registered.consent_revision,messageId,this.now()-86400000);
    const task=this.one("SELECT r.receipt FROM bridge_task_receipts r JOIN outbox o ON o.receipt=r.receipt WHERE r.context_ref=? AND o.message_id=? AND o.intent='bridge_task' AND o.status='sent' AND r.created_at>?",ref,messageId,this.now()-86400000);
    if(!(found&&this.responseAuthorized(found.receipt))&&!(task&&this.taskAuthority(source,task.receipt)))fail('bridge_message_not_confirmed',409);
    return context;
  }
  providerAccepted(raw){try{const r=JSON.parse(raw??'{}');return r.state==='sent'&&r.reason==='provider_accepted'&&typeof r.messageId==='string'&&r.messageId.length>0&&r.messageId.length<=256;}catch{return false;}}
  resolveQQContext(ref,trusted){
    if(!trusted||trusted.channel!=='qq'||trusted.owner_id!==this.bindings.ownerId||!this.recipient?.(trusted))fail('bridge_requester_not_authorized',403);
    const registered=this.one('SELECT * FROM bridge_contexts WHERE context_ref=?',ref);
    if(!registered)fail('bridge_context_not_registered',404);
    const source=this.bindings.sources.find(s=>s.source_id===registered.source_id),context=JSON.parse(registered.context);
    if(!this.preference(source).commands_enabled)fail('bridge_commands_not_enabled',403);
    this.requireContext(source,context);
    const rows=this.rows("SELECT r.receipt,q.result FROM bridge_responses r JOIN qq_continuous_outbox q ON q.receipt=r.receipt WHERE r.source_id=? AND r.context=? AND r.consent_revision=? AND q.status='sent' AND r.accepted_at>?",source.source_id,registered.context,registered.consent_revision,this.now()-86400000);
    const tasks=this.rows("SELECT r.receipt,q.result FROM bridge_task_receipts r JOIN qq_continuous_outbox q ON q.receipt=r.receipt WHERE r.context_ref=? AND q.status='sent' AND r.created_at>?",ref,this.now()-86400000);
    if(!rows.some(r=>this.responseAuthorized(r.receipt)&&this.providerAccepted(r.result))&&!tasks.some(r=>this.taskAuthority(source,r.receipt)&&this.providerAccepted(r.result)))fail('bridge_message_not_confirmed',409);
    return context;
  }
  responseAuthority(source,receipt){
    if(!this.responseAuthorized(receipt))return null;
    const row=this.one('SELECT * FROM events WHERE source_id=? AND receipt=? AND decision=?',source.source_id,receipt,'bridge_response');
    if(!row)return null;
    const event=JSON.parse(row.payload),stored=this.one('SELECT context,consent_revision FROM bridge_responses WHERE receipt=?',receipt);
    return {event,receiptId:receipt,revision:row.revision,decision:row.decision,context:JSON.parse(stored.context),context_ref:event.bridge_context_ref,consent_revision:stored.consent_revision};
  }
  responseAuthorized(receipt){
    if(!this.has('bridge_responses'))return false;
    const row=this.one('SELECT source_id,binding,context,consent_revision FROM bridge_responses WHERE receipt=?',receipt);
    const source=row&&this.bindings.sources.find(s=>s.source_id===row.source_id);
    try{return !!source&&this.binding(source)===row.binding&&this.preference(source).mode==='every_response'&&this.preference(source).revision===row.consent_revision&&!!this.requireContext(source,JSON.parse(row.context));}catch{return false;}
  }
  responseReceipt(source,receipt,duplicate=false){
    if(!this.has('bridge_responses'))fail('bridge_receipt_not_found',404);
    const row=this.one('SELECT * FROM bridge_responses WHERE source_id=? AND receipt=?',this.source(source).source_id,receipt);
    if(!row||row.binding!==this.binding(source))fail('bridge_receipt_not_found',404);
    const jobs=this.rows('SELECT status,last_error FROM outbox WHERE receipt=?',receipt);
    const states=jobs.map(j=>j.status);
    const state=states.length===0?'unknown':states.some(s=>['sending','uncertain'].includes(s))?'unknown':states.every(s=>s==='sent')?'provider_accepted':states.some(s=>['blocked','suppressed','dead_letter'].includes(s))?'blocked':'queued';
    return {receipt_id:receipt,duplicate,event:'accepted',context:JSON.parse(row.context),channels:{discord:{state},qq:this.responseChannelReceipt?.(source,receipt)??{state:'unsupported',reason:'response_adapter_not_implemented'}},recipient_confirmation:'not_observed'};
  }
  nextExpiry(){if(!this.has('bridge_commands'))return Infinity;const row=this.one("SELECT MIN(CASE WHEN state='claimed' THEN MIN(claim_until,expires_at) ELSE expires_at END) AS at FROM bridge_commands WHERE payload IS NOT NULL AND state IN ('pending','claimed','unknown')");return row?.at??Infinity;}
  expire(){if(!this.has('bridge_commands'))return;const now=this.now();this.rows("UPDATE bridge_commands SET state='unknown' WHERE state='claimed' AND claim_until<=?",now);this.rows("UPDATE bridge_commands SET state='expired',payload=NULL WHERE state='pending' AND expires_at<=?",now);this.rows('UPDATE bridge_commands SET payload=NULL WHERE expires_at<=?',now);}
  async enqueueCommand(trusted,input,admissionGuard){
    this.initialize();
    if(!exact(input,['source_id',...BRIDGE_CONTEXT_FIELDS,'text','ttl_seconds'])||!text(input.text)||!Number.isInteger(input.ttl_seconds)||input.ttl_seconds<60||input.ttl_seconds>86400)fail('invalid_bridge_command');
    if(!trusted||!['discord','qq'].includes(trusted.channel)||trusted.owner_id!==this.bindings.ownerId||!id(trusted.event_id)||!this.recipient?.(trusted))fail('bridge_requester_not_authorized',403);
    const source=this.bindings.sources.find(s=>s.source_id===input.source_id),context=this.requireContext(source,input),binding=this.binding(source);
    if(!this.preference(source).commands_enabled)fail('bridge_commands_not_enabled',403);
    const command_id=trusted.channel+':'+trusted.event_id;
    const fingerprint=await digest(JSON.stringify([trusted.channel,trusted.requester_id,trusted.conversation_id,context,input.text,input.ttl_seconds])),textDigest=await digest(input.text);
    return this.storage.transaction(async()=>{
      if(admissionGuard)await admissionGuard();
      if(binding!==this.binding(source)||!this.preference(source).commands_enabled)fail('bridge_authority_changed',409);
      this.requireContext(source,input);
      this.expire();const prior=this.one('SELECT * FROM bridge_commands WHERE command_id=?',command_id);
      if(prior){if(prior.fingerprint!==fingerprint||prior.binding!==binding||prior.consent_revision!==this.preference(source).revision)fail('bridge_command_conflict',409);return {command_id,state:prior.state,duplicate:true,source_woken:false};}
      if(this.one('SELECT COUNT(*) AS n FROM bridge_commands').n>=10000)fail('bridge_command_capacity',429);
      const now=this.now(),payload=JSON.stringify({text:input.text,requester:{channel:trusted.channel,id:trusted.requester_id,conversation_id:trusted.conversation_id},context});
      this.rows("INSERT INTO bridge_commands(command_id,source_id,binding,context,fingerprint,text_digest,consent_revision,payload,state,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?)",command_id,source.source_id,binding,JSON.stringify(context),fingerprint,textDigest,this.preference(source).revision,payload,now+input.ttl_seconds*1000,now);
      return {command_id,state:'pending',duplicate:false,source_woken:false,execution:'not_started'};
    });
  }
  async claim(source,input){
    this.initialize();
    if(!this.preference(source).commands_enabled)fail('bridge_commands_not_enabled',403);
    if(!exact(input,[...BRIDGE_CONTEXT_FIELDS,'claim_id'])||!id(input.claim_id))fail('invalid_bridge_claim');
    const context=JSON.stringify(this.requireContext(source,input)),binding=this.binding(source);
    return this.storage.transaction(async()=>{
      this.expire();const previous=this.one('SELECT * FROM bridge_commands WHERE source_id=? AND claim_id=?',source.source_id,input.claim_id);
      if(previous){if(previous.binding!==binding||previous.context!==context||previous.consent_revision!==this.preference(source).revision)fail('bridge_claim_conflict',409);return {command_id:previous.command_id,state:previous.state,duplicate:true,execute:false};}
      const row=this.one("SELECT * FROM bridge_commands WHERE source_id=? AND binding=? AND context=? AND consent_revision=? AND state='pending' ORDER BY created_at,command_id LIMIT 1",source.source_id,binding,context,this.preference(source).revision);
      if(!row)return {state:'empty',execute:false};
      const token=this.random(),until=Math.min(row.expires_at,this.now()+60000);
      this.rows("UPDATE bridge_commands SET state='claimed',claim_id=?,claim_token=?,claim_until=? WHERE command_id=? AND state='pending'",input.claim_id,token,until,row.command_id);
      return {command_id:row.command_id,state:'claimed',duplicate:false,claim_token:token,claim_until:until,expires_at:row.expires_at,...JSON.parse(row.payload),execution:'source_policy_required'};
    });
  }
  async acknowledge(source,input){
    this.initialize();
    if(!this.preference(source).commands_enabled)fail('bridge_commands_not_enabled',403);
    if(!exact(input,['command_id','claim_token','outcome'])||typeof input.command_id!=='string'||typeof input.claim_token!=='string'||!['completed','rejected','unknown'].includes(input.outcome))fail('invalid_bridge_ack');
    const binding=this.binding(source);
    return this.storage.transaction(async()=>{
      this.expire();const row=this.one('SELECT * FROM bridge_commands WHERE command_id=? AND source_id=?',input.command_id,source.source_id);
      if(!row||row.binding!==binding||row.consent_revision!==this.preference(source).revision||row.claim_token!==input.claim_token)fail('bridge_claim_not_found',404);
      if(row.ack){if(row.ack!==input.outcome)fail('bridge_ack_conflict',409);return {command_id:row.command_id,state:row.state,duplicate:true};}
      if(!['claimed','unknown'].includes(row.state))fail('bridge_ack_conflict',409);
      this.rows('UPDATE bridge_commands SET state=?,ack=?,payload=NULL WHERE command_id=?',input.outcome,input.outcome,row.command_id);
      return {command_id:row.command_id,state:input.outcome,duplicate:false,execution_confirmed_by:'source_report_only'};
    });
  }
}
