// Conservative offline classification only. Reads are supplied by a synthetic
// harness: this module cannot create sessions, send requests, or accept work.
import {createHash} from 'node:crypto';
export const inferenceShellTextDigest=text=>createHash('sha256').update(text,'utf8').digest('hex');
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(x);
const rowHasNoTools=m=>m.tool_invocations===undefined||Array.isArray(m.tool_invocations)&&m.tool_invocations.length===0;
const singleText=m=>m.content?.length===1&&m.content[0]?.type==='text'&&typeof m.content[0].text==='string'&&
 Buffer.byteLength(m.content[0].text,'utf8')<=16000?m.content[0].text:null;
const held=reason=>Object.freeze({state:'verify_original_attempt',reason});
export function classifyInferenceShellFixture({enabled=false,binding,snapshot}={}){
 if(enabled!==true) return Object.freeze({state:'disabled'});
 // These audit booleans are fixture observations from a trusted boundary;
 // neither a vendor transcript nor caller text can vouch for the grant.
 const {chatId,versionId,workspaceId,inputDigest,knownMessageId}=binding??{};
 if(![chatId,versionId,workspaceId].every(id)||!(/^[a-f0-9]{64}$/.test(inputDigest??''))||
  knownMessageId!==undefined&&!id(knownMessageId))return held('missing_original_binding');
 const {chat,audit,transcript,runs}=snapshot??{};
 if(audit?.fixtureVerified!==true||audit.policyCurrent!==true||audit.exclusiveWriter!==true||audit.textOnly!==true||audit.emptyBeforeSend!==true||
  chat?.id!==chatId||chat.workspace_id!==workspaceId||chat.agent_version_id!==versionId||chat.visibility!=='private'||
  chat.origin!=='api'||chat.agent_data?.allow_all_tools!==false||chat.agent_data?.disable_hooks!==true||
  chat.channel_context||chat.harness_session_id||chat.forked_from_message_id)return held('scope_unproven');
 if(!['idle','completed'].includes(chat.status)||chat.active_run||chat.active_run_id)return held('run_unsettled');
 if(transcript?.has_next!==false||transcript.has_previous!==false||transcript.next_cursor||runs?.has_next!==false||runs.has_previous!==false||runs.next_cursor||
  !Array.isArray(transcript.items)||!Array.isArray(runs.items)||runs.items.length!==1||
  transcript.items.length!==3)return held('incomplete_or_ambiguous_history');
 const run=runs.items[0];
 if(!id(run?.id)||run.chat_id!==chatId||run.state!=='completed')return held('run_not_complete');
 const rows=transcript.items;
 if(rows.some(x=>!id(x?.id)||x.chat_id!==chatId||!Number.isSafeInteger(x.order)||x.order<0||x.status!=='ready'||!rowHasNoTools(x))||
  new Set(rows.map(x=>x.id)).size!==3||new Set(rows.map(x=>x.order)).size!==3)return held('unexpected_message');
 const [user,assistant,event]=[...rows].sort((a,b)=>a.order-b.order);
 const inText=singleText(user),outText=singleText(assistant);
 const end=event.content?.length===1&&event.content[0]?.type==='event'?event.content[0].event:null;
 if(user.role!=='user'||!inText?.trim()||knownMessageId&&knownMessageId!==user.id||
  inferenceShellTextDigest(inText)!==inputDigest||assistant.role!=='assistant'||event.role!=='event')return held('original_message_unproven');
 if(end?.type!=='run_ended'||end.run?.run_id!==run.id||end.run.state!=='completed'||end.run.reason!==undefined||
  !outText?.trim())return held('no_matching_complete_answer');
 // The reviewed REST example does not document a run ID on assistant rows.
 // One dedicated chat + exactly one run and complete single-turn transcript
 // is an inference for this fixture, not a vendor-guaranteed correlation ID.
 return Object.freeze({state:'awaiting_coordinator_review',receipt:run.id,artifact:inferenceShellTextDigest(outText)});
}
