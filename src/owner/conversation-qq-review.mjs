// Owner-only metadata acknowledgement. Never certifies delivery, sends a message,
// resumes a runtime or modifies the original uncertain receipt.
import {canonicalConversationContext as canonical,conversationQQRequest} from './conversation-qq-queue.mjs';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const hash=async v=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)))].map(n=>n.toString(16).padStart(2,'0')).join('');
const fail=code=>{throw Object.assign(new Error(code),{code,status:409});};
const same=(a,b)=>canonical(a)===canonical(b);
export class ConversationQQReview {
 constructor({storage,queue,currentOwnerState,gateway=(op,payload)=>conversationQQRequest(queue,op,payload),now=Date.now,random=()=>crypto.randomUUID()}){Object.assign(this,{storage,queue,currentOwnerState,gateway,now,random});}
 rows(q,...a){return this.storage.sql.exec(q,...a).toArray();}
 has(){return this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_qq_reviews'").length>0;}
 initialize(){this.storage.sql.exec('CREATE TABLE IF NOT EXISTS conversation_qq_reviews(review_id TEXT PRIMARY KEY,receipt_id TEXT NOT NULL,scope_hash TEXT NOT NULL,snapshot TEXT NOT NULL,state TEXT NOT NULL,expires_at REAL NOT NULL,payload TEXT,result TEXT,created_at REAL NOT NULL,updated_at REAL NOT NULL,confirmed_at REAL,authorized_until REAL);CREATE TABLE IF NOT EXISTS conversation_qq_reviewed(receipt_id TEXT PRIMARY KEY,review_id TEXT UNIQUE NOT NULL,scope_hash TEXT NOT NULL,reviewed_at REAL NOT NULL,sequence_floor INTEGER NOT NULL)');}
 one(id){return this.has()?this.rows('SELECT * FROM conversation_qq_reviews WHERE review_id=?',id)[0]??null:null;}
 pending(receipt,exclude=''){return this.has()?this.rows("SELECT review_id FROM conversation_qq_reviews WHERE receipt_id=? AND review_id<>? AND state IN ('confirmed','readback','blocked') LIMIT 1",receipt,exclude)[0]??null:null;}
 async identity(receipt){if(!uuid(receipt))fail('conversation_review_receipt_invalid');return {intentId:await hash('rivule-conversation-qq-v2\n'+receipt),receiptId:receipt};}
 maxSequence(){return this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_v2_responses'").length?this.rows('SELECT COALESCE(MAX(sequence),0) AS n FROM conversation_v2_responses')[0].n:0;}
 async snapshot(receipt,status){
  const row=this.queue.unknownReceipts().find(r=>r.receipt_id===receipt);if(!row||status?.state!=='reviewable'||!status.scope||!Number.isFinite(status.validUntil)||status.validUntil<=this.now())fail('conversation_review_unavailable');
  const identity=await this.identity(receipt),scope=status.scope;
  if(scope.intentId!==identity.intentId||scope.receiptId!==receipt||scope.sourceId!==row.source_id||scope.sequence!==row.sequence||scope.consentRevision!==row.consent_revision||typeof status.snapshotDigest!=='string'||!/^[a-f0-9]{64}$/.test(status.snapshotDigest))fail('conversation_review_scope_mismatch');
  const owner=await this.currentOwnerState(row.source_id,row,scope);
  let original;try{original=JSON.parse(row.binding);}catch{fail('conversation_review_identity_unavailable');}
  if(!Array.isArray(original)||scope.sourceGeneration!==original[3]||scope.sourceGrantRevision!==original[4]||scope.sourceBindingDigest!==await hash(row.binding))fail('conversation_review_original_binding_mismatch');
  const destination=JSON.stringify([scope.ownerId,scope.appId,scope.userOpenId,scope.bindingFingerprint]);
  if(!owner||!Array.isArray(original)||owner.sourceId!==original[0]||owner.providerId!==original[1]||owner.accountBinding!==original[2]||owner.generation!==original[3]||owner.sourceId!==row.source_id||owner.recipient!==row.recipient||owner.recipient!==destination||!Number.isSafeInteger(owner.grantRevision)||!Number.isSafeInteger(owner.consentRevision)||typeof owner.sourceBinding!=='string'||!['sourceEnabled','consentEnabled','commandsEnabled'].every(k=>typeof owner[k]==='boolean')||!Number.isFinite(owner.verifiedAt)||owner.verifiedAt>this.now())fail('conversation_review_identity_changed');
  const {verifiedAt,...current}=owner; // Fresh evidence may refresh without changing authorization.
  return {original:row,current,gatewayScope:scope,gatewayDigest:status.snapshotDigest,unknownSet:this.queue.unknownReceipts().map(r=>({receipt:r.receipt_id,binding:r.binding,recipient:r.recipient,consent:r.consent_revision,result:r.result})),maxSequence:this.maxSequence()};
 }
 async preview(receipt){
  if(this.pending(receipt))fail('conversation_review_already_pending');
  await this.queue.recover();const id=await this.identity(receipt),status=await this.gateway('conversation_review_status',id),snapshot=await this.snapshot(receipt,status),scopeHash=await hash(canonical(snapshot));
  this.initialize();return this.storage.transaction(async()=>{
   if(!same(await this.snapshot(receipt,status),snapshot))fail('conversation_review_changed');
   if(this.pending(receipt))fail('conversation_review_already_pending');
   this.rows("DELETE FROM conversation_qq_reviews WHERE state='prepared' AND confirmed_at IS NULL AND expires_at<=?",this.now());
   if(this.rows('SELECT COUNT(*) AS n FROM conversation_qq_reviews')[0].n>=1000)fail('conversation_review_capacity');
   const reviewId=this.random(),expiresAt=Math.min(this.now()+300000,status.validUntil);if(!uuid(reviewId))fail('conversation_review_id_invalid');
   this.rows('INSERT INTO conversation_qq_reviews VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL)',reviewId,receipt,scopeHash,JSON.stringify(snapshot),'prepared',expiresAt,null,null,this.now(),this.now());
   return {review_id:reviewId,receipt_id:receipt,scope:scopeHash,expires_at:expiresAt,state:'confirmation_required',scope_summary:{source_id:snapshot.original.source_id,original_source_generation:JSON.parse(snapshot.original.binding)[3],current_source_generation:snapshot.current.generation,original_grant_revision:JSON.parse(snapshot.original.binding)[4],current_grant_revision:snapshot.current.grantRevision,original_consent_revision:snapshot.original.consent_revision,current_consent_revision:snapshot.current.consentRevision,current_consent_enabled:snapshot.current.consentEnabled,evidence_kind:'persisted_lineage_not_live_ownership'},delivery_resumed:false,old_receipt_retried:false,text:'仅记录你已核对这条结果未知的消息。原消息仍未知且不会重发；之前等待的消息会跳过。之后的新消息仍须通过原有授权和 QQ 开启流程。'};
  });
 }
 report(row){return {review_id:row.review_id,receipt_id:row.receipt_id,state:row.state==='reviewed'?'reviewed':row.state==='prepared'?'confirmation_required':row.state==='blocked'?'blocked':'readback_required',delivery_resumed:false,old_receipt_retried:false,original_delivery:'unknown',next_step:row.state==='reviewed'?'existing_owner_qq_enable':row.state==='blocked'?'manual_reconciliation_required':'owner_review_readback'};}
 async confirm(reviewId,scopeHash,admissionGuard){
  let row=this.one(reviewId);if(!row||row.scope_hash!==scopeHash)fail('conversation_review_not_found');
  if(row.state!=='prepared')return this.report(row);
  if(this.pending(row.receipt_id,reviewId))fail('conversation_review_already_pending');
  if(row.expires_at<=this.now()||typeof admissionGuard!=='function')fail('conversation_review_confirmation_required');
  const status=await this.gateway('conversation_review_status',await this.identity(row.receipt_id)),snapshot=await this.snapshot(row.receipt_id,status);
  if(!same(snapshot,JSON.parse(row.snapshot)))fail('conversation_review_changed');
  const payload={...await this.identity(row.receipt_id),reviewId,snapshotDigest:status.snapshotDigest,sequenceFloor:snapshot.maxSequence};
  await this.storage.transaction(async()=>{
   await admissionGuard();const current=this.one(reviewId);if(current?.state!=='prepared'||current.expires_at<=this.now()||!same(await this.snapshot(row.receipt_id,status),snapshot))fail('conversation_review_changed');
   if(this.pending(row.receipt_id,reviewId))fail('conversation_review_already_pending');
   if(this.one(reviewId)?.state!=='prepared')fail('conversation_review_changed');
   this.rows("UPDATE conversation_qq_reviews SET state='confirmed',payload=?,updated_at=?,confirmed_at=?,authorized_until=? WHERE review_id=?",JSON.stringify(payload),this.now(),this.now(),Math.min(this.now()+30000,current.expires_at),reviewId);
  });
  try{await this.storage.sync();}catch{
   await this.storage.transaction(async()=>this.rows("UPDATE conversation_qq_reviews SET state='blocked',result=?,updated_at=? WHERE review_id=?",JSON.stringify({reason:'local_review_not_dispatched'}),this.now(),reviewId));
   return this.report(this.one(reviewId));
  } // Persist explicit owner intent before a remote mutation.
  let result;
  try{result=await this.gateway('conversation_review',payload);}
  catch{await this.markReadback(reviewId);return this.report(this.one(reviewId));}
  return this.settle(reviewId,result);
 }
 async markReadback(id){await this.storage.transaction(async()=>{this.rows("UPDATE conversation_qq_reviews SET state='readback',updated_at=? WHERE review_id=? AND state='confirmed'",this.now(),id);});}
 // Read-only independent verifier API for main's signed fixed service endpoint.
 async reviewAuthority(reviewId,scope,payload){return this.validateConfirmed(this.one(reviewId),scope,payload,true);}
 async validateConfirmed(row,scope,payload,authorizationWindow){
  if(!row||!['confirmed','readback'].includes(row.state)||!same(JSON.parse(row.payload??'null'),payload)||authorizationWindow&&(!Number.isFinite(row.confirmed_at)||!Number.isFinite(row.authorized_until)||row.confirmed_at>this.now()||row.authorized_until<=this.now()))return false;
  const saved=JSON.parse(row.snapshot);if(!same(saved.gatewayScope,scope))return false;
  try{const current=await this.snapshot(row.receipt_id,{state:'reviewable',scope,snapshotDigest:saved.gatewayDigest,validUntil:this.now()+1000});
   // New responses during review are suppressed, never included in a send backlog.
   return same({...current,maxSequence:saved.maxSequence},{...saved,maxSequence:saved.maxSequence});
  }catch{return false;}
 }
 async readback(reviewId){
  const row=this.one(reviewId);if(!row)fail('conversation_review_not_found');if(!['confirmed','readback'].includes(row.state))return this.report(row);
  // Never repeat conversation_review after a lost response or process restart.
  let result;try{result=await this.gateway('conversation_review_status',await this.identity(row.receipt_id));}catch{return this.report(row);}
  return this.settle(reviewId,result);
 }
 async settle(reviewId,result){
  const row=this.one(reviewId);if(!row)return fail('conversation_review_not_found');if(row.state==='reviewed')return this.report(row);
  const saved=JSON.parse(row.snapshot),payload=JSON.parse(row.payload??'null');
  if(result?.state!=='reviewed'||result.reviewId!==reviewId||result.snapshotDigest!==payload?.snapshotDigest||result.sequenceFloor!==payload?.sequenceFloor||!same(result.scope,saved.gatewayScope)||result.delivery_resumed!==false){await this.markReadback(reviewId);return this.report(this.one(reviewId));}
  await this.storage.transaction(async()=>{
   const current=this.one(reviewId);if(!['confirmed','readback'].includes(current.state))return;
   if(!await this.validateConfirmed(current,result.scope,payload,false)){this.rows("UPDATE conversation_qq_reviews SET state='blocked',result=?,updated_at=? WHERE review_id=?",JSON.stringify({reason:'owner_scope_changed_after_gateway_review'}),this.now(),reviewId);return;}
   const floor=this.maxSequence();
   this.rows("UPDATE conversation_qq_outbox SET status='suppressed',result=? WHERE status='queued' AND sequence<=?",JSON.stringify({state:'suppressed',reason:'owner_review_skips_backlog'}),floor);
   this.rows('INSERT INTO conversation_qq_reviewed VALUES(?,?,?,?,?)',row.receipt_id,reviewId,row.scope_hash,this.now(),floor);
   this.rows("UPDATE conversation_qq_reviews SET state='reviewed',result=?,updated_at=? WHERE review_id=?",JSON.stringify({state:'reviewed',delivery_resumed:false,original_delivery:'unknown',sequence_floor:floor}),this.now(),reviewId);
  });return this.report(this.one(reviewId));
 }
}
