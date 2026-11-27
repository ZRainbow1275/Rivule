// First-party Aily Session -> Message -> Run contract. Isolated lab only.
// A host must compare-and-store each prepared state before sending its mockRequest.
const base='/open-apis/aily/v1/sessions';
const origin='https://open.feishu.cn';
const short=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(x);
const rid=(x,p)=>typeof x==='string'&&new RegExp('^'+p+'_[0-9a-hjkmnp-z]{1,24}$').test(x);
const app=x=>typeof x==='string'&&/^spring_[a-z0-9]{1,32}__c$/.test(x);
const hex=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
const sha=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
const trusted=b=>b?.provider==='feishu-aily'&&b.tokenKind==='verified-user'&&b.publicTextOnly===true&&b.noConnectedTools===true&&
 b.dedicatedSession===true&&short(b.tenantRef)&&short(b.userRef)&&short(b.lane)&&app(b.appId);
const scope=(b,t)=>[b.tenantRef,b.userRef,b.lane,b.appId,t];
const same=(b,j)=>trusted(b)&&short(j?.task)&&Array.isArray(j.scope)&&JSON.stringify(j.scope)===JSON.stringify(scope(b,j.task));
const request=(method,path,body)=>Object.freeze({origin,method,path,...(body?{body:Object.freeze(body)}:{})});
const next=(j,extra)=>Object.freeze({...j,...extra});
const ok=r=>r?.status===200&&r.json?.code===0?r.json.data:null;
const sid=s=>rid(s,'session'), mid=s=>rid(s,'message'), runid=s=>rid(s,'run');
const matchedRun=(b,j,r)=>r?.app_id===b.appId&&r?.session_id===j.sessionId&&runid(r.id);
const getMsg=(b,j,response)=>{const m=ok(response)?.message;
 return mid(m?.id)&&m.session_id===j.sessionId&&m.sender?.sender_type==='USER'&&m.sender.aily_id===b.userRef&&m.content_type==='TEXT'?m:null;};
export async function openAilyTrial({binding,task,inputDigest}){
 if(!trusted(binding)||!short(task)||!hex(inputDigest))throw new TypeError('invalid Aily binding');
 return Object.freeze({task,scope:Object.freeze(scope(binding,task)),inputDigest,state:'ready'});
}
export async function reserveAilyWrite({binding:b,entry:j,approvedText,at,manualReplay=false}){
 if(!same(b,j)||!Number.isSafeInteger(at)||at<0)throw new TypeError('invalid Aily operation');
 if(j.state==='ready'){
  const marker=await sha(JSON.stringify(['aily-session',j.scope]));
  return {entry:next(j,{state:'session_sending',marker,sentAt:at}),mockRequest:request('POST',base,{metadata:JSON.stringify({rivule:marker})})};
 }
 if(j.state==='session_recorded'||(manualReplay&&j.state==='message_verifying'&&j.replays===0)){
  if(!sid(j.sessionId)||typeof approvedText!=='string'||!approvedText.trim()||
   approvedText.length>3000||await sha(approvedText)!==j.inputDigest)throw new TypeError('changed Aily input');
  const marker='rv-'+(await sha(JSON.stringify(['aily-text',j.scope,j.sessionId]))).slice(0,32);
  const replay=j.state==='message_verifying';
  if(replay&&(!Number.isSafeInteger(j.sentAt)||at<j.sentAt||at-j.sentAt>=72*3600*1000||marker!==j.marker))
    return {entry:next(j,{state:'owner_review_no_resend'})};
  return {entry:next(j,{state:'message_sending',marker,replays:replay?1:0,sentAt:replay?j.sentAt:at}),
   mockRequest:request('POST',base+'/'+j.sessionId+'/messages',{idempotent_id:marker,content_type:'TEXT',content:approvedText})};
 }
 if(j.state==='message_recorded'&&mid(j.messageId)&&sid(j.sessionId)){
  const marker=await sha(JSON.stringify(['aily-run',j.scope,j.sessionId,j.messageId]));
  return {entry:next(j,{state:'run_sending',marker,sentAt:at}),
   mockRequest:request('POST',base+'/'+j.sessionId+'/runs',{app_id:b.appId,metadata:JSON.stringify({rivule:marker})})};
 }
 return {entry:j};
}
export async function observeAilyWrite({binding:b,entry:j,response}){
 if(!same(b,j))throw new TypeError('foreign Aily operation');
 if(j.state==='session_sending'){
  const x=ok(response)?.session;
  return sid(x?.id)&&x.created_by===b.userRef
   ?next(j,{state:'session_recorded',sessionId:x.id}):next(j,{state:'owner_review_no_resend'});
 }
 if(j.state==='message_sending'){
  const x=getMsg(b,j,response);
  return x&&typeof x.content==='string'&&await sha(x.content)===j.inputDigest
   ?next(j,{state:'message_recorded',messageId:x.id}):next(j,{state:'message_verifying'});
 }
 if(j.state==='run_sending'){
  const x=ok(response)?.run;
  return matchedRun(b,j,x)?next(j,{state:'run_recorded',runId:x.id}):next(j,{state:'run_verifying'});
 }
 return j;
}
export function planAilyRead({binding:b,entry:j}){
 if(!same(b,j)||!sid(j.sessionId))return [];
 const url=base+'/'+j.sessionId;
 if(j.state==='run_verifying')return [request('GET',url+'/runs?page_size=20')];
 if(j.state==='run_metadata_verifying'&&runid(j.candidateRunId))return [request('GET',url+'/runs/'+j.candidateRunId)];
 if(j.state==='run_recorded'&&runid(j.runId))return [request('GET',url+'/runs/'+j.runId)];
 if(j.state==='awaiting_artifact'&&runid(j.runId))return [request('GET',url+'/messages?page_size=20&with_partial_message=false&run_id='+j.runId)];
 return [];
}
export function reconcileAilyRun({binding:b,entry:j,response}){
 if(!same(b,j))throw new TypeError('foreign Aily operation');
 const data=ok(response);
 if(j.state==='run_verifying'){
  // List may omit metadata. Match a single exact marker if returned. A missing or
  // partial result is not evidence the original POST never committed.
  if(data?.has_more!==false||!Array.isArray(data.runs)||data.runs.length>20)return j;
  const inScope=data.runs.filter(r=>matchedRun(b,j,r));
  if(inScope.length!==1)return j;
  const r=inScope[0];
  return r.metadata===JSON.stringify({rivule:j.marker})?next(j,{state:'run_recorded',runId:r.id}):
   next(j,{state:'run_metadata_verifying',candidateRunId:r.id});
 }
 const r=data?.run;
 if(j.state==='run_metadata_verifying'){
  return matchedRun(b,j,r)&&r.id===j.candidateRunId&&r.metadata===JSON.stringify({rivule:j.marker})
   ?next(j,{state:'run_recorded',runId:r.id}):j;
 }
 if(j.state!=='run_recorded'||!matchedRun(b,j,r)||r.id!==j.runId)return j;
 if(r.status==='COMPLETED')return next(j,{state:'awaiting_artifact'});
 if(r.status==='REQUIRES_MESSAGE')return next(j,{state:'requires_owner_decision'});
 if(['EXPIRED','CANCELED','CANCELLED','FAILED'].includes(r.status))return next(j,{state:'terminal_needs_review'});
 return j;
}
export function projectAilyArtifact({binding:b,entry:j,response}){
 if(!same(b,j)||j.state!=='awaiting_artifact'||!runid(j.runId))return {state:'result_unverified'};
 const d=ok(response);
 if(d?.has_more!==false||!Array.isArray(d.messages)||d.messages.length>20)return {state:'result_unverified'};
 const candidates=d.messages.filter(m=>m.session_id===j.sessionId&&m.run_id===j.runId&&mid(m.id)&&
  m.sender?.sender_type==='ASSISTANT'&&['TEXT','MDX'].includes(m.content_type)&&typeof m.plain_text==='string'&&m.plain_text.trim()&&m.plain_text.length<=8000);
 if(candidates.length!==1)return {state:'result_unverified'};
 return {state:'artifact_pending_rivule_review',artifact:{messageId:candidates[0].id,text:candidates[0].plain_text}};
}
