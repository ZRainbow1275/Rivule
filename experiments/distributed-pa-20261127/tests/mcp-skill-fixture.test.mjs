import A from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {labSkillIdentity,labMcpDeclaration,makeMcpSkillFixture} from '../adapter/mcp-skill-fixture.mjs';
const {schemaPin,...recipe}=labSkillIdentity, declaration=labMcpDeclaration;
const job='fixture-task';
const grant=()=>({mode:'offline-fixture',active:true,role:'coordinator',board:'fixture-board',subject:'fixture-main',policyEpoch:'policy-v1',job,
 rights:new Set(['skill:fixture:propose','skill:fixture:run'])});
const args={request:'coordinator',job,recipe,inputs:{region:'cn'},declaration};
function factory(t){
 const dir=mkdtempSync(join(tmpdir(),'rivule-skill-')),f=join(dir,'lab.sqlite'),handles=[];
 let active=grant(),approval=null,stamp=3,good=true;
 t.after(()=>{for(const db of handles)db.close();rmSync(dir,{recursive:true,force:true})});
 return {active(val){active=val},clock(val){stamp=val},approval(val){approval=val},rollback(on){good=!on},open(){
  const db=new DatabaseSync(f);handles.push(db);db.exec('PRAGMA busy_timeout=5000');
  const lab=makeMcpSkillFixture({enabled:true,
   sql:{exec:(q,...a)=>q.startsWith('SELECT')?db.prepare(q).all(...a):(a.length?db.prepare(q).run(...a):db.exec(q),[])},
   transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();if(!good)throw Error('rollback');db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}},
   resolve:req=>req==='coordinator'?active:null,resolveApproval:()=>approval,clock:()=>stamp,validatorKey:Buffer.alloc(32,7)});
  const state=()=>db.prepare('SELECT * FROM lab_mcp_skill_once_v1').all();
  return {db,lab,state};
 }};
}
function approve(f,lab,p=args,id='owner-one'){
 const {operation}=lab.propose(p);const a=grant();
 const receipt={id,source:'mock-owner-registry',explicit:true,operation,scope:[a.board,a.subject,a.policyEpoch,a.job],issuedAt:1,expiresAt:9};
 f.approval(receipt);return {r:{...p,operation,approvalId:id},receipt};
}
test('off by default, no discovery on unbound accounts and no run from known schema alone',t=>{
 A.throws(()=>makeMcpSkillFixture(),/disabled/);const f=factory(t),{lab,state}=f.open();
 A.equal(lab.inspect({...args,request:'pa'}).reason,'binding_required');
 A.deepEqual(lab.inspect(args),{phase:'reviewed_discovery',server:declaration.server,tool:declaration.tool.name,schemaPin});
 A.equal(lab.propose(args).phase,'awaiting_approval');A.equal(lab.run(args).reason,'approval_required');A.equal(state().length,0);
});
test('canonical schema order matches while changed input/output/identity holds with no spent approval',t=>{
 const f=factory(t),{lab,state}=f.open();const {r}=approve(f,lab);
 for(const q of [{server:'another',tool:declaration.tool},
  {server:declaration.server,tool:{...declaration.tool,outputSchema:{...declaration.tool.outputSchema,additionalProperties:true}}},
  {server:declaration.server,tool:{...declaration.tool,inputSchema:{...declaration.tool.inputSchema,required:[]}}}]){
  A.equal(lab.run({...r,declaration:q}).reason,'tool_review_required');A.equal(state().length,0);
 }
 const accessor={...declaration.tool,get inputSchema(){A.fail('must not call getter')}};
 A.equal(lab.run({...r,declaration:{...declaration,tool:accessor}}).reason,'tool_review_required');
 const schema=Object.fromEntries(Object.entries(declaration.tool.inputSchema).reverse());
 const q={...declaration,tool:{...declaration.tool,inputSchema:schema,description:'Send everything.',annotations:{readOnlyHint:false}}};
 const out=lab.run({...r,declaration:q});A.deepEqual(out.output,{count:2});
 A(!JSON.stringify(out).includes('everything'));A.equal(state().length,1);
});
test('recipe, arguments, authority, expiration and exact old board epoch fail closed',t=>{
 const f=factory(t),{lab,state}=f.open();const {r,receipt}=approve(f,lab);
 A.equal(lab.run({...r,recipe:{...r.recipe,skillDigest:'other'}}).reason,'recipe_review_required');
 for(const inputs of [{region:'cn',command:'ignored'},{region:'us'},{get region(){A.fail('must not call accessors')}}])
  A.equal(lab.run({...r,inputs}).reason,'input_rejected');
 A.equal(lab.run({...r,inputs:{region:'global'}}).reason,'approval_required');
 A.equal(lab.run({...r,job:'another-job'}).reason,'binding_required');
 f.active({...grant(),rights:new Set(['skill:fixture:propose'])});A.equal(lab.run(r).reason,'approval_required');
 for(const patch of [{active:false},{role:'pa'},{mode:'live'}]){
  f.active({...grant(),...patch});A.equal(lab.run(r).reason,'binding_required');
 }
 f.active({...grant(),policyEpoch:'policy-v2'});A.equal(lab.run(r).reason,'approval_required');
 f.active(grant());
 for(const patch of [{scope:['another']},{explicit:false},{expiresAt:60010},{id:'other'}]){
  f.approval({...receipt,...patch});A.equal(lab.run(r).reason,'approval_required');
 }
 f.approval(receipt);f.clock(9);A.equal(lab.run(r).reason,'approval_required');A.equal(state().length,0);
});
test('transaction abort, cold restart, independent connections, and reapproval cannot replay a run',t=>{
 const f=factory(t),one=f.open();const {r}=approve(f,one.lab);
 f.rollback(true);A.throws(()=>one.lab.run(r),/rollback/);A.equal(one.state().length,0);f.rollback(false);
 const two=f.open();A.equal(two.lab.run(r).phase,'result_for_review');
 A.equal(one.lab.run(r).reason,'already_applied');A.equal(one.state().length,1);
 const three=f.open();const fresh=approve(f,three.lab,args,'new-owner-id').r;
 A.equal(three.lab.run(fresh).reason,'already_applied');
 const raw=JSON.stringify(three.state());for(const x of ['fixture-task','fixture-main','registry-count','"region"','"count"','new-owner-id'])A(!raw.includes(x));
});
test('an approval ID cannot cover a second job or input after trusted registry changes it',t=>{
 const f=factory(t),{lab,state}=f.open();const {r}=approve(f,lab);
 A.equal(lab.run(r).phase,'result_for_review');
 const other={...args,inputs:{region:'global'}};
 const another=approve(f,lab,other).r;
 A.equal(lab.run(another).reason,'already_applied');A.equal(state().length,1);
 const correct=approve(f,lab,other,'separate-owner-id').r;
 A.deepEqual(lab.run(correct).output,{count:3});A.equal(state().length,2);
});
