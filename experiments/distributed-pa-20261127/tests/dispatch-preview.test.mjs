import test from 'node:test';
import A from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {makeSqlJournal} from '../storage/sql-journal.mjs';
const scope='seat-preview',owner={scope,role:'coordinator',subject:'lead'};
const profile=(worker,regions,lane=worker)=>({
 worker,provider:'mock-pa',lane,ready:true,authorized:true,dataRegions:regions,capabilities:['read']
});
test('offline seat preview explains gates without reserving, leaking or dispatching',()=>{
 const db=new DatabaseSync(':memory:');
 const store=makeSqlJournal({
  sql:{exec:(q,...args)=>q.startsWith('SELECT')?db.prepare(q).all(...args):(db.prepare(q).run(...args),[])},
  transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const out=fn();db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}
 });
 try{
  store.prepare();
  const ids=['public-source','independent','merge'], readable=ids.slice();
  let at=0;
  const snap=()=>store.project({scope,selected:ids,readable});
  const apply=(command,p)=>store.append({at:++at,expectedVersion:snap().asOfVersion,
   auth:p?{scope,role:'worker',subject:p.worker}:owner,command,profile:p});
  const add=(task,region,requires=[])=>apply({type:'add',id:'add-'+task,task,capability:'read',
   allowedRegions:[region],inputDigest:'d'.repeat(64),requires});
  add(ids[0],'cn-mainland');add(ids[1],'cn-mainland');add(ids[2],'cn-mainland',ids.slice(0,2));
  const domestic=profile('desk-cn',['cn-mainland'],'shared-desk'), international=profile('desk-intl',['cn-mainland','us']);
  const spare=profile('desk-spare',['cn-mainland']),other={...profile('desk-other',['cn-mainland']),authorized:false};
  const seats=[
   {alias:'domestic',profile:domestic,budgetReviewed:true},{alias:'intl',profile:international,budgetReviewed:true},
   {alias:'spare',profile:spare,budgetReviewed:false},{alias:'unbound',profile:other,budgetReviewed:true}
  ];
  const read=(task=ids[0],auth=owner,access=readable)=>store.preview({task,auth,readable:access,seats});
  const capture=(label)=>({...snap(),label,dispatch:read()});
  const expected=[['domestic','candidate_for_review'],['intl','region_mismatch'],['spare','budget_unreviewed'],['unbound','worker_unavailable']];
  A.deepEqual(read().cards.map(x=>[x.alias,x.state]),expected);
  A.deepEqual(read('merge').cards,[]);A.equal(read('merge').gate,'dependencies_open');
  for(const fn of [()=>read(ids[0],{...owner,role:'worker'}),()=>read(ids[0],owner,[ids[1]]),()=>read('hidden',owner,['hidden'])])
   A.throws(fn,{code:'not_authorized'});
  A.throws(()=>store.preview({auth:owner,task:ids[0],readable,seats:[seats[0],seats[0]]}),{code:'duplicate_list_member'});
  const frames=[capture('同样会做这件事，处理地区、预算和授权不同。')];
  const pre=store.outboxAfter(scope);read();A.deepEqual(store.outboxAfter(scope),pre);
  apply({type:'claim',id:'claim-peer',task:ids[1],worker:domestic.worker,leaseMs:99},domestic);
  const inUse=read(ids[0],owner,[ids[0]]);A.equal(inUse.cards[0].state,'lane_busy');
  A(!JSON.stringify(inUse).includes('independent'));A(!JSON.stringify(inUse).includes('shared-desk'));
  frames.push(capture('境内席位正在处理独立任务；主 Agent 暂不派送。'));
  seats[2]={...seats[2],budgetReviewed:true};
  const sameRev=read();A.equal(sameRev.cards[2].state,'candidate_for_review');
  A.equal(sameRev.asOfVersion,inUse.asOfVersion);A.equal(store.outboxAfter(scope).length,4);
  frames.push(capture('备选席位预算已核对，可交主 Agent 决定。'));
  const r=apply({type:'claim',id:'claim-source',task:ids[0],worker:spare.worker,leaseMs:99},spare);
  A(r.committed&&!r.permit);A.equal(read().gate,'task_already_claimed_or_closed');A.deepEqual(read().cards,[]);
  A.equal(snap().cards.find(x=>x.task==='merge').state,'blocked');
  A(!store.outboxAfter(scope).some(x=>x.phase==='begin'));
  frames.push(capture('主 Agent 选定了备选席位。领取后仍要另行取得派送许可。'));
  if(process.env.RIVULE_DISPATCH_PREVIEW==='1')console.log('RIVULE_DISPATCH_PREVIEW:'+JSON.stringify(frames));
 }finally{db.close();}
});
