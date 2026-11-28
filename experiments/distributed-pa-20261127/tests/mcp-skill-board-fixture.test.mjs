import A from 'node:assert/strict';import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {labSkillIdentity,labMcpDeclaration} from '../adapter/mcp-skill-fixture.mjs';
import {makeMcpSkillBoardFixture,localSkillCard,localSkillProfile} from '../storage/mcp-skill-board-fixture.mjs';
import {makeSqlJournal} from '../storage/sql-journal.mjs';
const {scope,task,subject,worker,capability,inputDigest}=localSkillCard;
const {schemaPin,...recipe}=labSkillIdentity;
const req={request:'lab-main',recipe,inputs:{region:'cn'},declaration:labMcpDeclaration};
function fixture(t,inp=inputDigest){
 const dir=mkdtempSync(join(tmpdir(),'rivule-mcp-board-')),dbs=[];
 t.after(()=>{dbs.forEach(db=>db.close());rmSync(dir,{force:true,recursive:true})});
 let approval=null,epoch='policy-v1',abort=false,rights=['skill:fixture:propose','skill:fixture:run'];
 const open=()=>{
  const db=new DatabaseSync(join(dir,'lab.sqlite'));dbs.push(db);db.exec('PRAGMA busy_timeout=5000');
  const sql={exec:(q,...a)=>q.startsWith('SELECT')?db.prepare(q).all(...a):(a.length?db.prepare(q).run(...a):db.exec(q),[])};
  const transactionSync=fn=>{db.exec('BEGIN IMMEDIATE');try{const out=fn();if(abort)throw Error('abort');db.exec('COMMIT');return out}catch(e){db.exec('ROLLBACK');throw e}};
  const board=makeSqlJournal({sql,transactionSync});
  const bridge=makeMcpSkillBoardFixture({enabled:true,sql,transactionSync,resolve:r=>r==='lab-main'?{
   role:'coordinator',mode:'offline-fixture',active:true,board:scope,subject,job:task,policyEpoch:epoch,rights:new Set(rights)
  }:null,resolveApproval:()=>approval,clock:()=>13,validatorKey:Buffer.alloc(32,1)});
  const view=()=>board.projectAll(scope),count=()=>db.prepare('SELECT COUNT(*) n FROM lab_mcp_skill_once_v1').get().n;
  const put=(type,fields,at=12,actor=subject,role='coordinator',key=task)=>board.append({
   auth:{scope,subject:actor,role},profile:localSkillProfile,at,expectedVersion:view().asOfVersion,
   command:{type,id:type+'-'+key,task:key,...fields}});
  return {bridge,board,db,view,put,count};
 };
 const h=open();
 for(const [key,requires] of [[task,[]],['peer',[]],['merge',[task]]])
  h.put('add',{requires,capability,allowedRegions:['cn-mainland'],inputDigest:inp},11,subject,'coordinator',key);
 h.put('claim',{worker,leaseMs:100},12,worker,'worker');
 const approve=(candidate=req)=>{
  const {operation}=h.bridge.propose(candidate);A(operation);
  const approvalId='owner-fixture-one';
  approval={source:'mock-owner-registry',explicit:true,operation,scope:[scope,subject,epoch,task],id:approvalId,issuedAt:12,expiresAt:30};
  return {...candidate,operation,approvalId};
 };
 return {open,h,approve,epoch:x=>{epoch=x},rights:x=>{rights=x},abort:x=>{abort=x}};
}
const run=(h,candidate,over={})=>h.bridge.run({candidate,expectedVersion:4,at:13,fence:1,...over});
const card=(h,key=task)=>h.view().cards.find(c=>c.task===key);
test('MCP offline board replay uses actual approval and canonical review while schema drift makes no write',t=>{
 const f=fixture(t),h=f.h,frames=[];
 function snap(db,r,label){
  const {schema,scope,asOfVersion,cards}=db.view();
  frames.push({schema,scope,asOfVersion,cards:cards.map(({task,state,worker,taskVersion,dependencies})=>({task,state,worker,taskVersion,
   dependencies:dependencies.map(({task,state})=>({task,state}))})),
   label,skill:{phase:r.phase,...(r.reason?{reason:r.reason}:{}),...(typeof r.output?.count==='number'?{count:r.output.count}:{}),runs:db.count()}});
 }
 const found=h.bridge.inspect(req);A.equal(found.phase,'reviewed_discovery');
 snap(h,found,'发现本地测试工具和已固定版本的 Skill。此时尚未批准执行。');
 const proposed=h.bridge.propose(req);A.equal(proposed.phase,'awaiting_approval');
 A.equal(run(h,req).reason,'approval_required');
 snap(h,proposed,'主 Agent 核对工具、Skill 版本和这次输入；合稿仍等待。');
 const approved=f.approve();
 const changed={...approved,declaration:{...req.declaration,tool:{...req.declaration.tool,
  outputSchema:{...req.declaration.tool.outputSchema,additionalProperties:true}}}};
 const blocked=run(h,changed);A.equal(blocked.reason,'tool_review_required');A.equal(h.count(),0);A.equal(h.view().asOfVersion,4);
 snap(h,blocked,'工具的结果格式变了，旧批准没有被消费。这一次不运行。');
 const cold=f.open(),out=run(cold,approved);A.equal(out.phase,'result_for_review');A.equal(out.version,7);
 A.deepEqual(out.output,{count:2});A.equal(cold.count(),1);
 A.equal(card(cold).state,'reported');A.equal(card(cold,'merge').state,'blocked');
 snap(cold,out,'原审核版本执行一次。示例结果是 2 条，正等主 Agent 验收。');
 A.equal(run(h,approved).reason,'board_changed');
 A.throws(()=>cold.put('accept',{fence:1,artifact:'0'.repeat(64)},14),/artifact_mismatch/);
 cold.put('accept',{fence:1,artifact:out.artifact},14);
 A.equal(card(cold,'merge').state,'ready');
 snap(cold,{phase:'accepted',output:out.output},'主 Agent 验收本次结果，后续合稿解锁。');
 const serialized=JSON.stringify(frames);
 for(const s of [approved.operation,approved.approvalId,out.artifact,'fixture-main','inputDigest','receipt','schemaPin','permit','cursor'])
  A(!serialized.includes(s));
 if(process.env.RIVULE_SKILL_REPLAY==='1')console.log('RIVULE_SKILL_REPLAY:'+serialized);
});
test('revocation, revision conflict, wrong card input and aborted transaction leave approval spend and outbox unchanged',t=>{
 A.throws(()=>makeMcpSkillBoardFixture(),/disabled/);
 const f=fixture(t),h=f.h,approved=f.approve(),cold=f.open();
 A.equal(run(h,approved,{expectedVersion:3}).reason,'board_changed');
 A.equal(run(h,approved,{fence:2}).reason,'board_changed');
 f.epoch('policy-v2');A.equal(run(h,approved).reason,'approval_required');f.epoch('policy-v1');
 f.rights(['skill:fixture:propose']);A.equal(run(h,approved).reason,'approval_required');
 f.rights(['skill:fixture:propose','skill:fixture:run']);
 const outbox=()=>h.board.outboxAfter(scope).length;
 f.abort(true);A.throws(()=>run(h,approved),/abort/);f.abort(false);
 A.equal(h.count(),0);A.equal(outbox(),4);A.equal(card(h).state,'leased');
 const mismatch=fixture(t,'0'.repeat(64));A.throws(()=>run(mismatch.h,mismatch.approve()),/fixture card plan changed/);
 A.equal(mismatch.h.count(),0);A.equal(mismatch.h.board.outboxAfter(scope).length,4);
 A.equal(run(cold,approved).phase,'result_for_review');A.equal(h.count(),1);A.equal(outbox(),7);
 A.equal(run(h,approved,{expectedVersion:7}).reason,'board_changed');
});
