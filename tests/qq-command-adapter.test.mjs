import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {QQCommandAdapter} from '../src/owner/qq-command-adapter.mjs';
// Execute the unchanged production Ed25519 verifier/normalizer, rather than a
// fake verified:true body flag or hand-written duplicate of the auth logic.
const source=readFileSync(new URL('../src/owner/worker.js',import.meta.url),'utf8');
const sandbox=vm.createContext({TextEncoder,TextDecoder,Response,Request,Headers,URL,crypto:webcrypto,__name:x=>x,qqHash:async v=>Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(v))).toString('hex'),qqReadBytes:async stream=>new Uint8Array(await new Response(stream).arrayBuffer())});
vm.runInContext(source.slice(source.indexOf('async function qqGateKey('),source.indexOf('var response = ',source.indexOf('var QQDurableInbox')))+'\nglobalThis.api={handleQQWebhook,qqSign,QQDurableInbox,qqGateKey};',sandbox);
const {handleQQWebhook,qqSign,QQDurableInbox,qqGateKey}=sandbox.api;
const ref='12345678-1234-1234-1234-123456789abc';
function fixture(){
 const now=1800000000000,context={source_id:'pa',project_id:'project',task_id:'task',run_id:'run',branch_id:'main',thread_id:'thread'};
 let enabled=true,generation='session1',active=true,binding='binding1',beforeGuard=null;const commands=new Map(),seen=new Map();
 const config={enabled:true,ownerId:'owner',appId:'123',userOpenId:'owner-openid',allowedSources:['pa'],allowedProjects:['project']};
 const bridge={bindings:{sources:[{source_id:'pa'}]},requireContext(source,c){assert.equal(source?.source_id,'pa');assert.deepEqual(c,context);return context;},preference:()=>({commands_enabled:enabled}),binding:()=>binding,resolveQQContext(code){if(code!==ref)throw Error('unknown_context');return context;},async enqueueCommand(trusted,input,guard){if(beforeGuard)await beforeGuard();await guard();const prior=commands.get(trusted.event_id);if(prior){assert.deepEqual(prior.input,input);return {...prior,duplicate:true};}const result={trusted,input,state:'pending',execution:'not_started'};commands.set(trusted.event_id,result);return result;}};
 const kv=new Map(),storage={get:async k=>kv.get(k),put:async(k,v)=>kv.set(k,v),transaction:async fn=>fn(storage)};
 const inbox=new QQDurableInbox(storage);
 const adapter=new QQCommandAdapter({bridge,inbox,revoked:async c=>(await storage.get(await qqGateKey(c.appId,c.userOpenId)))===true,config:()=>config,authority:async()=>({active,...config,generation,validUntil:now+60000}),now:()=>now});
 async function send({content='/rivule '+ref+' continue testing',author='owner-openid',app='123',signature=true,eventId='event1',id='message1',timestamp=now,type='C2C_MESSAGE_CREATE',extra={}}={}){
 const payload={op:0,id:eventId,t:type,d:{id,author:{user_openid:author},content,timestamp:new Date(timestamp).toISOString(),...extra}},raw=JSON.stringify(payload),ts=String(now/1000);
 const sig=signature?await qqSign('test-secret',new TextEncoder().encode(ts+raw)):'0'.repeat(128);
 return handleQQWebhook(new Request('https://owner.internal/qq/webhook',{method:'POST',headers:{'X-Bot-Appid':app,'X-Signature-Timestamp':ts,'X-Signature-Ed25519':sig},body:raw}),{enabled:true,appId:'123',userOpenId:'owner-openid',appSecret:()=> 'test-secret'},adapter,now);
 }
 return {send,commands,config,setEnabled:v=>enabled=v,setActive:v=>active=v,setBeforeGuard:fn=>beforeGuard=fn};
}
test('real signed owner callback queues exact registered task once, does not execute',async()=>{
 const f=fixture();assert.equal((await f.send()).status,200);assert.equal((await f.send()).status,200);assert.equal((await f.send({eventId:'redelivery-event'})).status,200);assert.equal(f.commands.size,1);
 const command=[...f.commands.values()][0];assert.equal(command.state,'pending');assert.equal(command.execution,'not_started');assert.equal(command.trusted.requester_id,'owner-openid');assert.equal(command.input.thread_id,'thread');
});
test('bad signature, wrong app, foreign owner, forged body trust never enqueue',async()=>{
 const f=fixture();assert.equal((await f.send({signature:false})).status,401);assert.equal((await f.send({app:'456'})).status,401);assert.equal((await f.send({author:'other',extra:{verified:true,owner_id:'owner'}})).status,200);assert.equal(f.commands.size,0);
});
test('commands disabled, lifecycle revoked, stale events, unknown context fail closed',async()=>{
 for(const mutate of [f=>f.setEnabled(false),f=>f.setActive(false),f=>f.config.allowedSources=[]]){const f=fixture();mutate(f);assert.equal((await f.send()).status,503);assert.equal(f.commands.size,0);}
 const f=fixture();assert.equal((await f.send({timestamp:1800000000000-300001})).status,503);assert.equal((await f.send({id:'m2',content:'/rivule 00000000-0000-0000-0000-000000000000 stop'})).status,503);assert.equal(f.commands.size,0);
});
test('provider message payload conflicts do not change queued instruction',async()=>{
 const f=fixture();assert.equal((await f.send()).status,200);assert.equal((await f.send({content:'/rivule '+ref+' changed'})).status,409);assert.equal(f.commands.size,1);
});
test('plain text and third-party instructions cannot select a source by prose',async()=>{
 const f=fixture();assert.equal((await f.send({content:'tell pa to continue'})).status,200);assert.equal(f.commands.size,0);
});

test('verified local lifecycle revoke blocks commands even while remote authority lags',async()=>{
 const f=fixture();assert.equal((await f.send({type:'FRIEND_DEL',extra:{openid:'owner-openid'}})).status,200);assert.equal((await f.send({id:'after-revoke',eventId:'new-event'})).status,503);assert.equal(f.commands.size,0);
});

test('local revoke after remote authority read still blocks guarded durable admission',async()=>{
 const f=fixture();f.setBeforeGuard(()=>f.send({type:'FRIEND_DEL',eventId:'revoke-during-admission',extra:{openid:'owner-openid'}}));
 assert.equal((await f.send()).status,503);assert.equal(f.commands.size,0);
});
