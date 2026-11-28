import {createHash} from 'node:crypto';
import {createJournal,decide} from '../src/sdk/coordination-board.mjs';
import {makeSyntheticAcceptance,compareArtifactBytes} from '../src/sdk/portable-acceptance.mjs';

// Source facts are pre-agreed public sample material. Not a live PA result.
export const documentName='验收试稿.txt';
export const sample=Buffer.from('11 月 14 日，瓦尔帕莱索启航，388 箱、8,500 吨。\n11 月 18 日，深圳另有新季启动活动。\n','utf8');
export const sameNameChanged=Buffer.from(sample.toString('utf8').replace('深圳','广州'),'utf8');
export function fixture(){
 const scope='demo-private-ledger',task='demo-internal-task',lead={scope,role:'coordinator',subject:'lead-internal-fixture'},worker={scope,role:'worker',subject:'worker-internal-fixture'};
 const profile={worker:worker.subject,provider:'fixture-provider',lane:'fixture-lane',dataRegions:['cn-mainland'],capabilities:['text'],authorized:true,ready:true};
 const journal=createJournal(scope);
 const artifact=createHash('sha256').update(sample).digest('hex');
 const append=(type,actor,fields)=>{
  const expectedVersion=journal.events.length,at=1700000000000+expectedVersion*100;
  const r=decide(journal,{auth:actor,profile,expectedVersion,at,command:{type,id:'evt-'+type,task,...fields}});
  journal.events.push(r.event);
 };
 append('add',lead,{inputDigest:'f'.repeat(64),allowedRegions:['cn-mainland'],capability:'text',requires:[]});
 append('claim',worker,{worker:worker.subject,leaseMs:3600});
 append('begin',worker,{fence:1});
 append('acknowledged',worker,{fence:1,receipt:'fixture-provider-receipt'});
 append('reported',worker,{fence:1,receipt:'fixture-provider-receipt',artifact});
 const delivered=journal.events.length;
 append('accept',lead,{fence:1,artifact});
 const accepted=journal.events.length;
 const proof=makeSyntheticAcceptance({enabled:true,aliases:key=>key.scope===scope&&key.task===task&&key.fence===1?
  {taskAlias:'sample-summary',attemptAlias:'sample-attempt-1'}:null});
 const select={auth:lead,task,readable:[task]};
 return {journal,artifact,proof,select,delivered,accepted};
}
export function replay(){
 const f=fixture(),record=f.proof.exportRecord(f.journal,{...f.select,atVersion:f.accepted});
 let before;
 try{f.proof.exportRecord(f.journal,{...f.select,atVersion:f.delivered});}
 catch(e){if(e.code!=='no_acceptance_at_revision')throw e;before='delivered_only';}
 return {fileName:documentName,record,cases:[
  {case:'original',fileOnly:compareArtifactBytes(record,sample),ledger:f.proof.verifyTrustedCopy(record,sample,f.journal,f.select)},
  {case:'same_name_changed',fileOnly:compareArtifactBytes(record,sameNameChanged),ledger:null},
  {case:'provider_complete_only',fileOnly:null,ledger:before}
 ]};
}
