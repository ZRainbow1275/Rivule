import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/owner/selected-decision-brief.mjs';
const q=(question,expires_at=null,expiry_elapsed=false)=>({question,impact:'改变本次排期',expires_at,expiry_elapsed});
const task=(qs,extra={})=>({state:'available',source_status:'needs_input',stale:false,archived:false,observed_at:'2026-11-18T10:00:00Z',pending_action_count:qs.length,pending_questions:{state:'available',items:qs,withheld_count:0,truncated:false},...extra});
test('earliest outstanding deadline as at the read wins; equivalent offsets compare as instants and other questions keep source order',()=>{
 const rows=[q('No date'),q('Elapsed','2026-11-18T09:00:00Z',true),q('Later','2026-11-18T12:00:00Z'),q('First','2026-11-18T18:30:00+08:00'),q('Equal','2026-11-18T10:30:00Z')],item=task(rows),before=JSON.stringify(item),b=api.selectedDecisionBrief(item);
 assert.deepEqual(b.questions.map(x=>x.question),['First','Equal','Later','No date','Elapsed']);assert.equal(b.nextMs,Date.parse('2026-11-18T10:30:00Z'));assert.equal(b.partial,false);assert.equal(JSON.stringify(item),before);
});
test('only current readable waiting tasks produce question previews',()=>{
 for(const delta of [{state:'withheld'},{state:'unavailable'},{stale:true},{archived:true},{stale:undefined},{archived:undefined},{source_status:'running',pending_action_count:0}])assert.equal(api.selectedDecisionBrief(task([q('RAW')],delta)),null);
 assert.equal(api.selectedDecisionBrief(task([q('valid')],{source_status:'running'})).questions[0].question,'valid');
});
test('status-only, missing details and withheld/truncated items preserve uncertainty without inventing a question',()=>{
 const status=api.selectedDecisionBrief(task([]));assert.equal(status.state,'status_only');assert.equal(status.questions.length,0);
 const legacy=api.selectedDecisionBrief(task([],{pending_action_count:2,pending_questions:undefined}));assert.equal(legacy.state,'unavailable');
 const items=[q('Shown')],p=api.selectedDecisionBrief(task(items,{pending_action_count:5,pending_questions:{state:'available',items,withheld_count:1,truncated:true}}));assert.equal(p.partial,true);assert.equal(p.questions.length,1);assert.equal(p.total,5);
});
test('the preview consumes the bounded read projection only; no raw action fields, IDs or unexpected dates enter',()=>{
 const allowed=q('OK'),raw={...q('RAW-ITEM'),sensitivity:'normal',request_id:'RAW-ID'},bad={...q('BAD-STAMP'),expires_at:'today'},item=task([raw,allowed,bad],{pending_actions:{items:[q('RAW-STORE')]}});
 const b=api.selectedDecisionBrief(item);assert.deepEqual(b.questions.map(x=>x.question),['OK']);assert.equal(b.partial,true);assert.doesNotMatch(JSON.stringify(b),/RAW|BAD-STAMP/);
 const tooMany=api.selectedDecisionBrief(task(Array.from({length:21},(_,i)=>q('unknown'+i))));assert.equal(tooMany.questions.length,0);assert.equal(tooMany.state,'unavailable');
});
