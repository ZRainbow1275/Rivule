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

test('R06 offline board shows two coordinator views converging without repeating dispatch',t=>{
 const h=fixture(t,2),a=owner(),b=owner('peer','second-window'),frames=[];
 const job='public-source',peer='editor-note',merge='merge';
 const worker={scope:board,role:'worker',subject:'helper'};
 const profile={worker:'helper',provider:'fixture',lane:'lab.public',capabilities:['research'],dataRegions:['us'],authorized:true,ready:true};
 const submit=(type,extra={})=>h.append({type,task:job,id:'job-'+type,fence:1,...extra},worker,profile);
 const stage=(task,requires)=>h.append({type:'add',task,id:'new-'+task,capability:'research',allowedRegions:['us'],inputDigest:artifact,requires});
 stage(job,[]);stage(peer,[]);stage(merge,[job]);
 h.append({type:'claim',id:'job-claim',task:job,worker:'helper',leaseMs:1000},worker,profile);
 const a0=h.stream.bootstrap(a),b0=h.open().stream.bootstrap(b);
 let va=apply(null,a0,a0),vb=apply(null,b0,b0),permits=0;
 const frame=(label,viewA,viewB)=>{
   const snap=va.snapshot;
   // Fixture render output only: no cursors, channels or permit material.
   frames.push({schema:snap.schema,scope:snap.scope,asOfVersion:snap.asOfVersion,
     cards:snap.cards.map(c=>({task:c.task,state:c.state,worker:c.worker,taskVersion:c.taskVersion,
      dependencies:c.dependencies.map(d=>({task:d.task,state:d.state}))})),
     label,sync:{a:{version:snap.asOfVersion,state:viewA},b:{version:vb.snapshot.asOfVersion,state:viewB},permits}});
 };
 frame('两个调度窗口都已看到任务被领走。','已同步','已同步');
 const begun=submit('begin');A(begun.permit);permits++;
 const old=h.stream.poll(a,va.cursor);
 const sb=h.stream.poll(b,vb.cursor);vb=apply(vb,b0,sb);
 A.equal(vb.snapshot.asOfVersion,5);A.equal(va.snapshot.asOfVersion,4);
 frame('窗口 A 断线，仍显示已领取。窗口 B 已看到首次派送。','已断线','已同步');
 submit('acknowledged',{receipt:'original-run'});
 submit('reported',{receipt:'original-run',artifact});
 h.append({type:'accept',id:'job-accept',task:job,fence:1,artifact});
 const accepted=h.stream.poll(b,vb.cursor);A.equal(accepted.mode,'coalesced');
 vb=apply(vb,b0,accepted);A.equal(vb.snapshot.cards.find(c=>c.task===merge).state,'ready');
 frame('窗口 B 已验收原任务，合稿解锁。离线的窗口 A 还停在旧进度。','等待重连','已验收');
 h.db.prepare('DELETE FROM lab_coord_outbox WHERE board=? AND v=?').run(board,5);
 const cold=h.open();
 const reset=cold.stream.poll(a,va.cursor);A.equal(reset.mode,'reset');va=apply(va,a0,reset);
 A.deepEqual(va.snapshot,vb.snapshot);
 frame('A 重连时发现通知有缺口，于是读取最新整板。合稿已在两个窗口解锁。','已恢复','已同步');
 A.equal(apply(va,a0,old),va);A.equal(apply(va,a0,reset),va);
 frame('旧派送响应和重复更新迟到。两个窗口继续显示已验收的版本。','忽略迟到响应','已同步');
 const e=h.db.prepare('SELECT COUNT(*) n FROM lab_coord_event').get().n;
 A.equal(cold.stream.poll(a,va.cursor).mode,'unchanged');
 A.equal(e,8);A.equal(permits,1);
 A(!/cursor|channel|original-run|inputDigest|sv1-|providerRequestId/.test(JSON.stringify(frames)));
 if(process.env.RIVULE_COORDINATOR_REPLAY==='1')console.log('RIVULE_COORDINATOR_REPLAY:'+JSON.stringify(frames));
});
