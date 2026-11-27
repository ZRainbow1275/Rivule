// Offline, no credentials, fetch, or side effects. Use only after a durable CAS
// creates/consumes an original operation in a separately bound host.
const ref=s=>typeof s==='string'&&/^[a-zA-Z0-9_-]{1,96}$/.test(s);
const digest=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const time=Number.isSafeInteger;
const sha=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
const valid=b=>b?.provider==='openassistant-rest'&&b.keyMode==='verified-user-key'&&b.dedicated===true&&b.connectionsDisabled===true&&
 b.scope==='public-text'&&ref(b.ownerRef)&&ref(b.assistantRef)&&ref(b.lane);
function authorizedProcess(p,binding,root){
 return p?.state==='task_created'&&p.journalVerified===true&&p.root===root&&p.ownerRef===binding.ownerRef&&
 p.assistantRef===binding.assistantRef&&p.lane===binding.lane&&ref(p.taskId)&&p.verifiedNoExecution===true&&p.explicitProcessApproval===true;
}
export async function prepareOpenAssistant({binding,root,phase,approvedText,approvedDigest,created,clock}){
 if(!valid(binding)||!ref(root)||!['create','process'].includes(phase)||!time(clock)||!digest(approvedDigest))
  throw new TypeError('invalid task binding');
 if(typeof approvedText!=='string'||!approvedText.trim()||approvedText.length>3000||await sha(approvedText)!==approvedDigest)
  throw new TypeError('invalid task text');
 if(phase==='process'&&!authorizedProcess(created,binding,root))throw new TypeError('separate execution not authorized');
 const taskId=phase==='process'?created.taskId:null;
 const scope=[binding.ownerRef,binding.assistantRef,binding.lane,root,phase,taskId];
 const clientMessageId='rv-'+await sha(JSON.stringify(['openassistant/rest/v1',scope]));
 const body=phase==='create'?{clientMessageId,title:'Rivule public-text trial',assistant:binding.assistantRef,
   description:approvedText,approvalPick:'manual',notificationScope:'activity_only'}:{clientMessageId,message:approvedText};
 const path=phase==='create'?'/api/tasks':'/api/tasks/'+taskId+'/process';
 const stamp=await sha(JSON.stringify([scope,path,body]));
 return {entry:Object.freeze({scope:Object.freeze(scope),phase,stamp,clientMessageId,taskId,preparedAt:clock}),
   mockRequest:Object.freeze({origin:'https://app.openassistant.us',method:'POST',path,body:Object.freeze(body)})};
}
// This result is advice for the journal, not a send permit. When retention and
// transport are not established for the verified seat, no replay is proposed.
export function checkOpenAssistantReplay({stored,proposed,clock,confirmedReplayUntil,attempts}){
 return stored&&proposed&&digest(stored.stamp)&&stored.stamp===proposed.stamp&&
 stored.clientMessageId===proposed.clientMessageId&&JSON.stringify(stored.scope)===JSON.stringify(proposed.scope)&&
 time(stored.preparedAt)&&time(clock)&&time(confirmedReplayUntil)&&clock>=stored.preparedAt&&clock<confirmedReplayUntil&&
 attempts===1?{state:'same_operation_only'}:{state:'owner_review_no_replay'};
}
export function classifyOpenAssistant({entry,response}){
 if(!entry?.scope||!Array.isArray(entry.scope))return {state:'verify_original_attempt'};
 const [owner,assistant]=entry.scope, {status,json}=response??{};
 if(status===409&&json?.error_code==='client_message_in_progress')return {state:'original_in_progress'};
 if(status===409&&json?.error_code==='client_message_id_reused')return {state:'owner_review_no_replay'};
 if(entry.phase==='create'&&status===201&&json?.ok===true&&ref(json?.task?.id)&&
 json.task.owner===owner&&json.task.assistant?.id===assistant)return {state:'task_created',taskId:json.task.id};
 if(entry.phase==='process'&&status===200&&json?.ok===true&&json?.process?.success===true&&
 json.process.taskId===entry.taskId)return {state:'execution_acknowledged',taskId:entry.taskId,
    executionId:ref(json.process.executionId)?json.process.executionId:null};
 return {state:'verify_original_attempt'};
}
export function classifyOpenAssistantRead({binding,receipt,response,actualArtifactVerified=false}){
 const t=response?.json?.task;
 if(!valid(binding)||!ref(receipt?.taskId)||receipt.ownerRef!==binding.ownerRef||receipt.assistantRef!==binding.assistantRef||
 receipt.lane!==binding.lane||response?.status!==200||response?.json?.ok!==true||
 t?.id!==receipt.taskId||t.owner!==binding.ownerRef||t.assistant?.id!==binding.assistantRef)return {state:'verify_original_attempt'};
 if(t.status==='awaiting_user_input')return {state:'requires_owner_decision'};
 if(t.status==='completed'||t.readyForReview===true)
  return {state:actualArtifactVerified===true?'artifact_pending_rivule_review':'result_unverified'};
 if(['executing','pending','subtasks_running'].includes(t.status))return {state:'running_or_queued'};
 return {state:'verify_original_attempt'};
}
