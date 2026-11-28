import A from 'node:assert/strict';import test from 'node:test';import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {makeModelBudgetFixture} from '../storage/model-budget-fixture.mjs';
const plan={source:'fixture-bounded-tokenizer',model:'rivule-local-fixture',payloadDigest:'a'.repeat(64),tools:0,fallback:false,inputUpperBound:8000,maxBillableOutput:1000};
const usage={source:'fixture-usage',model:plan.model,terminal:'complete',input:600,output:90,reasoningIncluded:true};
const grant={kind:'offline-model-budget',role:'coordinator',active:true,publicTextOnly:true,board:'test-board',job:'summary',run:'initial',epoch:'policy-1',subject:'main',rights:new Set(['model:fixture:reserve','model:fixture:observe'])};
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'rv-model-budget')),dbs=[];
 t.after(()=>{dbs.forEach(d=>d.close());rmSync(dir,{recursive:true,force:true});});
 let current=grant,p=plan,o=null,abort=false,reads=0;
 function open(){
  const d=new DatabaseSync(join(dir,'test.sqlite'));d.exec('PRAGMA busy_timeout=5000');dbs.push(d);
  const sql={exec:(q,...v)=>q.startsWith('SELECT')?d.prepare(q).all(...v):(v.length?d.prepare(q).run(...v):d.exec(q),[])};
  const transactionSync=fn=>{d.exec('BEGIN IMMEDIATE');try{const out=fn();if(abort)throw Error('aborted');d.exec('COMMIT');return out}catch(e){d.exec('ROLLBACK');throw e}};
  const gate=makeModelBudgetFixture({enabled:true,sql,transactionSync,resolve:r=>r==='active'?current:null,resolveModelPlan:()=>p,
   resolveUsage:({call,plan})=>{reads++;return o&&{call,plan,...o}},validatorKey:Buffer.alloc(32,42)});
  return {...gate,state:()=>d.prepare('SELECT * FROM lab_model_budget_v1').all()};
 }
 return {open,authority:v=>{current=v},plan:v=>{p=v},usage:v=>{o=v},abort:v=>{abort=v},reads:()=>reads};
}
test('default disabled; proven input and output bounds, exact model, no fallback and no tools',t=>{
 A.throws(()=>makeModelBudgetFixture(),/disabled/);
 const f=fixture(t),a=f.open();
 A.equal(a.reserve('wrong').reason,'binding_required');
 for(const p of [null,{...plan,model:'different'},{...plan,source:'operator-estimate'},{...plan,tools:1},{...plan,fallback:true},
  {...plan,inputUpperBound:8001},{...plan,maxBillableOutput:1001},{...plan,maxBillableOutput:'1000'},{...plan,body:'example text'}]){
  f.plan(p);A.equal(a.reserve('active').reason,'model_plan_out_of_bounds');A.equal(a.state().length,0);
 }
 f.plan(plan); const r=a.reserve('active');A.equal(r.phase,'fixture_model_call_reserved');A.deepEqual(r.limits,{upperInput:8000,maxBillableOutput:1000});
 A(!JSON.stringify(a.state()).includes(plan.payloadDigest));
});
test('the original attempt stays spent across independent connections, cold restart and approval epoch change',t=>{
 const f=fixture(t),a=f.open(),b=f.open();
 const r=a.reserve('active');A.equal(r.phase,'fixture_model_call_reserved');
 A.equal(b.reserve('active').reason,'original_call_already_reserved');
 const cold=f.open();
 for(const changes of [{epoch:'policy-2',subject:'another-coordinator'},{run:'new-alias'}]){
  f.authority({...grant,...changes});
  A.equal(cold.reserve('active').reason,'original_call_already_reserved');
  f.usage(usage);A.equal(cold.observe('active',r.call).reason,'original_call_required');
 }
 A.equal(f.reads(),0);A.equal(cold.state().length,1);
 f.authority({...grant,job:'separate-task'});
 A.equal(cold.reserve('active').phase,'fixture_model_call_reserved');
 A.equal(cold.state().length,2);
});
test('partial, uncorrelated, and usage without reasoning accounting remain unknown, not free to retry',t=>{
 const f=fixture(t),a=f.open(),r=a.reserve('active');
 for(const o of [null,{...usage,terminal:'partial'},{...usage,reasoningIncluded:false},{...usage,call:'other'},{...usage,plan:'other'}]){
  f.usage(o);A.equal(a.observe('active',r.call).reason,'usage_not_confirmed');A.equal(a.state()[0].status,'consumed');
  A.equal(a.reserve('active').reason,'original_call_already_reserved');
 }
 f.usage(usage);const cold=f.open();
 A.deepEqual(cold.observe('active',r.call),{phase:'usage_for_main_agent_review',usage:{input:600,output:90}});
 A.equal(a.observe('active',r.call).reason,'settlement_already_recorded');
});
test('a trusted terminal overshoot is held; lower late numbers cannot erase it',t=>{
 const f=fixture(t),a=f.open(),r=a.reserve('active');
 f.usage({...usage,output:1001});A.equal(a.observe('active',r.call).reason,'usage_budget_exceeded');
 A.equal(f.open().state()[0].status,'held');f.usage(usage);
 A.equal(a.observe('active',r.call).reason,'settlement_already_recorded');
});
test('rollback preserves paid-slot atomicity; revocation prevents reads without discarding the slot',t=>{
 const f=fixture(t),a=f.open(),b=f.open();
 f.abort(true);A.throws(()=>a.reserve('active'),/aborted/);f.abort(false);A.equal(b.state().length,0);
 const r=b.reserve('active');f.usage(usage);
 f.authority({...grant,active:false});A.equal(a.observe('active',r.call).reason,'binding_required');A.equal(f.reads(),0);
 f.authority(grant);f.abort(true);A.throws(()=>a.observe('active',r.call),/aborted/);f.abort(false);
 A.equal(b.state()[0].status,'consumed');
 A.equal(b.observe('active',r.call).phase,'usage_for_main_agent_review');
});
