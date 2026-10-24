import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {MessageBridge} from '../src/owner/message-bridge.mjs';
import {bridgeSourceOperation,bridgeTools} from '../src/owner/bridge-source-contract.mjs';
const ctx={project_id:'p',task_id:'t',run_id:'r',branch_id:'main',thread_id:'thread'};
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE branches(branch_key TEXT PRIMARY KEY,source_id TEXT,project_id TEXT,payload TEXT,archived INTEGER);CREATE TABLE events(revision INTEGER PRIMARY KEY AUTOINCREMENT,source_id TEXT,event_id TEXT,receipt TEXT,payload TEXT,decision TEXT);CREATE TABLE outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,receipt TEXT,intent TEXT,payload TEXT,status TEXT,message_id TEXT,last_error TEXT);CREATE TABLE qq_continuous_outbox(receipt TEXT,status TEXT,result TEXT);`);
 let now=1800000000000,generation=1,seq=0;
 const rows=(q,...args)=>db.prepare(q).all(...args);
 const storage={sql:{exec(q,...args){if(q.includes('CREATE TABLE')){db.exec(q);return{toArray:()=>[]};}return {toArray:()=>rows(q,...args)};}},async transaction(fn){db.exec('BEGIN');try{const r=await fn(storage);db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const source={source_id:'pa',enabled:true},other={source_id:'other',enabled:true},bindings={ownerId:'owner',appId:'100',userId:'200',dmId:'300',allowedProjectIds:['p'],sources:[source,other]};
 const event={source_id:'pa',project_id:'p',task_id:'t',run_id:'r',branch_id:'main',sensitivity:'normal',summary:'update',kind:'progress',source_status:'running'};
 rows('INSERT INTO branches VALUES(?,?,?,?,0)',JSON.stringify(['pa','t','r','main']),'pa','p',JSON.stringify(event));
 const add=(receipt,event,decision)=>rows('INSERT INTO events(source_id,event_id,receipt,payload,decision) VALUES(?,?,?,?,?)','pa','event'+ ++seq,receipt,JSON.stringify(event),decision);
 const bridge=new MessageBridge({storage,bindings,now:()=>now,sourceBinding:()=>generation,recipient:r=>r.requester_id==='200'&&r.conversation_id==='300',enqueueTask:(s,e,r,m)=>rows("INSERT INTO outbox(receipt,intent,payload,status,message_id) VALUES(?,'bridge_task',?,'queued',NULL)",r,JSON.stringify({...e,...m})),enqueueResponse:(s,c,text,r,m)=>{add(r,{...event,kind:'response',summary:text,bridge_context_ref:m.context_ref},'bridge_response');rows("INSERT INTO outbox(receipt,intent,payload,status) VALUES(?,'bridge_response',?,'queued')",r,JSON.stringify({text}));}});
 const pref=(mode='task_updates',commands=true)=>bridge.setPreference(source,{mode,commands_enabled:commands,confirm:true,expected_revision:bridge.preference(source).revision});
 const command=(text='continue',event_id='e1')=>bridge.enqueueCommand({channel:'discord',owner_id:'owner',requester_id:'200',conversation_id:'300',event_id},{source_id:'pa',...ctx,text,ttl_seconds:60});
 const response=(text='answer',response_id='response1')=>bridge.publishResponse(source,{...ctx,response_id,text,origin:'source',content_kind:'user_visible_response'});
 return {bridge,db,storage,rows,source,other,pref,command,response,add,event,advance:n=>now+=n,rotate:()=>generation++};
}
test('default capability read is observational, task-only, and cannot silently enable forwarding',async t=>{
 const f=fixture(t);assert.equal(f.bridge.capabilities(f.source).mode,'task_updates');assert.equal(f.bridge.capabilities(f.source).commands_enabled,false);assert.equal(f.bridge.has('bridge_preferences'),false);
 await f.bridge.registerContext(f.source,ctx);await assert.rejects(f.response(),/every_response_not_enabled/);await assert.rejects(f.command(),/bridge_commands_not_enabled/);assert.equal(f.rows('SELECT * FROM outbox').length,0);
});
test('task-mode real durable receipt correlation supports commands without every-response consent',async t=>{
 const f=fixture(t);await f.pref();const reg=await f.bridge.registerContext(f.source,ctx);f.add('task-receipt',f.event,'applied');f.bridge.recordTask(f.event,'task-receipt');
 assert.throws(()=>f.bridge.resolveDiscordContext(reg.context_ref,'400'),/not_confirmed/);f.rows("UPDATE outbox SET status='sent',message_id='400'");assert.deepEqual(f.bridge.resolveDiscordContext(reg.context_ref,'400'),{source_id:'pa',...ctx});
 const queued=await f.command();assert.equal(queued.state,'pending');assert.equal(queued.source_woken,false);assert.equal((await f.command()).duplicate,true);
 const claimed=await f.bridge.claim(f.source,{...ctx,claim_id:'claim1'});assert.equal(claimed.text,'continue');assert.equal(claimed.requester.id,'200');assert.equal((await f.bridge.claim(f.source,{...ctx,claim_id:'claim1'})).execute,false);
 assert.equal((await f.bridge.acknowledge(f.source,{command_id:claimed.command_id,claim_token:claimed.claim_token,outcome:'completed'})).state,'completed');assert.equal(f.rows('SELECT payload FROM bridge_commands')[0].payload,null);
});
test('every-response produces a distinct queued receipt without changing task projection, unknown is not delivered',async t=>{
 const f=fixture(t);await f.pref('every_response');await f.bridge.registerContext(f.source,ctx);const before=f.rows('SELECT payload FROM branches')[0].payload;
 const r=await f.response();assert.equal(r.channels.discord.state,'queued');assert.equal(r.channels.qq.state,'unsupported');assert.equal((await f.response()).duplicate,true);assert.equal(f.rows('SELECT payload FROM branches')[0].payload,before);assert.equal(f.rows('SELECT * FROM outbox').length,1);
 f.rows("UPDATE outbox SET status='sending'");assert.equal(f.bridge.responseReceipt(f.source,r.receipt_id).channels.discord.state,'unknown');f.rows("UPDATE outbox SET status='sent'");assert.equal(f.bridge.responseReceipt(f.source,r.receipt_id).channels.discord.state,'provider_accepted');assert.equal(r.recipient_confirmation,'not_observed');
 await assert.rejects(f.response('changed'),/conflict/);assert.throws(()=>f.bridge.responseReceipt(f.other,r.receipt_id),/not_found/);
});
test('consent off and on never resurrects old queued responses, contexts or commands',async t=>{
 const f=fixture(t);await f.pref('every_response');const old=await f.bridge.registerContext(f.source,ctx),r=await f.response();await f.command();await f.pref('task_updates',false);await f.pref('every_response',true);assert.equal(f.bridge.responseAuthorized(r.receipt_id),false);await assert.rejects(f.bridge.claim(f.source,{...ctx,claim_id:'claim'}),/not_registered/);const current=await f.bridge.registerContext(f.source,ctx);assert.notEqual(current.context_ref,old.context_ref);assert.equal((await f.bridge.claim(f.source,{...ctx,claim_id:'claim'})).state,'empty');
});
test('source generation rotation invalidates standing preferences and registered task routing',async t=>{
 const f=fixture(t);await f.pref('every_response');await f.bridge.registerContext(f.source,ctx);const r=await f.response();f.rotate();assert.equal(f.bridge.preference(f.source).mode,'task_updates');assert.equal(f.bridge.responseAuthorized(r.receipt_id),false);assert.throws(()=>f.bridge.responseReceipt(f.source,r.receipt_id),/not_found/);
});
test('lost claims expire unknown, never reissue; pending TTL erases text without another source request',async t=>{
 const f=fixture(t);await f.pref();await f.bridge.registerContext(f.source,ctx);await f.command();const claimed=await f.bridge.claim(f.source,{...ctx,claim_id:'claim'});f.advance(60001);f.bridge.expire();assert.equal((await f.bridge.claim(f.source,{...ctx,claim_id:'new-claim'})).state,'empty');assert.equal(f.rows('SELECT state,payload FROM bridge_commands')[0].state,'unknown');assert.equal(f.rows('SELECT payload FROM bridge_commands')[0].payload,null);assert.equal(f.bridge.nextExpiry(),Infinity);assert.equal((await f.bridge.acknowledge(f.source,{command_id:claimed.command_id,claim_token:claimed.claim_token,outcome:'unknown'})).state,'unknown');
});
test('foreign requester, unregistered thread, secret/tool content and literal relay echo fail closed',async t=>{
 const f=fixture(t);await f.pref('every_response');await f.bridge.registerContext(f.source,ctx);
 await assert.rejects(f.bridge.enqueueCommand({channel:'discord',owner_id:'owner',requester_id:'other',conversation_id:'300',event_id:'e'},{source_id:'pa',...ctx,text:'test',ttl_seconds:60}),/not_authorized/);
 await assert.rejects(f.bridge.claim(f.source,{...ctx,thread_id:'other',claim_id:'c'}),/not_registered/);await assert.rejects(f.response('api_key=do-not-forward'),/sensitive/);await f.command('literal echo');await assert.rejects(f.response('literal echo'),/echo/);
 await assert.rejects(f.bridge.publishResponse(f.source,{...ctx,response_id:'x',text:'x',content_kind:'tool',origin:'source'}),/invalid_bridge_response/);
});
test('admission guard runs inside transaction and cannot leave queued command after revocation',async t=>{
 const f=fixture(t);await f.pref();await f.bridge.registerContext(f.source,ctx);
 await assert.rejects(f.bridge.enqueueCommand({channel:'discord',owner_id:'owner',requester_id:'200',conversation_id:'300',event_id:'e'},{source_id:'pa',...ctx,text:'test',ttl_seconds:60},async()=>{throw Error('revoked');}),/revoked/);assert.equal(f.rows('SELECT * FROM bridge_commands').length,0);
});
test('source contract cannot modify owner preference or invent unsupported operations',async t=>{
 const f=fixture(t);await assert.rejects(bridgeSourceOperation(f.bridge,f.source,'preference',{mode:'every_response'}),/invalid_bridge_operation/);assert.equal(bridgeTools.some(t=>/preference/.test(t.name)),false);assert.equal(bridgeTools.length,6);
});
