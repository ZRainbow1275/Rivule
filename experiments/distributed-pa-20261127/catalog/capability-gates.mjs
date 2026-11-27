// A provider catalog is capability evidence, not an authorization table.
const modes=new Set(['push','pull','read','handoff','observe']);
const stages=new Set(['documented','mock-tested','unverified','retired']);
const vocab=new Set(['consumer','enterprise','self-hosted','platform','protocol']);
const regionSet=new Set(['cn-mainland','hk','mo','tw','us','sg','jp','kr','au','ca','gb','de','fr','ie','nl','eu-eea','ch','in','br']);
const identifier=x=>typeof x==='string'&&/^[a-z0-9][a-z0-9._-]{1,78}$/.test(x);
const effects=new Set(['research-public-text','read-status','manual-copy']);
const validUrl=s=>{try{const u=new URL(s);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}};
const checked=(ok,n)=>{if(!ok)throw new TypeError(n);};
const exactKeys=(x,k)=>x&&typeof x==='object'&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).length===k.length&&k.every(y=>Object.hasOwn(x,y));
const supported=(a,s)=>Array.isArray(a)&&a.every(x=>s.has(x))&&new Set(a).size===a.length;
export function validateCatalog(rows){
 checked(Array.isArray(rows)&&rows.length<=350,'invalid catalog');
 const result=new Map();
 for(const r of rows){
  checked(exactKeys(r,['id','name','type','market','reviewed','routes','official','limits'])&&identifier(r.id)&&!result.has(r.id)&&
   typeof r.name==='string'&&r.name.trim()&&r.name.length<=100&&vocab.has(r.type)&&['cn','global','both'].includes(r.market)&&
   /^\d{4}-\d{2}-\d{2}$/.test(r.reviewed)&&Array.isArray(r.routes)&&r.routes.length>0&&
   Array.isArray(r.official)&&r.official.length>0&&r.official.every(validUrl)&&
   Array.isArray(r.limits)&&r.limits.every(x=>typeof x==='string'&&x.length>0&&x.length<=250),'invalid provider row');
  const seen=new Set();
  for(const d of r.routes){
   checked(exactKeys(d,['mode','stage','effect','liveTested'])&&modes.has(d.mode)&&!seen.has(d.mode)&&stages.has(d.stage)&&
    effects.has(d.effect)&&d.liveTested===false,'invalid route');
   const allowed=d.mode==='observe'|| d.mode==='handoff'&&d.effect==='manual-copy'||d.mode==='read'&&d.effect==='read-status'||
    ['push','pull'].includes(d.mode)&&d.effect==='research-public-text';
   checked(allowed,'mode/effect mismatch');seen.add(d.mode);
  }
  result.set(r.id,structuredClone(r));
 }
 return result;
}
export function gateRoute({row,mode,binding,approval}){
 const route=row?.routes?.find(r=>r.mode===mode);
 if(!route||['observe','handoff'].includes(mode)||['retired','unverified'].includes(route.stage))
  return {state:'not_automatable'};
 if(!binding||binding.product!==row.id||binding.mode!==mode||binding.verifiedIdentity!==true||!identifier(binding.lane))
  return {state:'needs_bound_account'};
 if(binding.regionReviewed!==true||!supported(binding.regions,regionSet)||!binding.regions.length||
  !supported(approval?.regions,regionSet)||!binding.regions.every(x=>approval.regions.includes(x)))
  return {state:'needs_data_region_review'};
 if(binding.costReviewed!==true||binding.writeToolsDisabled!==true||approval?.effect!==route.effect)
  return {state:'needs_scope_or_budget_review'};
 // This lab does not return a live execution permit: that happens only in an
 // independently approved coordinator CAS after a production host verifies it.
 return {state:route.stage==='mock-tested'?'eligible_for_explicit_live_trial':'needs_adapter_tests'};
}
