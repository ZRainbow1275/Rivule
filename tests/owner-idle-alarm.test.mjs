import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from 'miniflare';
import {loadProductionWorker} from './helpers/production-worker.mjs';

const worker=await loadProductionWorker();
const bindings={SOURCES_JSON:JSON.stringify([{source_id:'pa',provider:'dot',display_name:'PA',enabled:true,allowed_hosts:[],secret_name:'PA_SOURCE',auth_methods:['hmac']}]),ALLOWED_PROJECT_IDS_JSON:'["project"]',PUBLIC_ORIGIN:'https://owner.test',OWNER_ID:'owner',APPLICATION_ID:'100',OWNER_DISCORD_ID:'200',DM_CHANNEL_ID:'300',DELIVERY_ENABLED:'false',GUILD_ID:'400',PA_SOURCE:'only-an-offline-fixture-key-32-characters'};
async function fixture(t,{initialize=true}={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let alarm=null,failSql=false;const sets=[],data=new Map(),now=1800000000000;
 const storage={sql:{exec(q,...args){if(failSql)throw Error('offline simulated SQL daily row read limit');if(/CREATE TABLE|CREATE INDEX|ALTER TABLE/.test(q)){db.exec(q);return{toArray:()=>[]};}const rows=db.prepare(q).all(...args);return{toArray:()=>rows};}},transaction:async f=>f(storage),transactionSync:f=>f(),getAlarm:async()=>alarm,setAlarm:async at=>{alarm=at;sets.push(at);},deleteAlarm:async()=>{alarm=null;},sync:async()=>{},get:async k=>data.get(k),put:async(k,v)=>data.set(k,v),delete:async k=>data.delete(k)};
 const owner=Object.create(worker.OwnerTerminal.prototype);owner.ctx={storage,blockConcurrencyWhile:fn=>fn()};owner.env={...bindings};if(initialize){await owner.initializeLegacy();owner.core.clock=()=>now;owner.qq.now=()=>now;}
 return {db,owner,storage,sets,now,alarm:()=>alarm,consume:()=>{alarm=null;sets.length=0;},failSql:value=>{failSql=value;}};
}

test('real OwnerTerminal never arms or re-arms an idle owner with Discord and QQ disabled',async t=>{
 const f=await fixture(t);assert.equal(f.owner.qq.nextAlarmAt(),null);assert.equal(f.owner.core.channels.nextAlarmAt(),Infinity);assert.equal(f.alarm(),null);assert.equal(f.sets.length,0);
 for(let i=0;i<4;i++){f.consume();await f.owner.alarm();assert.equal(f.alarm(),null);assert.equal(f.sets.length,0);}
});

test('production deadline composition ignores absent/invalid values and preserves finite and past work',async t=>{
 const f=await fixture(t);const slots=[f.owner.qq,'nextAlarmAt',f.owner.conversationQQ,'nextAlarmAt',f.owner.messageBridge,'nextExpiry',f.owner.conversationBridge,'nextExpiry'];
 const set=values=>{for(let i=0;i<values.length;i++)slots[i*2][slots[i*2+1]]=()=>values[i];};
 for(const absent of [null,undefined,NaN,Infinity,-Infinity,'0']){
  set([absent,undefined,NaN,null]);f.consume();await f.owner.core.schedule();assert.equal(f.alarm(),null,String(absent));
  for(let active=0;active<4;active++){const values=[absent,absent,absent,absent];values[active]=f.now+1000;set(values);f.consume();await f.owner.core.schedule();assert.equal(f.alarm(),f.now+1000);}
 }
 set([f.now+9000,f.now+5000,f.now+7000,f.now+3000]);f.consume();await f.owner.core.schedule();assert.equal(f.alarm(),f.now+3000);
 await f.storage.setAlarm(f.now+100);f.sets.length=0;await f.owner.core.schedule();assert.equal(f.alarm(),f.now+100);assert.equal(f.sets.length,0,'earlier wake is never postponed');
 for(const due of [0,f.now-1,f.now]){set([due,null,undefined,NaN]);f.consume();await f.owner.core.schedule();assert.equal(f.alarm(),f.now+1,'due work remains immediate');}
 // Modal expiry is another real composition input, not an injected queue callback.
 set([null,undefined,NaN,null]);f.db.exec('CREATE TABLE conversation_discord_modals(expires REAL)');f.db.prepare('INSERT INTO conversation_discord_modals VALUES(?)').run(f.now+800);f.consume();await f.owner.core.schedule();assert.equal(f.alarm(),f.now+800);
});

test('real QQ-only and Discord-only future jobs, retry backoff, pause and quarantine retain deadlines',async t=>{
 const f=await fixture(t);await f.owner.qq.initializeContinuous();
 f.owner.qq.config=()=>({enabled:true});f.owner.qq.activation=()=>({active:true,expiresAt:f.now+86400000});
 const payload={source_id:'pa',project_id:'project',kind:'progress',source_status:'running'};
 f.db.prepare("INSERT INTO qq_continuous_outbox VALUES('qq-r','pa',1,1,?,'queued',NULL,?)").run(JSON.stringify(payload),f.now);
 f.consume();await f.owner.core.schedule();assert.equal(f.alarm(),f.now+60000,'routine QQ window is not made immediate');
 f.owner.qq.activation=()=>({active:false,expiresAt:f.now+86400000});f.consume();await f.owner.core.schedule();assert.equal(f.alarm(),null,'paused QQ creates no wake');
 f.owner.core.enabled=true;f.db.prepare("INSERT INTO outbox(receipt,view_key,intent,payload,revision,status,next_at) VALUES('discord-r','terminal','terminal',?,1,'queued',?)").run(JSON.stringify(payload),f.now+5000);
 f.consume();await f.owner.core.schedule();assert.equal(f.alarm(),f.now+5000,'Discord future work survives absent QQ deadline');
 f.db.prepare("UPDATE outbox SET status='retry_wait',next_at=?").run(f.now+7000);f.db.prepare("INSERT INTO meta VALUES('rate_until',?)").run(String(f.now+9000));f.consume();await f.owner.core.schedule();assert.equal(f.alarm(),f.now+9000,'rate-limit backoff preserved');
 f.owner.qq.activation=()=>({active:true,expiresAt:f.now+86400000});f.consume();await f.owner.core.schedule();assert.equal(f.alarm(),f.now+9000,'earliest legal channel wins');
 f.owner.qq.activation=()=>({active:false,expiresAt:f.now+86400000});f.db.exec("UPDATE outbox SET status='uncertain'");f.consume();await f.owner.alarm();assert.equal(f.alarm(),null);assert.equal(f.db.prepare('SELECT status FROM outbox').get().status,'uncertain','unknown receipt never retries');
});

test('SQL quota failure in a consumed alarm creates no immediate wake; recovery drains idle state safely',async t=>{
 const f=await fixture(t);await f.storage.setAlarm(f.now-1);f.consume();f.failSql(true);
 await assert.rejects(f.owner.alarm(),/SQL daily row read limit/);assert.equal(f.alarm(),null);assert.equal(f.sets.length,0,'no application retry is scheduled on SQL failure');
 f.failSql(false);await f.owner.alarm();assert.equal(f.alarm(),null);assert.equal(f.sets.length,0,'a later host retry after quota recovery cannot restart idle spin');
});

test('cold owner quota failure creates no alarm; a fresh host incarnation recovers without idle wake',async t=>{
 const f=await fixture(t,{initialize:false});f.consume();f.failSql(true);await assert.rejects(f.owner.alarm(),/SQL daily row read limit/);assert.equal(f.alarm(),null);assert.equal(f.sets.length,0);assert.equal(f.owner.core,undefined,'schema failure precedes core initialization');
 // blockConcurrencyWhile rejection resets the real host object. Model that
 // lifecycle explicitly instead of reusing its rejected initialization promise.
 f.failSql(false);const restarted=Object.create(worker.OwnerTerminal.prototype);restarted.ctx=f.owner.ctx;restarted.env=f.owner.env;await restarted.alarm();assert.equal(f.alarm(),null);assert.equal(f.sets.length,0);
 f.consume();await restarted.alarm();assert.equal(f.alarm(),null);assert.equal(f.sets.length,0);
});

test('quota recovery preserves already queued future work and scheduler failures propagate unchanged',async t=>{
 const f=await fixture(t),event={source_id:'pa',project_id:'project',kind:'completed',source_status:'completed'};f.owner.core.enabled=true;
 f.db.prepare("INSERT INTO outbox(receipt,view_key,intent,payload,revision,status,next_at) VALUES('future','future','terminal',?,1,'queued',?)").run(JSON.stringify(event),f.now+5000);
 await f.owner.core.schedule();assert.equal(f.alarm(),f.now+5000);f.consume();f.failSql(true);await assert.rejects(f.owner.alarm(),/SQL daily row read limit/);assert.equal(f.sets.length,0);
 f.failSql(false);await f.owner.alarm();assert.equal(f.alarm(),f.now+5000);assert.deepEqual({...f.db.prepare('SELECT status,next_at FROM outbox').get()},{status:'queued',next_at:f.now+5000});
 const failure=Error('offline deadline read failure');f.consume();Object.defineProperty(f.owner.qq,'nextAlarmAt',{get(){throw failure;}});await assert.rejects(f.owner.core.schedule(),e=>e===failure);assert.equal(f.sets.length,0);
});

test('actual local workerd owner performs multiple idle cycles with no alarm writes and no business resends',async()=>{
 const root=new URL('../src/owner/',import.meta.url),require=createRequire(import.meta.url);
 const script=`import {OwnerTerminal} from './worker.js';export class Probe extends OwnerTerminal {async measure(){let logs=[],sets=[],alarm=null;const storage=this.ctx.storage,exec=storage.sql.exec.bind(storage.sql);storage.sql.exec=(q,...args)=>{const c=exec(q,...args);logs.push(c);return c;};storage.setAlarm=async at=>{alarm=Number(at);sets.push(alarm);};storage.getAlarm=async()=>alarm;storage.deleteAlarm=async()=>{alarm=null;};await this.initializeLegacy();const initial={alarm,sets:sets.length},cycles=[];for(let i=0;i<4;i++){logs=[];sets=[];alarm=null;await this.alarm();cycles.push({reads:logs.reduce((n,c)=>n+c.rowsRead,0),writes:logs.reduce((n,c)=>n+c.rowsWritten,0),queries:logs.length,alarm,sets:sets.length});}return {initial,cycles};}}export default {async fetch(r,e){return Response.json(await e.OWNERS.getByName('owner:owner').measure());}};`;
 const modules=[{type:'ESModule',path:'idle-alarm-probe.mjs',contents:script},...readdirSync(root).filter(x=>/\.(js|mjs)$/.test(x)).map(x=>({type:'ESModule',path:x,contents:readFileSync(new URL(x,root))})),{type:'Data',path:'font.otf',contents:readFileSync(new URL('../assets/font.otf',import.meta.url))},{type:'CompiledWasm',path:'renderer.wasm',contents:readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm'))}];
 const mf=new Miniflare(convertV4MiniflareOptions({modules,modulesRootPath:process.cwd(),bindings,durableObjects:{OWNERS:{className:'Probe',useSQLite:true}},compatibilityDate:'2026-10-11',log:new Log(LogLevel.NONE)}));
 try{const response=await mf.dispatchFetch('http://localhost/');assert.equal(response.status,200);const result=await response.json();assert.deepEqual(result.initial,{alarm:null,sets:0});for(const cycle of result.cycles){assert.equal(cycle.alarm,null);assert.equal(cycle.sets,0);}for(const cycle of result.cycles.slice(1))assert.equal(cycle.writes,0);console.log('Offline workerd idle owner:',JSON.stringify(result));}finally{await mf.dispose();}
});
