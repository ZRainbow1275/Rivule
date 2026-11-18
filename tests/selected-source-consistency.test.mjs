import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedTaskDirectory} from '../src/owner/selected-task-directory.mjs';
import {selectedCommandFollowup} from '../src/owner/selected-command-followup.mjs';
const stamp='2026-11-18T10:10:00Z';
const task=s=>({source_id:s,state:'available',source_status:'running',stale:false,archived:false,task_name:'Launch',project_name:'Harbor',branch_name:'Main',commands:{state:'available',items:[{created_at:stamp,source_report:null,state:'pending',channel:'discord'}]}});
const input=['muse-east','muse-west'].map(id=>({source_id:id,display_name:'Studio',state:'connected',items:[task(id)]}));
for(const [title,query] of [['tasks',selectedTaskDirectory],['commands',selectedCommandFollowup]])test(title+': same-name PAs can be found by stable source ID plus project, without visibility or input changes',()=>{
 const before=JSON.stringify(input);assert.deepEqual(query(input,'studio harbor').rows.map(r=>r.source_id),['muse-east','muse-west']);
 assert.deepEqual(query(input,'ＭＵＳＥ－ＷＥＳＴ harbor').rows.map(r=>r.source_id),['muse-west']);
 assert.equal(query(input,'muse-west missing').rows.length,0);assert.equal(JSON.stringify(input),before);
});
