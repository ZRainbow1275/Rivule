import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {QQCommandAdapter} from '../src/owner/qq-command-adapter.mjs';
import {ConversationQQCommandAdapter} from '../src/owner/conversation-qq-command-adapter.mjs';
// Execute the unchanged production Ed25519 verifier/normalizer, rather than a
// fake verified:true body flag or hand-written duplicate of the auth logic.
const source=readFileSync(new URL('../src/owner/worker.js',import.meta.url),'utf8');
const sandbox=vm.createContext({TextEncoder,TextDecoder,Response,Request,Headers,URL,crypto:webcrypto,__name:x=>x,qqHash:async v=>Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(v))).toString('hex'),qqReadBytes:async stream=>new Uint8Array(await new Response(stream).arrayBuffer())});
vm.runInContext(source.slice(source.indexOf('async function qqGateKey('),source.indexOf('var response = ',source.indexOf('var QQDurableInbox')))+'\nglobalThis.api={handleQQWebhook,qqSign,QQDurableInbox,qqGateKey};',sandbox);
const {handleQQWebhook,qqSign,QQDurableInbox,qqGateKey}=sandbox.api;
const ref='12345678-1234-1234-1234-123456789abc';
function fixture(wrapInbox=task=>task){
 const now=1800000000000,context={source_id:'pa',project_id:'project',task_id:'task',run_id:'run',branch_id:'main',thread_id:'thread'};
 let enabled=true,generation='session1',active=true,binding='binding1',beforeGuard=null;const commands=new Map(),seen=new Map();
 const config={enabled:true,ownerId:'owner',appId:'123',userOpenId:'owner-openid',allowedSources:['pa'],allowedProjects:['project']};
 const bridge={bindings:{sources:[{source_id:'pa'}]},requireContext(source,c){assert.equal(source?.source_id,'pa');assert.deepEqual(c,context);return context;},preference:()=>({commands_enabled:enabled}),binding:()=>binding,resolveQQContext(code){if(code!==ref)throw Error('unknown_context');return context;},async enqueueCommand(trusted,input,guard){if(beforeGuard)await beforeGuard();await guard();const prior=commands.get(trusted.event_id);if(prior){assert.deepEqual(prior.input,input);return {...prior,duplicate:true};}const result={trusted,input,state:'pending',execution:'not_started'};commands.set(trusted.event_id,result);return result;}};
 const kv=new Map(),storage={get:async k=>kv.get(k),put:async(k,v)=>kv.set(k,v),transaction:async fn=>fn(storage)};
 const inbox=new QQDurableInbox(storage);
 const adapter=new QQCommandAdapter({bridge,inbox,revoked:async c=>(await storage.get(await qqGateKey(c.appId,c.userOpenId)))===true,config:()=>config,authority:async()=>({active,...config,generation,validUntil:now+60000}),now:()=>now});
 const callbackInbox=wrapInbox(adapter,inbox);
 async function send({content='/rivule '+ref+' continue testing',author='owner-openid',app='123',signature=true,eventId='event1',id='message1',timestamp=now,type='C2C_MESSAGE_CREATE',extra={}}={}){
 const payload={op:0,id:eventId,t:type,d:{id,author:{user_openid:author},content,timestamp:new Date(timestamp).toISOString(),...extra}},raw=JSON.stringify(payload),ts=String(now/1000);
 const sig=signature?await qqSign('test-secret',new TextEncoder().encode(ts+raw)):'0'.repeat(128);
 return handleQQWebhook(new Request('https://owner.internal/qq/webhook',{method:'POST',headers:{'X-Bot-Appid':app,'X-Signature-Timestamp':ts,'X-Signature-Ed25519':sig},body:raw}),{enabled:true,appId:'123',userOpenId:'owner-openid',appSecret:()=> 'test-secret'},callbackInbox,now);
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

test('task command parser preserves trailing whitespace and rejects oversized final-newline body',async()=>{
 const f=fixture(),text='x'.repeat(1199)+'\n';assert.equal((await f.send({content:'/rivule '+ref+' '+text})).status,200);assert.equal([...f.commands.values()][0].input.text,text);
 const g=fixture();assert.equal((await g.send({content:'/rivule '+ref+' '+'x'.repeat(1200)+'\n'})).status,503);assert.equal(g.commands.size,0);
});

for(const [label,content] of [
 ['longer word','/rivulet 是一本诗集'],['Chinese continuation','/rivule笔记 里面有目录'],
 ['filename','/rivule.md 是文档名'],['hyphenated name','/rivule-guide 是目录名'],
 ['path with leading spaces','  /rivule/docs/readme.md'],['numbered label','/rivule2 项目代号']
])test('ordinary QQ '+label+' is acknowledged as inbox text, never a command',async()=>{
 const f=fixture(),r=await f.send({content});assert.equal(r.status,200);assert.deepEqual(await r.json(),{op:12});assert.equal(f.commands.size,0);
});
test('ordinary near-name redelivery stays successful without a command or changed message',async()=>{
 const f=fixture(),content='/rivulet 读书清单';assert.equal((await f.send({content})).status,200);
 assert.equal((await f.send({content,eventId:'redelivery'})).status,200);assert.equal(f.commands.size,0);
});
test('normal words are still accepted when PA commands are switched off',async()=>{
 const f=fixture();f.setEnabled(false);f.setActive(false);const r=await f.send({content:'/rivule.notes 是本地说明'});assert.equal(r.status,200);assert.equal(f.commands.size,0);
});
test('exact command marker remains strict; a blank or malformed explicit request does not enqueue',async()=>{
 for(const content of ['/rivule','/rivule help','/rivule\t'+ref+' test','/rivule　'+ref+' test']){
  const f=fixture();assert.equal((await f.send({content})).status,503);assert.equal(f.commands.size,0);
 }
});
test('normalized ordinary inbox path does not perform PA authority reads and retains original inbox result',async()=>{
 const calls=[];const adapter=new QQCommandAdapter({inbox:{enqueueOnce:async e=>{calls.push(e.content);return 'duplicate';}},config:()=>{throw Error('unexpected command path');}});
 assert.equal(await adapter.enqueueOnce({type:'message',content:'/rivulet 读书清单'}),'duplicate');assert.deepEqual(calls,['/rivulet 读书清单']);
});
test('a proper explicit instruction after near-name chat still queues once, preserving the instruction text',async()=>{
 const f=fixture();assert.equal((await f.send({content:'/rivulet ordinary'})).status,200);
 const text='整理目录，保留这段说明  ';const r=await f.send({content:'  /rivule '+ref+' '+text,eventId:'after-ordinary',id:'explicit-command'});
 assert.equal(r.status,200);assert.equal(f.commands.size,1);assert.equal([...f.commands.values()][0].input.text,text);assert.equal([...f.commands.values()][0].execution,'not_started');
});
test('task-only routing never acknowledges the explicit separate conversation verb as ordinary text',async()=>{
 for(const content of ['/rivule-chat','/rivule-chat '+ref+' continue','  /rivule-chat\targument']){
  const f=fixture(),response=await f.send({content});assert.equal(response.status,503);assert.equal(f.commands.size,0);
 }
});
test('the real outer conversation router distinguishes the complete chat verb from ordinary near-names',async()=>{
 const rawOptions=[];let configurationChecks=0;
 const f=fixture((task,raw)=>new ConversationQQCommandAdapter({inbox:task,rawInbox:{enqueueOnce(event,options){rawOptions.push(options);return raw.enqueueOnce(event,options);}},config:()=>{configurationChecks++;return {enabled:false};}}));
 const ordinary=await f.send({content:'/rivule-chat.md 普通文档',id:'doc',eventId:'doc-event'});assert.equal(ordinary.status,200);
 assert.equal(configurationChecks,0);assert.equal(rawOptions.length,0);
 const reserved=await f.send({content:'/rivule-chat '+ref+' continue',id:'chat',eventId:'chat-event'});assert.equal(reserved.status,503);
 assert.equal(configurationChecks,1);assert.deepEqual(rawOptions,[{retainContent:false}]);assert.equal(f.commands.size,0);
});
