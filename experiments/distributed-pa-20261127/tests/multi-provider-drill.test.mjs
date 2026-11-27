import A from 'node:assert/strict';import test from 'node:test';import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';
import {makeSqlJournal} from '../storage/sql-journal.mjs';import {dispatchA2A} from '../adapter/a2a-coordinate.mjs';
import {dispatchGlean} from '../adapter/glean-durable.mjs';import {makeMuseAssignmentBridge} from '../muse/assignment-bridge.mjs';
const sum=x=>createHash('sha256').update(x).digest('hex');
test('same transactional board: A2A loses reply, Glean succeeds, Muse delivers; merge waits for main acceptance',async()=>{
 const db=new DatabaseSync(':memory:'),scope='constant',docs='Compare these publicly published dates.',inputDigest=sum(docs);
 const store=makeSqlJournal({sql:{exec:(q,...a)=>a.length?db.prepare(q).all(...a):db.exec(q)??[]},transactionSync:f=>{db.exec('BEGIN IMMEDIATE');try{const v=f();db.exec('COMMIT');return v}catch(e){db.exec('ROLLBACK');throw e}}});
 try{
 store.prepare();
 let at=0,calls=0;const reg=(worker,provider,lane,dataRegions)=>({worker,provider,lane,dataRegions,capabilities:['abstract'],authorized:true,ready:true});
 const profiles={A:reg('alpha','a2a','a-lane',['sg']),B:reg('beta','glean-durable','b-lane',['us']),C:reg('gamma','muse-personal','c-lane',['sg'])};
 const post=(command,profile)=>store.append({auth:{scope,subject:profile?.worker??'head',role:profile?'worker':'coordinator'},
 expectedVersion:store.outboxAfter(scope).at(-1)?.version??0,at:++at,command,profile});
 const projects=['first','second','third','merge'];
 for(const [i,task] of projects.entries())post({type:'add',id:'add-'+task,task,capability:'abstract',allowedRegions:[i===1?'us':'sg'],inputDigest,requires:i===3?projects.slice(0,3):[]});
 const snap=()=>store.project({scope,selected:projects,readable:projects}),card=task=>snap().cards.find(c=>c.task===task);
 A.throws(()=>post({type:'claim',id:'bad',task:'second',worker:'alpha',leaseMs:100},profiles.A),{code:'region_mismatch'});
 for(const [task,profile] of [['first',profiles.A],['second',profiles.B]])post({type:'claim',id:'take-'+task,task,worker:profile.worker,leaseMs:500},profile);
 const a=()=>dispatchA2A({commit:c=>post(c,profiles.A),clock:()=>at,task:'first',fence:1,text:docs,
   binding:{approvedClass:'public-text',provider:'a2a',contract:'1.0.1',lane:'a-lane',endpointRef:'peer',inputDigest},
   sendMessage:async()=>{calls++;throw Error('remote work created; connection lost')}});
 const b=()=>dispatchGlean({commit:c=>post(c,profiles.B),clock:()=>at,task:'second',fence:1,approvedText:docs,
  binding:{provider:'glean-durable',oauthMode:'verified-user',agentType:'published-chat-text',classification:'public-text',
    retentionReviewed:true,writeToolsDisabled:true,tenantRef:'fixture',lane:'b-lane',agentId:'approved',inputDigest},
  transport:async()=>({status:201,json:{run:{agent_id:'approved',run_id:'r-2',state:'SUCCEEDED'}}})});
 A.deepEqual((await Promise.all([a(),b()])).map(x=>x.state),['verify_original_attempt','provider_acknowledged']);
 A.equal((await a()).state,'no_fresh_permit');A.equal(calls,1);
 const muse=makeMuseAssignmentBridge({resolve:async()=>({board:scope,subject:'gamma',provider:'muse-personal',active:true,
  taskIds:new Set(['third']),scopes:new Set(['pa:assignment:read','pa:assignment:claim','pa:assignment:report']),profile:profiles.C}),
  load:o=>store.project(o),append:d=>store.append({...d,at:++at})});
 A.equal((await muse.claim({}, {task:'third',eventId:'muse-claim',expectedVersion:snap().asOfVersion})).state,'leased');
 post({type:'begin',id:'gc-begin',task:'third',fence:1},profiles.C);
 post({type:'acknowledged',id:'gc-ack',task:'third',fence:1,receipt:'r-3'},profiles.C);
 const c=sum('candidate C');
 A.equal((await muse.report({}, {task:'third',eventId:'muse-report',expectedVersion:snap().asOfVersion,fence:1,receipt:'r-3',artifact:c})).state,'awaiting_coordinator_review');
 const g=sum('candidate B');post({type:'reported',id:'report-b',task:'second',fence:1,receipt:'r-2',artifact:g},profiles.B);
 post({type:'accept',id:'accept-b',task:'second',fence:1,artifact:g});
 post({type:'accept',id:'accept-c',task:'third',fence:1,artifact:c});
 A.equal(card('first').state,'needs_review');A.equal(card('merge').state,'blocked');
 const f=sum('original remote candidate A'),e=sum('fixture attestation');
 store.append({auth:{scope,subject:'head',role:'coordinator'},expectedVersion:snap().asOfVersion,at:++at,
 command:{type:'reconcile',id:'read-original',task:'first',fence:1,attestation:e},
 attestation:{verified:true,scope,task:'first',fence:1,worker:'alpha',provider:'a2a',lane:'a-lane',
 key:scope+'/first/1',digest:e,verdict:'result_verified',receipt:'r-original',artifact:f}});
 A.equal(card('first').state,'reported');A.equal(card('merge').state,'blocked');
 post({type:'accept',id:'accept-a',task:'first',fence:1,artifact:f});
 A.equal(card('merge').state,'ready');A.equal(calls,1);
 }finally{db.close();}
});
