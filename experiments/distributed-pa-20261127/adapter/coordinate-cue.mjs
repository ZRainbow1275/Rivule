// Server-only interop seam; the injected ledger API owns the authenticated CAS.
// Never invoke on replay or automatically retry a provider write.
const hex = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))), b=>b.toString(16).padStart(2,'0')).join('');
export async function coordinateCue({commit, adapter, task, fence, packet, authorization, clock}) {
 if(typeof commit!=='function'||typeof clock!=='function'||typeof adapter?.dispatch!=='function'||
    !Number.isSafeInteger(fence)||fence<1||typeof packet?.text!=='string'||!packet.text.trim()||packet.text.length>3000||
    packet.text.includes('[rivule-attempt:')||authorization?.fact!=='authorized-text-only'||
    typeof authorization.agentId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(authorization.agentId)||
    typeof authorization.lane!=='string'||!authorization.lane)throw new TypeError('invalid server dispatch binding');
 const digest=await hex(packet.text);
 if(digest!==authorization.inputDigest)throw new TypeError('packet differs from approved digest');
 const token=await hex(JSON.stringify([task,fence]));
 const begin=await commit({type:'begin',id:'cue-begin-'+token,task,fence});
 // commit must be an authenticated atomically inserted transaction, not a plain reducer.
 const p=begin?.permit;
 if(!begin?.committed||!p)return {state:'not_sent_by_this_invocation'};
 let result={state:'unknown'};
 try{
  if(p.provider!=='cue'||p.task!==task||p.fence!==fence||
     p.lane!==authorization.lane||p.inputDigest!==digest||clock()>=p.expiresAt)
   throw new Error('mismatched or expired intent');
  const attemptRef=await hex(p.key);
  if(clock()>=p.expiresAt)throw new Error('expired before send');
  result=await adapter.dispatch({agentId:authorization.agentId,attemptRef,approvedText:packet.text,approval:authorization.fact});
 }catch{/* Leave an explicit needs_review decision rather than claiming absence. */}
 const validId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,96}$/.test(v);
 const ok=result?.state==='delivered'&&validId(result.requestId);
 const hold=(result?.state==='owner_review'&&validId(result.requestId)||['throttled','rejected'].includes(result?.state))
   ?result.state:null;
 const decision={type:ok?'acknowledged':hold?'delivery_hold':'uncertain',id:'cue-observed-'+token,task,fence,
  ...(ok?{receipt:result.requestId}:hold?{deliveryState:hold,providerRequestId:hold==='owner_review'?result.requestId:null}:{})};
 try {
  const recorded=await commit(decision);
  return {state:recorded?.committed?(ok?'accepted_by_provider':hold??'needs_review'):'verify_original_attempt'};
 }catch{return {state:'verify_original_attempt'};}
}
