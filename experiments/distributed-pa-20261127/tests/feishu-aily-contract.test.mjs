import test from 'node:test';
import A from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openAilyTrial,reserveAilyWrite,observeAilyWrite,reconcileAilyRun,projectAilyArtifact,planAilyRead} from '../adapter/feishu-aily-contract.mjs';
const binding={provider:'feishu-aily',tokenKind:'verified-user',publicTextOnly:true,noConnectedTools:true,dedicatedSession:true,tenantRef:'tenant',userRef:'owner',lane:'aily-one',appId:'spring_lab__c'};
const text='List two public product changes.';
const init={binding,task:'task-a',inputDigest:createHash('sha256').update(text).digest('hex')};
const good=data=>({status:200,json:{code:0,data}});
const plan=(entry,extra={})=>reserveAilyWrite({binding,entry,approvedText:text,at:10,...extra});
const observe=(entry,response)=>observeAilyWrite({binding,entry,response});
const run=(entry,response)=>reconcileAilyRun({binding,entry,response});
const session={id:'session_a1',created_by:binding.userRef};
const msg={id:'message_a1',session_id:session.id,sender:{sender_type:'USER',aily_id:binding.userRef},content_type:'TEXT',content:text};
const vrun={id:'run_a1',app_id:binding.appId,session_id:session.id};
async function start(){return (await plan(await openAilyTrial(init))).entry;}
async function stageMsg(){return plan(await observe(await start(),good({session}))); }
async function stageRun(){return plan(await observe((await stageMsg()).entry,good({message:msg}))); }
test('Aily exact stage receipts and no early provider acknowledgment',async()=>{
 const first=await plan(await openAilyTrial(init));A.equal(first.mockRequest.path,'/open-apis/aily/v1/sessions');
 A.equal((await plan(first.entry)).mockRequest,undefined);
 const next=await stageMsg();A.deepEqual(next.mockRequest.body,{idempotent_id:next.entry.marker,content_type:'TEXT',content:text});
 const last=await stageRun();A.equal(last.mockRequest.path,'/open-apis/aily/v1/sessions/session_a1/runs');
 A.equal(last.mockRequest.body.app_id,binding.appId);
 A.equal((await observe(last.entry,good({run:{...vrun,status:'QUEUED'}}))).state,'run_recorded');
});
test('lost session remains held and app/identity drift fails closed',async()=>{
 const e=await start(),lost=await observe(e,undefined);
 A.equal(lost.state,'owner_review_no_resend');A.equal((await plan(lost)).mockRequest,undefined);
 A.equal((await observe(e,good({session:{...session,created_by:'other'}}))).state,'owner_review_no_resend');
 await A.rejects(()=>plan(e,{binding:{...binding,userRef:'other'}}));
 await A.rejects(()=>openAilyTrial({...init,binding:{...binding,tokenKind:'tenant'}}));
});
test('message-only replay is exact, under 72h and separately selected',async()=>{
 const m=await stageMsg(), verify=await observe(m.entry,undefined);
 A.equal((await plan(verify)).mockRequest,undefined);
 const retried=await plan(JSON.parse(JSON.stringify(verify)),{manualReplay:true,at:20});
 A.deepEqual(m.mockRequest,retried.mockRequest);
 A.equal((await plan(await observe(retried.entry,undefined),{manualReplay:true,at:30})).mockRequest,undefined);
 A.equal((await plan(verify,{manualReplay:true,at:10+72*3600*1000})).entry.state,'owner_review_no_resend');
 await A.rejects(()=>plan(verify,{manualReplay:true,approvedText:'changed'}));
});
test('mismatched sender, scope, digest and Feishu code cannot confirm message',async()=>{
 const e=(await stageMsg()).entry;
 for(const r of [good({message:{...msg,session_id:'session_b2'}}),good({message:{...msg,content:'changed'}}),
 good({message:{...msg,sender:{sender_type:'ASSISTANT',aily_id:binding.userRef}}}),{status:200,json:{code:1,data:{message:msg}}}])
  A.equal((await observe(e,r)).state,'message_verifying');
});
test('lost Run response is read-only, exactly one marked same session and app',async()=>{
 const e=(await stageRun()).entry,lost=await observe(e,undefined);
 A.equal(lost.state,'run_verifying');A.equal((await plan(lost)).mockRequest,undefined);
 A.match(planAilyRead({binding,entry:lost})[0].path,/\/runs\?/);
 const exact={...vrun,metadata:JSON.stringify({rivule:e.marker})};
 for(const d of [{has_more:true,runs:[exact]},
  {has_more:false,runs:[{...exact,app_id:'spring_other__c'}]},{has_more:false,runs:[exact,exact]}])
  A.equal(run(lost,good(d)).state,'run_verifying');
 A.equal(run(lost,good({has_more:false,runs:[exact]})).runId,vrun.id);
 const candidate=run(lost,good({has_more:false,runs:[vrun]}));
 A.equal(candidate.state,'run_metadata_verifying');
 A.match(planAilyRead({binding,entry:candidate})[0].path,/run_a1$/);
 A.equal(run(candidate,good({run:vrun})).state,'run_metadata_verifying');
 A.equal(run(candidate,good({run:exact})).runId,vrun.id);
 A.equal((await plan(candidate)).mockRequest,undefined);
});
test('Run completion does not accept output and user input stays held',async()=>{
 const e=await observe((await stageRun()).entry,good({run:vrun}));
 const status=(v)=>run(e,good({run:{...vrun,status:v}}));
 const done=status('COMPLETED');A.equal(done.state,'awaiting_artifact');
 A.equal(status('REQUIRES_MESSAGE').state,'requires_owner_decision');A.equal(status('FAILED').state,'terminal_needs_review');
 A.match(planAilyRead({binding,entry:done})[0].path,/with_partial_message=false&run_id=run_a1$/);
 const m={...msg,run_id:'run_a1',sender:{sender_type:'ASSISTANT'},plain_text:'Public facts',reasoning_content:'should never pass'};
 const project=(v)=>projectAilyArtifact({binding,entry:done,response:good(v)});
 A.deepEqual(project({has_more:false,messages:[m]}),{state:'artifact_pending_rivule_review',artifact:{messageId:m.id,text:m.plain_text}});
 for(const v of [{has_more:true,messages:[m]},{has_more:false,messages:[{...m,run_id:'run_b2'}]},
  {has_more:false,messages:[{...m,sender:{sender_type:'USER'}}]},{has_more:false,messages:[m,m]},{has_more:false,messages:[{...m,content_type:'FILE'}]}])
  A.equal(project(v).state,'result_unverified');
 A.equal(project({has_more:false,messages:[{...m,content_type:'MDX',content:'<foreign markup>'}]}).artifact.text,'Public facts');
});
