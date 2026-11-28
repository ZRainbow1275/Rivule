import test from 'node:test';
import A from 'node:assert/strict';
import {classifyInferenceShellFixture as classify,inferenceShellTextDigest as sha} from '../adapter/inference-shell-readback-fixture.mjs';
const original='核对这段公开材料的日期，仅返回简短文字。';
const output='来源卡片：示例结果。';
function fixture(){
 const chatId='chat_owned',runId='run_one',versionId='version_pinned',workspaceId='ws_lab';
 const step=(id,role,order,content)=>({id,role,order,content,chat_id:chatId,status:'ready',tool_invocations:[]});
 const message=(id,role,order,text)=>step(id,role,order,[{type:'text',text}]);
 const user=message('msg_original','user',1,original),answer=message('msg_answer','assistant',2,output);
 const terminal=step('msg_end','event',3,[{type:'event',event:{type:'run_ended',run:{run_id:runId,state:'completed'}}}]);
 return {enabled:true,binding:{chatId,versionId,workspaceId,inputDigest:sha(original)},snapshot:{
  audit:{fixtureVerified:true,exclusiveWriter:true,policyCurrent:true,textOnly:true,emptyBeforeSend:true},
  chat:{id:chatId,workspace_id:workspaceId,agent_version_id:versionId,origin:'api',visibility:'private',status:'idle',
   agent_data:{allow_all_tools:false,disable_hooks:true}},
  transcript:{items:[terminal,answer,user],has_next:false,has_previous:false,next_cursor:null},
  runs:{items:[{id:runId,chat_id:chatId,state:'completed'}],has_next:false,has_previous:false,next_cursor:null}
 }};
}
const held=x=>A.equal(classify(x).state,'verify_original_attempt');
test('readback requires opt in and never accepts a result, including a lost send response',()=>{
 const x=fixture();
 A.deepEqual(classify({...x,enabled:undefined}),{state:'disabled'});
 A.deepEqual(classify(x),{state:'awaiting_coordinator_review',receipt:'run_one',artifact:sha(output)});
 x.binding.knownMessageId='msg_original';
 const r=classify(x);A.equal(r.state,'awaiting_coordinator_review');A(!JSON.stringify(r).includes(output));
 x.binding.knownMessageId='msg_elsewhere';held(x);
});
test('an extra, queued, mismatched or incomplete message cannot become a deliverable',()=>{
 const changes=[
  x=>x.snapshot.transcript.has_next=true,
  x=>x.snapshot.transcript.next_cursor='next',
  x=>x.snapshot.transcript.has_previous=true,
  x=>x.snapshot.runs.has_next=true,
  x=>x.snapshot.runs.items.push({...x.snapshot.runs.items[0],id:'second_run'}),
  x=>x.snapshot.transcript.items.push({...x.snapshot.transcript.items[2],id:'msg_queued',order:4,status:'queued'}),
  x=>x.snapshot.transcript.items[2].status='queued',
  x=>x.snapshot.transcript.items[2].content[0].text+='x',
  x=>x.snapshot.transcript.items[1].chat_id='different_chat',
  x=>x.snapshot.transcript.items[1].order=1,
  x=>x.snapshot.transcript.items[1].tool_invocations.push({id:'unexpected_tool'}),
  x=>x.snapshot.chat.active_run_id='second_run',
  x=>x.snapshot.chat.status='awaiting_input'
 ];
 for(const change of changes){const x=fixture();change(x);held(x);}
});
test('a no-reply, output-limit, failed or empty ending does not release anything',()=>{
 for(const reason of ['no_reply','output_limit','unknown']){
  const x=fixture();x.snapshot.transcript.items[0].content[0].event.run.reason=reason;held(x);
 }
 for(const change of [
  x=>x.snapshot.transcript.items[0].content[0].event.run.run_id='wrong_run',
  x=>x.snapshot.runs.items[0].state='failed',
  x=>x.snapshot.transcript.items[1].content[0].text=' ',
  x=>x.snapshot.transcript.items[1].content[0].text='字'.repeat(6000),
  x=>x.snapshot.audit.exclusiveWriter=false,
  x=>x.snapshot.audit.emptyBeforeSend=false,
  x=>x.snapshot.audit.policyCurrent=false,
  x=>x.snapshot.chat.channel_context={channel_type:'unverified'},
  x=>x.snapshot.chat.visibility='team',
  x=>x.snapshot.chat.workspace_id='other_ws',
  x=>x.snapshot.chat.agent_version_id='changed',
  x=>x.snapshot.chat.agent_data.disable_hooks=false
 ]){const x=fixture();change(x);held(x);}
});
