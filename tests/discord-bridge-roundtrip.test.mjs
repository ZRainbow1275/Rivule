import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {loadProductionWorker} from './helpers/production-worker.mjs';
import {MessageBridge} from '../src/owner/message-bridge.mjs';
import {bridgeSourceOperation} from '../src/owner/bridge-source-contract.mjs';
import {DiscordCommandAdapter} from '../src/owner/discord-command-adapter.mjs';
const worker=await loadProductionWorker();
test('production source ingestion, immutable Discord renderer/dispatcher, signed modal and source claim/ack roundtrip',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let alarm=null;const storage={sql:{exec(q,...args){if(q.includes('CREATE TABLE')){db.exec(q);return{toArray:()=>[]};}return{toArray:()=>db.prepare(q).all(...args)};}},async transaction(fn){db.exec('BEGIN');try{const v=await fn(storage);db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}},setAlarm:async v=>alarm=v,getAlarm:async()=>alarm,deleteAlarm:async()=>alarm=null,sync:async()=>{}};
 const now=Date.now(),pa={source_id:'pa',provider:'dot',display_name:'PA',enabled:true,allowed_hosts:[]},b={ownerId:'owner',appId:'100',userId:'200',dmId:'300',publicOrigin:'https://owner.test',allowedProjectIds:['p'],sources:[pa]};let bridge,posts=0;const posted=[];
 const sender=worker.createDiscordSender({bindings:b,guildId:'400',token:()=> 'offline-test-token-long',prepare:async d=>d.payload.intent==='overview'?{payload:{content:'overview fixture only',allowed_mentions:{parse:[]}}}:worker.prepare(d)},async(url,init)=>{
  if(init.method==='GET'){const value=url.endsWith('/users/@me')?{id:'100',bot:true}:url.includes('/members/')?{user:{id:url.endsWith('/100')?'100':'200',bot:url.endsWith('/100')}}:{id:'300',type:1,recipients:[{id:'200'}]};return Response.json(value);}
  assert.equal(init.method,'POST');posts++;posted.push(JSON.parse(init.body));return Response.json({id:String(500+posts),channel_id:'300',author:{id:'100'}});
 });
 const core=new worker.OwnerCore(storage,b,{clock:()=>now,enabled:true,synthetic:false,sender,channels:{onAccepted:(event,receipt,mode)=>bridge?.recordTask(event,receipt,{discord:mode!=='overview_only'})}});await core.initialize();
 const event={event_id:'e1',source_id:'pa',project_id:'p',task_id:'t',run_id:'r',branch_id:'main',project_name:'Project',task_name:'Task',branch_name:'Main',kind:'started',source_status:'running',source_seq:1,occurred_at:new Date(now).toISOString(),summary:'Task started',sensitivity:'normal'};
 await core.ingest(pa,event);
 bridge=new MessageBridge({storage,bindings:b,now:()=>now,sourceBinding:s=>[core.connections.binding(s),core.connections.status(s).connection_generation],recipient:r=>r.channel==='discord'&&r.requester_id==='200'&&r.conversation_id==='300',enqueueTask:(s,e,receipt,meta)=>core.enqueue(receipt,'bridge_task:'+receipt,'bridge_task',{...e,bridge_context_ref:meta.context_ref,bridge_consent_revision:meta.consent_revision},core.one('SELECT revision FROM events WHERE receipt=?',receipt).revision)});
 await bridge.setPreference(pa,{mode:'task_updates',commands_enabled:true,expected_revision:0,confirm:true});const context={project_id:'p',task_id:'t',run_id:'r',branch_id:'main',thread_id:'actual-thread'};const registered=await bridgeSourceOperation(bridge,pa,'register_context',context);
 await core.ingest(pa,{...event,event_id:'e2',source_seq:2,summary:'Second task update'});
 for(let i=0;i<3;i++)await core.alarm();
 const row=core.one("SELECT * FROM outbox WHERE intent='bridge_task'");assert.equal(row.status,'sent');assert.ok(row.message_id);const card=posted.find(p=>p.components?.[0]?.components?.[0]?.custom_id==='rvcommand:'+registered.context_ref);assert.ok(card);assert.match(card.embeds[0].description,/Second task update/);assert.deepEqual(card.allowed_mentions,{parse:[]});
 const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']),hex=v=>Buffer.from(v).toString('hex'),publicKey=hex(await crypto.subtle.exportKey('raw',pair.publicKey));const adapter=new DiscordCommandAdapter({storage,bindings:b,bridge,publicKey,now:()=>now});
 const base={id:'800',application_id:'100',type:3,user:{id:'200'},context:1,channel_id:'300',authorizing_integration_owners:{'1':'200'},message:{id:row.message_id,author:{id:'100'},channel_id:'300'},data:{component_type:2,custom_id:'rvcommand:'+registered.context_ref}};
 const signed=async p=>{const text=JSON.stringify(p),stamp=String(Math.floor(now/1000)),signature=hex(await crypto.subtle.sign('Ed25519',pair.privateKey,new TextEncoder().encode(stamp+text)));return new Request(b.publicOrigin+'/discord/interactions',{method:'POST',headers:{'x-signature-timestamp':stamp,'x-signature-ed25519':signature},body:text});};
 const modal=await(await adapter.handle(await signed(base))).json();assert.equal(modal.type,9);const submit={...base,id:'801',type:5,data:{custom_id:modal.data.custom_id,components:[{type:1,components:[{type:4,custom_id:'instruction',value:'Continue tests, do not deploy'}]}]}};
 const result=await(await adapter.handle(await signed(submit))).json();assert.match(result.data.content,/尚未执行/);await adapter.handle(await signed(submit));assert.equal(core.one('SELECT COUNT(*) n FROM bridge_commands').n,1);
 const claim=await bridgeSourceOperation(bridge,pa,'claim',{...context,claim_id:'durable-claim'});assert.equal(claim.text,'Continue tests, do not deploy');assert.equal(claim.context.source_id,'pa');assert.equal((await bridgeSourceOperation(bridge,pa,'claim',{...context,claim_id:'durable-claim'})).execute,false);
 const ack=await bridgeSourceOperation(bridge,pa,'acknowledge',{command_id:claim.command_id,claim_token:claim.claim_token,outcome:'rejected'});assert.equal(ack.state,'rejected');assert.equal(core.one('SELECT payload FROM bridge_commands').payload,null);
 const before=core.one("SELECT COUNT(*) n FROM outbox WHERE intent='bridge_task'").n;await core.ingest(pa,{...event,event_id:'e3',source_seq:3,summary:'Overview only'},'overview_only');assert.equal(core.one("SELECT COUNT(*) n FROM outbox WHERE intent='bridge_task'").n,before,'overview-only never adds a separate command card');
});

test('task-context response renderer uses full escaped body within aggregate embed budgets',async()=>{
 for(const summary of ['*'.repeat(1200),'@'.repeat(1200),'中👩🏽‍💻\t\r\n  ']){
  const result=await worker.prepare({payload:{intent:'bridge_response',event:{source_id:'pa',project_name:'P'.repeat(120),task_name:'T'.repeat(120),branch_name:'B'.repeat(80),summary},sources:[]}}),card=result.payload,expected='\u200b'+summary.replace(/@/g,'@\u200b').replace(/[\\`*_{}\[\]<>|~]/g,'\\$&')+'\u200b';
  assert.equal(card.embeds[0].description,expected);assert.ok(card.embeds[0].title.length+card.embeds[0].description.length+card.embeds[0].footer.text.length<=6000);assert.equal(JSON.stringify(card.allowed_mentions),JSON.stringify({parse:[]}));
 }
});
