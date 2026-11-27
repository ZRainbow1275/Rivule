import t from 'node:test';import a from 'node:assert/strict';import {createHash} from 'node:crypto';
import {coordinateCue} from '../adapter/coordinate-cue.mjs';
import {makeCueAdapter} from '../adapter/manus-cue.mjs';
import {createJournal,decide,projectBoard} from '../src/sdk/coordination-board.mjs';
const input='从两份公开资料提取规范版本。', digest=createHash('sha256').update(input).digest('hex');
async function example(outcome) {
 const scope='sample',profile={worker:'w',provider:'cue',lane:'one',dataRegions:['sg'],capabilities:['text'],ready:true,authorized:true};
 let journal=createJournal(scope),now=0,posts=0,reads=0;
 const append=(command,role='worker',attestation)=>{const r=decide(journal,{attestation,auth:{scope,role,subject:role==='worker'?'w':'owner'},command,at:++now,expectedVersion:journal.events.length,profile});
   if(r.event)journal={...journal,events:[...journal.events,r.event]};return {...r,committed:!!r.event};};
 append({type:'add',id:'add',task:'p',capability:'text',allowedRegions:['sg'],inputDigest:digest,requires:[]},'coordinator');
 append({type:'claim',id:'claim',task:'p',worker:'w',leaseMs:100});
 const adapter=makeCueAdapter({credential:{kind:'api-key',value:'offline-only'},bindings:[{agentId:'A',threadId:'T',dedicated:true,ownedByCredential:true,regionVerified:true}],
 fetcher:async(url,init)=>{
  if(init.method==='GET'){
   reads++;a.match(url,/task.listMessages/);
   const ref=createHash('sha256').update('sample/p/1').digest('hex');
   return Response.json({ok:true,task_id:'T',has_more:false,messages:[{id:'stored-input',type:'user_message',
     user_message:{content:'[rivule-attempt:'+ref+']\n'+input}}]});
  }
  posts++;a.equal(init.method,'POST');if(outcome==='lost')throw new Error('response lost');
  if(outcome==='rate')return Response.json({ok:false},{status:429});
  if(outcome==='reject')return Response.json({ok:false,error:{code:'permission_denied'}},{status:403});
  return Response.json({ok:true,task_id:'T',request_id:'receipt1',status:outcome==='review'?'pending_owner_review':'delivered'});}});
 const q={commit:async c=>append(c),adapter,task:'p',fence:1,packet:{text:input},authorization:{fact:'authorized-text-only',agentId:'A',inputDigest:digest,lane:'one'},clock:()=>now};
 const r=await coordinateCue(q);
 const replay=await coordinateCue(q);a.equal(replay.state,'not_sent_by_this_invocation');
 a.equal(posts,1);
 await a.rejects(coordinateCue({...q,packet:{text:'changed'}}),/approved digest/);a.equal(posts,1);
 const view=()=>projectBoard(JSON.parse(JSON.stringify(journal)),{scope,selected:['p'],readable:['p']}).cards[0];
 const original=view(), last=journal.events.at(-1).command;
 if(outcome==='review'){
  a.equal(last.providerRequestId,'receipt1');
  a.equal(Object.hasOwn(original,'providerRequestId'),false);
  const inputEvidence=await adapter.observe({agentId:'A',attemptRef:createHash('sha256').update('sample/p/1').digest('hex'),approvedText:input});
  a.equal(inputEvidence.state,'observed_delivery');
  const attestation={verified:true,scope,task:'p',fence:1,worker:'w',provider:'cue',lane:'one',key:'sample/p/1',digest:'9'.repeat(64),
   verdict:'input_verified',providerRequestId:'receipt1',inputDigest:digest,inputReceipt:inputEvidence.messageId};
  const cmd={type:'reconcile',id:'evidence',task:'p',fence:1,attestation:attestation.digest};
  a.throws(()=>append(cmd,'coordinator',{...attestation,providerRequestId:'different'}),/request_mismatch/);
  a.throws(()=>append(cmd,'coordinator',{...attestation,inputDigest:'a'.repeat(64)}),/input_mismatch/);
  append(cmd,'coordinator',attestation);a.equal(view().deliveryState,'input_observed');
  a.equal(view().state,'needs_review');
  a.throws(()=>append({...cmd,id:'false-clear'},'coordinator',{...attestation,verdict:'closed_not_sent',submitterQuiesced:true,remoteRequestClosed:true}),/not_proven_closed/);
  a.equal(reads,1);a.equal(posts,1);
 }
 if(outcome==='rate'||outcome==='reject'){
  append({type:'add',id:'add-b',task:'q',capability:'text',allowedRegions:['sg'],inputDigest:digest,requires:[]},'coordinator');
  a.throws(()=>append({type:'claim',id:'claim-b',task:'q',worker:'w',leaseMs:100}),/lane_busy/);
  a.equal(reads,0);a.equal(posts,1);
 }
 return [r.state,original.state,...(original.deliveryState?[original.deliveryState]:[])];
}
t('official Cue ack becomes running but not completed by the coordinator',async()=>a.deepEqual(await example('ack'),['accepted_by_provider','running']));
t('lost Cue response quarantines the same attempt; re-entering does not replay send',async()=>a.deepEqual(await example('lost'),['needs_review','needs_review','unknown']));
t('owner review preserves request privately; finding the original input cannot accept result or release it',async()=>a.deepEqual(await example('review'),['owner_review','needs_review','owner_review']));
t('rate-limited Cue is distinct, occupies original slot and never sends again automatically',async()=>a.deepEqual(await example('rate'),['throttled','needs_review','throttled']));
t('explicit Cue rejection stays distinct and is never reported as a delivered or completed action',async()=>a.deepEqual(await example('reject'),['rejected','needs_review','rejected']));
