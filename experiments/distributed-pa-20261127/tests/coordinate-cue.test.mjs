import t from 'node:test';import a from 'node:assert/strict';import {createHash} from 'node:crypto';
import {coordinateCue} from '../adapter/coordinate-cue.mjs';
import {makeCueAdapter} from '../adapter/manus-cue.mjs';
import {createJournal,decide,projectBoard} from '../src/sdk/coordination-board.mjs';
const input='从两份公开资料提取规范版本。', digest=createHash('sha256').update(input).digest('hex');
async function example(outcome) {
 const scope='sample',profile={worker:'w',provider:'cue',lane:'one',dataRegions:['sg'],capabilities:['text'],ready:true,authorized:true};
 let journal=createJournal(scope),now=0,posts=0;
 const append=(command,role='worker')=>{const r=decide(journal,{auth:{scope,role,subject:role==='worker'?'w':'owner'},command,at:++now,expectedVersion:journal.events.length,profile});
   if(r.event)journal={...journal,events:[...journal.events,r.event]};return {...r,committed:!!r.event};};
 append({type:'add',id:'add',task:'p',capability:'text',allowedRegions:['sg'],inputDigest:digest,requires:[]},'coordinator');
 append({type:'claim',id:'claim',task:'p',worker:'w',leaseMs:100});
 const adapter=makeCueAdapter({credential:{kind:'api-key',value:'offline-only'},bindings:[{agentId:'A',threadId:'T',dedicated:true,regionVerified:true}],
 fetcher:async(url,init)=>{posts++;a.equal(init.method,'POST');if(outcome==='lost')throw new Error('response lost');
 return Response.json({ok:true,task_id:'T',request_id:'receipt1',status:'delivered'});}});
 const q={commit:async c=>append(c),adapter,task:'p',fence:1,packet:{text:input},authorization:{fact:'authorized-text-only',agentId:'A',inputDigest:digest,lane:'one'},clock:()=>now};
 const r=await coordinateCue(q);
 const replay=await coordinateCue(q);a.equal(replay.state,'not_sent_by_this_invocation');
 a.equal(posts,1);
 await a.rejects(coordinateCue({...q,packet:{text:'changed'}}),/approved digest/);a.equal(posts,1);
 const projected=projectBoard(journal,{scope,selected:['p'],readable:['p']});
 return [r.state,projected.cards[0].state];
}
t('official Cue ack becomes running but not completed by the coordinator',async()=>a.deepEqual(await example('ack'),['accepted_by_provider','running']));
t('lost Cue response quarantines the same attempt; re-entering does not replay send',async()=>a.deepEqual(await example('lost'),['needs_review','needs_review']));
