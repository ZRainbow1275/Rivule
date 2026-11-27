import test from 'node:test';
import A from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {prepareOpenAssistant,checkOpenAssistantReplay,classifyOpenAssistant,classifyOpenAssistantRead} from '../adapter/openassistant-task-contract.mjs';
import {planMuleRunRecovery} from '../adapter/mulerun-cli-contract.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const binding={provider:'openassistant-rest',keyMode:'verified-user-key',dedicated:true,connectionsDisabled:true,
 scope:'public-text',ownerRef:'fixture-user',assistantRef:'fixture-assistant',lane:'one'};
const text='Summarize these two public pages.';
const opts={binding,root:'fixture-attempt',phase:'create',approvedText:text,approvedDigest:hash(text),clock:100};
const createdResponse={status:201,json:{ok:true,task:{id:'same-task',owner:binding.ownerRef,assistant:{id:binding.assistantRef}}}};
const proof={state:'task_created',journalVerified:true,root:opts.root,ownerRef:binding.ownerRef,assistantRef:binding.assistantRef,
 lane:binding.lane,taskId:'same-task',verifiedNoExecution:true,explicitProcessApproval:true};
test('lost create response, cold exact replay yields one simulated task',async()=>{
 const first=await prepareOpenAssistant(opts),second=await prepareOpenAssistant({...opts,clock:110});
 const journal=JSON.parse(JSON.stringify(first.entry));
 const initial=checkOpenAssistantReplay({stored:journal,proposed:second.entry,clock:110,confirmedReplayUntil:150,attempts:1});
 A.equal(initial.state,'same_operation_only');A.deepEqual(first.mockRequest,second.mockRequest);
 const mock=new Map();let writes=0;
 const send=({body})=>{if(!mock.has(body.clientMessageId)){writes++;mock.set(body.clientMessageId,createdResponse);}return mock.get(body.clientMessageId);};
 send(first.mockRequest); // response deliberately lost
 A.deepEqual(classifyOpenAssistant({entry:second.entry,response:send(second.mockRequest)}),{state:'task_created',taskId:'same-task'});
 A.equal(writes,1);
});
test('retry must retain seat and text digest, use verified retention and one allowance',async()=>{
 const {entry}=await prepareOpenAssistant(opts),gate=(st,other={})=>checkOpenAssistantReplay({stored:entry,proposed:st,clock:120,confirmedReplayUntil:150,attempts:1,...other}).state;
 for(const o of [{clock:150},{attempts:2},{confirmedReplayUntil:null}])A.equal(gate(entry,o),'owner_review_no_replay');
 for(const change of [{binding:{...binding,ownerRef:'other'}},{approvedText:'change',approvedDigest:hash('change')}])
  A.equal(gate((await prepareOpenAssistant({...opts,...change})).entry),'owner_review_no_replay');
 await A.rejects(()=>prepareOpenAssistant({...opts,binding:{...binding,connectionsDisabled:false}}));
});
test('409 in progress is pending; same key different body stops',async()=>{
 const {entry}=await prepareOpenAssistant(opts);
 for(const [error_code,state] of [['client_message_in_progress','original_in_progress'],['client_message_id_reused','owner_review_no_replay']])
  A.equal(classifyOpenAssistant({entry,response:{status:409,json:{error_code}}}).state,state);
 A.equal(classifyOpenAssistant({entry,response:undefined}).state,'verify_original_attempt');
});
test('create credit is distinct from explicit process; task mismatch cannot acknowledge',async()=>{
 const {entry}=await prepareOpenAssistant(opts);
 A.equal(classifyOpenAssistant({entry,response:createdResponse}).state,'task_created');
 await A.rejects(()=>prepareOpenAssistant({...opts,phase:'process',created:{...proof,verifiedNoExecution:false}}));
 await A.rejects(()=>prepareOpenAssistant({...opts,phase:'process',created:{...proof,explicitProcessApproval:false}}));
 const p=await prepareOpenAssistant({...opts,phase:'process',created:proof});
 A.notEqual(p.entry.clientMessageId,entry.clientMessageId);
 A.equal(p.mockRequest.path,'/api/tasks/same-task/process');
 const response={status:200,json:{ok:true,process:{success:true,taskId:'other',executionId:'run'}}};
 A.equal(classifyOpenAssistant({entry:p.entry,response}).state,'verify_original_attempt');
 response.json.process.taskId='same-task';
 A.equal(classifyOpenAssistant({entry:p.entry,response}).state,'execution_acknowledged');
});
test('finished status without independent artifact/acceptance cannot unlock board',()=>{
 const response={status:200,json:{...createdResponse.json,task:{...createdResponse.json.task,status:'completed',summary:'handed off'}}};
 const read=(artifact,receipt=proof)=>classifyOpenAssistantRead({binding,receipt,response,actualArtifactVerified:artifact}).state;
 A.equal(read(false),'result_unverified');A.equal(read(true),'artifact_pending_rivule_review');
 A.equal(read(true,{...proof,ownerRef:'foreign'}),'verify_original_attempt');
});
const local={provider:'mulerun-cli',verifiedOAuthExecutor:true,executorRef:'one',lane:'fixed-lane'};
const run={executorRef:'one',lane:'fixed-lane',sessionId:'same-original'};
test('MuleRun lost response reads only exact session; explicit interrupt is separate',()=>{
 for(const [loss,state] of [['stream_lost','verify_same_session'],['caller_wait_expired','verify_same_session'],['explicit_interrupt','verify_cancellation']]){
  const r=planMuleRunRecovery({binding:local,receipt:run,loss});
  A.equal(r.state,state);A.deepEqual(r.read.map(x=>x.slice(2,4)),[['get','same-original'],['events','same-original']]);
 }
});
test('MuleRun missing session and argv-like IDs stay unknown with no second create',()=>{
 for(const sessionId of [null,'--flag','with space'])A.deepEqual(planMuleRunRecovery({binding:local,receipt:{...run,sessionId},loss:'stream_lost'}),
  {state:'original_unknown_no_resend',read:[]});
});
