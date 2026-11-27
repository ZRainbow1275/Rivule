import test from 'node:test';import A from 'node:assert/strict';import {createHash} from 'node:crypto';
import {dispatchGlean,readGlean} from '../adapter/glean-durable.mjs';
const text='Compare public release dates',d=createHash('sha256').update(text).digest('hex');
const binding={provider:'glean-durable',oauthMode:'verified-user',agentType:'published-chat-text',
 classification:'public-text',retentionReviewed:true,writeToolsDisabled:true,tenantRef:'single-tenant',lane:'one-seat',agentId:'stable-agent',inputDigest:d};
const trial=()=>{const e=[];let used=false;
 const commit=async c=>{if(c.type==='begin'){if(used)return {committed:false};used=true;e.push(c);return {committed:true,permit:{task:'sample',fence:1,inputDigest:d,provider:'glean-durable',lane:'one-seat',expiresAt:50}};}
 e.push(c);return {committed:true};};
 return {e,base:{commit,binding,task:'sample',fence:1,approvedText:text,clock:()=>1}};
};
test('Glean start has exact official durable API shape; only acknowledges run',async()=>{
 const {e,base}=trial();const x=await dispatchGlean({...base,transport:async q=>{A.deepEqual(q,{method:'POST',tenantRef:'single-tenant',path:'/api/agents/stable-agent/runs',body:{execution_mode:'DURABLE',stream:false,messages:[{role:'USER',content:[{type:'text',text}]}]}});
 return {status:201,json:{run:{agent_id:'stable-agent',run_id:'run-one',state:'SUCCEEDED'}}};}});
 A.equal(x.state,'provider_acknowledged');A.deepEqual(e.map(n=>n.type),['begin','acknowledged']);A.equal(e[1].receipt,'run-one');
});
test('Glean lost response never creates a second run',async()=>{const {e,base}=trial();let calls=0;const p={...base,transport:async()=>{calls++;throw Error('lost');}};
 A.equal((await dispatchGlean(p)).state,'verify_original_attempt');A.equal((await dispatchGlean(p)).state,'already_reserved');
 A.equal(calls,1);A.equal(e[1].type,'uncertain');
});
test('no dispatch if user-specific tenant/privacy controls missing',async()=>{const {e,base}=trial();
 await A.rejects(dispatchGlean({...base,binding:{...binding,writeToolsDisabled:false},transport:async()=>A.fail()}),/unauthorized/);
 A.deepEqual(e,[]);
});
test('foreign run is not acknowledged',async()=>{const {e,base}=trial();const x=await dispatchGlean({...base,transport:async()=>({status:201,json:{run:{agent_id:'foreign',run_id:'run-one'}}})});
 A.equal(x.state,'verify_original_attempt');A.equal(e[1].type,'uncertain');
});
test('known run needs human approval; read API never approves, exposes arguments or finishes',async()=>{
 const receipt={agentId:'stable-agent',runId:'run-one',lane:'one-seat',tenantRef:'single-tenant'};
 const read=state=>readGlean({binding,receipt,transport:async req=>{A.equal(req.method,'GET');A.equal(req.path,'/api/agents/stable-agent/runs/run-one');
 return {status:200,json:{run:{agent_id:'stable-agent',run_id:'run-one',state,pending_interactions:[{arguments:'private'}]}}};}});
 A.deepEqual(await read('REQUIRES_INPUT'),{state:'requires_owner_decision'});
 A.deepEqual(await read('SUCCEEDED'),{state:'result_available_for_review'});
 await A.rejects(readGlean({binding,receipt:{...receipt,lane:'other'},transport:async()=>A.fail()}),/unverified/);
});
