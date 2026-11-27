import test from 'node:test';
import A from 'node:assert/strict';
import {makeMuseAssignmentBridge,assignmentToolDescriptors} from '../muse/assignment-bridge.mjs';
import {createJournal,decide,projectBoard} from '../src/sdk/coordination-board.mjs';
const board='preview', roles=['pa:assignment:read','pa:assignment:claim','pa:assignment:report'], D='d'.repeat(64);
async function fixture(){
 let j=createJournal(board),clock=1;
 const owner={scope:board,subject:'lead',role:'coordinator'};
 const make=(uid,allowed,scopes=roles,regions=['sg'])=>({board,subject:uid,provider:'muse-personal',active:true,scopes:new Set(scopes),taskIds:new Set(allowed),
  profile:{worker:uid,provider:'muse-personal',lane:'lane-'+uid,dataRegions:regions,capabilities:['research'],ready:true,authorized:true}});
 const a=make('seat-a',['a','shared']),b=make('seat-b',['b','shared']),weak=make('read-only',['a'],[roles[0]]),other=make('region-mismatch',['a'],roles,['us']);
 const callers=new Map([[1,a],[2,b],[3,weak],[4,other]]);
 const store=(args)=>{const v=decide(j,{...args,at:clock++});if(v.event)j={...j,events:[...j.events,v.event]};return {...v,committed:!!v.event};};
 const push=(command,auth=owner,profile)=>store({command,auth,expectedVersion:j.events.length,profile});
 for(const task of ['a','b','shared'])push({type:'add',id:'add-'+task,task,capability:'research',allowedRegions:['sg'],inputDigest:D,requires:[]});
 let writes=0;
 const bridge=makeMuseAssignmentBridge({resolve:async token=>callers.get(token),load:async q=>projectBoard(j,q),
   append:async args=>{writes++;return store(args);}});
 return {bridge,a,b,weak,push,v:()=>j.events.length,writes:()=>writes,flip:()=>{a.active=false;}};
}
const task=(id,expectedVersion,eventId=id)=>({task:id,eventId,expectedVersion});
test('two OAuth fixtures see and claim only their own tasks; read scope never writes',async()=>{
 const f=await fixture(),{bridge}=f;
 A.deepEqual((await bridge.list(1)).cards.map(x=>x.task),['a','shared']);
 A.deepEqual((await bridge.list(2)).cards.map(x=>x.task),['b','shared']);
 await A.rejects(bridge.claim(1,task('b',3)),/not_authorized/);
 await A.rejects(bridge.claim(3,task('a',3)),/not_authorized/);
 await A.rejects(bridge.claim(1,{...task('a',3),worker:'seat-b'}),/invalid_input/);
 A.equal(f.writes(),0);
 await A.rejects(bridge.claim(4,task('a',3)),/region_mismatch/);
 A.equal((await bridge.claim(1,task('a',3))).state,'leased');
 A.equal((await bridge.claim(2,task('b',4,'a'))).state,'leased');
 A.equal((await bridge.claim(2,task('b',4,'a'))).state,'already_observed');
 A.deepEqual((await bridge.list(1)).cards.map(x=>[x.task,x.state]),[['a','leased'],['shared','ready']]);
});
test('the losing seat never receives the shared assignment; no duplicate or stale report may complete it',async()=>{
 const f=await fixture(),{bridge}=f;
 const req=await Promise.allSettled([bridge.claim(1,task('shared',3,'s1')),bridge.claim(2,task('shared',3,'s2'))]);
 A.equal(req.filter(x=>x.status==='fulfilled').length,1);
 const winner=req[0].status==='fulfilled'?1:2,loser=winner===1?2:1;
 const seat=winner===1?f.a:f.b;
 A.equal((await bridge.list(loser)).cards.some(x=>x.task==='shared'),false);
 const ownerAsWorker={scope:board,subject:seat.subject,role:'worker'};
 f.push({type:'begin',id:'begin',task:'shared',fence:1},ownerAsWorker,seat.profile);
 f.push({type:'acknowledged',id:'ack',task:'shared',fence:1,receipt:'receipt'},ownerAsWorker,seat.profile);
 const payload={...task('shared',f.v(),'send'),fence:1,receipt:'receipt',artifact:D};
 await A.rejects(bridge.report(loser,payload),/wrong_worker/);
 await A.rejects(bridge.report(winner,{...payload,receipt:'another'}),/receipt_mismatch/);
 A.equal((await bridge.report(winner,payload)).state,'awaiting_coordinator_review');
 A.equal((await bridge.report(winner,payload)).state,'already_observed');
 f.flip();await A.rejects(bridge.list(1),/not_authorized/);
});
test('connector descriptors make claim and report writes, verify no credential property',()=>{
 A.deepEqual(assignmentToolDescriptors.map(x=>[x.name,x.readOnly]),[['list_my_assignments',true],['claim_assignment',false],['submit_artifact',false]]);
});
