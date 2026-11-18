// Offline only: real published OwnerCore and SQLite; synthetic clock, sender and page controls.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { readDashboardActivity } from '../src/owner/dashboard-activity.mjs';
import { dashboardClient, selectedWorkbench } from '../src/owner/presentation.mjs';
import { loadProductionWorker } from './helpers/production-worker.mjs';

const {OwnerCore}=await loadProductionWorker();
const query={project_id:'project',task_id:'task',run_id:'run',branch_id:'main'};
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const state={now:1800000000000,alarm:null,alarmWrites:0,sql:[],attempts:0};
  const storage={sql:{exec(q,...args){state.sql.push(q);if(q.includes('CREATE TABLE')||q.includes('CREATE INDEX')){db.exec(q);return {toArray:()=>[]};}return {toArray:()=>db.prepare(q).all(...args)};}},
    async transaction(fn){db.exec('BEGIN');try{const got=await fn(storage);db.exec('COMMIT');return got;}catch(e){db.exec('ROLLBACK');throw e;}},
    getAlarm:async()=>state.alarm,setAlarm:async at=>{state.alarm=at;state.alarmWrites++;},deleteAlarm:async()=>{state.alarm=null;state.alarmWrites++;},sync:async()=>{}};
  const source={source_id:'pa',provider:'dot',display_name:'Fixture',enabled:true,allowed_hosts:[],secret_name:'OFFLINE_FIXTURE',auth_methods:['hmac']};
  const bindings={ownerId:'owner',appId:'100',userId:'200',dmId:'300',publicOrigin:'https://owner.test',sources:[source],allowedProjectIds:['project']};
  const core=new OwnerCore(storage,bindings,{clock:()=>state.now,enabled:true,synthetic:false,
    sender:async()=>{state.attempts++;return state.attempts===1?{status:429,retryAfter:3}:{status:200,body:{id:'500',channel_id:'300',author:{id:'100'}}};},
    channels:{onAccepted:()=>{},nextAlarmAt:()=>null}});
  const event={schema_version:'1.0',...query,event_id:'offline-layout-progress',source_id:'pa',project_name:'Offline project',task_name:'排版进度',kind:'progress',source_status:'running',source_seq:1,summary:'合成排版任务',occurred_at:new Date(state.now).toISOString(),sensitivity:'normal'};
  const peek=()=>db.prepare('SELECT status,next_at FROM outbox ORDER BY id LIMIT 1').get();
  const activity=()=>{const offset=state.sql.length,a=state.attempts,w=state.alarmWrites;const r=readDashboardActivity(storage,bindings,source,query,state.now);
    assert.ok(state.sql.slice(offset).every(q=>q.startsWith('SELECT ')));assert.equal(state.attempts,a);assert.equal(state.alarmWrites,w);return r;};
  const advance=async()=>{state.now=peek().next_at;state.alarm=null;await core.alarm();};
  return {core,event,source,db,state,activity,advance,peek};
}

// Run the production client. The small DOM implements only the controls used by this read path.
async function pageText(activity,route='primary'){
  class E { constructor(){this.children=[];this.listeners={};this.textContent='';this.classList={toggle(){}};}
    addEventListener(k,fn){this.listeners[k]=fn;}replaceChildren(...items){this.children=items;}append(...items){this.children.push(...items);}insertBefore(item){this.children.push(item);}setAttribute(){}focus(){}remove(){}showModal(){this.open=true;}close(){this.open=false;}}
  const document=new E(),win=new E(),els=new Map();document.getElementById=k=>{if(!els.has(k))els.set(k,new E());return els.get(k);};
  document.createElement=()=>new E();document.createElementNS=()=>new E();document.body=new E();
  const item={...query,task_name:'排版进度',source_id:'pa',state:'available',source_status:'running',summary:'合成排版任务',last_confirmed_at:'2026-10-23T10:00:00Z',activity};
  const data=route==='secondary'?{state:'ready',items:[],sources:[{state:'ready',source_id:'pa',display_name:'第二个 PA',items:[item]}]}:{state:'ready',items:[item]};
  let reads=0;
  vm.runInNewContext('('+dashboardClient.toString()+')()', {document,window:win,selectedWorkbench,Date,crypto,localStorage:{getItem(){}},AbortController,setTimeout,clearTimeout,
    fetch:async url=>{assert.equal(url,'/dashboard/data');reads++;return {ok:true,status:200,json:async()=>data};}});
  await win.listeners.pageshow();
  const at=k=>document.getElementById(k);const [where,label]=route==='secondary'?['canvas','工作详情与日志']:route==='activity'?['activity-list','查看日志']:['items','打开详情'];
  const flat=x=>[x,...(x.children||[]).flatMap(flat)];
  const open=flat(at(where)).find(e=>e.textContent===label);assert.ok(open);open.listeners.click();
  const rows=at('detail-content').children.map(e=>e.textContent);
  assert.equal(at('detail-dialog').open,true);assert.equal(reads,1);
  assert.ok(rows.some(s=>s.includes('不代表 QQ 投递或接收人已读')));
  win.listeners.pagehide();
  return rows.find(s=>s.includes('Discord 投递 · ')).split('Discord 投递 · ')[1].split(' · 来源发生时间')[0];
}
async function started(t){const f=fixture(t);await f.core.initialize();await f.core.ingest(f.source,f.event);return f;}
async function collect(t){
  const f=await started(t);const {db,core,state,activity}=f;
  const trace=[];async function snap(){const a=activity();trace.push({row:f.peek().status,workbench:a.items[0].delivery[0],label:await pageText(a),attempts:state.attempts});}
  await snap();await f.advance();await snap();const retryNow=state.now;
  assert.equal(f.peek().next_at,retryNow+3000);state.now+=1;await core.alarm();assert.equal(state.attempts,1);
  await f.advance();await snap();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM outbox').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n,1);
  return {f,trace};
}
test('one real offline event: queued → synthetic 429 wait → provider accepted; display follows the same job and never calls a sender itself',async t=>{
  const {trace}=await collect(t);t.diagnostic('OBSERVATION '+JSON.stringify(trace));
  assert.deepEqual(trace.map(x=>x.row),['queued','retry_wait','sent']);assert.deepEqual(trace.map(x=>x.attempts),[0,1,2]);
  assert.deepEqual(trace.map(x=>x.workbench),['queued','retry_wait','sent']);assert.deepEqual(trace.map(x=>x.label),['排队中（尚未发送）','等待重试（尚未确认送达）','服务端已发送（未确认阅读）']);
});
for(const route of ['primary','secondary','activity'])test(route+': known queue states are distinct and do not promise human receipt',async t=>{
  const f=await started(t);
  for(const [raw,expected] of [['queued','排队中（尚未发送）'],['retry_wait','等待重试（尚未确认送达）'],['sent','服务端已发送（未确认阅读）']]){
    f.db.prepare('UPDATE outbox SET status=?').run(raw);assert.equal(await pageText(f.activity(),route),expected);
  }
});
for(const [raw,projected,word] of [['sending','uncertain','结果未知'],['uncertain','uncertain','结果未知'],['future_state','unknown','未知'],['pending','pending','排队中'],['blocked','blocked','已阻止'],['dead_letter','dead_letter','发送终止'],['suppressed','suppressed','已抑制'],['coalesced','coalesced','已合并（非单条送达）']])test(raw+': retains the existing conservative outcome',async t=>{
  const f=await started(t);f.db.prepare('UPDATE outbox SET status=?').run(raw);
  const a=f.activity();assert.deepEqual(a.items[0].delivery,[projected]);assert.equal(await pageText(a),word);
});
test('no matching job means no recorded delivery; rows for another receipt remain out of sight',async t=>{
  const f=await started(t);f.db.prepare('UPDATE outbox SET receipt=?').run('rcpt_'+'b'.repeat(32));
  const a=f.activity();assert.deepEqual(a.items[0].delivery,['not_recorded']);assert.equal(await pageText(a),'无对应投递记录');
});
test('several jobs for the same update keep each distinct, honest outcome in newest-first order, without raw identifiers',async t=>{
  const f=await started(t),insert=f.db.prepare('INSERT INTO outbox(receipt,view_key,intent,payload,revision,status,next_at) SELECT receipt,?,intent,payload,revision,?,next_at FROM outbox WHERE id=1');
  ['future_value','sent','queued','retry_wait','retry_wait','sending'].forEach((s,i)=>insert.run('local-view-'+i,s));
  const a=f.activity();assert.deepEqual(a.items[0].delivery,['uncertain','retry_wait','queued','sent','unknown']);
  assert.equal(await pageText(a),'结果未知 / 等待重试（尚未确认送达） / 排队中（尚未发送） / 服务端已发送（未确认阅读） / 未知');
  assert.doesNotMatch(JSON.stringify(a),/rcpt_|local-view-/);
});
