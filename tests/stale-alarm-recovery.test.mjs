import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {loadProductionWorker} from './helpers/production-worker.mjs';
import {readDiscordDeliveryDiagnostics} from '../src/owner/discord-delivery-diagnostics.mjs';
const worker=await loadProductionWorker();
const plain=v=>JSON.parse(JSON.stringify(v));
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const state={now:1800000000000,alarm:null,writes:[],sent:[],admissions:0,failSql:false};
 const storage={sql:{exec(q,...a){if(state.failSql)throw Error('offline quota failure');if(q.includes('CREATE TABLE')||q.includes('CREATE INDEX')){db.exec(q);return{toArray:()=>[]};}return{toArray:()=>db.prepare(q).all(...a)};}},
  async transaction(fn){db.exec('BEGIN');try{const r=await fn(storage);db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}},
  getAlarm:async()=>state.alarm,setAlarm:async at=>{state.alarm=at;state.writes.push(at);},deleteAlarm:async()=>{state.alarm=null;},sync:async()=>{}};
 const source={source_id:'pa',provider:'dot',display_name:'Fixture',enabled:true,allowed_hosts:[],secret_name:'OFFLINE_KEY',auth_methods:['hmac']};
 const bindings={ownerId:'owner',appId:'100',userId:'200',dmId:'300',publicOrigin:'https://owner.test',sources:[source],allowedProjectIds:['project']};
 const core=new worker.OwnerCore(storage,bindings,{clock:()=>state.now,enabled:true,synthetic:false,
  sender:async d=>{state.sent.push(plain(d));return{status:200,body:{id:'500',channel_id:'300',author:{id:'100'}}};},
  channels:{onAccepted:()=>{state.admissions++;},nextAlarmAt:()=>null}});
 const event={schema_version:'1.0',event_id:'exact-original',source_id:'pa',project_id:'project',task_id:'task',run_id:'run',branch_id:'main',project_name:'Offline fixture',task_name:'Recovery test',kind:'progress',source_status:'running',source_seq:1,summary:'Authorized offline test',occurred_at:new Date(state.now).toISOString(),sensitivity:'normal'};
 const snapshot=()=>Object.fromEntries(['events','branches','outbox','source_health','source_connections','requests','milestones','audit'].map(table=>[table,db.prepare('SELECT * FROM '+table).all()]));
 return{db,state,storage,source,core,event,snapshot};
}
test('exact duplicate repairs long-past alarm without new event/revision/jobs/QQ admission and dispatches existing job once',async t=>{
 const f=fixture(t),accepted=await f.core.ingest(f.source,f.event);assert.equal(f.state.admissions,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM outbox').get().n,1);
 f.state.now+=600000;f.state.alarm=f.state.now-86400000;f.state.writes=[];const before=f.snapshot();
 const duplicate=await f.core.ingest(f.source,f.event);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.receipt_id,accepted.receipt_id);assert.equal(duplicate.revision,accepted.revision);assert.deepEqual(f.snapshot(),before);assert.equal(f.state.admissions,1);assert.equal(f.state.sent.length,0);assert.deepEqual(f.state.writes,[f.state.now+1]);
 // More identical requests cannot postpone the newly pending wake.
 f.state.now+=2;await f.core.ingest(f.source,f.event);assert.equal(f.state.writes.length,1);assert.deepEqual(f.snapshot(),before);
 f.state.alarm=null;assert.equal((await f.core.alarm()).status,'sent');assert.equal(f.state.sent.length,1);assert.equal(f.db.prepare('SELECT attempts FROM outbox').get().attempts,1);
 await f.core.alarm();await f.core.ingest(f.source,f.event);assert.equal(f.state.sent.length,1);assert.equal(f.state.admissions,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM events').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM outbox').get().n,1);
});
test('earlier future and normal overdue/retry-window alarms remain untouched at five-minute boundary',async t=>{
 for(const age of [-500,0,1,126000,186000,299999,300000]){const f=fixture(t);await f.core.ingest(f.source,f.event);f.state.alarm=f.state.now-age;f.state.writes=[];await f.core.ingest(f.source,f.event);assert.equal(f.state.alarm,f.state.now-age);assert.deepEqual(f.state.writes,[],String(age));}
 const f=fixture(t);await f.core.ingest(f.source,f.event);f.state.alarm=f.state.now-300001;f.state.writes=[];await f.core.ingest(f.source,f.event);assert.deepEqual(f.state.writes,[f.state.now+60000],'routine progress still waits its original window');
});
test('stale-alarm repair obeys quarantine, disabled delivery, rate limit and missing work',async t=>{
 for(const status of ['uncertain','sending','blocked']){const f=fixture(t);await f.core.ingest(f.source,f.event);f.db.prepare('UPDATE outbox SET status=?').run(status);f.state.alarm=f.state.now-86400000;f.state.writes=[];await f.core.ingest(f.source,f.event);assert.equal(f.state.alarm,null);assert.equal(f.state.writes.length,0);await f.core.alarm();assert.equal(f.state.sent.length,0);}
 const disabled=fixture(t);await disabled.core.ingest(disabled.source,disabled.event);disabled.core.enabled=false;disabled.state.alarm=disabled.state.now-86400000;disabled.state.writes=[];await disabled.core.ingest(disabled.source,disabled.event);assert.equal(disabled.state.alarm,null);assert.equal(disabled.state.writes.length,0);
 const rate=fixture(t);await rate.core.ingest(rate.source,rate.event);rate.state.now+=600000;rate.db.prepare("INSERT INTO meta VALUES('rate_until',?)").run(String(rate.state.now+120000));rate.state.alarm=rate.state.now-86400000;rate.state.writes=[];await rate.core.ingest(rate.source,rate.event);assert.deepEqual(rate.state.writes,[rate.state.now+120000]);await rate.core.alarm();assert.equal(rate.state.sent.length,0);
 const empty=fixture(t);empty.state.alarm=empty.state.now-86400000;await empty.core.schedule();assert.equal(empty.state.alarm,null);assert.equal(empty.state.writes.length,0);
});
test('read diagnostics never repairs an old alarm; quota failure never arms a recovery loop',async t=>{
 const f=fixture(t);await f.core.ingest(f.source,f.event);f.state.alarm=f.state.now-86400000;f.state.writes=[];
 const before=f.snapshot(),r=await readDiscordDeliveryDiagnostics(f.storage,{tables:new Set(['events','outbox','meta']),sourceId:'pa',now:f.state.now});assert.equal(r.alarm.scheduled_at,f.state.alarm);assert.equal(f.state.writes.length,0);assert.deepEqual(f.snapshot(),before);
 f.state.failSql=true;await assert.rejects(f.core.schedule(),/quota failure/);assert.equal(f.state.writes.length,0);assert.equal(f.state.alarm,f.state.now-86400000);
});

test('an uncertain dispatch or conflicting duplicate cannot be turned into a resend by stale repair',async t=>{
 const f=fixture(t);await f.core.ingest(f.source,f.event);f.state.now+=600000;f.state.alarm=f.state.now-86400000;f.state.writes=[];
 await assert.rejects(f.core.ingest(f.source,{...f.event,summary:'different content'}),e=>e.code==='event_id_conflict');assert.equal(f.state.writes.length,0);
 await f.core.ingest(f.source,f.event);f.core.sender=async()=>{f.state.sent.push('unknown');return{};};f.state.alarm=null;assert.equal((await f.core.alarm()).status,'uncertain');assert.equal(f.state.sent.length,1);
 f.state.alarm=f.state.now-86400000;f.state.writes=[];const before=f.snapshot();await f.core.ingest(f.source,f.event);assert.deepEqual(f.snapshot(),before);assert.equal(f.state.alarm,null);assert.equal(f.state.writes.length,0);await f.core.alarm();assert.equal(f.state.sent.length,1);assert.equal(f.state.admissions,1);
});

test('live recovery shape completed/overview_only duplicate preserves receipt and sends the single overview once',async t=>{
 const f=fixture(t),event={...f.event,kind:'completed',source_status:'completed'},mode='overview_only';
 const accepted=await f.core.ingest(f.source,event,mode);
 assert.deepEqual(f.db.prepare('SELECT intent,status,attempts FROM outbox').all().map(plain),[{intent:'overview',status:'queued',attempts:0}]);
 f.state.now+=600000;f.state.alarm=f.state.now-86400000;f.state.writes=[];const before=f.snapshot();
 const duplicate=await f.core.ingest(f.source,event,mode);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.receipt_id,accepted.receipt_id);assert.equal(duplicate.revision,accepted.revision);assert.deepEqual(f.snapshot(),before);assert.equal(f.state.admissions,1);assert.equal(f.state.sent.length,0);assert.deepEqual(f.state.writes,[f.state.now+1]);
 await assert.rejects(f.core.ingest(f.source,event,'standard'),e=>e.code==='event_id_conflict');assert.deepEqual(f.snapshot(),before);
 f.state.now++;f.state.alarm=null;assert.equal((await f.core.alarm()).status,'sent');assert.equal(f.state.sent.length,1);assert.equal(f.state.sent[0].payload.intent,'overview');assert.equal(f.state.sent[0].payload.event.kind,'completed');
 assert.deepEqual(f.db.prepare('SELECT intent,status,attempts FROM outbox').all().map(plain),[{intent:'overview',status:'sent',attempts:1}]);
 await f.core.ingest(f.source,event,mode);await f.core.alarm();assert.equal(f.state.sent.length,1);assert.equal(f.state.admissions,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM events').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM outbox').get().n,1);assert.equal(f.state.alarm,null);
});
