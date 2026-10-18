import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const clean = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
export const source = readFileSync(path.join(root, 'modules/gateway-candidate.mjs'), 'utf8');
export const ownerSource = readFileSync(path.join(root, 'reference/qq-integration.mjs'), 'utf8');
export let forbiddenCalls = 0;
export const forbiddenFetch = () => { forbiddenCalls++; throw Error('EXTERNAL_NETWORK_FORBIDDEN'); };
function load(source, gateway) {
  const exports = gateway ? 'export {\n  QQGatewayObject,\n  worker_default as default\n};' : 'export {\n  QQBridgeQueue,\n  qqInteractionResponse\n};';
  assert.equal(source.split(exports).length, 2);
  let code = source.replace(exports, '');
  if (gateway) code = code.replace('import { DurableObject } from "cloudflare:workers";', '');
  else code += '\n' + readFileSync(path.join(root, 'reference/verify-discord-exact.mjs'), 'utf8');
  const names = gateway ? 'GatewayActor,QQGatewayObject,worker_default,ownerSetup,fixedActiveProbe,activeProbePanel,activeProbeEligibility,activeBindingFingerprint,ACTIVE_PROBE_TEXT,ACTIVE_PROBE_ID,createQQRuntime,QQGateway,DurableStateStore,fixedReplyProof,NotificationBridge' : 'qqInteractionResponse,QQBridgeQueue,verifyDiscordInteraction,signBridgeRequest,verifyBridgeResponse';
  const context = createContext({ crypto: webcrypto, TextEncoder, TextDecoder, Response, Request, Headers, URL, Event, EventTarget, AbortSignal, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval, fetch: forbiddenFetch, __name: fn => fn, DurableObject: class { constructor(ctx, env) { this.ctx=ctx;this.env=env; } } });
  runInContext(code + '\nglobalThis.audit = {' + names + '};', context, { timeout: 1500 });
  return context.audit;
}
export const gateway = load(source, true), owner = load(ownerSource, false);
export class SqlStorage {
  db = new DatabaseSync(':memory:');
  tail = Promise.resolve();
  alarm = null;
  failCommit = null;
  sql = { exec: (query, ...args) => {
    if (/^\s*CREATE\b/.test(query) && !args.length) { this.db.exec(query); return { toArray: () => [] }; }
    const s = this.db.prepare(query), rows = s.columns().length ? s.all(...args) : (s.run(...args), []);
    return { toArray: () => rows };
  } };
  transaction(fn) {
    const result = this.tail.then(async () => {
      this.db.exec('BEGIN');
      try { const value = await fn(); if(this.failCommit?.()) throw Error('synthetic_storage_failure'); this.db.exec('COMMIT'); return value; }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
    });
    this.tail = result.catch(() => {}); return result;
  }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
  close() { this.db.close(); }
}
export const NOW = Date.parse('2026-10-18T12:00:00Z');
export const KEY = 'SYNTHETIC-LOCAL-BRIDGE-KEY-NOT-REAL-0000';
export class Socket {
  readyState=1; listeners={}; sent=[];
  constructor(url) { this.url=url; }
  addEventListener(name, callback) { this.listeners[name]=callback; }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState=3; this.listeners.close?.(); }
}
export const adminEvent = (id, ref='qqsetup:open', changes={}) => ({ id:String(id), application_id:'111', type:3, context:1, channel_id:'333', user:{id:'222'}, authorizing_integration_owners:{'0':'0'}, message:{id:'9001',author:{id:'111'},channel_id:'333'}, data:{component_type:2,custom_id:ref}, ...changes });
export const buttons = response => response.data.components?.flatMap(row=>row.components) ?? [];
export const button = response => buttons(response).find(control=>control.label==='发送一次主动测试')?.custom_id;
export const deferred = () => { let resolve,reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; };
export async function harness(t, { state={}, env={}, message, realRuntime=false, storage }={}) {
  let now=NOW; const calls=[], waits=[];
  const db=storage??new SqlStorage();
  const environment={ OWNER_ID:'owner', QQ_OWNER_ID:'owner', QQ_APP_ID:'123', QQ_ENABLED:'true', QQ_SETUP_ENABLED:'true', QQ_PROOF_ENABLED:'true', QQ_DELIVERY_ENABLED:'false', QQ_CAPABILITIES_JSON:'{}', QQ_DAILY_ACTIVE_BUDGET_MS:'7200000', QQ_ALLOWED_SOURCE_IDS:'["source"]', QQ_ALLOWED_PROJECT_IDS:'["project"]', QQ_APP_SECRET:'SYNTHETIC-SECRET-NOT-REAL', QQ_BRIDGE_SECRET:KEY, APPLICATION_ID:'111', OWNER_DISCORD_ID:'222', DM_CHANNEL_ID:'333', ...env };
  const network=async(url,init={})=>{
    calls.push({url,init});
    const u=new URL(url);assert.equal(u.origin,'https://api.bot.qq.com');
    if(u.pathname==='/app/getAppAccessToken')return Response.json({access_token:'SYNTHETIC-TOKEN-NOT-REAL',expires_in:7200});
    if(u.pathname==='/gateway')return Response.json({url:'wss://api.sgroup.qq.com/websocket/'});
    assert.equal(u.pathname,'/v2/users/fixed-user/messages');
    return message?message(url,init):Response.json({id:'synthetic-provider-message'});
  };
  const ctx={storage:db,waitUntil:promise=>waits.push(promise)};
  const actor=new gateway.GatewayActor(ctx,environment,{fetch:network,WebSocket:Socket,now:()=>now});
  const flush=async()=>{for(let i=0;i<waits.length;i++) await waits[i];};
  if(realRuntime){
    await actor.start();const c=actor.runtime.client;
    await c.receive(c.ws,JSON.stringify({op:10,d:{heartbeat_interval:60000}}));
    await c.receive(c.ws,JSON.stringify({op:0,s:1,t:'READY',d:{session_id:'synthetic-session'}}));await flush();
  } else actor.runtime={client:{ready:true,tokenValue:async()=> 'SYNTHETIC-TOKEN-NOT-REAL'},stop(){this.client.ready=false;}};
  await actor.store.transaction(s=>Object.assign(s, {binding:{appId:'123',ownerId:'owner',userOpenId:'fixed-user',confirmedAt:NOW-10000,replyMessage:{messageId:'passive-reply',eventAt:NOW-1000}},control:{running:true},qqIngestionHealth:{healthy:true},activeBudget:{day:Math.floor(NOW/86400000),usedMs:0,lastAt:NOW},...state}));
  const panel=async(id=101)=>gateway.ownerSetup(actor,adminEvent(id));
  const approve=async(id=102)=>{const p=await panel(id-1),ref=button(p);assert.ok(ref,p.data.content);const action=await actor.store.transaction(s=>clean(s.adminControls[ref]));return {ref,action,id:String(id)};};
  const send=async(id=102)=>{const {ref}=await approve(id);return gateway.ownerSetup(actor,adminEvent(id,ref));};
  const messages=()=>calls.filter(x=>x.url.endsWith('/messages'));
  const snapshot=()=>actor.store.transaction(s=>clean(s));
  const frame=async(type,{seq=actor.runtime.client.sequence+1,timestamp=Math.floor(now/1000),openid='fixed-user',...d}={},extras={})=>{
    const c=actor.runtime.client;return c.receive(c.ws,JSON.stringify({op:0,s:seq,t:type,d:{openid,timestamp,...d},...extras}));
  };
  t.after(async()=>{ if(realRuntime)actor.runtime.stop();await flush();if(!storage)db.close(); });
  return {actor,env:environment,ctx,db,calls,waits,flush,network,panel,approve,send,messages,snapshot,frame,now:()=>now,advance:ms=>now+=ms};
}
export async function signedHarness(h) {
  const keys=await webcrypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
  const hex=value=>Buffer.from(value).toString('hex');
  const key=hex(await webcrypto.subtle.exportKey('raw',keys.publicKey));
  const binding={publicOrigin:'https://synthetic.example',ownerId:'owner',appId:'111',userId:'222',dmId:'333'};
  let calls=0;
  const environment={...h.env,QQ_GATEWAY:{idFromName:name=>{assert.equal(name,'qq:owner');return name;},get:()=>({ownerSetup:p=>{calls++;assert.equal(p.token,undefined);return gateway.ownerSetup(h.actor,p);}})}};
  async function request(payload,{age=0,tamper=false,url=binding.publicOrigin+'/discord/interactions',headers={}}={}){
    const timestamp=String(Math.floor(h.now()/1000)-age),body=JSON.stringify(payload),signature=hex(await webcrypto.subtle.sign('Ed25519',keys.privateKey,new TextEncoder().encode(timestamp+body)));
    return new Request(url,{method:'POST',headers:{'x-signature-timestamp':timestamp,'x-signature-ed25519':signature,...headers},body:body+(tamper?'x':'')});
  }
  async function invoke(payload,options={}) {
    return owner.qqInteractionResponse(await request(payload,options),binding,key,'444',()=>{throw Error('not_navigation');},environment,()=>{throw Error('not_navigation');},(r,b,k,g)=>owner.verifyDiscordInteraction(r,b,k,g,h.now()),v=>Response.json(v),e=>Response.json({error:e.code??'unknown'},{status:e.status??503}));
  }
  return {invoke,request,calls:()=>calls};
}
