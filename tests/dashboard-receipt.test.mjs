import test from 'node:test';
import assert from 'node:assert/strict';
import {readDashboardTestReceipt,validateDashboardTestReceipt} from '../src/owner/dashboard-receipt.mjs';
const selector={receipt_id:'rcpt_'+'a'.repeat(32),event_id:'test-event',run_id:'test-run',revision:12};
function fixture(){
 const source={source_id:'zot-main',enabled:true},bindings={sources:[source],allowedProjectIds:['project'],ownerId:'owner',appId:'app',userId:'user',dmId:'dm'};
 const payload={source_id:'zot-main',event_id:'test-event',project_id:'project',task_id:'test-task',run_id:'test-run',branch_id:'test-branch',summary:'not returned'};
 const row={source_id:'zot-main',event_id:'test-event',revision:12,branch_key:JSON.stringify(['zot-main','test-task','test-run','test-branch']),payload:JSON.stringify(payload)};
 const calls=[];let present=true,identity=JSON.stringify(['owner','app','user','dm']);
 const storage={sql:{exec(sql,...args){calls.push([sql,args]);assert.match(sql,/^SELECT /);return {toArray:()=>sql.includes('sqlite_master')?[{name:'meta'},{name:'events'}]:sql.includes('FROM meta')?[{value:identity}]:present?[row]:[]};}}};
 return {source,bindings,payload,row,calls,read:()=>readDashboardTestReceipt(storage,bindings,source,selector),change(fn){fn(payload);row.payload=JSON.stringify(payload);},missing(){present=false;},wrongIdentity(){identity='other';}};
}
test('private resolver reads one exact source-owned receipt and returns only branch identifiers',()=>{
 const f=fixture();assert.deepEqual(f.read(),{project_id:'project',task_id:'test-task',run_id:'test-run',branch_id:'test-branch'});
 assert.deepEqual(f.calls.at(-1),['SELECT source_id,event_id,revision,branch_key,payload FROM events WHERE receipt=? AND source_id=? LIMIT 1',[selector.receipt_id,'zot-main']]);assert.equal(f.calls.length,3);
});
test('receipt selector rejects invalid shape before SQL',()=>{
 for(const s of [{...selector,extra:1},{...selector,revision:0},{...selector,revision:1.2},{...selector,receipt_id:'bad'},{...selector,event_id:''},{...selector,run_id:'../x'},[]])assert.throws(()=>validateDashboardTestReceipt(s));
 assert.equal(validateDashboardTestReceipt(null),null);
});
test('missing receipt and every source/project/event/run/revision/branch mismatch fail closed',()=>{
 const edits=[f=>f.missing(),f=>f.wrongIdentity(),f=>{f.source.enabled=false;},f=>{f.row.source_id='other';},f=>{f.row.event_id='other';},f=>{f.row.revision=13;},f=>{f.row.branch_key='[]';},f=>{f.row.payload='bad';},f=>f.change(p=>p.source_id='other'),f=>f.change(p=>p.project_id='other'),f=>f.change(p=>p.event_id='other'),f=>f.change(p=>p.run_id='other'),f=>f.change(p=>p.branch_id='other'),f=>f.change(p=>p.task_id='other'),f=>f.change(p=>p.branch_id='../x')];
 for(const edit of edits){const f=fixture();edit(f);assert.throws(()=>f.read());}
});
