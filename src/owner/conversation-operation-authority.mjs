import {configuredConversationGrant} from './conversation-source-contract.mjs';
const stable=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(stable):Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
// Config changes are observed on mutation/alarm only. Reads never initialize or
// rewrite authority. Once revoked/changed, an observed revision cannot be reused.
export class ConversationOperationAuthority {
 constructor({storage,raw,sources,proof}){Object.assign(this,{storage,raw,sources,proof});}
 rows(q,...a){return this.storage.sql.exec(q,...a).toArray();}
 has(){return this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_v2_operation_authority'").length>0;}
 configured(){let list;try{list=JSON.parse(this.raw()??'[]');}catch{return [];}
  const fields=['source_id','provider_id','account_binding','generation','revision','operations','enabled'];
  if(!Array.isArray(list)||list.length>16||list.some(v=>!v||typeof v!=='object'||Object.keys(v).length!==fields.length||!fields.every(k=>Object.hasOwn(v,k)))||new Set(list.map(v=>v.source_id)).size!==list.length)return [];
  return list;
 }
 reconcile(){
  if(!this.raw()&&!this.has())return;
  this.storage.sql.exec('CREATE TABLE IF NOT EXISTS conversation_v2_operation_authority(source_id TEXT PRIMARY KEY,max_revision INTEGER NOT NULL,fingerprint TEXT NOT NULL,revoked INTEGER NOT NULL)');
  const list=this.configured(),existing=this.rows('SELECT * FROM conversation_v2_operation_authority');
  for(const old of existing){if(!list.some(g=>g.source_id===old.source_id))this.rows('UPDATE conversation_v2_operation_authority SET revoked=1 WHERE source_id=?',old.source_id);}
  for(const g of list){
   if(typeof g.source_id!=='string'||!Number.isSafeInteger(g.revision)||g.revision<1)continue;
   const old=existing.find(r=>r.source_id===g.source_id),fingerprint=JSON.stringify(stable(g)),source=this.sources.find(s=>s.source_id===g.source_id);
   const valid=!!source?.enabled&&source.provider===g.provider_id&&g.enabled===true;
   if(!old)this.rows('INSERT INTO conversation_v2_operation_authority VALUES(?,?,?,?)',g.source_id,g.revision,fingerprint,valid?0:1);
   else if(g.revision>old.max_revision)this.rows('UPDATE conversation_v2_operation_authority SET max_revision=?,fingerprint=?,revoked=? WHERE source_id=?',g.revision,fingerprint,valid?0:1,g.source_id);
   else if(g.revision!==old.max_revision||fingerprint!==old.fingerprint||!valid)this.rows('UPDATE conversation_v2_operation_authority SET revoked=1 WHERE source_id=?',g.source_id);
  }
 }
 resolve(source){return this.resolveConfigured(source,this.proof(source));}
 resolveConfigured(source,proof){
  if(!this.has())return null;
  const g=configuredConversationGrant(this.raw(),source,proof);if(!g)return null;
  const row=this.rows('SELECT * FROM conversation_v2_operation_authority WHERE source_id=?',source.source_id)[0];
  return row&&row.revoked===0&&row.max_revision===g.revision&&row.fingerprint===JSON.stringify(stable(g))?g:null;
 }
}
