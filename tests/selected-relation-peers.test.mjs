import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedRelationPeers} from '../src/owner/selected-relation-peers.mjs';
import {selectedTaskDirectory} from '../src/owner/selected-task-directory.mjs';
import {selectedCommandFollowup} from '../src/owner/selected-command-followup.mjs';
const key = {source_id:'a',project_id:'print',task_id:'leaf',run_id:'one',branch_id:'main'};
const normal = {...key,task_id:'parent',state:'available',task_name:'Parent',commands:{state:'available',items:[{state:'pending',channel:'dashboard',created_at:'2026-11-17T10:00:00Z'}]}};
const restricted = {...key,state:'withheld',task_name:'Private fixture title',commands:normal.commands};
test('unreadable selections contribute only their exact identity and read outcome',()=>{
  for(const state of ['withheld','not_found','unavailable']) {
    const row={...restricted,state},source={source_id:'a',items:[row,normal]},before=JSON.stringify(source);
    const peers=selectedRelationPeers(source);assert.deepEqual(peers,[{...key,state},normal]);assert.equal(peers[1],normal);assert.equal(JSON.stringify(source),before);
  }
});
test('missing, malformed, unrecognized, and other-source records cannot identify a selected child',()=>{
  const peers=selectedRelationPeers({source_id:'a',items:[null,{...restricted,task_id:''},{...restricted,run_id:'invalid key'},
    {...restricted,state:'unexpected'},{...restricted,source_id:undefined},{...restricted,source_id:'b'},{...normal,source_id:'b'}]});
  assert.deepEqual(peers,[]);assert.deepEqual(selectedRelationPeers(null),[]);
});
for(const [label,project] of [['directory',selectedTaskDirectory],['command follow-up',selectedCommandFollowup]])test(label+': status-only peers do not become results, search hits, or command counts',()=>{
  const sources=[{source_id:'a',state:'connected',items:[restricted,normal]}];const model=project(sources);
  assert.deepEqual(model.rows.map(r=>r.item.task_id),['parent']);assert.deepEqual(model.rows[0].peers,[{...key,state:'withheld'},normal]);
  assert.equal(model.partial,true);assert.equal(project(sources,'Private fixture title').rows.length,0);assert.equal(model.records??model.readable,1);
});
