import test from 'node:test';
import A from 'node:assert/strict';
import {makeCueAdapter,cueCapability} from './manus-cue.mjs';
const binding={agentId:'Agent-A',threadId:'Thread-A',dedicated:true,regionVerified:true};
const credential={kind:'api-key',value:'fake-credential-never-sent'};
const work={agentId:'Agent-A',attemptRef:'job-1-attempt-1',approvedText:'对比两个公开资料的定义。只交摘要。',approval:'authorized-text-only'};
const reply=(j,status=200)=>Response.json(j,{status});
function fake(responses,opts={}) {
 const calls=[];
 const a=makeCueAdapter({credential,bindings:[binding],...opts,fetcher:async (u,p)=>{
  calls.push({u,p});
  const x=responses.shift();if(x instanceof Error)throw x;
  A(x,'unexpected extra call');return x;
 }});
 return {a,calls};
}
test('read official supported identities, without exposing credential or binding wrong thread',async()=>{
 const {a,calls}=fake([reply({ok:true,data:[{id:'Agent-A',task_id:'Thread-A',nickname:'Cue specialist',about:'private bio'},{id:'Agent-B',task_id:'Other',nickname:'Other'}]})]);
 A.deepEqual(await a.discover(),{state:'discovered',agents:[{agentId:'Agent-A',threadId:'Thread-A',nickname:'Cue specialist',bound:true}]});
 A.equal(calls[0].u,'https://api.manus.ai/v2/agent.list');
 A.equal(calls[0].p.method,'GET');A.equal(calls[0].p.redirect,'error');
 A(!cueCapability.defaultEnabled);
 await A.rejects(a.dispatch({...work,agentId:'Agent-B'}),/not bound/);
 A.equal(calls.length,1);
});
test('authorized isolated Cue task; acknowledgment differs from completion',async()=>{
 const {a,calls}=fake([reply({ok:true,task_id:'Thread-A',request_id:'request1',status:'delivered'})]);
 A.deepEqual(await a.dispatch(work),{state:'delivered',requestId:'request1'});
 const [c]=calls;
 A.equal(c.u,'https://api.manus.ai/v2/task.sendMessage');
 A.deepEqual(JSON.parse(c.p.body),{task_id:'Thread-A',clear_connectors:true,message:{content:'[rivule-attempt:job-1-attempt-1]\n'+work.approvedText}});
 A.equal(c.p.headers['x-manus-api-key'],credential.value);
 A(!('authorization' in c.p.headers));
});
test('cannot dispatch without authorizing exact ticket and dedicated regional binding',async()=>{
 const {a,calls}=fake([]);
 await A.rejects(a.dispatch({...work,approval:'unapproved'}),/invalid approved/);
 await A.rejects(a.dispatch({...work,attemptRef:'anything\nforged'}),/invalid attempt/);
 await A.rejects(a.dispatch({...work,approvedText:'[rivule-attempt:fake]'}),/invalid approved/);
 A.throws(()=>makeCueAdapter({credential,fetcher:()=>{},bindings:[{...binding,regionVerified:false}]}),/region-verified/);
 A.equal(calls.length,0);
});
test('ambiguous dispatch does not retry; pending review remains pending; rate limits recorded separately',async()=>{
 for(const [x,expected] of [
  [Error('timeout on uncertain write'),'unknown'],[reply({ok:false},503),'unknown'],
  [reply({ok:true,task_id:'Other',request_id:'request1',status:'delivered'}),'unknown'],
  [reply({ok:true,task_id:'Thread-A',request_id:'request1',status:'pending_owner_review'}),'owner_review'],
  [reply({ok:false,error:{code:'permission_denied',message:'private info'}},403),'rejected'],
  [reply({ok:false},429),'throttled']
 ]){
  const {a,calls}=fake([x]);const r=await a.dispatch(work);A.equal(r.state,expected);A.equal(calls.length,1);
  A(!JSON.stringify(r).includes('private info'));
 }
});
test('read receipt requires exact existing user message; assistant echo does not count',async()=>{
 const exact='[rivule-attempt:job-1-attempt-1]\n'+work.approvedText;
 const user=(id,content)=>({id,type:'user_message',user_message:{content}});
 const result=(messages,has_more=false,next_cursor)=>reply({ok:true,task_id:'Thread-A',messages,has_more,next_cursor});
 const {a,calls}=fake([
  result([{id:'a',type:'assistant_message',assistant_message:{content:exact}},user('b',exact+'wrong')],true,'cursor1'),
  result([user('goal',exact)]),
  result([user('a',exact),user('b',exact)])
 ],{credential:{kind:'trusted-oauth',value:'test-only'}});
 A.deepEqual(await a.observe(work),{state:'not_observed',nextCursor:'cursor1'});
 A.deepEqual(await a.observe({...work,cursor:'cursor1'}),{state:'observed_delivery',messageId:'goal',nextCursor:null});
 A.equal(new URL(calls[1].u).searchParams.get('cursor'),'cursor1');
 A.equal(calls[1].p.headers.authorization,'Bearer test-only');
 A.deepEqual(await a.observe(work),{state:'needs_review',reason:'duplicate_or_invalid_receipt'});
});
