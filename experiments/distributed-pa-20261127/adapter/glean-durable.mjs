// Glean official Platform Agents API, per-user published text Agent only.
// Inject an OAuth-authorized tenant-bound mock/client in the host, never a user URL.
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,90}$/.test(x);
const named=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9.:-]{0,95}$/.test(x);
const sha=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
const valid=(x)=>x?.provider==='glean-durable'&&x?.oauthMode==='verified-user'&&x?.agentType==='published-chat-text'&&
 x?.classification==='public-text'&&x?.retentionReviewed===true&&x?.writeToolsDisabled===true&&
 named(x.tenantRef)&&named(x.lane)&&id(x.agentId)&&/^[a-f0-9]{64}$/.test(x.inputDigest);
export async function dispatchGlean({commit,binding,task,fence,approvedText,transport,clock}){
 if(!valid(binding)||!named(task)||!Number.isSafeInteger(fence)||fence<1||
 typeof approvedText!=='string'||!approvedText.trim()||approvedText.length>3000||
 typeof commit!=='function'||typeof transport!=='function'||typeof clock!=='function')throw new TypeError('unauthorized Glean binding');
 const digest=await sha(approvedText);
 if(digest!==binding.inputDigest)throw new TypeError('changed input');
 const token=await sha(JSON.stringify([task,fence]));
 const started=await commit({type:'begin',id:'glean-begin-'+token,task,fence});
 const p=started?.permit;
 if(!started?.committed||!p)return {state:'already_reserved'};
 let runId=null;
 try{
  if(p.task!==task||p.fence!==fence||p.inputDigest!==digest||p.provider!==binding.provider||
     p.lane!==binding.lane||clock()>=p.expiresAt)throw Error('expired or mismatched send');
  const r=await transport({method:'POST',tenantRef:binding.tenantRef,
    path:'/api/agents/'+binding.agentId+'/runs',body:{execution_mode:'DURABLE',stream:false,
      messages:[{role:'USER',content:[{type:'text',text:approvedText}]}]} });
  if(r?.status===201&&r.json?.run?.agent_id===binding.agentId&&id(r.json.run.run_id))runId=r.json.run.run_id;
 }catch{/* A lost create response can leave a billable run. Never retry. */}
 try{
  const r=await commit({type:runId?'acknowledged':'uncertain',id:'glean-observed-'+token,task,fence,...(runId?{receipt:runId}:{})});
  return {state:r?.committed&&runId?'provider_acknowledged':'verify_original_attempt'};
 }catch{return {state:'verify_original_attempt'};}
}
export async function readGlean({binding,receipt,transport}){
 if(!valid(binding)||!id(receipt?.runId)||receipt.agentId!==binding.agentId||
  receipt.tenantRef!==binding.tenantRef||receipt.lane!==binding.lane||typeof transport!=='function')throw new TypeError('unverified original run');
 const r=await transport({method:'GET',tenantRef:binding.tenantRef,path:'/api/agents/'+binding.agentId+'/runs/'+receipt.runId});
 const v=r?.json?.run;
 if(r?.status!==200||v?.run_id!==receipt.runId||v.agent_id!==receipt.agentId)return {state:'verify_original_attempt'};
 if(v.state==='REQUIRES_INPUT')return {state:'requires_owner_decision'};
 if(v.state==='SUCCEEDED')return {state:'result_available_for_review'};
 if(['FAILED','CANCELLED','CANCELED'].includes(v.state))return {state:'terminal_status_needs_evidence'};
 return {state:v.state==='RUNNING'?'running':'verify_original_attempt'};
}
