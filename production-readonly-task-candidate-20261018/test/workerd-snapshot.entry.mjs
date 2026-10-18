import worker,{OwnerTerminal as ProductionOwner} from './worker.js';
// Test-only subclass reads raw SQLite for before/after comparisons; absent from
// the deployable candidate. All outbound calls are denied by the runner.
export class OwnerTerminal extends ProductionOwner {
  async inspectStorage(){
    const names=this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_cf_*' ORDER BY name").toArray();
    return {tables:names.map(({name})=>({name,rows:this.ctx.storage.sql.exec('SELECT * FROM "'+name+'"').toArray()})),alarm:await this.ctx.storage.getAlarm()};
  }
  async seedRestartFixtures(){
    await this.initializeLegacy();
    this.ctx.storage.sql.exec("UPDATE outbox SET status='sending'");
    this.ctx.storage.sql.exec("UPDATE source_connections SET binding='OLD-BINDING',evidence_kind='accepted_event'");
    this.ctx.storage.sql.exec("INSERT INTO qq_outbox VALUES('zot-main','test-qq','test',?,'sending',0,NULL)",'{}');
    await this.ctx.storage.setAlarm(Date.now()+86400000);
  }
}
const eq=(a,b,m)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error(m+': '+JSON.stringify({a,b}));};
const assert=(v,m)=>{if(!v)throw Error(m);};
const principal={version:1,owner_id:'one',source_id:'zot-main',client_id:'synthetic-client'};
const query={project_id:'p',task_id:'t',run_id:'r',branch_id:'main'};
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
export default {async test(_ctrl,env,ctx){
 const owner=env.OWNERS.get(env.OWNERS.idFromName('owner:'+env.OWNER_ID));
 const snapshot=()=>owner.taskSnapshot(principal,query);
 const signed=async()=>{const raw=JSON.stringify(query),ts=String(Math.floor(Date.now()/1000)),key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.PA_ZOT_HMAC),{name:'HMAC',hash:'SHA-256'},false,['sign']);return new Request(env.PUBLIC_ORIGIN+'/v1/task/snapshot',{method:'POST',headers:{'content-type':'application/json','x-pa-source':'zot-main','x-pa-timestamp':ts,'x-pa-signature':hex(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(ts+'.'+raw)))},body:raw})};
 if(env.TEST_STAGE==='seed'){
  const empty=await owner.inspectStorage();assert(empty.tables.length===0&&empty.alarm===null,'constructor_not_empty');
  const absent=await snapshot();assert(absent.ok&&absent.result.found===false,'empty_snapshot');
  const http=await worker.fetch(await signed(),env,ctx);assert(http.status===200,'cold_http');assert(!http.headers.has('x-rivule-request-id'),'read_diagnostic_written');eq(await owner.inspectStorage(),empty,'empty_read_wrote_state');
  const event={event_id:'runtime-initial',source_id:'zot-main',...query,project_name:'Project',task_name:'Task',kind:'started',source_status:'running',source_seq:null,occurred_at:new Date().toISOString()};
  const initial=await owner.publish(principal,event,'overview_only');assert(initial.ok,'initial_publish');
  const before=await owner.inspectStorage();const s=await snapshot();assert(s.result.snapshot.source_seq===null&&s.result.sequence.next_seq===0&&s.result.sequence.mode==='initialize_sequence','null_advice');eq(await owner.inspectStorage(),before,'warm_read_wrote_state');
  const initialized=await owner.publish(principal,{...event,event_id:'runtime-initialize',source_seq:0},'overview_only');assert(initialized.ok,'sequence_initialize');
  const stale=await owner.publish(principal,{...event,event_id:'runtime-race',source_seq:0},'overview_only');assert(stale.error==='overview_only_requires_unambiguous_nonapproval_update','stale_guard_bypass');
  const omit=await owner.publish(principal,{...event,event_id:'runtime-null'},'overview_only');assert(omit.error==='overview_only_requires_unambiguous_nonapproval_update','unsequenced_guard_bypass');
  const forbidden=await owner.taskSnapshot({...principal,source_id:'spark-main'},query);assert(!forbidden.ok&&forbidden.status===403,'source_boundary');
  const wrongProject=await owner.taskSnapshot(principal,{...query,project_id:'q'});assert(wrongProject.ok&&wrongProject.result.found===false,'project_boundary');
  await owner.seedRestartFixtures();
  console.log(JSON.stringify({stage:'seed',cold_empty_read_sql_tables:0,cold_empty_read_alarm:null,warm_read_state_unchanged:true,null_sequence_initialization:0,stale_and_null_guards_preserved:true,source_project_boundaries:true}));
 } else {
  const before=await owner.inspectStorage();
  const table=name=>before.tables.find(t=>t.name===name)?.rows??[];
  assert(table('outbox').some(r=>r.status==='sending'),'restart_fixture_missing');assert(table('qq_outbox')[0].status==='sending','qq_restart_fixture_missing');assert(table('source_connections')[0].binding==='OLD-BINDING','constructor_reconciled_proof');
  const s=await snapshot();assert(s.ok&&s.result.snapshot.source_seq===0&&s.result.sequence.next_seq===1,'restart_snapshot');
  const http=await worker.fetch(await signed(),env,ctx);assert(http.status===200,'restart_http');eq(await owner.inspectStorage(),before,'cold_persisted_read_wrote_state_or_alarm');
  const legacy=await owner.recordSourceHandshake(principal,'read_probe');assert(legacy.ok,'legacy_initializer');
  const after=await owner.inspectStorage();const next=name=>after.tables.find(t=>t.name===name)?.rows??[];
  assert(next('outbox').some(r=>r.status==='uncertain'),'legacy_quarantine_missing');assert(next('qq_outbox')[0].status==='uncertain','legacy_qq_recovery_missing');const proof=next('source_connections').find(r=>r.source_id==='zot-main');assert(proof.binding!=='OLD-BINDING'&&proof.evidence_kind==='read_probe','legacy_proof_recovery_missing');
  console.log(JSON.stringify({stage:'restart',actual_persisted_sqlite_cold_read_unchanged:true,queue_qq_proof_and_alarm_unchanged:true,legacy_recovery_preserved:true,external_requests:0}));
 }
}};
