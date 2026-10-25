import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from 'miniflare';
import {loadProductionWorker} from './helpers/production-worker.mjs';

const worker=await loadProductionWorker();
const source=readFileSync(new URL('../src/owner/worker.js',import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
// Reconstruct only the old dispatch expression. All scheduler, authority and
// receipt-state logic is the actual production method under test.
const alarmText=worker.OwnerCore.prototype.alarm.toString();
assert.equal(alarmText.split('historical_sources: this.sourceSummary().filter').length,2);
const oldAlarm=Function('Rejected','numericId','return ('+alarmText.replace('async alarm()', 'async function()').replace('historical_sources: this.sourceSummary().filter','historical_sources: this.snapshot().sources.filter')+');')(
  worker.Rejected,v=>typeof v==='string'&&/^[0-9]{1,25}$/.test(v)&&v!=='0');

function fixture(t,{intent='terminal',legacy=false,result='sent',allow=true}={}){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const queries=[],sent=[];let alarm=null;const now=1800000000000;
  const storage={sql:{exec(q,...args){queries.push(q);if(q.includes('CREATE TABLE')){db.exec(q);return{toArray:()=>[]};}return{toArray:()=>db.prepare(q).all(...args)};}},async transaction(fn){db.exec('BEGIN');try{const r=await fn(storage);db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}},getAlarm:async()=>alarm,setAlarm:async a=>{alarm=a;},deleteAlarm:async()=>{alarm=null;},sync:async()=>{}};
  const sources=['verified','unverified','revoked','disabled'].map(source_id=>({source_id,provider:'dot',display_name:source_id,enabled:source_id!=='disabled',secret_name:'OFFLINE_SECRET',allowed_hosts:[]}));
  const b={ownerId:'owner',appId:'100',userId:'200',dmId:'300',publicOrigin:'https://owner.test',allowedProjectIds:['project'],sources};
  const core=new worker.OwnerCore(storage,b,{clock:()=>now,enabled:true,synthetic:false,channels:{bridgeDispatchAllowed:()=>allow,conversationDispatchAllowed:()=>allow},sender:async dispatch=>{sent.push(plain(dispatch));return result==='sent'?{status:200,body:{id:'500',channel_id:'300',author:{id:'100'}}}:{};}});
  core.connections.reconcile();core.connections.record(sources[0],'initialize',now);core.connections.record(sources[2],'initialize',now);core.connections.revoke('revoked');
  for(const [i,s] of sources.entries()){
    core.rows('INSERT INTO source_health VALUES(?,?)',s.source_id,now-i);
    core.rows('INSERT INTO events(source_id,event_id,receipt,branch_key,hash,payload,decision,received_at) VALUES(?,?,?,?,?,?,?,?)',s.source_id,'e'+i,'r'+i,'b'+i,'hash','{}','applied',now);
  }
  for(let i=0;i<6;i++){
    const event={source_id:'verified',project_id:'project',task_id:'task'+i,run_id:'run',branch_id:'main',source_status:'completed',summary:'Fixture',occurred_at:new Date(now).toISOString(),sensitivity:'normal',kind:'completed'};
    core.rows('INSERT INTO branches VALUES(?,?,?,?,?,?,?, ?,?)','b'+i,'verified','project',JSON.stringify(event),1,1,i+1,now,0);
    for(let m=0;m<8;m++)core.rows('INSERT INTO milestones VALUES(?,?,?,?,?,?)','m'+i+':'+m,'b'+i,'phase'+m,'Phase '+m,'event'+m,new Date(now+m).toISOString());
  }
  const event={source_id:'verified',project_id:'project',task_id:'task',run_id:'run',branch_id:'main',source_status:'completed',kind:'completed',sensitivity:'normal'};
  core.rows("INSERT INTO requests VALUES('request','b0','request',?,'pending',1)",JSON.stringify(event));
  const view=intent==='request'?'request:request':intent==='overview'?'overview':intent+':receipt';
  core.rows("INSERT INTO outbox(receipt,view_key,intent,payload,revision,status,next_at) VALUES('receipt',?,?,?,1,'queued',?)",view,intent,JSON.stringify(event),now);
  // Controls are orthogonal to this extraction and contain random opaque IDs.
  // Fix only those IDs so full dispatch payload equality is exact across runs.
  core.controls=()=>[{type:1,components:[{type:2,custom_id:'fixed-control',label:'Fixture'}]}];
  if(legacy)core.alarm=oldAlarm;
  queries.length=0;return {db,core,queries,sent,b,now,storage};
}

test('sourceSummary preserves all source fields and status semantics with only source-scoped reads',t=>{
  const f=fixture(t),reference=f.core.snapshot().sources;
  f.queries.length=0;assert.deepEqual(plain(f.core.sourceSummary()),plain(reference));
  assert.equal(f.queries.length,3*f.b.sources.length);
  assert.ok(f.queries.every(q=>/FROM (source_health|source_connections|events) WHERE source_id=\?/.test(q)),f.queries.join('\n'));
  const summary=f.core.sourceSummary();assert.deepEqual(summary.map(s=>s.connection_status),['verified','needs_reverification','revoked','disabled']);
  assert.ok(summary.every(s=>s.secret_name===undefined));
  f.core.connections.revoke('verified');assert.equal(f.core.sourceSummary()[0].connection_status,'revoked','proof is reread, not cached');
  assert.equal(f.core.sourceSummary()[0].selectable,false);
});

test('every production dispatch intent keeps the exact old payload and saves one full snapshot',async t=>{
  for(const intent of ['terminal','request','overview','bridge_task','bridge_response','bridge_conversation_response']){
    const before=fixture(t,{intent,legacy:true}),after=fixture(t,{intent});
    assert.deepEqual(plain(await before.core.alarm()),plain(await after.core.alarm()));
    assert.equal(after.sent.length,1,intent);assert.deepEqual(after.sent,before.sent,intent);
    const milestone=q=>q.startsWith('SELECT phase_id,label,event_id,occurred_at FROM milestones');
    assert.equal(before.queries.filter(milestone).length-after.queries.filter(milestone).length,6,intent);
    assert.equal(before.queries.length-after.queries.length,6+2*after.b.sources.length+4,intent);
    assert.deepEqual(plain(after.core.one('SELECT status,attempts,message_id,last_error FROM outbox')),plain(before.core.one('SELECT status,attempts,message_id,last_error FROM outbox')));
  }
});

test('source summary extraction does not bypass dispatch authority or resend uncertain outcomes',async t=>{
  for(const legacy of [false,true]){
    const denied=fixture(t,{legacy,allow:false});assert.equal((await denied.core.alarm()).status,'suppressed');assert.equal(denied.sent.length,0);
    const unknown=fixture(t,{legacy,result:'unknown'});assert.equal((await unknown.core.alarm()).status,'uncertain');assert.equal(unknown.sent.length,1);
    await unknown.core.alarm();assert.equal(unknown.sent.length,1);assert.equal(unknown.core.one('SELECT status FROM outbox').status,'uncertain');
  }
});

test('local workerd rowsRead measures the removed snapshot without DDL or cached proof changes',async()=>{
  const schema=[...source.matchAll(/var schema = `(.*?)`;/gs)].at(-1)[1];
  const methods=['rows','one','sourceStatus','connectedSources','sourceSummary','snapshot'].map(name=>worker.OwnerCore.prototype[name].toString()).join('\n');
  const script=`import {DurableObject} from 'cloudflare:workers';
  const isConnectedSource=s=>s.enabled===true&&s.selectable===true&&s.connection_status==='verified';
  class Core {${methods}}
  export class Probe extends DurableObject {async fetch(){const sql=this.ctx.storage.sql;sql.exec(${JSON.stringify(schema)});sql.exec('CREATE TABLE source_connections(source_id TEXT PRIMARY KEY,binding TEXT,generation INTEGER,evidence_kind TEXT,last_verified_at REAL,revoked INTEGER)');sql.exec("INSERT INTO source_connections VALUES('source','binding',1,'initialize',1000,0)");sql.exec("INSERT INTO source_health VALUES('source',1000)");
    for(let i=0;i<250;i++){const b='b'+i;sql.exec('INSERT INTO branches VALUES(?,?,?,?,?,?,?,?,?)',b,'source','project',JSON.stringify({source_id:'source',project_id:'project',source_status:'completed'}),1,1,i+1,1000,0);}
    for(let i=0;i<10000;i++){const b='b'+(i%250);sql.exec('INSERT INTO milestones VALUES(?,?,?,?,?,?)','m'+i,b,'p'+i,'Phase','e'+i,String(i));sql.exec('INSERT INTO events(source_id,event_id,receipt,branch_key,hash,payload,decision,received_at) VALUES(?,?,?,?,?,?,?,?)','source','e'+i,'r'+i,b,'hash','{}','applied',1000);}
    const core=new Core();let reads=0,count=0;core.storage={sql:{exec(q,...args){const c=sql.exec(q,...args);return{toArray(){const rows=c.toArray();reads+=c.rowsRead;count++;return rows;}}}}};core.b={ownerId:'owner',sources:[{source_id:'source',enabled:true,secret_name:'OFFLINE_SECRET'}]};core.clock=()=>1000;core.connections={status(source){const row=core.one('SELECT * FROM source_connections WHERE source_id=?',source.source_id);return{selectable:!row.revoked,connection_status:row.revoked?'revoked':'verified',evidence_kind:row.evidence_kind,last_verified_at:row.last_verified_at,connection_generation:row.generation};}};
    const old=core.snapshot().sources,before={rowsRead:reads,queries:count};reads=0;count=0;const optimized=core.sourceSummary(),after={rowsRead:reads,queries:count};return Response.json({before,after,equal:JSON.stringify(old)===JSON.stringify(optimized)});}}
  export default {fetch(r,e){return e.DB.getByName('offline-only').fetch(r)}};`;
  const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:'source-summary-budget.mjs',contents:script}],modulesRootPath:process.cwd(),durableObjects:{DB:{className:'Probe',useSQLite:true}},compatibilityDate:'2026-10-11',log:new Log(LogLevel.NONE)}));
  try{
    const response=await mf.dispatchFetch('http://localhost/');assert.equal(response.status,200);const result=await response.json();
    assert.equal(result.equal,true);assert.equal(result.before.queries,259);assert.equal(result.after.queries,3);
    assert.equal(result.before.rowsRead,2530256);assert.equal(result.after.rowsRead,10002);
    console.log('Offline workerd source-summary rowsRead:',JSON.stringify(result));
  }finally{await mf.dispose();}
});
