import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {makeScopedValidator} from '../src/sdk/scoped-validator.mjs';

const tool='registry-count', server='rivule-fixture-registry', name='lab-provider-summary';
const wire=Object.freeze({
 name:tool,
 inputSchema:Object.freeze({type:'object',properties:Object.freeze({region:Object.freeze({enum:Object.freeze(['cn','global'])})}),
  required:Object.freeze(['region']),additionalProperties:false}),
 outputSchema:Object.freeze({type:'object',properties:Object.freeze({count:Object.freeze({type:'integer',minimum:0})}),
  required:Object.freeze(['count']),additionalProperties:false}),
});
const digest=x=>createHash('sha256').update(x).digest('hex');
const actionKey=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(x);
const proof=x=>typeof x==='string'&&/^sv1-[\w-]{43}$/.test(x);
const saneTime=x=>Number.isSafeInteger(x)&&x>=0;
const skillPath=new URL('../skills/lab-provider-summary/SKILL.md',import.meta.url);
// Digest is rooted in the versioned file, not in received prompts, metadata or skill instructions.
const skillDigest=digest(readFileSync(skillPath));
const counts=Object.freeze({cn:2,global:3}); // fixed synthetic fixture, not live registry statistics
const exact=(a,...keys)=>a&&Object.getPrototypeOf(a)===Object.prototype&&Reflect.ownKeys(a).length===keys.length&&
 keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(a,k)??{},'value'));
function canonical(x){
 let remaining=400;
 function visit(v,depth){
  if(--remaining<0||depth>10)throw Error('schema_limit');
  if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return v;
  if(typeof v==='string'&&v.length<=1024)return v;
  if(Array.isArray(v)){
   if(v.length>32||!Array.from({length:v.length},(_,i)=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,i)??{},'value')).every(Boolean)||
     Reflect.ownKeys(v).length!==v.length+1)throw Error('schema_array');
   return v.map(a=>visit(a,depth+1));
  }
  if(!v||Object.getPrototypeOf(v)!==Object.prototype)throw Error('schema_object');
  const keys=Reflect.ownKeys(v);
  if(keys.length>32||!keys.every(k=>typeof k==='string'&&k.length<=100&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value')))
   throw Error('schema_keys');
  return Object.fromEntries(keys.sort().map(k=>[k,visit(v[k],depth+1)]));
 }
 return JSON.stringify(visit(x,0));
}
const schemaPin=desc=>digest(canonical([server,desc.name,desc.inputSchema,desc.outputSchema]));
const reviewed=schemaPin(wire),recipePin=digest(canonical([name,1,skillDigest,server,tool,reviewed,'fixture-read']));
export const labMcpDeclaration=Object.freeze({server,tool:wire});
export const labSkillIdentity=Object.freeze({name,version:1,recipePin,skillDigest,schemaPin:reviewed});
const field=(x,k)=>{const d=Object.getOwnPropertyDescriptor(x,k);return d&&Object.hasOwn(d,'value')?d.value:undefined;};
function usable(declaration){
 try{
  if(field(declaration,'server')!==server)return false;
  const d=field(declaration,'tool'),n=field(d,'name');
  return n===tool&&schemaPin({name:n,inputSchema:field(d,'inputSchema'),outputSchema:field(d,'outputSchema')})===reviewed;
 }catch{return false}
}
const wait=reason=>Object.freeze({phase:'holding',reason});
const grantFor=(p,job)=>p?.active===true&&p.mode==='offline-fixture'&&p.role==='coordinator'&&p.job===job&&
 [p.board,p.subject,p.policyEpoch,p.job].every(actionKey)&&p.rights instanceof Set&&p.rights.has('skill:fixture:propose');
export function makeMcpSkillFixture({enabled=false,sql,transactionSync,resolve,resolveApproval,clock,validatorKey}={}){
 if(enabled!==true||typeof sql?.exec!=='function'||![transactionSync,resolve,resolveApproval,clock].every(x=>typeof x==='function'))
  throw TypeError('offline fixture disabled');
 const mark=makeScopedValidator(validatorKey);
 transactionSync(()=>sql.exec('CREATE TABLE IF NOT EXISTS lab_mcp_skill_once_v1 (approvalKey TEXT PRIMARY KEY, invocation TEXT UNIQUE NOT NULL, receipt TEXT NOT NULL)'));
 const prepare=({request,job,recipe,inputs,declaration})=>{
  const p=resolve(request);
  if(!grantFor(p,job))return wait('binding_required');
  if(!usable(declaration))return wait('tool_review_required');
  if(!exact(recipe,'name','version','recipePin','skillDigest')||recipe.name!==name||recipe.version!==1||
    recipe.recipePin!==recipePin||recipe.skillDigest!==skillDigest)return wait('recipe_review_required');
  if(!exact(inputs,'region')||!['cn','global'].includes(inputs.region))return wait('input_rejected');
  const scope=[p.board,p.subject,p.policyEpoch,p.job],region=inputs.region;
  return {phase:'awaiting_approval',p,scope,region,operation:mark('mcp-skill-proposal',scope,[recipePin,reviewed,region])};
 };
 return Object.freeze({
  inspect({request,job,declaration}){
   const p=resolve(request);
   if(!grantFor(p,job))return wait('binding_required');
   return usable(declaration)?{phase:'reviewed_discovery',server,tool,schemaPin:reviewed}:{phase:'discovery_only',reason:'tool_review_required'};
  },
  propose(args){
   const q=prepare(args);
   return q.phase!=='awaiting_approval'?q:{phase:q.phase,operation:q.operation,recipe:name,version:1,server,tool,inputs:{region:q.region}};
  },
  run(args){
   return transactionSync(()=>{
    const q=prepare(args);
    if(q.phase!=='awaiting_approval')return q;
    if(!q.p.rights.has('skill:fixture:run')||args.operation!==q.operation||!proof(args.operation)||!actionKey(args.approvalId))
     return wait('approval_required');
    const approval=resolveApproval({scope:[...q.scope],operation:q.operation,id:args.approvalId}),now=clock();
    if(approval?.source!=='mock-owner-registry'||approval.id!==args.approvalId||approval.operation!==q.operation||
      JSON.stringify(approval.scope)!==JSON.stringify(q.scope)||approval.explicit!==true||
      ![now,approval.issuedAt,approval.expiresAt].every(saneTime)||now<approval.issuedAt||now>=approval.expiresAt||
      approval.expiresAt-approval.issuedAt>60_000)return wait('approval_required');
    const approvalKey=mark('mcp-skill-approval',[q.p.board,q.p.subject,q.p.policyEpoch],approval.id);
    // The exact invocation remains spent after cold restart. Another approval ID cannot replay it.
    if([...sql.exec('SELECT 1 FROM lab_mcp_skill_once_v1 WHERE approvalKey=? OR invocation=?',approvalKey,q.operation)].length)
     return wait('already_applied');
    const result={count:counts[q.region]};
    const receipt=mark('mcp-skill-result',q.scope,[q.operation,result]);
    sql.exec('INSERT INTO lab_mcp_skill_once_v1 (approvalKey,invocation,receipt) VALUES (?,?,?)',approvalKey,q.operation,receipt);
    return {phase:'result_for_review',operation:q.operation,receipt,output:result};
   });
  }
 });
}
