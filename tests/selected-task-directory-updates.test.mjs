import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedTaskDirectory} from '../src/owner/selected-task-directory.mjs';
const at=h=>'2026-11-18T'+String(h).padStart(2,'0')+':00:00.000Z';
const row=(id,o={})=>({source_id:'pa',task_id:id,task_name:id,state:'available',source_status:'running',summary:'Current '+id,...o});
const read=(items,search='',order='recent')=>selectedTaskDirectory([{source_id:'pa',display_name:'Muse',state:'connected',items}],search,'all',order).rows;
const run=(summary,h,o={})=>({kind:'progress',summary,received_at:at(h),projection_applied:true,...o});
const event=(...items)=>({state:'available',items}),reply=(text,h,o={})=>({source_id:'pa',text,accepted_at:at(h),...o});
test('landing order uses the newest received substantive fact across tasks and PAs, not heartbeat, read time or client clock',()=>{
 const a=row('first',{activity:event(run('landed',4),run('heartbeat',19,{kind:'heartbeat'}),run('superseded',20,{projection_applied:false})),observed_at:at(23),last_confirmed_at:at(22)});
 const b=row('second',{replies:event(reply('new deliverable',5,{occurred_at:at(1)}))});
 const c=row('no record',{observed_at:at(23),last_confirmed_at:at(23)});const r=read([a,c,b]);
 assert.deepEqual(r.map(x=>x.item.task_id),['second','first','no record']);assert.equal(r[0].update.type,'reply');assert.equal(r[0].update.at,at(5));assert.equal(r[1].update.text,'landed');assert.equal(r[2].update.type,'snapshot');assert.equal(r[2].update.at,null);
 assert.deepEqual(read([a,c,b],'','source').map(x=>x.item.task_id),['first','no record','second']);
});
test('a reply never changes the displayed task state and equal timestamps retain stable order',()=>{
 const a=row('active',{activity:event(run('Task started',6,{kind:'started'})),replies:event(reply('I think we are done',7))}),b=row('peer',{activity:event(run('progress peer',7))});const before=JSON.stringify([a,b]);const rows=read([a,b]);assert.equal(rows[0].update.type,'reply');assert.equal(rows[0].item.source_status,'running');assert.deepEqual(rows.map(x=>x.item.task_id),['active','peer']);assert.equal(JSON.stringify([a,b]),before);
});
test('search matches a visible latest excerpt but not hidden, unknown, displaced or unavailable records',()=>{
 const a=row('one',{activity:event(run('Ｍａｐ rebuilt',5),run('superseded text',3)),replies:{state:'not_connected',items:[reply('Invisible',9)]}});
 const hide=row('h',{state:'withheld',activity:event(run('Invisible',7))});const malformed=row('bad',{activity:event(run('bad clock',9,{received_at:'bad'}))});
 assert.equal(read([a,hide,malformed],'muse MAP').length,1);for(const q of ['Invisible','superseded','bad clock'])assert.equal(read([a,hide,malformed],q).length,0);
});
test('empty or unavailable logs remain a labeled snapshot, without invented activity timestamps',()=>{
 const a=row('fallback',{activity:{state:'unavailable',items:[run('Never surfaced',9)]},replies:event(reply('wrong source',11,{source_id:'other'}),reply('bad date',9,{accepted_at:'invalid'}))});const e=read([a])[0].update;assert.equal(e.type,'snapshot');assert.equal(e.at,null);assert.equal(e.text,'Current fallback');
});
