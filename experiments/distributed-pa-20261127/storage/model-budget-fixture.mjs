// Offline-only QwenPaw model-boundary rehearsal, deliberately not a transport
// or a billing mechanism. Auth, tokenizer bounds and usage come from the host.
import {makeScopedValidator} from '../src/sdk/scoped-validator.mjs';
const id=v=>typeof v==='string'&&/^[a-zA-Z0-9._-]{1,80}$/.test(v);
const count=(n,lo,hi)=>Number.isSafeInteger(n)&&lo<=n&&n<=hi;
const shape=(x,k)=>!!x&&Object.getPrototypeOf(x)===Object.prototype&&Reflect.ownKeys(x).length===k.length&&
 k.every(a=>Object.hasOwn(Object.getOwnPropertyDescriptor(x,a)??{},'value'));
const hold=reason=>({phase:'holding',reason});
const MODEL='rivule-local-fixture',INPUT=8000,OUTPUT=1000;
function grant(a){
 return a?.active===true&&a.kind==='offline-model-budget'&&a.role==='coordinator'&&a.publicTextOnly===true&&
  [a.board,a.job,a.run,a.epoch,a.subject].every(id)&&a.rights instanceof Set&&a.rights.has('model:fixture:reserve');
}
export function makeModelBudgetFixture({enabled=false,sql,transactionSync,resolve,resolveModelPlan,resolveUsage,validatorKey}={}){
 if(enabled!==true||typeof sql?.exec!=='function'||![transactionSync,resolve,resolveModelPlan,resolveUsage].every(x=>typeof x==='function'))
  throw TypeError('offline metering disabled');
 const stamp=makeScopedValidator(validatorKey);
 transactionSync(()=>sql.exec(`CREATE TABLE IF NOT EXISTS lab_model_budget_v1 (
   original TEXT PRIMARY KEY, call TEXT UNIQUE NOT NULL, auth TEXT NOT NULL, plan TEXT NOT NULL,
   status TEXT NOT NULL CHECK(status IN('consumed','review','held')), inCap INTEGER NOT NULL, outCap INTEGER NOT NULL)`));
 // The pilot grants one spend slot per original board task, not per run alias.
 // A changed account, epoch or run cannot recreate the slot.
 const original=a=>stamp('model-run',[a.board],a.job);
 const auth=a=>stamp('model-auth',[a.board,a.job,a.run,a.subject],a.epoch);
 const row=k=>[...sql.exec('SELECT * FROM lab_model_budget_v1 WHERE original=?',k)][0];
 const planFor=a=>resolveModelPlan({board:a.board,job:a.job,run:a.run,subject:a.subject,epoch:a.epoch});
 function validPlan(p){
  return shape(p,['model','payloadDigest','inputUpperBound','maxBillableOutput','tools','fallback','source'])&&
   p.source==='fixture-bounded-tokenizer'&&p.model===MODEL&&typeof p.payloadDigest==='string'&&/^[0-9a-f]{64}$/.test(p.payloadDigest)&&
   count(p.inputUpperBound,1,INPUT)&&count(p.maxBillableOutput,1,OUTPUT)&&p.tools===0&&p.fallback===false;
 }
 function reserve(request){
  return transactionSync(()=>{
   const a=resolve(request);
   if(!grant(a))return hold('binding_required');
   const k=original(a);
   if(row(k))return hold('original_call_already_reserved');
   const p=planFor(a);
   if(!validPlan(p))return hold('model_plan_out_of_bounds');
   const s=auth(a),pin=stamp('model-plan',[k,s],[p.model,p.payloadDigest,p.inputUpperBound,p.maxBillableOutput]);
   const call=stamp('model-call',[k,s],pin);
   // One irreversible reservation in this drill. Unknown or failed inbound
   // result does not refund it. No global token counters are public.
   sql.exec('INSERT INTO lab_model_budget_v1 (original,call,auth,plan,status,inCap,outCap) VALUES (?,?,?,?,?,?,?)',
     k,call,s,pin,'consumed',p.inputUpperBound,p.maxBillableOutput);
   return {phase:'fixture_model_call_reserved',call,limits:{upperInput:p.inputUpperBound,maxBillableOutput:p.maxBillableOutput}};
  });
 }
 function observe(request,call){
  return transactionSync(()=>{
   const a=resolve(request);
   if(!grant(a)||!a.rights.has('model:fixture:observe'))return hold('binding_required');
   const k=original(a),r=row(k),s=auth(a);
   if(!r||r.auth!==s||r.call!==call)return hold('original_call_required');
   if(r.status!=='consumed')return hold('settlement_already_recorded');
   const o=resolveUsage({call:r.call,plan:r.plan});
   const correlated=o?.source==='fixture-usage'&&o?.call===r.call&&o?.plan===r.plan&&
    o?.model===MODEL&&o?.reasoningIncluded===true&&o?.terminal==='complete';
   const okay=correlated&&count(o.input,1,r.inCap)&&count(o.output,0,r.outCap);
   if(!correlated)return hold('usage_not_confirmed'); // late exact receipt may still arrive; never reserve again.
   sql.exec('UPDATE lab_model_budget_v1 SET status=? WHERE original=?',okay?'review':'held',k);
   return okay?{phase:'usage_for_main_agent_review',usage:{input:o.input,output:o.output}}:hold('usage_budget_exceeded');
  });
 }
 return Object.freeze({reserve,observe});
}
