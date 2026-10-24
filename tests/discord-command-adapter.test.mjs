import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {DiscordCommandAdapter} from '../src/owner/discord-command-adapter.mjs';
const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
const hex=b=>Buffer.from(b).toString('hex');
const publicKey=hex(await crypto.subtle.exportKey('raw',pair.publicKey));
const contextRef='12345678-1234-1234-1234-123456789abc';
const context={source_id:'dot',project_id:'p',task_id:'t',run_id:'r',branch_id:'b',thread_id:'thread'};
const b={publicOrigin:'https://relay.example',ownerId:'owner',appId:'100',userId:'200',dmId:'300'};
function fixture(){
  let now=1700000000000;const db=new DatabaseSync(':memory:');
  const storage={sql:{exec(q,...args){const rows=db.prepare(q).all(...args);return {toArray:()=>rows};}},transaction:async fn=>fn()};
  const calls=[];let valid=true;
  const bridge={resolveDiscordContext(ref,msg){if(!valid||ref!==contextRef||msg!=='400')throw Object.assign(Error('stale'),{code:'bridge_control_expired',status:409});return context;},async enqueueCommand(trusted,input){calls.push({trusted,input});return {state:'pending'};}};
  const adapter=new DiscordCommandAdapter({storage,bindings:b,bridge,publicKey,now:()=>now});
  const payload=(id='500')=>({id,application_id:b.appId,type:3,user:{id:b.userId},context:1,channel_id:b.dmId,authorizing_integration_owners:{'1':b.userId},message:{id:'400',channel_id:b.dmId,author:{id:b.appId}},data:{component_type:2,custom_id:'rvcommand:'+contextRef}});
  const request=async(p,changes={})=>{const raw=changes.raw??JSON.stringify(p),stamp=String(changes.timestamp??Math.floor(now/1000)),sig=hex(await crypto.subtle.sign('Ed25519',pair.privateKey,new TextEncoder().encode(stamp+raw)));return new Request(b.publicOrigin+'/discord/interactions',{method:'POST',headers:{'x-signature-timestamp':stamp,'x-signature-ed25519':changes.signature??sig},body:changes.body??raw});};
  const open=async()=>{const r=await adapter.handle(await request(payload()));assert.equal(r.status,200);const data=await r.json();assert.equal(data.type,9);return data.data.custom_id;};
  const submit=(ref,id='501',text='继续调查，不要部署')=>({...payload(id),type:5,data:{custom_id:ref,components:[{type:1,components:[{type:4,custom_id:'instruction',value:text}]}]}});
  return {adapter,bridge,calls,payload,request,open,submit,setNow:n=>now=n,revoke:()=>valid=false};
}
test('signed button/modal resolves stored target and queues only configured owner, no execution claim',async()=>{
  const f=fixture(),ref=await f.open(),r=await f.adapter.handle(await f.request(f.submit(ref)));assert.equal(r.status,200);assert.match((await r.json()).data.content,/尚未执行/);
  assert.deepEqual(f.calls,[{trusted:{channel:'discord',owner_id:'owner',requester_id:'200',conversation_id:'300',event_id:'501'},input:{...context,text:'继续调查，不要部署',ttl_seconds:3600}}]);
});
test('raw signature, timestamp, app, owner, channel, message author and install are auth boundaries',async()=>{
  for(const alter of [p=>p.user.id='999',p=>p.application_id='999',p=>p.channel_id='999',p=>p.message.author.id='999',p=>p.message.channel_id='999',p=>p.guild_id='999',p=>p.member={user:{id:'200'}},p=>p.context=2,p=>p.authorizing_integration_owners={'0':'0','1':'999'}]){
    const f=fixture(),p=f.payload();alter(p);assert.equal((await f.adapter.handle(await f.request(p))).status,403);assert.equal(f.calls.length,0);
  }
  const f=fixture();for(const opts of [{signature:'0'.repeat(128)},{timestamp:1699999000},{body:JSON.stringify(f.payload())+' '}])assert.equal((await f.adapter.handle(await f.request(f.payload(),opts))).status,401);
  await assert.rejects(f.adapter.handleVerified(f.payload()),/unverified_interaction/);
});
test('stale, unknown and cross-message targets never enqueue',async()=>{
  const f=fixture(),ref=await f.open();const cross=f.submit(ref);cross.message.id='401';assert.equal((await f.adapter.handle(await f.request(cross))).status,409);
  f.revoke();assert.equal((await f.adapter.handle(await f.request(f.submit(ref)))).status,409);assert.equal(f.calls.length,0);
  const g=fixture(),p=g.payload();p.data.custom_id='rvcommand:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';assert.equal((await g.adapter.handle(await g.request(p))).status,409);
});
test('modal bounded text, expiry and one-time submission replay protection',async()=>{
  const f=fixture(),ref=await f.open();
  for(const text of ['', 'x'.repeat(1201),'a\u0000b'])assert.equal((await f.adapter.handle(await f.request(f.submit(ref,'501',text)))).status,422);
  assert.equal((await f.adapter.handle(await f.request(f.submit(ref)))).status,200);
  assert.equal((await f.adapter.handle(await f.request(f.submit(ref,'502')))).status,409);
  assert.equal((await f.adapter.handle(await f.request(f.submit(ref,'501','changed')))).status,409);
  // Exact network duplicate is sent through the durable queue's event-id deduplication.
  assert.equal((await f.adapter.handle(await f.request(f.submit(ref)))).status,200);
  assert.equal(f.calls[0].trusted.event_id,f.calls[1].trusted.event_id);
  f.setNow(1700000300001);assert.equal((await f.adapter.handle(await f.request(f.submit(ref)))).status,409);
});
test('opening event duplicate reuses modal and rejects altered origin',async()=>{
  const f=fixture(),ref=await f.open();assert.equal((await (await f.adapter.handle(await f.request(f.payload()))).json()).data.custom_id,ref);
});
test('timeout responds well inside Discord 3-second deadline without fake success/retry',async()=>{
  const f=fixture(),ref=await f.open();let finish;f.bridge.enqueueCommand=()=>new Promise(resolve=>finish=resolve);f.adapter.timeoutMs=25;
  const start=performance.now(),response=await f.adapter.handle(await f.request(f.submit(ref)));assert.ok(performance.now()-start<1000);assert.match((await response.json()).data.content,/无法确认/);finish({state:'pending'});
});
test('other valid components return null for existing dashboard dispatcher',async()=>{
  const f=fixture(),p=f.payload();p.data.custom_id='view:existing';assert.equal(await f.adapter.handle(await f.request(p)),null);
});
test('slow unverified body times out without ever starting authenticated work later',async()=>{
  const f=fixture();f.adapter.timeoutMs=20;const signed=await f.request(f.payload()),raw=await signed.text();let controller;
  const request=new Request(signed.url,{method:'POST',headers:signed.headers,body:new ReadableStream({start(c){controller=c;}}),duplex:'half'});
  let resolutions=0;f.bridge.resolveDiscordContext=()=>{resolutions++;return context;};
  assert.equal((await f.adapter.handle(request)).status,503);
  controller.enqueue(new TextEncoder().encode(raw));controller.close();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(resolutions,0);assert.equal(f.calls.length,0);
});
test('body limit and ping signature verification apply before any storage action',async()=>{
  const f=fixture();assert.equal((await f.adapter.handle(await f.request(f.payload(),{raw:'x'.repeat(65537)}))).status,413);
  const ping={id:'900',application_id:b.appId,type:1};assert.deepEqual(await (await f.adapter.handle(await f.request(ping))).json(),{type:1});
  assert.equal((await f.adapter.handle(await f.request(ping,{signature:'0'.repeat(128)}))).status,401);
});
test('modal tickets retain only a digest and expire without another user interaction',async()=>{
  const f=fixture(),ref=await f.open(),text='private owner instruction';
  await f.adapter.handle(await f.request(f.submit(ref,'501',text)));
  const ticket=f.adapter.one('SELECT * FROM bridge_discord_modals WHERE ref=?',ref);
  assert.match(ticket.submission_hash,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(ticket).includes(text));
  assert.equal(f.adapter.nextExpiry(),1700000300000);f.setNow(1700000300000);f.adapter.expire();assert.equal(f.adapter.nextExpiry(),Infinity);
});
