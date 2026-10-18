/** Offline OpenClaw hook -> Rivule agent-run branch adapter. No SDK load, I/O or hook registration. */
import {identifier,validateEvent} from './contracts.ts';import type {Source,Event} from './contracts.ts';
export type ApprovedRunBinding={enabled:boolean;source:Source;allowedProjectIds:readonly string[];projectId:string;projectName:string;taskId:string;taskName:string;runId:string;branchId:string;
 agentId:string;sessionKey:string;upstreamRunId:string;scope:'agent_run';approvedSummary?:string};
export type HookObservation={hook:string;event:unknown;context:unknown;eventKey:string;occurredAt:string;sequence:number};
export type HookResult={state:'mapped';observation:string;event:Event}|{state:'skipped';reason:string};
const skip=(reason:string):HookResult=>({state:'skipped',reason});
// Read only own data fields. Never invoke getters or read transcripts, prompts, parameters, or error text.
function field(value:unknown,key:string):unknown {if(!value||typeof value!=='object')return undefined;const d=Object.getOwnPropertyDescriptor(value,key);return d&&'value'in d?d.value:undefined;}
export async function mapOpenClawObservation(binding:ApprovedRunBinding,input:HookObservation,now=Date.now()):Promise<HookResult>{
 if(!binding.enabled||!binding.source.enabled)return skip('disabled');
 if(binding.scope!=='agent_run'||!binding.allowedProjectIds.includes(binding.projectId))return skip('binding_not_authorized');
 if(!binding.agentId||!binding.sessionKey||!binding.upstreamRunId||field(input.context,'agentId')!==binding.agentId||field(input.context,'sessionKey')!==binding.sessionKey||field(input.context,'runId')!==binding.upstreamRunId)return skip('identity_missing_or_out_of_scope');
 let observation:string,kind='progress',status='running',blocker:string|null=null;
 if(input.hook==='before_agent_run')observation='agent_run_started';
 else if(input.hook==='after_tool_call')observation='tool_call_ended_task_not_completed';
 else if(input.hook==='agent_end'){
  const success=field(input.event,'success');if(typeof success!=='boolean')return skip('unknown_run_outcome');
  observation=success?'agent_run_succeeded':'agent_run_failed';kind=success?'completed':'failed';status=kind;
  if(!success)blocker='代理运行失败；错误详情未转发，请回来源核对';
 }else if(input.hook==='session_end')return skip('session_ended_task_outcome_unknown');
 else return skip('unsupported_hook');
 try{
  identifier(input.eventKey);if(!Number.isSafeInteger(input.sequence)||input.sequence<0)return skip('invalid_observation');
  const fingerprint=JSON.stringify([binding.source.source_id,binding.projectId,binding.taskId,binding.runId,binding.branchId,input.hook,input.eventKey]);
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(fingerprint))),x=>x.toString(16).padStart(2,'0')).join('');
  const labels:Record<string,string>={agent_run_started:'代理运行开始',tool_call_ended_task_not_completed:'一次工具调用结束；不代表任务完成',agent_run_succeeded:'代理运行成功结束；不代表整个项目完成',agent_run_failed:'代理运行失败；不代表整个项目不可恢复'};
  const event=validateEvent({event_id:'oc_'+digest,source_id:binding.source.source_id,project_id:binding.projectId,project_name:binding.projectName,task_id:binding.taskId,task_name:binding.taskName,run_id:binding.runId,branch_id:binding.branchId,branch_name:'代理运行',kind,source_status:status,source_seq:input.sequence,occurred_at:input.occurredAt,summary:labels[observation]+(binding.approvedSummary?'；'+binding.approvedSummary:''),blocker},binding.source,now);
  return {state:'mapped',observation,event};
 }catch{return skip('invalid_observation_or_binding');}
}
