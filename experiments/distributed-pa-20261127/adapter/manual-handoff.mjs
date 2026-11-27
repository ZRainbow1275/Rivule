// Share a bounded text brief by intentional copy/paste; no background sends.
// This path does not synthesize provider evidence, run IDs, or accepted status.
const token=x=>typeof x==='string'&&/^[A-Za-z0-9._:-]{1,96}$/.test(x);
const sum=async x=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x))),a=>a.toString(16).padStart(2,'0')).join('');
const fail=x=>{throw new TypeError(x)};
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const body=(x,max)=>typeof x==='string'&&x.trim().length>0&&x.length<=max;
export async function buildManualBrief({authorization,route,text}){
 const a=authorization;
 if(!token(route)||!token(a?.board)||!token(a?.task)||!token(a?.subject)||a.channel!==route||
  a.effect!=='manual-copy'||a.classification!=='public-text'||a.explicitCopyAllowed!==true||
  !digest(a.inputDigest)||!body(text,3000))fail('needs explicit scoped public brief');
 if(await sum(text)!==a.inputDigest)fail('approved brief changed');
 // Draft contains only the approved outward text and a standard format;
 // no house task id, binding, region, account token, hidden notes, or logs.
 const draft=text+'\n\n请提供能复核的结果和公开来源；缺证据的地方留空。';
 return {status:'awaiting_user_copy',draft,proof:{inputDigest:a.inputDigest,exportDigest:await sum(draft)}};
}
export async function prepareManualCandidate({authorization,route,briefProof,result,provenance}){
 const a=authorization;
 if(!token(route)||!token(a?.board)||!token(a?.task)||!token(a?.subject)||a.channel!==route||
  a.effect!=='manual-return'||a.classification!=='public-text'||a.explicitImportAllowed!==true||
  !digest(a.inputDigest)||briefProof?.inputDigest!==a.inputDigest||!digest(briefProof?.exportDigest)||
  a.exportDigest!==briefProof.exportDigest||provenance!=='user_pasted_unverified'||!body(result,8000))
   fail('unverified or out-of-scope manual return');
 return {status:'manual_candidate_for_owner_review',providerEvidence:false,accepted:false,
   board:a.board,task:a.task,artifactDigest:await sum(result),source:'user_pasted_unverified'};
}
