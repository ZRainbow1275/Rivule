import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {readDiscordDeliveryDiagnostics, DISCORD_DIAGNOSTIC_QUERY} from '../src/owner/discord-delivery-diagnostics.mjs';
import {loadProductionWorker} from './helpers/production-worker.mjs';
function fixture(t) {
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('CREATE TABLE events(receipt TEXT PRIMARY KEY,source_id TEXT,payload TEXT); CREATE TABLE outbox(id INTEGER PRIMARY KEY,receipt TEXT,status TEXT,next_at REAL,payload TEXT); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE INDEX outbox_due ON outbox(status,next_at,id);');
 const queries=[];let alarmReads=0;
 const storage={sql:{exec(sql,...args){queries.push(sql);assert.match(sql,/^SELECT /);return {toArray:()=>db.prepare(sql).all(...args)};}},getAlarm:async()=>{alarmReads++;return 1500;},setAlarm(){assert.fail('alarm write');},deleteAlarm(){assert.fail('alarm delete');},put(){assert.fail('KV write');},transaction(){assert.fail('transaction');}};
 const add=(id,source,status,at=1000)=>{db.prepare('INSERT INTO events VALUES(?,?,?)').run('r'+id,source,'private payload recipient sentinel');db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?)').run(id,'r'+id,status,at,'Bearer private payload sentinel');};
 const read=()=>readDiscordDeliveryDiagnostics(storage,{tables:new Set(['outbox','events','meta']),sourceId:'pa',deliveryEnabled:true,now:1000});
 return {db,storage,add,read,queries,alarmReads:()=>alarmReads};
}
test('source counts stay scoped; owner-wide quarantine is count-only and every operation is read-only',async t=>{
 const f=fixture(t);f.add(1,'pa','queued',2000);f.add(2,'pa','sent');f.add(3,'other','blocked');f.add(4,'other','queued');f.db.prepare('INSERT INTO meta VALUES(?,?)').run('rate_until','3000');
 const before=f.db.prepare('SELECT total_changes() AS n').get().n,r=await f.read();
 assert.equal(r.source_queue.counts.queued.count,1);assert.equal(r.source_queue.counts.sent,undefined);assert.equal(r.source_queue.counts.blocked.count,0);assert.equal(r.source_queue.earliest_sampled_pending_at,2000);
 assert.equal(r.owner_dispatch_gate.quarantine_counts.blocked.count,1);assert.equal(r.owner_dispatch_gate.quarantine_present,true);assert.equal(r.owner_dispatch_gate.rate_state,'waiting');assert.deepEqual(r.alarm,{state:'scheduled',scheduled_at:1500});
 assert.equal(f.alarmReads(),1);assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,before);assert.doesNotMatch(JSON.stringify(r),/other|private|Bearer|payload|receipt/);assert.ok(f.queries.every(q=>!q.includes('payload')));
});
test('absent schema and failed reads are unavailable, never initialized or claimed empty',async t=>{
 const f=fixture(t);let r=await readDiscordDeliveryDiagnostics(f.storage,{tables:new Set(),sourceId:'pa',now:1000});assert.equal(r.reason,'schema_unavailable');assert.equal(f.queries.length,0);assert.equal(f.alarmReads(),0);
 f.storage.sql.exec=()=>{throw Error('private secret error');};r=await f.read();assert.equal(r.reason,'state_unavailable');assert.doesNotMatch(JSON.stringify(r),/private|secret/);assert.equal(f.alarmReads(),0);
});
test('unknown states are whitelisted; malformed rate and failing alarm are unavailable independently',async t=>{
 const f=fixture(t);f.add(1,'pa','private-state');f.db.prepare('INSERT INTO meta VALUES(?,?)').run('rate_until','private rate');f.storage.getAlarm=async()=>{throw Error('private alarm');};const r=await f.read();assert.equal(r.source_queue.counts['private-state'],undefined);assert.equal(r.owner_dispatch_gate.rate_state,'unavailable');assert.equal(r.alarm.state,'unavailable');assert.doesNotMatch(JSON.stringify(r),/private/);
});
test('empty queue, consumed alarm and expired backoff remain distinct',async t=>{
 const f=fixture(t);f.storage.getAlarm=async()=>null;const r=await f.read();assert.equal(r.source_queue.counts.queued.count,0);assert.equal(r.source_queue.earliest_sampled_pending_at,null);assert.equal(r.owner_dispatch_gate.quarantine_present,false);assert.equal(r.owner_dispatch_gate.rate_state,'not_waiting');assert.equal(r.alarm.state,'not_scheduled');assert.equal(r.source_queue.truncated,false);
});
test('large queues return bounded aggregates with explicit incomplete semantics',async t=>{
 const f=fixture(t);for(let i=1;i<=1005;i++)f.add(i,'pa','blocked');const r=await f.read();assert.equal(r.source_queue.counts.blocked.count,101);assert.equal(r.source_queue.truncated,true);assert.equal(r.source_queue.counts_semantics,'lower_bounds_candidate_limit');assert.equal(r.owner_dispatch_gate.quarantine_counts.blocked.count,101);assert.equal(r.owner_dispatch_gate.truncated,true);
});
test('actual production diagnostic authorization rejects before storage reads or initialization',async()=>{
 const w=await loadProductionWorker(),owner=Object.create(w.OwnerTerminal.prototype);let reads=0;
 owner.env={};owner.ctx={storage:{sql:{exec(){reads++;throw Error('unexpected read');}}}};owner.source=()=>{throw new w.Rejected('source_not_authorized',403);};owner.initializeLegacy=()=>assert.fail('initialization forbidden');
 const result=await owner.connectionDiagnostics({},{});assert.equal(result.ok,false);assert.equal(result.error,'source_not_authorized');assert.equal(reads,0);
 const source=readFileSync(new URL('../src/owner/worker.js',import.meta.url),'utf8');const method=source.slice(source.lastIndexOf('    async connectionDiagnostics(principal, query) {'),source.indexOf('    async selectView',source.lastIndexOf('    async connectionDiagnostics(principal, query) {')));
 assert.ok(method.indexOf('isDiagnosticReader')<method.indexOf('readDiscordDeliveryDiagnostics'));assert.ok(method.includes('}, false)'));assert.doesNotMatch(method,/initializeLegacy|schedule\(|publish\(|setAlarm/);
});

test('indexed candidate budget ignores large historical populations and limits before source join',async t=>{
 const f=fixture(t);for(let i=1;i<=10000;i++)f.add(i,'other','sent');for(let i=10001;i<=10102;i++)f.add(i,'other','queued');f.add(10103,'pa','queued');
 const plan=f.db.prepare('EXPLAIN QUERY PLAN '+DISCORD_DIAGNOSTIC_QUERY).all('pa','pa','queued',101).map(r=>r.detail).join('\n');
 assert.match(plan,/USING INDEX outbox_due/);assert.match(plan,/SEARCH e USING INDEX sqlite_autoindex_events_1/);assert.doesNotMatch(plan,/SCAN outbox|SCAN e(?: |$)|USE TEMP B-TREE/);
 const r=await f.read();assert.equal(r.source_queue.counts.queued.count,0);assert.equal(r.source_queue.counts.queued.has_more,true);assert.equal(r.source_queue.counts_semantics,'lower_bounds_candidate_limit');assert.equal(f.queries.filter(q=>q.includes('LIMIT ?')).length,5);
});

test('actual local workerd diagnostic has bounded rowsRead and zero writes with large history',async()=>{
 const {Miniflare,convertV4MiniflareOptions,Log,LogLevel}=await import('miniflare');
 const helper=readFileSync(new URL('../src/owner/discord-delivery-diagnostics.mjs',import.meta.url),'utf8');
 const script=`import {DurableObject} from 'cloudflare:workers';import {readDiscordDeliveryDiagnostics} from './diagnostics.mjs';
 export class Probe extends DurableObject {async fetch(){const sql=this.ctx.storage.sql;sql.exec('CREATE TABLE IF NOT EXISTS events(receipt TEXT PRIMARY KEY,source_id TEXT,payload TEXT);CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY,receipt TEXT,status TEXT,next_at REAL,payload TEXT);CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status,next_at,id);CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);');
 const add=(id,status)=>{sql.exec('INSERT INTO events VALUES(?,?,?)','r'+id,'other','private');sql.exec('INSERT INTO outbox VALUES(?,?,?,?,?)',id,'r'+id,status,1000,'private');};for(let i=1;i<=105;i++)add(i,'blocked');
 const measure=async()=>{let reads=0,writes=0,queries=0,alarms=0;const storage={sql:{exec(q,...a){const c=sql.exec(q,...a);return{toArray(){const r=c.toArray();reads+=c.rowsRead;writes+=c.rowsWritten;queries++;return r;}};}},getAlarm:async()=>{alarms++;return null;}};const result=await readDiscordDeliveryDiagnostics(storage,{tables:new Set(['events','outbox','meta']),sourceId:'pa',now:1000});return{reads,writes,queries,alarms,result};};
 const before=await measure();for(let i=106;i<10106;i++)add(i,'sent');const after=await measure();return Response.json({before,after});}}
 export default {fetch(r,e){return e.DB.getByName('offline-diagnostic-only').fetch(r);}};`;
 const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:'probe.mjs',contents:script},{type:'ESModule',path:'diagnostics.mjs',contents:helper}],modulesRootPath:process.cwd(),durableObjects:{DB:{className:'Probe',useSQLite:true}},compatibilityDate:'2026-10-11',log:new Log(LogLevel.NONE)}));
 try {const r=await(await mf.dispatchFetch('http://localhost/')).json();assert.equal(r.before.reads,r.after.reads);assert.ok(r.after.reads<=510,r.after.reads);assert.equal(r.after.writes,0);assert.equal(r.after.queries,6);assert.equal(r.after.alarms,1);assert.equal(r.after.result.owner_dispatch_gate.quarantine_present,true);assert.equal(r.after.result.source_queue.truncated,true);console.log('Diagnostic offline workerd budget',JSON.stringify({rowsRead:r.after.reads,rowsWritten:r.after.writes,queries:r.after.queries,alarmReads:r.after.alarms}));}finally{await mf.dispose();}
});
