// Runs in a browser or Node. All accounts, tasks, artifacts and receipts are
// fixtures. No clock, I/O, provider SDK, fetch, tokens, or account discovery.
import {createJournal, decide, projectBoard} from '../src/sdk/coordination-board.mjs';
const hash=n=>n.repeat(64), all=['cn-notes','overseas-a','overseas-b','editorial'];
const scope='training'; // one owner + one authority; isolated sample board
const owner={scope,subject:'lead',role:'coordinator'};
const catalog=Object.freeze({
  local:{worker:'local',provider:'domestic-demo',lane:'sample.cn',dataRegions:['cn-mainland'],capabilities:['check.local'],ready:true,authorized:true},
  seatA:{worker:'seatA',provider:'muse-demo',lane:'training.a',dataRegions:['sg'],capabilities:['check.public'],ready:true,authorized:true},
  seatB:{worker:'seatB',provider:'muse-demo',lane:'training.b',dataRegions:['sg'],capabilities:['check.public','edit.public'],ready:true,authorized:true}
});
const entries=Object.freeze([
 ['cn-notes','check.local',['cn-mainland'],hash('1'),[]],
 ['overseas-a','check.public',['sg'],hash('2'),[]],
 ['overseas-b','check.public',['sg'],hash('3'),[]],
 ['editorial','edit.public',['sg'],hash('4'),['overseas-a','overseas-b']]
]);
export function runCoordinationExample(){
 let j=createJournal(scope),clock=1;
 const phases=[];
 const next=(agent,c,ctx={})=>{
   const auth=agent==='lead'?owner:{scope,subject:agent,role:'worker'};
   const publication=decide(j,{expectedVersion:j.events.length,at:clock++,auth,profile:catalog[agent],...ctx,command:c});
   if(publication.event)j={...j,events:[...j.events,publication.event]};
   return publication;
 };
 const frame=label=>phases.push({label,...projectBoard(j,{scope,selected:all,readable:all})});
 const add=([task,capability,allowedRegions,inputDigest,requires])=>next('lead',{type:'add',task,capability,allowedRegions,inputDigest,requires,id:'add.'+task});
 const claim=(task,worker)=>next(worker,{type:'claim',id:'lease.'+task,task,worker,leaseMs:100});
 const phase=(type,worker,task,fields={})=>next(worker,{type,id:type+'.'+task,task,fence:1,...fields});
 const result=(task,worker,receipt,artifact)=>{phase('reported',worker,task,{receipt,artifact});phase('accept','lead',task,{artifact});};
 for(const row of entries)add(row);frame('拆分后，无依赖的任务先领；合稿等待两份公开材料');
 for(const [task,w] of [['cn-notes','local'],['overseas-a','seatA'],['overseas-b','seatB']]){
  claim(task,w);phase('begin',w,task);
 }
 frame('一条国内通道、两条独立授权的示例 Muse 通道分别领工');
 phase('acknowledged','local','cn-notes',{receipt:'local-1'});
 phase('acknowledged','seatB','overseas-b',{receipt:'b-1'});
 phase('uncertain','seatA','overseas-a');result('overseas-b','seatB','b-1',hash('b'));
 frame('A 的投递结果未知；B 已验收，合稿没有越过依赖');
 const proof={verified:true,scope,task:'overseas-a',fence:1,worker:'seatA',provider:'muse-demo',lane:'training.a',key:'training/overseas-a/1',
    digest:hash('e'),verdict:'result_verified',receipt:'a-1',artifact:hash('a')};
 next('lead',{type:'reconcile',id:'resolve.a',task:'overseas-a',fence:1,attestation:hash('e')},{attestation:proof});
 frame('用相同投递身份核回已有产物；没有重发，主 Agent 尚未验收');
 phase('accept','lead','overseas-a',{artifact:hash('a')});
 result('cn-notes','local','local-1',hash('c'));claim('editorial','seatB');phase('begin','seatB','editorial');
 frame('两份公开材料均已验收，合稿被领取；国内原件仍留在原通道');
 phase('acknowledged','seatB','editorial',{receipt:'edit-1'});result('editorial','seatB','edit-1',hash('d'));
 frame('合稿验收完成，每张卡可按修订号重放');
 return {synthetic:true,providerRequests:0,accountsUsed:0,phases,journal:j};
}
