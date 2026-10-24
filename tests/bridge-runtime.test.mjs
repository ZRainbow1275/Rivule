import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {dashboardResponse} from '../src/owner/dashboard.mjs';
const source=readFileSync(new URL('../src/owner/worker.js',import.meta.url),'utf8');
const start=source.indexOf('var API = "https://discord.com/api/v10";'),end=source.indexOf('function createDiscordIdentity',start);
const box=vm.createContext({Response,TextDecoder,Uint8Array,AbortSignal,FormData,Blob,__name:x=>x,Rejected:Error});
vm.runInContext(source.slice(start,end)+';globalThis.sender=createDiscordSender;',box);
test('actual Discord transport rechecks consent after async preflight/render and never POSTs revoked work',async()=>{
 const b={ownerId:'owner',appId:'100',userId:'200',dmId:'300'};let allowed=true,posts=0,gets=0;
 const sender=box.sender({bindings:b,guildId:'400',token:()=> 'offline-token-long-enough',prepare:async()=>{await Promise.resolve();allowed=false;return {payload:{content:'safe response',allowed_mentions:{parse:[]}}};},beforeSend:()=>allowed},async(url,init)=>{
  if(init.method!=='GET'){posts++;throw Error('must not send');}gets++;
  const value=url.endsWith('/users/@me')?{id:'100',bot:true}:url.includes('/members/')?{user:{id:url.endsWith('/100')?'100':'200',bot:url.endsWith('/100')}}:{id:'300',type:1,recipients:[{id:'200'}]};return Response.json(value);
 });
 const result=await sender({ownerId:'owner',appId:'100',dmId:'300',messageId:null,nonce:'offline'});assert.equal(gets,4);assert.equal(posts,0);assert.equal(result.notSent,true);assert.equal(result.reason,'preflight_authority');
});
function fixture(){
 const data=new Map(),origin='https://rivule.example.test';let time=1800000000000,tail=Promise.resolve(),binding='binding1',revision=0,qqRevision=0,enabled=false;
 const storage={get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v)),delete:async k=>data.delete(k),list:async({prefix,limit})=>new Map([...data].filter(([k])=>k.startsWith(prefix)).slice(0,limit)),transaction(fn){const run=tail.then(()=>fn(storage));tail=run.catch(()=>{});return run;}};
 const bindings={ownerId:'owner',appId:'100',userId:'200',dmId:'300',publicOrigin:origin,allowedProjectIds:['p'],sources:[{source_id:'zot-main',enabled:true}]};let writes=0;
 const config={bindings,storage,env:{DASHBOARD_ENABLED:'true',DASHBOARD_WATCHLIST_JSON:'[]'},now:()=>time,identity:{authorizationUrl:async state=>'https://discord.com/oauth2/authorize?'+new URLSearchParams({state,client_id:'100',scope:'identify',redirect_uri:origin+'/callback'}),authenticate:async()=>({subject:'200'})},manageBridge:async(s,action,args)=>{
  assert.equal(s.source_id,'zot-main');if(action==='binding')return binding;if(action==='capabilities')return {source_id:s.source_id,mode:'task_updates',commands_enabled:false,revision};if(action==='qq_status')return {enabled,revision:qqRevision,recipient_label:enabled?'本人 QQ':null};if(action==='qq_target')return {active:true,ownerId:'owner',appId:'qqapp',userOpenId:'qqowner',bindingFingerprint:'recipient-binding',validUntil:time+30000};if(action==='preference'){assert.equal(args.expected_revision,revision);writes++;return {revision:++revision};}if(action==='qq_preference'){assert.equal(args.expected_revision,qqRevision);writes++;enabled=args.enabled;return {enabled,revision:++qqRevision};}throw Error('bad action');}};
 async function send(path,method='GET',cookie='',body,headers={}){return dashboardResponse(new Request('https://owner.internal'+path,{method,headers:{'sec-fetch-site':'same-origin',...(method==='POST'?{origin,'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),config);}
 async function login(){const first=await send('/dashboard/login','POST'),loginCookie=first.headers.getSetCookie()[0].split(';')[0],state=new URL(first.headers.get('location')).searchParams.get('state');const r=await send('/callback?state='+state+'&code=c','GET',loginCookie);return r.headers.getSetCookie().find(v=>v.startsWith('__Host-rivule-dashboard-session=')).split(';')[0];}
 return {send,login,config,data,rotate:()=>binding='binding2',advance:n=>time+=n,get writes(){return writes;}};
}
test('real dashboard route requires owner login, same-origin, CSRF and fresh source-scoped bridge access',async()=>{
 const f=fixture();assert.equal((await f.send('/dashboard/bridge')).status,401);const cookie=await f.login(),read=await(await f.send('/dashboard/bridge','GET',cookie)).json();assert.equal(read.sources[0].source_id,'zot-main');assert.equal(f.writes,0);
 const body={csrf:read.csrf,source_id:'zot-main',confirm:true,mode:'every_response',commands_enabled:true,expected_revision:0};assert.equal((await f.send('/dashboard/bridge/preference','POST',cookie,body)).status,403);
 assert.equal((await f.send('/dashboard/bridge/access','POST',cookie,{csrf:'wrong',source_id:'zot-main',confirm:true})).status,403);
 const cap=await(await f.send('/dashboard/bridge/access','POST',cookie,{csrf:read.csrf,source_id:'zot-main',confirm:true})).json();assert.equal((await f.send('/dashboard/bridge/preference','POST',cookie,{...body,access_token:cap.access_token},{origin:'https://evil.test'})).status,403);
 assert.equal((await f.send('/dashboard/bridge/preference','POST',cookie,{...body,access_token:cap.access_token})).status,200);assert.equal(f.writes,1);f.rotate();assert.equal((await f.send('/dashboard/bridge/preference','POST',cookie,{...body,expected_revision:1,access_token:cap.access_token})).status,403);
});
test('QQ response category has a distinct owner capability and its lifetime does not expire consent',async()=>{
 const f=fixture(),cookie=await f.login(),read=await(await f.send('/dashboard/bridge','GET',cookie)).json();const base={csrf:read.csrf,source_id:'zot-main',confirm:true};
 const ordinary=await(await f.send('/dashboard/bridge/access','POST',cookie,base)).json();assert.equal((await f.send('/dashboard/bridge/qq-response/preference','POST',cookie,{...base,enabled:true,expected_revision:0,access_token:ordinary.access_token})).status,403);
 const qq=await(await f.send('/dashboard/bridge/qq-response/access','POST',cookie,base)).json();assert.equal(qq.can_enable,true);assert.equal(typeof qq.recipient_label,'string');assert.equal(qq.revision,0);assert.equal((await f.send('/dashboard/bridge/qq-response/preference','POST',cookie,{...base,enabled:true,expected_revision:0,access_token:qq.access_token})).status,200);f.advance(300001);assert.equal((await f.send('/dashboard/bridge/qq-response/preference','POST',cookie,{...base,enabled:false,expected_revision:1,access_token:qq.access_token})).status,403);assert.equal(f.writes,1);
});
test('logout prevents old management capability from authorizing a late confirmation',async()=>{
 const f=fixture(),cookie=await f.login(),read=await(await f.send('/dashboard/bridge','GET',cookie)).json(),base={csrf:read.csrf,source_id:'zot-main',confirm:true};const cap=await(await f.send('/dashboard/bridge/access','POST',cookie,base)).json();await f.send('/dashboard/logout','POST',cookie);assert.equal((await f.send('/dashboard/bridge/preference','POST',cookie,{...base,access_token:cap.access_token,mode:'every_response',commands_enabled:true,expected_revision:0})).status,401);assert.equal(f.writes,0);
});
test('cold source mutations schedule the new lease deadline without replacing earlier channel alarms',async()=>{
 const a=source.indexOf('    async scheduleBridgeMutation() {'),b=source.indexOf('    async bridge(',a);assert.ok(a>0&&b>a);
 const fixture=vm.createContext({Date});vm.runInContext('this.Schedule=class {'+source.slice(a,b)+'}',fixture);const object=new fixture.Schedule();let alarm=Date.now()+300000;const lease=Date.now()+60000;object.ctx={storage:{getAlarm:async()=>alarm,setAlarm:async at=>alarm=at}};object.messageBridge={nextExpiry:()=>lease};await object.scheduleBridgeMutation();assert.equal(alarm,lease);alarm=Date.now()+10000;const first=alarm;await object.scheduleBridgeMutation();assert.equal(alarm,first);
 assert.match(source,/if\(!\['capabilities','response_receipt'\]\.includes\(action\)\)await this\.scheduleBridgeMutation/);
});
import {DatabaseSync} from 'node:sqlite';
import {QQBridgeQueue} from '../src/owner/qq-integration.mjs';
test('actual readonly owner source proof rejects stale/future evidence and accepts legitimate same-generation refresh',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE source_connections(source_id TEXT,binding TEXT,generation INTEGER,revoked INTEGER,evidence_kind TEXT,last_verified_at REAL)');
 let now=1800000000000;const pa={source_id:'pa',enabled:true},b={ownerId:'owner',publicOrigin:'https://owner.test',sources:[pa]};const binding=JSON.stringify(['owner',b.publicOrigin,pa,'auth-context']);
 db.prepare('INSERT INTO source_connections VALUES(?,?,1,0,?,?)').run('pa',binding,'accepted_event',now-86400001);
 const rows=(storage,q,...args)=>db.prepare(q).all(...args),tables=()=>new Set(['source_connections']);
 const start=source.indexOf('    async readonlyQQQueue() {'),end=source.indexOf('    async qqResponseTarget()',start);const sandbox=vm.createContext({QQBridgeQueue,loadBindings:()=>b,canonical:JSON.stringify,__ownerUiOverlay:{sourceBindingContexts:async()=>({pa:'auth-context'})},readonlyRows:rows,readonlyTables:tables,fetch:()=>{throw Error('read must never fetch');},Date:class extends Date{static now(){return now;}}});
 vm.runInContext('this.Owner=class {'+source.slice(start,end)+'}',sandbox);const owner=new sandbox.Owner();owner.ctx={storage:{}};owner.env={};owner.ensureMessageBridge=async()=>({});const queue=await owner.readonlyQQQueue();
 assert.equal(queue.readAuthority('pa').selectable,false,'forged fresh producer timestamp cannot modify owner DB evidence');
 db.prepare('UPDATE source_connections SET last_verified_at=?').run(now);const refreshed=queue.readAuthority('pa');assert.equal(refreshed.selectable,true);assert.equal(refreshed.connection_generation,1);assert.equal(refreshed.binding,binding);
 db.prepare('UPDATE source_connections SET last_verified_at=?').run(now+1);assert.equal(queue.readAuthority('pa').selectable,false);
 db.prepare('UPDATE source_connections SET last_verified_at=?,revoked=1').run(now);assert.equal(queue.readAuthority('pa').selectable,false);
});
