import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import A from 'node:assert/strict';import test from 'node:test';
import {stable,sha} from '../adapter/qwenpaw-recovery.mjs';
import {makeQwenPawBoardFixture} from '../storage/qwenpaw-board-fixture.mjs';
import {dispatchGlean} from '../adapter/glean-durable.mjs';
const scope='lab-room',otherScope='other-room',task='china-proof',intl='overseas-proof',merge='merge',approvedText='Check the date on this public notice.',inputDigest=sha(approvedText);
const internationalText='Summarize the overseas public schedule.',intlDigest=sha(internationalText);
const profile={worker:'qwen',provider:'qwenpaw',lane:'cn-proof',dataRegions:['cn-mainland'],capabilities:['public-summary'],ready:true,authorized:true},
 iProfile={worker:'international',provider:'glean-durable',lane:'overseas',dataRegions:['us'],capabilities:['public-summary'],ready:true,authorized:true};
const binding={enabled:true,mode:'offline-fixture',provider:'qwenpaw',version:stable,scope:'public-text',dedicated:true,toolsDisabled:true,
 instance:'mock-cn-gateway',agent:'lab',user:'local-seat',lane:'cn-proof',channel:'console'};
const owner={scope,role:'coordinator',subject:'lead'},worker={scope,role:'worker',subject:'qwen'};
const open=(path,fail=()=>false,enabled=true,policy=()=>true)=>{
 const db=new DatabaseSync(path);db.exec('PRAGMA busy_timeout=3000');
 function transactionSync(fn){
  db.exec('BEGIN IMMEDIATE');try{const v=fn();if(fail())throw Error('injected rollback');db.exec('COMMIT');return v}
  catch(e){db.exec('ROLLBACK');throw e}
 }
 const exec=(q,...params)=>q.startsWith('SELECT')?db.prepare(q).all(...params):(params.length?db.prepare(q).run(...params):db.exec(q),[]);
 try{
  const bridge=makeQwenPawBoardFixture({enabled,sql:{exec},transactionSync,resolve:({scope:s,task:t})=>(
   [scope,otherScope].includes(s)&&t===task?{scope:s,task:t,profile:{...profile,authorized:policy()},coordinator:'lead',binding}:null)});
  return {db,bridge};
 }catch(e){db.close();throw e}
};
const set=t=>{
 const dir=mkdtempSync(join(tmpdir(),'rv-qpb-')),file=join(dir,'lab.sqlite'),active=new Set();
 t.after(()=>{for(const h of active)h.db.close();rmSync(dir,{force:true,recursive:true})});
 let at=0;
 return {open(fail,policy){const h=open(file,fail,true,policy);active.add(h);return h},close(h){active.delete(h);h.db.close()},time:()=>++at};
};
const boardVersion=(h,s=scope)=>h.bridge.board.project({scope:s,selected:[],readable:[]}).asOfVersion;
const card=(h,id,s=scope)=>h.bridge.board.project({scope:s,selected:[id],readable:[id]}).cards[0];
function helpers(r,h,s=scope){
 const post=(cmd,p)=>h.bridge.board.append({auth:p?{scope:s,subject:p.worker,role:'worker'}:{...owner,scope:s},
   command:cmd,expectedVersion:boardVersion(h,s),at:r.time(),profile:p});
 const tryOp=(event,rest={})=>({auth:{...['start','uncertain'].includes(event)?worker:owner,scope:s},
   task,fence:1,at:r.time(),expectedBoardVersion:boardVersion(h,s),eventId:event,...rest});
 const add=(id,region,requires=[],digest=inputDigest)=>post({type:'add',id:'add-'+id,task:id,capability:'public-summary',allowedRegions:[region],inputDigest:digest,requires});
 const claim=(id,p)=>post({type:'claim',id:'claim-'+id,task:id,worker:p.worker,leaseMs:100},p);
 function start(){return h.bridge.start(tryOp('start',{approvedText}))}
 function unknown(){return h.bridge.markUncertain(tryOp('uncertain'))}
 function gateway(send){
  const body=send.mockRequest.body,computed=body.input[0].content[0].text;
  const proof={source:'mock-owned-registry',instance:binding.instance,version:stable,agent:binding.agent,user:binding.user,
   channel:'console',session:body.session_id,chat:'1765e4e8-43f6-4c84-9f68-61355b167a73',observedAt:r.time()};
  const request={instance:binding.instance,method:'GET',path:'/api/chats/'+proof.chat+'?include_app_owned=false',headers:{'X-Agent-Id':binding.agent}};
  const msg=(role,text)=>({role,type:'message',status:'completed',content:[{type:'text',text}]});
  const observation={source:'mock-pinned-response',request,status:200,body:{status:'idle',messages:[
   msg('user',computed),msg('assistant',computed.split('\n')[0]+'\nDate confirmed from a public notice.')]}};
  return {proof,observation};
 }
 return {post,tryOp,add,claim,start,unknown,gateway};
}
test('Bridge has no options for a live transport and defaults off',()=>A.throws(()=>open(':memory:',undefined,false),/not enabled/));
test('QwenPaw loses response: Glean keeps working; exact old history alone never unlocks merge',async t=>{
 const r=set(t),h=r.open(),b=helpers(r,h),frames=[];
 const capture=(label)=>frames.push({label,...h.bridge.board.project({scope,selected:[task,intl,merge],readable:[task,intl,merge]})});
 b.add(task,'cn-mainland');b.add(intl,'us',[],intlDigest);b.add(merge,'us',[task,intl]);
 capture('主 Agent 拆出境内与海外材料。两路独立进行，合稿等待分别验收。');
 A.throws(()=>b.claim(task,iProfile),{code:'region_mismatch'});
 b.claim(task,profile);b.claim(intl,iProfile);
 const first=b.start(),wire=structuredClone(first.mockRequest);
 A.equal(card(h,task).state,'submitting');A.equal(wire.body.input.length,1);
 capture('QwenPaw 原任务在事务里领到唯一一次派工许可；Glean 已领取另一张卡。');
 const {proof,observation}=b.gateway(first);
 b.unknown();A.equal(card(h,task).state,'needs_review');
 capture('连接断开，任务留在待核查。会话身份还没绑定，既不重派，也不尝试接回陌生会话。');
 A.equal(h.bridge.attach(b.tryOp('attach',{proof,expectedProviderRevision:0})).mockRequest,undefined);
 A.equal(h.bridge.start(b.tryOp('start',{approvedText})).mockRequest,undefined);
 let overseasWire=null;
 const second=await dispatchGlean({commit:c=>b.post(c,iProfile),clock:()=>0,task:intl,fence:1,approvedText:internationalText,
  binding:{provider:'glean-durable',oauthMode:'verified-user',agentType:'published-chat-text',classification:'public-text',
    retentionReviewed:true,writeToolsDisabled:true,tenantRef:'fixture',lane:iProfile.lane,agentId:'public-trial',inputDigest:intlDigest},
  transport:async req=>{overseasWire=req;return {status:201,json:{run:{agent_id:'public-trial',run_id:'independent',state:'SUCCEEDED'}}}}});
 A.equal(overseasWire.body.messages[0].content[0].text,internationalText);
 A(!JSON.stringify(overseasWire).includes(approvedText));A(!JSON.stringify(wire).includes(internationalText));
 A.equal(second.state,'provider_acknowledged');
 const other=sha('independent extract');
 b.post({type:'reported',id:'report-intl',task:intl,fence:1,receipt:'independent',artifact:other},iProfile);
 b.post({type:'accept',id:'accept-intl',task:intl,fence:1,artifact:other});
 A.equal(card(h,merge).state,'blocked');A.equal(card(h,task).state,'needs_review');
 capture('海外结果先验收。境内仍不重派，合稿仍锁住。');
 A(h.bridge.bind(b.tryOp('bind',{proof,expectedProviderRevision:0})).committed);
 const attach=h.bridge.attach(b.tryOp('attach',{proof,expectedProviderRevision:1}));
 A.deepEqual(attach.mockRequest.body,{reconnect:true,user_id:wire.body.user_id,channel:'console',session_id:wire.body.session_id});
 A.equal(h.bridge.attach(b.tryOp('attach',{proof,expectedProviderRevision:2})).mockRequest,undefined);
 A.equal(h.bridge.reconcile(b.tryOp('reconcile',{proof,expectedProviderRevision:2,observation:{...observation,body:{status:'idle',messages:[]}}})).committed,false);
 A.deepEqual(h.bridge.history(b.tryOp('history',{proof,expectedProviderRevision:2})).mockRequest,observation.request);
 const report=h.bridge.reconcile(b.tryOp('reconcile',{proof,expectedProviderRevision:2,observation}));
 A(report.committed);A.equal(card(h,task).state,'reported');A.equal(card(h,merge).state,'blocked');
 capture('仅接回原会话并核对历史，境内结果进入待审。合稿还没解锁。');
 A.throws(()=>b.post({type:'accept',id:'accept-wrong',task,fence:1,artifact:sha('wrong')}),{code:'artifact_mismatch'});
 b.post({type:'accept',id:'accept-local',task,fence:1,artifact:report.artifact});
 A.equal(card(h,merge).state,'ready');
 capture('主 Agent 明确验收原结果后，才解锁合稿。');
 A.equal(h.bridge.reconcile(b.tryOp('reconcile',{proof,expectedProviderRevision:3,observation})).committed,false);
 const rows=h.db.prepare('SELECT body FROM lab_coord_event').all();
 A(!JSON.stringify(rows).includes(approvedText));A(!JSON.stringify(rows).includes('Date confirmed'));
 if(process.env.RIVULE_BOARD_REPLAY==='1')console.log('RIVULE_BOARD_REPLAY:'+JSON.stringify(frames));
});
test('Atomic send and report rollback preserve both journals and allow legitimate cold continuation',t=>{
 const r=set(t);let fail=false;
 const h=r.open(()=>fail),b=helpers(r,h);
 b.add(task,'cn-mainland');b.claim(task,profile);const before=boardVersion(h);
 fail=true;A.throws(()=>b.start(),/injected rollback/);fail=false;
 A.equal(card(h,task).state,'leased');A.equal(boardVersion(h),before);
 A.equal(h.db.prepare('SELECT COUNT(*) AS n FROM lab_qwenpaw_v1').get().n,0);
 const first=b.start(); const {proof,observation}=b.gateway(first);
 b.unknown();A(h.bridge.bind(b.tryOp('bind',{proof,expectedProviderRevision:0})).committed);
 const p=b.tryOp('reconcile',{proof,expectedProviderRevision:1,observation});
 fail=true;A.throws(()=>h.bridge.reconcile(p),/injected rollback/);fail=false;
 A.equal(card(h,task).state,'needs_review');
 A.equal(h.db.prepare('SELECT rev FROM lab_qwenpaw_v1').get().rev,1);
 r.close(h);const cold=r.open(),c=helpers(r,cold);
 A.equal(cold.bridge.start(c.tryOp('start',{approvedText})).mockRequest,undefined);
 A(cold.bridge.reconcile(p).committed);A.equal(card(cold,task).state,'reported');
});
test('Board scope and fencing reject a proof/receipt from the same-named task elsewhere',t=>{
 const r=set(t),h=r.open(),one=helpers(r,h),two=helpers(r,h,otherScope);
 for(const b of [one,two]){b.add(task,'cn-mainland');b.claim(task,profile);}
 const a=one.start(),b=two.start();one.unknown();two.unknown();
 A.notEqual(a.mockRequest.body.session_id,b.mockRequest.body.session_id);
 const {proof,observation}=one.gateway(a);
 A.equal(h.bridge.bind(two.tryOp('bind',{proof,expectedProviderRevision:0})).committed,false);
 A.equal(h.bridge.bind(one.tryOp('bind',{proof,expectedProviderRevision:0,fence:2})).committed,false);
 A.throws(()=>h.bridge.bind(one.tryOp('bind',{proof,expectedProviderRevision:0,auth:{...owner,subject:'other'}})),/enrollment/);
 A(h.bridge.bind(one.tryOp('bind',{proof,expectedProviderRevision:0})).committed);
 A.equal(h.bridge.reconcile(one.tryOp('reconcile',{proof,observation,expectedProviderRevision:1,expectedBoardVersion:1})).reason,'stale_board');
 A.equal(card(h,task,otherScope).state,'needs_review');
});

test('Revoked enrollment cannot open a second transport or read original history',t=>{
 const r=set(t);let authorized=true;
 const h=r.open(undefined,()=>authorized),b=helpers(r,h);
 b.add(task,'cn-mainland');b.claim(task,profile);
 const first=b.start(),{proof,observation}=b.gateway(first);b.unknown();
 A(h.bridge.bind(b.tryOp('bind',{proof,expectedProviderRevision:0})).committed);
 authorized=false;
 for(const method of ['attach','history','reconcile'])
  A.throws(()=>h.bridge[method](b.tryOp(method,{proof,observation,expectedProviderRevision:1})),/enrollment/);
 A.equal(card(h,task).state,'needs_review');
 A.equal(h.db.prepare('SELECT rev FROM lab_qwenpaw_v1').get().rev,1);
});
