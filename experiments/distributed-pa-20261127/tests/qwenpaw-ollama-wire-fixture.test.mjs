import A from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeModelBudgetFixture} from '../storage/model-budget-fixture.mjs';
import {makeFixtureWire,makeQwenPawOllamaWireFixture,stagedSse,taggedRequestShape as taggedShape} from '../adapter/qwenpaw-ollama-wire-fixture.mjs';
const answer='11月14日，TPS 首班船从瓦尔帕莱索启航，载有388箱、8500吨智利车厘子。11月18日，ProChile 在深圳举办新一季启动活动。';
const base={id:'chat-fixture-1',model:taggedShape.model,object:'chat.completion.chunk'};
const frame=z=>'data: '+JSON.stringify({...base,...z})+'\n\n';
const delta=frame({choices:[{index:0,delta:{role:'assistant',content:answer},finish_reason:null}]});
const thought=frame({choices:[{index:0,delta:{reasoning:'不可进入结果卡'},finish_reason:null}]});
const stop=frame({choices:[{index:0,delta:{},finish_reason:'stop'}]});
const used=(out=41)=>frame({choices:[],usage:{prompt_tokens:335,completion_tokens:out,total_tokens:335+out}});
const done='data: [DONE]\n\n';
const full=thought+delta+stop+used()+done;
const plan={source:'fixture-bounded-tokenizer',model:taggedShape.model,...makeFixtureWire(taggedShape).proof,inputUpperBound:8000,tools:0,fallback:false};
const grant={active:true,role:'coordinator',kind:'offline-model-budget',publicTextOnly:true,board:'board',job:'original',run:'run',epoch:'epoch',subject:'local',rights:new Set(['model:fixture:reserve','model:fixture:observe'])};
async function fixture(t,replyFn){
 const received=[],dbs=[],usages=new Map(),folder=mkdtempSync(join(tmpdir(),'rivule-wire'));
 const server=createServer(async(req,res)=>{
  let body='';for await(const bytes of req)body+=bytes;
  received.push([req.method,req.url,JSON.parse(body)]);
  await replyFn(res,received.length);
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(cb=>server.close(cb));dbs.forEach(d=>d.close());rmSync(folder,{force:true,recursive:true});});
 let g=grant,p=plan;
 function open(){
  const d=new DatabaseSync(join(folder,'wire.sqlite'));dbs.push(d);
  const sql={exec:(q,...v)=>q.startsWith('SELECT')?d.prepare(q).all(...v):(v.length?d.prepare(q).run(...v):d.exec(q),[])};
  const transactionSync=fn=>{d.exec('BEGIN IMMEDIATE');try{const out=fn();d.exec('COMMIT');return out}catch(e){d.exec('ROLLBACK');throw e}};
  const budget=makeModelBudgetFixture({enabled:true,sql,transactionSync,resolve:r=>r==='allowed'?g:null,resolveModelPlan:()=>p,
   resolveUsage:({call,plan})=>usages.has(call)?{call,plan,...usages.get(call)}:null,validatorKey:Buffer.alloc(32,10)});
  const adapter=makeQwenPawOllamaWireFixture({enabled:true,port:server.address().port,budget,saveUsageForFixture:(k,x)=>usages.set(k,x)});
  return {...adapter,rows:()=>d.prepare('SELECT status FROM lab_model_budget_v1').all()};
 }
 return {open,received,changePlan:v=>{p=v},grant:v=>{g=v}};
}
function sse(res,body){res.writeHead(200,{'content-type':'text/event-stream'});res.end(body);}
test('one upstream POST, actual max_tokens, full stream and review-only (no visible reasoning)',async t=>{
 const f=await fixture(t,(res)=>{
  res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8'});
  // Split one multibyte code point across TCP writes deliberately.
  const buf=Buffer.from(full),i=buf.indexOf(Buffer.from('不'))+1;
  res.write(buf.subarray(0,i));setImmediate(()=>res.end(buf.subarray(i)));
 });
 const a=f.open(),b=f.open();
 const [r,duplicate]=await Promise.all([a.dispatch('allowed',taggedShape),b.dispatch('allowed',taggedShape)]);
 A.deepEqual(r,{phase:'usage_for_main_agent_review',usage:{input:335,output:41},candidate:answer});
 A.equal(duplicate.reason,'original_call_already_reserved');
 A.equal(f.received.length,1);
 A.deepEqual(f.received[0],['POST','/v1/chat/completions',JSON.parse(makeFixtureWire(taggedShape).body)]);
 A.equal(f.received[0][2].max_completion_tokens,undefined);A.equal(f.received[0][2].max_tokens,1000);
 A.equal(a.rows()[0].status,'review');
});
test('stop without usage or [DONE] is held after restart and does not send a second POST',async t=>{
 const f=await fixture(t,res=>sse(res,delta+stop));
 const a=f.open();
 A.equal((await a.dispatch('allowed',taggedShape)).reason,'wire_outcome_unknown');
 A.equal(a.rows()[0].status,'consumed');
 f.grant({...grant,run:'renamed',epoch:'renewed'});
 A.equal((await f.open().dispatch('allowed',taggedShape)).reason,'original_call_already_reserved');
 A.equal(f.received.length,1);
});
test('HTTP 503 with Retry-After and redirect both consume their original slot without followup',async t=>{
 const f=await fixture(t,(res,n)=>{res.writeHead(n===1?503:307,{location:'/v1/chat/completions','retry-after':'0'});res.end();});
 const a=f.open();
 for(const job of ['original','second']){
  f.grant({...grant,job});
  A.equal((await a.dispatch('allowed',taggedShape)).reason,'wire_outcome_unknown');
  A.equal((await a.dispatch('allowed',taggedShape)).reason,'original_call_already_reserved');
 }
 A.equal(f.received.length,2);
});
test('cap, digest, source and role are checked before the network; true overshoot stays held',async t=>{
 const f=await fixture(t,res=>sse(res,delta+stop+used(1001)+done)),a=f.open();
 A.throws(()=>makeQwenPawOllamaWireFixture(),/disabled/);
 for(const bad of [{...taggedShape,max_tokens:999},{...taggedShape,max_completion_tokens:1001},{...taggedShape,tools:[{}]},
  {...taggedShape,messages:[{role:'system',content:'其它'}]}]){
  A.equal((await a.dispatch('allowed',bad)).reason,'unapproved_wire_request');
 }
 A.equal((await a.dispatch('allowed',{...taggedShape,max_completion_tokens:997})).reason,'wire_plan_mismatch');
 f.changePlan({...plan,payloadDigest:'0'.repeat(64)});A.equal((await a.dispatch('allowed',taggedShape)).reason,'wire_plan_mismatch');
 f.changePlan(plan);A.equal((await a.dispatch('not allowed',taggedShape)).reason,'binding_required');
 A.deepEqual(a.rows(),[]);A.deepEqual(f.received,[]);
 A.equal((await a.dispatch('allowed',taggedShape)).reason,'usage_budget_exceeded');
 A.equal(a.rows()[0].status,'held');A.equal(f.received.length,1);
});
test('terminal stream rejects wrong ID, out-of-order usage, abrupt EOF, tools, empty output or abnormal finish',()=>{
 for(const x of [delta+stop+used(),delta+used()+stop+done,delta+stop+done,thought+stop+used()+done,
  delta+stop+used()+used()+done,delta+stop+used()+done+delta,full.replace('chat-fixture-1','chat-other'),
  delta+stop.replace('"stop"','"length"')+used()+done,delta.replace('"content":','"tool_calls":')+stop+used()+done,
  delta+stop+used().replace('"total_tokens":376','"total_tokens":0')+done])A.equal(stagedSse(x),undefined);
 A.deepEqual(stagedSse(full.replaceAll('\n','\r\n')),{usage:{input:335,output:41},text:answer});
});

test('a real TCP cut after stop does not expose partials or authorize another POST',async t=>{
 const f=await fixture(t,res=>{
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.write(delta+stop,()=>res.destroy());
 });
 const a=f.open();
 A.deepEqual(await a.dispatch('allowed',taggedShape),{phase:'holding',reason:'wire_outcome_unknown'});
 A.equal((await f.open().dispatch('allowed',taggedShape)).reason,'original_call_already_reserved');
 A.equal(f.received.length,1);
});
test('revocation while a matching result arrives leaves it hidden and the next independent task still works',async t=>{
 let accept,wait;const inFlight=new Promise(r=>{wait=r});const release=new Promise(r=>{accept=r});
 const f=await fixture(t,async(res,n)=>{if(n===1){wait();await release;}sse(res,full);});
 const a=f.open(),pending=a.dispatch('allowed',taggedShape);await inFlight;
 f.grant({...grant,active:false});accept();
 A.deepEqual(await pending,{phase:'holding',reason:'binding_required'});
 A.equal(a.rows()[0].status,'consumed');
 f.grant({...grant,run:'new-run',epoch:'new-epoch'});
 A.equal((await f.open().dispatch('allowed',taggedShape)).reason,'original_call_already_reserved');
 f.grant({...grant,job:'independent'});
 A.equal((await f.open().dispatch('allowed',taggedShape)).phase,'usage_for_main_agent_review');
 A.equal(f.received.length,2);
});
