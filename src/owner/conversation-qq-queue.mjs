// Separate ordinary-conversation queue: no synthetic project, task, or task cursor.
const enc=new TextEncoder(),hex=v=>[...new Uint8Array(v)].map(n=>n.toString(16).padStart(2,'0')).join('');
const hash=async v=>hex(await crypto.subtle.digest('SHA-256',enc.encode(v)));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const valid=v=>typeof v==='string'&&v.length>0&&v.length<=1024;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const stable=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(stable):Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
export const canonicalConversationContext=value=>JSON.stringify(stable(value));
export function formatConversationQQResponse(a){
 if(a?.kind!=='conversation'||a.version!==2||!uuid(a.receipt_id)||typeof a.text!=='string'||!a.text.trim()||a.text.length>1200||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(a.text))fail('conversation_payload_invalid');
 return `${a.source_id} · PA 回复\n${a.text}${a.commands_enabled?`\n\n回复指令：/rivule-chat ${a.receipt_id} <指令>`:''}`;
}
async function key(secret){if(typeof secret!=='string'||secret.length<32)fail('conversation_gateway_unavailable');return crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export async function conversationQQRequest(queue,operation,payload){
 const c=queue.config(),secret=queue.env.QQ_BRIDGE_SECRET,k=await key(secret);
 const body=JSON.stringify({version:2,timestamp:queue.now(),ownerId:queue.ownerId,appId:c.appId,operation,payload});
 const packet={body,signature:hex(await crypto.subtle.sign('HMAC',k,enc.encode('rivule-qq-request-v2\n'+body)))};
 const stub=queue.env.QQ_GATEWAY.get(queue.env.QQ_GATEWAY.idFromName('qq:'+queue.ownerId)),response=await stub.continuousRequest(packet);
 if(typeof response?.body!=='string'||enc.encode(response.body).length>65536||!/^[a-f0-9]{64}$/.test(response.signature??''))fail('conversation_gateway_response_invalid');
 if(!await crypto.subtle.verify('HMAC',k,Uint8Array.from(response.signature.match(/../g),v=>parseInt(v,16)),enc.encode('rivule-qq-response-v2\n'+response.body)))fail('conversation_gateway_response_invalid');
 const e=JSON.parse(response.body);if(e.version!==2||e.requestHash!==await hash(body)||!e.result)fail('conversation_gateway_response_invalid');return e.result;
}
export class ConversationQQQueue {
 constructor({storage,bridge,env,ownerId,config,sourceAuthority,activation,now=Date.now}){Object.assign(this,{storage,bridge,env,ownerId,config,sourceAuthority,activation,now});}
 rows(q,...a){return this.storage.sql.exec(q,...a).toArray();}
 has(){return !!this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_qq_outbox'").length;}
 initialize(){this.storage.sql.exec('CREATE TABLE IF NOT EXISTS conversation_qq_outbox(receipt_id TEXT PRIMARY KEY,sequence INTEGER NOT NULL,source_id TEXT NOT NULL,binding TEXT NOT NULL,recipient TEXT NOT NULL,context_ref TEXT NOT NULL,consent_revision INTEGER NOT NULL,accepted_at REAL NOT NULL,expires_at REAL NOT NULL,status TEXT NOT NULL,result TEXT)');}
 async recover(){if(this.recovered)return;if(this.recovering)return this.recovering;this.initialize();this.recovering=this.storage.transaction(async()=>{this.rows("UPDATE conversation_qq_outbox SET status='uncertain',result=? WHERE status='sending'",JSON.stringify({state:'uncertain',reason:'restart_during_dispatch'}));});try{await this.recovering;this.recovered=true;}finally{this.recovering=null;}}
 unknownReceipts(){
  if(!this.has())return [];
  const reviewed=this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_qq_reviewed'").length;
  return this.rows(reviewed?"SELECT q.* FROM conversation_qq_outbox q LEFT JOIN conversation_qq_reviewed r ON r.receipt_id=q.receipt_id WHERE q.status='uncertain' AND r.receipt_id IS NULL ORDER BY q.receipt_id":"SELECT * FROM conversation_qq_outbox WHERE status='uncertain' ORDER BY receipt_id");
 }
 hasUnknown(){return this.unknownReceipts().length>0;}
 current(receipt){
  const c=this.config(),activation=this.activation();
  if(c?.enabled!==true||c.ownerId!==this.ownerId||!valid(c.appId)||!valid(c.userOpenId)||!Array.isArray(c.allowedSources))fail('conversation_delivery_disabled');
  if(activation?.active!==true||!valid(activation.grantId)||!valid(activation.bindingFingerprint)||!Number.isFinite(activation.expiresAt)||activation.expiresAt<=this.now())fail('conversation_runtime_inactive');
  const a=this.bridge.responseAuthority(receipt,'qq');if(!a||a.kind!=='conversation'||a.version!==2||!c.allowedSources.includes(a.source_id))fail('conversation_response_not_authorized');
  const source=this.bridge.sources.find(s=>s.source_id===a.source_id),grant=this.bridge.grant(source,'publish_response');
  const binding=this.bridge.binding(source),recipient=this.bridge.recipientBinding('qq');if(!recipient)fail('conversation_recipient_unavailable');
  return {a,source,grant,binding,recipient,activation,c};
 }
 enqueue(authority){
  if(!uuid(authority?.receipt_id))fail('conversation_receipt_invalid');
  this.initialize();const prior=this.rows('SELECT * FROM conversation_qq_outbox WHERE receipt_id=?',authority.receipt_id)[0];
  if(prior)return this.delivery(authority.receipt_id); // Never revive a suppressed or uncertain receipt.
  let x,result=null;
  try{x=this.current(authority.receipt_id);if(canonicalConversationContext(x.a)!==canonicalConversationContext(authority))fail('conversation_authority_changed');if(this.hasUnknown())fail('conversation_unknown_outcome_requires_review');}
  catch(error){
   if(!['conversation_unknown_outcome_requires_review','conversation_delivery_disabled','conversation_runtime_inactive','conversation_response_not_authorized','conversation_recipient_unavailable','conversation_authority_changed','conversation_operation_not_authorized'].includes(error?.code))throw error;
   result={state:'suppressed',reason:error.code};
   const source=this.bridge.sources.find(s=>s.source_id===authority.source_id);
   let binding='unavailable',recipient='unavailable';try{binding=this.bridge.binding(source);recipient=this.bridge.recipientBinding('qq')??recipient;}catch{}
   x={a:authority,binding,recipient};
  }
  const a=x.a;
  if(this.rows('SELECT COUNT(*) AS n FROM conversation_qq_outbox')[0].n>=10000)fail('conversation_queue_capacity');
  this.rows('INSERT INTO conversation_qq_outbox VALUES(?,?,?,?,?,?,?,?,?,?,?)',a.receipt_id,a.sequence,a.source_id,x.binding,x.recipient,a.context_ref,a.consent_revision,a.accepted_at,a.expires_at,result?'suppressed':'queued',result?JSON.stringify(result):null);
  return result??{state:'queued'};
 }
 delivery(receipt){if(!this.has())return null;const row=this.rows('SELECT status,result FROM conversation_qq_outbox WHERE receipt_id=?',receipt)[0];if(!row)return null;const result=row.result?JSON.parse(row.result):null;if(row.status==='sent'&&result?.state==='sent'&&result.reason==='provider_accepted'&&valid(result.messageId))return {state:'provider_accepted',message_id:result.messageId};return {state:row.status==='sending'||row.status==='uncertain'?'unknown':row.status==='sent'?'unknown':row.status,...result?.reason?{reason:result.reason}:{}};}
 erase(receipt){if(this.has())this.rows("UPDATE conversation_qq_outbox SET status=CASE WHEN status='queued' THEN 'expired' ELSE status END WHERE receipt_id=?",receipt);}
 nextAlarmAt(){const a=this.activation();if(!this.has()||this.hasUnknown()||this.config()?.enabled!==true||a?.active!==true||a.expiresAt<=this.now())return null;return this.rows("SELECT receipt_id FROM conversation_qq_outbox WHERE status='queued' LIMIT 1").length?this.now()+3100:null;}
 commandAuthority(){return conversationQQRequest(this,'command_authority',null);}
 async currentJob(receipt){
  const row=this.has()&&this.rows('SELECT * FROM conversation_qq_outbox WHERE receipt_id=?',receipt)[0];if(!row)fail('conversation_receipt_not_found');
  const x=this.current(receipt),a=x.a,activationStamp=canonicalConversationContext(x.activation);
  if(row.binding!==x.binding||row.recipient!==x.recipient||row.context_ref!==a.context_ref||row.consent_revision!==a.consent_revision||row.sequence!==a.sequence||row.expires_at<=this.now())fail('conversation_authority_changed');
  const proof=await this.sourceAuthority(a.source_id);
  if(proof?.selectable!==true||!Number.isFinite(proof.verifiedAt)||proof.verifiedAt>this.now()||this.now()-proof.verifiedAt>=86400000)fail('conversation_source_unverified');
  const content=formatConversationQQResponse(a),payloadHash=await hash(content),contextDigest=await hash(canonicalConversationContext(a.context)),sourceBindingDigest=await this.bridge.bindingToken(x.source),intentId=await hash('rivule-conversation-qq-v2\n'+receipt);
  const proofAfter=await this.sourceAuthority(a.source_id);
  if(proofAfter?.selectable!==true||!Number.isFinite(proofAfter.verifiedAt)||proofAfter.verifiedAt>this.now()||this.now()-proofAfter.verifiedAt>=86400000)fail('conversation_source_unverified');
  const fresh=this.current(receipt);if(canonicalConversationContext(fresh.a)!==canonicalConversationContext(a)||fresh.binding!==x.binding||fresh.recipient!==x.recipient||canonicalConversationContext(fresh.activation)!==activationStamp)fail('conversation_authority_changed');
  const job={kind:'conversation',version:2,intentId,sourceId:a.source_id,sourceGeneration:x.grant.generation,sourceGrantRevision:x.grant.revision,sourceBindingDigest,receiptId:receipt,contextRef:a.context_ref,contextDigest,sequence:a.sequence,consentRevision:a.consent_revision,acceptedAt:a.accepted_at,expiresAt:a.expires_at,payloadHash,content,grantId:x.activation.grantId,bindingFingerprint:x.activation.bindingFingerprint};
  const source={selectable:true,enabled:true,revoked:false,sourceId:a.source_id,generation:x.grant.generation,bindingDigest:sourceBindingDigest,verifiedAt:proofAfter.verifiedAt,kind:'conversation',version:2,sourceGrantRevision:x.grant.revision,receiptId:receipt,contextRef:a.context_ref,contextDigest,sequence:a.sequence,consentRevision:a.consent_revision,payloadHash,sensitivity:'normal'};
  return {job,source};
 }
 async drain(){
  await this.recover();if(this.busy)return {state:'idle',reason:'already_draining'};this.busy=true;let receipt,commitStarted=false;
  try{
   if(this.hasUnknown())return {state:'idle',reason:'unknown_outcome_requires_review'};
   if(this.config()?.enabled!==true||this.activation()?.active!==true)return {state:'idle',reason:'inactive'};
   await this.storage.transaction(async()=>{const row=this.rows("SELECT receipt_id FROM conversation_qq_outbox WHERE status='queued' ORDER BY sequence LIMIT 1")[0];if(row){receipt=row.receipt_id;this.rows("UPDATE conversation_qq_outbox SET status='sending' WHERE receipt_id=? AND status='queued'",receipt);}});
   if(!receipt)return {state:'idle',reason:'nothing_due'};
   await this.storage.sync();const first=await this.currentJob(receipt),prepared=await conversationQQRequest(this,'conversation_prepare',first);let result;
   if(prepared.state!=='prepared')result={state:'suppressed',reason:prepared.reason??'conversation_not_prepared'};
   else{
    const fresh=await this.currentJob(receipt);if(canonicalConversationContext(fresh.job)!==canonicalConversationContext(first.job))fail('conversation_authority_changed');
    commitStarted=true;result=await conversationQQRequest(this,'conversation_commit',{intentId:first.job.intentId,permit:{intentId:first.job.intentId,challenge:prepared.challenge,expiresAt:prepared.expiresAt,grantRevision:prepared.grantRevision,payloadHash:first.job.payloadHash},source:fresh.source});
    if(!['sent','not_sent','suppressed','uncertain'].includes(result?.state)||result.state==='sent'&&(result.reason!=='provider_accepted'||!valid(result.messageId)))result={state:'uncertain',reason:'conversation_provider_outcome_unknown'};
   }
   await this.storage.transaction(async()=>this.rows('UPDATE conversation_qq_outbox SET status=?,result=? WHERE receipt_id=?',result.state,JSON.stringify(result),receipt));return result;
  }catch(error){const result={state:commitStarted?'uncertain':'suppressed',reason:commitStarted?'conversation_bridge_outcome_unknown':['conversation_delivery_disabled','conversation_runtime_inactive','conversation_response_not_authorized','conversation_source_unverified','conversation_authority_changed'].includes(error?.code)?error.code:'conversation_preflight_unavailable'};if(receipt)await this.storage.transaction(async()=>this.rows('UPDATE conversation_qq_outbox SET status=?,result=? WHERE receipt_id=?',result.state,JSON.stringify(result),receipt));return result;}
  finally{this.busy=false;}
 }
}
