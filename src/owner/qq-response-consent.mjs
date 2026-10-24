import {BridgeError} from './message-bridge.mjs';
const enc=new TextEncoder();
const hex=v=>[...new Uint8Array(v)].map(n=>n.toString(16).padStart(2,'0')).join('');
const digest=async v=>hex(await crypto.subtle.digest('SHA-256',enc.encode(v)));
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const stable=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(stable):Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
async function key(secret){if(typeof secret!=='string'||secret.length<32)throw Error('authority_unavailable');return crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export async function signQQAuthority(secret,domain,value){const body=JSON.stringify(value);return {body,signature:hex(await crypto.subtle.sign('HMAC',await key(secret),enc.encode(domain+'\n'+body)))};}
export class QQResponseConsent {
 constructor({storage,bridge,now=Date.now}){Object.assign(this,{storage,bridge,now});}
 rows(q,...args){return this.storage.sql.exec(q,...args).toArray();}
 exists(){return !!this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='bridge_qq_response_consent'").length;}
 initialize(){this.storage.sql.exec('CREATE TABLE IF NOT EXISTS bridge_qq_response_consent(source_id TEXT PRIMARY KEY,binding TEXT NOT NULL,enabled INTEGER NOT NULL,revision INTEGER NOT NULL,target TEXT,start_after_revision INTEGER NOT NULL,updated_at REAL NOT NULL)');}
 target(value){if(!value||value.active!==true||value.ownerId!==this.bridge.bindings.ownerId||!['appId','userOpenId','bindingFingerprint'].every(k=>typeof value[k]==='string'&&value[k].length>0&&value[k].length<=1024)||!Number.isFinite(value.validUntil)||value.validUntil<=this.now())throw new BridgeError('qq_response_target_unavailable',409);return {ownerId:value.ownerId,appId:value.appId,userOpenId:value.userOpenId,bindingFingerprint:value.bindingFingerprint};}
 status(source){this.bridge.source(source);const row=this.exists()?this.rows('SELECT * FROM bridge_qq_response_consent WHERE source_id=?',source.source_id)[0]:null;const binding=this.bridge.binding(source);return {enabled:row?.binding===binding&&row.enabled===1,revision:row?.revision??0,channel:'qq',category:'user_visible_response',recipient_label:row?.target?'本人 QQ · 已确认绑定（账号已隐藏）':null,persistence:'until_owner_revokes',source_mode_required:'every_response'};}
 async set(source,{enabled,expected_revision,confirm,target,expected_binding},admissionGuard){
  if(typeof enabled!=='boolean'||!Number.isSafeInteger(expected_revision)||confirm!==true)throw new BridgeError('invalid_qq_response_consent');
  const destination=enabled?this.target(target):null;
  if(enabled&&this.bridge.preference(source).mode!=='every_response')throw new BridgeError('every_response_not_enabled',409);
  this.initialize();return this.storage.transaction(async()=>{if(admissionGuard)await admissionGuard();if(expected_binding!==undefined&&expected_binding!==this.bridge.binding(source))throw new BridgeError('bridge_authority_changed',409);const status=this.status(source);if(status.revision!==expected_revision)throw new BridgeError('qq_response_consent_conflict',409);this.rows('INSERT INTO bridge_qq_response_consent VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET binding=excluded.binding,enabled=excluded.enabled,revision=excluded.revision,target=excluded.target,start_after_revision=excluded.start_after_revision,updated_at=excluded.updated_at',source.source_id,this.bridge.binding(source),enabled?1:0,status.revision+1,destination?JSON.stringify(destination):null,this.bridge.has('events')?this.rows('SELECT COALESCE(MAX(revision),0) AS revision FROM events')[0].revision:0,this.now());return this.status(source);});
 }
 authorized(source,target,revision){if(!this.status(source).enabled)return false;const row=this.rows('SELECT target,start_after_revision FROM bridge_qq_response_consent WHERE source_id=?',source.source_id)[0];return Number.isSafeInteger(revision)&&revision>row.start_after_revision&&row?.target===JSON.stringify({ownerId:target.ownerId,appId:target.appId,userOpenId:target.userOpenId,bindingFingerprint:target.bindingFingerprint});}
}
// Read-only signed verification, callable only through a fixed configured service
// binding. A producer-signed request never creates or changes owner consent.
export async function qqResponseAuthorityResponse(request,{secret,enabled,ownerId,appId,consent,bridge,loadJob,now=Date.now}){
 const fail=()=>Response.json({error:'response_authority_unavailable'},{status:403,headers:{'cache-control':'no-store'}});
 if(!enabled||request.method!=='POST'||request.url!=='https://rivule-owner.internal/internal/qq-response-authority')return fail();
 try{
  if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return fail();
  const reader=request.body?.getReader();if(!reader)return fail();let size=0,chunks=[];
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>32768){await reader.cancel();return fail();}chunks.push(value);}
  const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}
  const packet=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!exact(packet,['body','signature'])||typeof packet.body!=='string'||packet.body.length>24576||!/^[a-f0-9]{64}$/.test(packet.signature??''))return fail();
  if(!await crypto.subtle.verify('HMAC',await key(secret),Uint8Array.from(packet.signature.match(/../g),v=>parseInt(v,16)),enc.encode('rivule-qq-response-authority-request-v1\n'+packet.body)))return fail();
  const e=JSON.parse(packet.body);
  if(!exact(e,['version','nonce','timestamp','ownerId','appId','userOpenId','bindingFingerprint','runtimeEpoch','grantId','job'])||e.version!==1||e.ownerId!==ownerId||e.appId!==appId||!/^[a-f0-9]{64}$/.test(e.nonce??'')||!Number.isSafeInteger(e.timestamp)||Math.abs(now()-e.timestamp)>30000)return fail();
  const source=bridge.bindings.sources.find(s=>s.source_id===e.job?.sourceId);
  let authorized=false;
  if(source&&e.job?.contentKind==='bridge_response'&&e.job.grantId===e.grantId&&e.job.bindingFingerprint===e.bindingFingerprint&&consent.authorized(source,e,e.job.responseRevision)){
   const first=consent.status(source),stored=await loadJob(e.job.receiptId);
   // Recheck after any async hashing, closing revoke/config changes during verification.
   authorized=!!stored&&JSON.stringify(stable(stored.job))===JSON.stringify(stable(e.job))&&consent.status(source).revision===first.revision&&consent.authorized(source,e,e.job.responseRevision)&&!!bridge.responseAuthority(source,e.job.receiptId);
  }
  const value={version:1,requestHash:await digest(packet.body),nonce:e.nonce,authorized,validUntil:Math.min(e.timestamp+30000,now()+10000)};
  return Response.json(await signQQAuthority(secret,'rivule-qq-response-authority-response-v1',value),{headers:{'cache-control':'no-store'}});
 }catch{return fail();}
}
