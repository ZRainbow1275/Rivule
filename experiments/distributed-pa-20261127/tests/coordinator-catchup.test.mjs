import test from 'node:test';
import A from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeSqlJournal} from '../storage/sql-journal.mjs';
import {makeCoordinatorCatchup,receiveCoordinatorFrame} from '../storage/coordinator-catchup.mjs';
const board='authority',key=Buffer.alloc(32,54),artifact='a'.repeat(64);
const auth={scope:board,subject:'primary',role:'coordinator'};
const owner=(subject='primary',view='tab-one',over={})=>({role:'coordinator',board,subject,view,policyEpoch:'grant1',
 active:true,fullBoard:true,rights:new Set(['coordinator:board:replay']),...over});
function fixture(t,limit=4){
 const dir=mkdtempSync(join(tmpdir(),'rv-coord-catchup-')),file=join(dir,'db.sqlite'),dbs=[];
 let abort=false;
 t.after(()=>{dbs.forEach(db=>db.close());rmSync(dir,{recursive:true,force:true});});
 const open=()=>{
  const db=new DatabaseSync(file);dbs.push(db);db.exec('PRAGMA busy_timeout=5000');
  const sql={exec:(q,...a)=>q.startsWith('SELECT')?db.prepare(q).all(...a):(a.length?db.prepare(q).run(...a):db.exec(q),[])};
  const transactionSync=f=>{db.exec('BEGIN IMMEDIATE');try{const x=f();if(abort)throw Error('rollback');db.exec('COMMIT');return x}catch(e){db.exec('ROLLBACK');throw e}};
  const opts={sql,transactionSync,resolve:x=>x,validatorKey:key,limit};
  const stream=makeCoordinatorCatchup({...opts,enabled:true}),journal=makeSqlJournal(opts);
  return {db,stream,journal,opts};
 };
 const h=open();
 function append(command,a=auth,profile){
  return h.journal.append({auth:a,expectedVersion:h.journal.projectAll(board).asOfVersion,at:100,command,profile});
 }
 function add(task){
  return append({type:'add',task,id:'event-'+task,capability:'research',allowedRegions:['us'],inputDigest:artifact,requires:[]});
 }
 return {...h,open,add,append,abort:v=>{abort=v}};
}
const apply=(i,a,r)=>receiveCoordinatorFrame(i,a.channel,r);
test('R01 two fully authorized coordinator views catch up independently after snapshot/listen gap and cold restart',t=>{
 const h=fixture(t),a=owner(),b=owner('colleague','tab-two');
 h.add('initial');
 const bootA=h.stream.bootstrap(a);let va=apply(null,bootA,bootA);
 h.add('between');
 const bootB=h.stream.bootstrap(b);let vb=apply(null,bootB,bootB);
 A.notEqual(bootA.channel,bootB.channel);
 A.throws(()=>h.stream.poll(b,bootA.cursor),{code:'invalid_cursor'});
 h.add('later');
 const cold=h.open();
 const fa=cold.stream.poll(a,va.cursor),fb=cold.stream.poll(b,vb.cursor);
 A.equal(fa.mode,'advanced');A.equal(fb.mode,'advanced');
 va=apply(va,bootA,fa);vb=apply(vb,bootB,fb);
 A.deepEqual(va.snapshot,vb.snapshot);A.equal(vb.snapshot.cards.length,3);
 A.deepEqual(cold.stream.poll(b,vb.cursor),{channel:bootB.channel,mode:'unchanged',cursor:vb.cursor});
 A.deepEqual(Object.keys(fa).sort(),['channel','cursor','mode','snapshot']);
});
test('R02 duplicate and out-of-order replies do not redraw or roll back a newer authorized view',t=>{
 const h=fixture(t),a=owner(),first=h.stream.bootstrap(a);
 A.equal(apply(null,first,first).snapshot.asOfVersion,0);
 h.add('old');const old=h.stream.poll(a,first.cursor);
 h.add('new');const fresh=h.stream.poll(a,first.cursor);
 let ui=apply(apply(null,first,first),first,fresh);
 A.equal(ui.snapshot.asOfVersion,2);A.equal(apply(ui,first,old),ui);A.equal(apply(ui,first,fresh),ui);
 A.equal(apply(null,first,fresh),null);
 A.equal(apply(ui,first,{...fresh,cursor:{...fresh.cursor,version:3}}),ui);
});
test('R03 bounded backlog coalesces and retained-history gap restores from canonical journal',t=>{
 const h=fixture(t,2),a=owner(),start=h.stream.bootstrap(a);
 for(const n of ['a1','a2','a3','a4'])h.add(n);
 const fast=h.stream.poll(a,start.cursor);A.equal(fast.mode,'coalesced');A.equal(fast.snapshot.asOfVersion,4);
 h.db.prepare('DELETE FROM lab_coord_outbox WHERE board=? AND v=?').run(board,1);
 const reset=h.open().stream.poll(a,start.cursor);
 A.equal(reset.mode,'reset');A.deepEqual(reset.snapshot,fast.snapshot);
 A.equal(reset.cursor.version,4);
 const again=h.stream.poll(a,reset.cursor);A.equal(again.mode,'unchanged');
 A.equal(h.db.prepare('SELECT COUNT(*) n FROM lab_coord_event').get().n,4);
 A.equal(h.db.prepare('SELECT COUNT(*) n FROM lab_coord_outbox').get().n,3);
});
test('R04 current explicit full-board grant, not just role or old token, required before reconnect',t=>{
 const h=fixture(t),a=owner(),boot=h.stream.bootstrap(a);
 for(const bad of [{active:false},{role:'worker'},{fullBoard:false},{rights:new Set(['pa:board:read_global'])}]){
  A.throws(()=>h.stream.bootstrap({...a,...bad}),{code:'not_authorized'});
  A.throws(()=>h.stream.poll({...a,...bad},boot.cursor),{code:'not_authorized'});
 }
 for(const changes of [{board:'another'},{policyEpoch:'grant2'},{view:'another'}]){
  A.throws(()=>h.stream.poll({...a,...changes},boot.cursor),{code:'invalid_cursor'});
  const current=h.stream.bootstrap({...a,...changes});
  A.notEqual(current.channel,boot.channel);A.equal(apply(null,current,boot),null);
 }
 A.throws(()=>h.stream.poll(a,{...boot.cursor,version:1}),{code:'invalid_cursor'});
 A.throws(()=>makeCoordinatorCatchup(h.opts),{code:'catchup_disabled'});
});
test('R05 replaying a begin invalidation cannot create another permit or write, and rollback stays invisible',t=>{
 const h=fixture(t),a=owner();h.add('job');
 const profile={worker:'helper',provider:'fixture',lane:'local',capabilities:['research'],dataRegions:['us'],authorized:true,ready:true};
 const worker={scope:board,role:'worker',subject:'helper'};
 h.append({type:'claim',id:'claim',task:'job',worker:'helper',leaseMs:1000},worker,profile);
 const start=h.stream.bootstrap(a);
 h.abort(true);A.throws(()=>h.add('aborted'),/rollback/);h.abort(false);
 A.equal(h.stream.poll(a,start.cursor).mode,'unchanged');
 const one=h.append({type:'begin',id:'begin',task:'job',fence:1},worker,profile);A(one.permit);
 const next=h.stream.poll(a,start.cursor),dup=h.open().stream.poll(a,start.cursor);
 A.deepEqual(next,dup);
 A.equal(next.snapshot.cards[0].state,'submitting');
 A(!JSON.stringify(next).includes('permit'));
 const terminal=h.journal.projectAll(board);
 A.equal(terminal.asOfVersion,3);
 A.equal(h.db.prepare('SELECT COUNT(*) n FROM lab_coord_outbox').get().n,3);
});
