// Owner-local unbound intent only. No account, metric, quota or operational policy.
const KEY='usage-preferences:unbound:v1';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const percentage=v=>Number.isInteger(v)&&v>=1&&v<=100;
export class UsagePreferenceError extends Error {constructor(code,status=409){super(code);this.code=code;this.status=status;}}
const fail=(code,status)=>{throw new UsagePreferenceError(code,status);};
export function createUnboundUsagePreferenceController({storage,getContext,now}){
 const context=async()=>{const c=await getContext(),at=now();if(!integer(at)||!c||c.authorized!==true||!integer(c.authorization_expires_at)||c.authorization_expires_at<=at||!id(c.owner_binding)||!id(c.session_binding))fail('management_authorization_required',403);return {owner_binding:c.owner_binding,session_binding:c.session_binding,authorization_expires_at:c.authorization_expires_at};};
 const same=async c=>{if(JSON.stringify(await context())!==JSON.stringify(c))fail('management_authorization_changed',403);};
 const decode=(record,c)=>{if(record===undefined||record===null)return null;if(!exact(record,['version','revision','owner_binding','threshold_percent'])||record.version!==1||!integer(record.revision)||record.revision<1||!id(record.owner_binding)||!percentage(record.threshold_percent))fail('stored_preference_invalid',503);if(record.owner_binding!==c.owner_binding)fail('stored_preference_binding_changed');return {...record};};
 const view=r=>({revision:r?.revision??0,draft:r?{threshold_percent:r.threshold_percent}:null,state:'unbound_draft',monitoring:'not_connected',notifications_enabled:false,usage:null,quota:null});
 const guard=async fn=>{try{return await fn();}catch(e){if(e instanceof UsagePreferenceError)throw e;throw new UsagePreferenceError('preference_unavailable',503);}};
 return Object.freeze({read:()=>guard(async()=>{const c=await context(),r=decode(await storage.get(KEY),c);await same(c);return view(r);}),saveDraft:body=>guard(async()=>{
  if(!exact(body,['expected_revision','threshold_percent']))fail('invalid_request',422);
  // Capture caller-owned input before any await; validate exactly what will be saved.
  const {expected_revision,threshold_percent}=body;
  if(!integer(expected_revision)||!percentage(threshold_percent))fail('invalid_request',422);
  const c=await context();return storage.transaction(async tx=>{const r=decode(await tx.get(KEY),c);await same(c);if(expected_revision!==(r?.revision??0))fail('revision_conflict');const revision=(r?.revision??0)+1;if(!integer(revision))fail('revision_capacity');const saved={version:1,revision,owner_binding:c.owner_binding,threshold_percent};await tx.put(KEY,saved);await same(c);return view(saved);});
 })});
}
