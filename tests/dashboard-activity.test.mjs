import test from 'node:test';
import assert from 'node:assert/strict';
import {readDashboardActivity,dashboardText,dashboardProgress} from '../src/owner/dashboard-activity.mjs';
const query={project_id:'project',task_id:'task',run_id:'run',branch_id:'main'};
function fixture(){
 const source={source_id:'muse-main',enabled:true};const bindings={sources:[source],allowedProjectIds:['project'],ownerId:'owner',appId:'app',userId:'user',dmId:'dm'};
 const payload={...query,source_id:source.source_id,event_id:'event',sensitivity:'normal',kind:'progress',source_status:'running',summary:'Built the dashboard',occurred_at:'2026-10-23T10:00:00Z',progress:{done:2,total:5,unit:'checks'}};
 const row={source_id:source.source_id,event_id:'event',revision:1,branch_key:JSON.stringify([source.source_id,query.task_id,query.run_id,query.branch_id]),payload:JSON.stringify(payload),receipt:'rcpt_'+'a'.repeat(32),received_at:Date.parse(payload.occurred_at),decision:'applied'};
 const calls=[];let identity=JSON.stringify(['owner','app','user','dm']),events=[row],delivery=[{status:'sent'}];
 const storage={sql:{exec(sql,...args){calls.push([sql,args]);assert.match(sql,/^SELECT /);return {toArray:()=>sql.includes('sqlite_master')?['meta','events','outbox'].map(name=>({name})):sql.includes('FROM meta')?[{value:identity}]:sql.includes('FROM events')?events:delivery};}}};
 return {row,payload,bindings,source,calls,read:()=>readDashboardActivity(storage,bindings,source,query),change(fn){fn(payload);row.payload=JSON.stringify(payload);},identity(v){identity=v;},events(v){events=v;},delivery(v){delivery=v;}};
}
test('reads exact owner/source/branch bounded history and only receipt status fields',()=>{
 const f=fixture(),r=f.read();assert.equal(r.items[0].summary,'Built the dashboard');assert.deepEqual(r.items[0].progress,{done:2,total:5,unit:'checks'});
 assert.match(f.calls[2][0],/WHERE source_id=\? AND branch_key=\? ORDER BY revision DESC LIMIT 31/);assert.equal(f.calls[2][1][0],'muse-main');
 assert.deepEqual(f.calls[3],['SELECT status FROM outbox WHERE receipt=? ORDER BY id DESC LIMIT 10',[f.row.receipt]]);
 assert.ok(!JSON.stringify(r).includes('rcpt_'));assert.ok(!JSON.stringify(r).includes('event_id'));
});
test('foreign identity, source, project, branch, receipt, malformed rows fail closed',()=>{
 for(const mutate of [f=>f.identity('other'),f=>{f.source.enabled=false;},f=>f.change(p=>p.source_id='zot-main'),f=>f.change(p=>p.project_id='foreign'),f=>f.change(p=>p.run_id='other'),f=>{f.row.receipt='private-recipient';},f=>{f.row.payload='invalid';}]){const f=fixture();mutate(f);assert.throws(()=>f.read());}
});
test('restricted events have an explicit withheld count and never query delivery',()=>{
 const f=fixture();f.change(p=>{p.sensitivity='restricted';p.summary='private detail';});const result=f.read();assert.equal(result.withheld_count,1);assert.deepEqual(result.items,[]);assert.equal(f.calls.length,3);assert.ok(!JSON.stringify(result).includes('private detail'));
});
test('history truncation, projection decision and delivery states are honest',()=>{
 const f=fixture();f.events(Array.from({length:31},(_,i)=>({...f.row,revision:31-i})));f.row.decision='stale_ignored';f.delivery([{status:'sending'},{status:'coalesced'},{status:'suppressed'}]);const r=f.read();assert.equal(r.truncated,true);assert.equal(r.items.length,30);assert.deepEqual(r.items[0].delivery,['uncertain','coalesced','suppressed']);
});
test('redacts quoted credentials, whitespace secrets, bearer, PEM, URLs and private IDs',()=>{
 for(const value of ['{"token":"supersecretvalue"}','password="alpha beta"','Authorization: Basic dXNlcjpwYXNz','-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----','Bearer supersecretvalue','https://example.test/?token=supersecretvalue','recipient_id=123456789012345678'])assert.ok(!/supersecretvalue|alpha|beta|dXNlcjpwYXNz|PRIVATE KEY|123456789012345678/.test(dashboardText(value)));
 assert.equal(dashboardText('Normal <script> content'),'Normal <script> content');
});
test('progress preserves real counts, unknown total, rejects manufactured invalid percentages',()=>{
 assert.deepEqual(dashboardProgress({done:4,total:null,unit:'tests'}),{done:4,total:null,unit:'tests'});
 for(const p of [null,{done:2,total:1,unit:'x'},{done:-1,total:null,unit:'x'},{done:1,total:0,unit:'x'},{done:1,total:null,unit:''}])assert.equal(dashboardProgress(p),null);
});

test('actual queued and retry-wait outbox states stay distinct from unknown outcomes',()=>{
 const f=fixture();f.delivery([{status:'queued'},{status:'retry_wait'},{status:'queued'},{status:'sending'},{status:'unexpected'}]);
 const r=f.read();assert.deepEqual(r.items[0].delivery,['queued','retry_wait','uncertain','unknown']);
 assert.deepEqual(f.calls[3],['SELECT status FROM outbox WHERE receipt=? ORDER BY id DESC LIMIT 10',[f.row.receipt]]);
 assert.equal(r.delivery_scope,'discord_outbox_not_recipient_confirmation');
});
