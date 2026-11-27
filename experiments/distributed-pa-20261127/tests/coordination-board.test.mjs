import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createJournal,decide,projectBoard,attemptKey} from '../src/sdk/coordination-board.mjs';

const owner={scope:'desk',subject:'main',role:'coordinator'};
const worker=n=>({scope:'desk',subject:n,role:'worker'});
const primary=worker('worker-a'),secondary=worker('worker-b'),scope='desk';
const H='a'.repeat(64),H2='b'.repeat(64);
const profile=(over={})=>({worker:'worker-a',provider:'provider-a',lane:'account-lane-a',dataRegions:['cn-mainland'],capabilities:['read'],authorized:true,ready:true,...over});
const input=(id,opts={})=>({type:'add',id:'create.'+id,task:id,capability:'read',allowedRegions:['cn-mainland'],inputDigest:H,requires:[],...opts});
const claim=(task='t',id='lease-'+task,worker='worker-a')=>({type:'claim',id,task,worker,leaseMs:20});
const ev=(type,id=type,props={})=>({type,id,task:'t',fence:1,...props});
function ledger(){
 let j=createJournal(scope),t=1;
 return {get j(){return j;}, set j(x){j=x;}, get at(){return t;},set at(x){t=x;},
  append(auth,command,ctx={}){const x=decide(j,{expectedVersion:j.events.length,at:t++,profile:profile(),...ctx,auth,command});if(x.event)j={...j,events:[...j.events,x.event]};return x;},
  replay(){return projectBoard(JSON.parse(JSON.stringify(j)),{scope,selected:['t','b','z'],readable:['t','b','z']});}
 };
}
function rejects(fn,code){assert.throws(fn,e=>e.code===code,code);}
function stage(j,target='submitting'){
 j.append(owner,input('t'));j.append(primary,claim());
 if(target==='leased')return;
 j.append(primary,ev('begin'));if(target==='submitting')return;
 j.append(primary,ev('acknowledged','ack',{receipt:'up-job'}));if(target==='running')return;
 j.append(primary,ev('reported','result',{receipt:'up-job',artifact:H}));
}
function attest(extra={}){return {verified:true,scope,task:'t',fence:1,worker:'worker-a',provider:'provider-a',lane:'account-lane-a',key:'desk/t/1',digest:H2,...extra};}

test('causal plan accepts evidence before releasing dependent work; restart and scope filter retain exact projection',()=>{
 const l=ledger();l.append(owner,input('t'));l.append(owner,input('b',{requires:['t']}));l.append(owner,input('z'));
 assert.equal(l.replay().cards[0].state,'blocked');
 rejects(()=>l.append(primary,claim('b')),'dependencies_open');
 l.append(primary,claim());l.append(primary,ev('begin'));l.append(primary,ev('acknowledged','ack',{receipt:'r'}));
 l.append(primary,ev('reported','reported',{receipt:'r',artifact:H}));assert.equal(l.replay().cards[0].state,'blocked');
 rejects(()=>l.append(owner,ev('accept','accept-wrong',{artifact:H2})),'artifact_mismatch');
 l.append(owner,ev('accept','accept',{artifact:H}));const board=l.replay();
 assert.equal(board.cards[0].state,'ready');assert.deepEqual(board.cards[0].dependencies,[{task:'t',state:'accepted',version:8}]);
 assert.equal(board.asOfVersion,8);assert.equal(board.cards[0].taskVersion,2);
 const limited=projectBoard(l.j,{scope,selected:['t','b','z'],readable:['b']});
 assert.deepEqual(limited.cards.map(x=>[x.task,x.dependencies]),[['b',[]]]);
 rejects(()=>projectBoard(l.j,{scope:'other',selected:['b'],readable:['b']}),'scope_or_role');
 l.append(primary,claim('b'));
});
test('worker profile is host-controlled; unknown capabilities, CN data routed via a second nonapproved region, disabled/unverified connections fail closed',()=>{
 const l=ledger();l.append(owner,input('t'));
 for(const [patch,err] of [[{capabilities:['image']},'capability_mismatch'],[{dataRegions:['cn-mainland','sg']},'region_mismatch'],[{dataRegions:[]},'invalid_list'],[{dataRegions:['unknown']},'unknown_region'],[{ready:false},'worker_unavailable'],[{authorized:false},'worker_unavailable'],[{worker:'worker-b'},'worker_unavailable']])rejects(()=>l.append(primary,claim(),{profile:profile(patch)}),err);
 rejects(()=>l.append(primary,{...claim(),authorized:true}),'invalid_shape');l.append(primary,claim());
 rejects(()=>l.append(primary,ev('begin'),{profile:profile({lane:'another'})}),'route_changed');
 rejects(()=>l.append(primary,ev('begin'),{profile:profile({ready:false})}),'worker_unavailable');
 rejects(()=>l.append(primary,ev('begin'),{profile:profile({dataRegions:['sg']})}),'region_mismatch');
});
test('only the actor owning the fence may begin; replay of send intent after lost response yields no permit',()=>{
 const l=ledger();stage(l,'leased');
 rejects(()=>l.append(secondary,ev('begin')),'wrong_worker');
 const x=l.append(primary,ev('begin'));assert.equal(x.permit.key,'desk/t/1');
 const stable=structuredClone(l.j);
 const dupe=l.append(primary,ev('begin'),{expectedVersion:0,at:0});assert.deepEqual(dupe,{duplicate:true,version:3,event:null,permit:null});
 assert.deepEqual(l.j,stable);rejects(()=>l.append(primary,ev('begin','try-again')),'not_leased');
 rejects(()=>l.append(primary,ev('begin','begin',{fence:2})),'idempotency_conflict');
 rejects(()=>l.append(secondary,ev('begin','begin')),'idempotency_conflict');
});
test('pre-send lease expiration is safely reassignable; old generation stays fenced',()=>{
 const l=ledger();stage(l,'leased');l.at=22;
 rejects(()=>l.append(primary,ev('begin')),'lease_expired');
 l.append(owner,ev('expire'));l.append(secondary,claim('t','lease-b','worker-b'),{profile:profile({worker:'worker-b',lane:'lane-b'})});
 rejects(()=>l.append(primary,ev('begin','stale')),'stale_fence');
 const x=l.append(secondary,ev('begin','new',{fence:2}),{profile:profile({worker:'worker-b',lane:'lane-b'})});assert.equal(x.permit.key,'desk/t/2');
});
test('post-send loss and even a lease timeout quarantine the shared account lane; 404 or account change cannot release it',()=>{
 const l=ledger();stage(l);l.append(owner,input('b'));l.at=22;l.append(owner,ev('expire'));
 assert.equal(l.replay().cards.find(c=>c.task==='t').state,'needs_review');
 rejects(()=>l.append(primary,claim('b')),'lane_busy');
 const cmd=ev('reconcile','different',{attestation:H2});
 rejects(()=>l.append(owner,cmd,{attestation:attest({verdict:'closed_not_sent',submitterQuiesced:false,remoteRequestClosed:true})}),'not_proven_closed');
 rejects(()=>l.append(owner,cmd,{attestation:attest({verdict:'closed_not_sent',submitterQuiesced:true,remoteRequestClosed:true,provider:'other'})}),'invalid_attestation');
 rejects(()=>l.append(owner,cmd,{attestation:undefined}),'invalid_attestation');
 l.append(owner,cmd,{attestation:attest({verdict:'closed_not_sent',submitterQuiesced:true,remoteRequestClosed:true})});
 l.append(primary,claim('b'));const state=l.replay();assert.equal(state.cards[0].state,'leased');assert.equal(state.cards[1].state,'ready');
});
test('confirmed external run cannot be requeued after timeout; verified result requires matching receipt/epoch and an independent acceptance',()=>{
 const l=ledger();stage(l,'running');l.append(primary,ev('uncertain'));
 const cmd=ev('reconcile','resolve',{attestation:H2});
 rejects(()=>l.append(owner,cmd,{attestation:attest({verdict:'closed_not_sent',submitterQuiesced:true,remoteRequestClosed:true})}),'not_proven_closed');
 rejects(()=>l.append(owner,cmd,{attestation:attest({verdict:'result_verified',receipt:'wrong',artifact:H})}),'receipt_mismatch');
 l.append(owner,cmd,{attestation:attest({verdict:'result_verified',receipt:'up-job',artifact:H})});
 assert.equal(l.replay().cards[0].state,'reported');l.append(owner,ev('accept','ok',{artifact:H}));assert.equal(l.replay().cards[0].state,'accepted');
 rejects(()=>l.append(primary,ev('reported','stale',{receipt:'up-job',artifact:H})),'receipt_mismatch');
});
test('two authorized principals in separate account lanes can run independent jobs; shared underlying lane stays serialized',()=>{
 const l=ledger();l.append(owner,input('t'));l.append(owner,input('b'));l.append(primary,claim());
 rejects(()=>l.append(secondary,claim('b','lease-b','worker-b'),{profile:profile({worker:'worker-b'})}),'lane_busy');
 l.append(secondary,claim('b','lease-b','worker-b'),{profile:profile({worker:'worker-b',lane:'separate-tenant-seat'})});
 assert.deepEqual(l.replay().cards.map(x=>x.state),['leased','leased']);
});
test('fence renewals extend only before expiration; irreversible terminal state does not hold account lane',()=>{
 const l=ledger();stage(l,'leased');
 rejects(()=>l.append(primary,ev('renew','shrink',{leaseMs:1})),'invalid_integer');
 l.append(primary,ev('renew','extend',{leaseMs:50}));l.at=23;l.append(primary,ev('begin'));
 l.append(primary,ev('acknowledged','ack',{receipt:'r'}));l.append(primary,ev('reported','done',{receipt:'r',artifact:H}));
 l.append(owner,input('b'));l.append(primary,claim('b'));l.at=60;rejects(()=>l.append(primary,ev('begin','late')),'lease_expired');
});
test('strict input, replay-linked order, per-board scope and actor roles; no command text or token field',()=>{
 const l=ledger();
 for(const cmd of [input('t',{sensitiveText:'no'}),{...claim(),profile:{}},ev('begin','x',{secret:'no'})])rejects(()=>l.append(owner,cmd),'invalid_shape');
 rejects(()=>l.append(primary,input('t')),'wrong_role');rejects(()=>l.append({...owner,scope:'x'},input('t')),'scope_or_role');
 rejects(()=>l.append(owner,input('t',{requires:['t']})),'unknown_dependency');
 l.append(owner,input('t'));const x=l.append(owner,{...input('t'),requires:[]},{expectedVersion:0});assert.equal(x.duplicate,true);
 rejects(()=>l.append(owner,input('b'),{expectedVersion:0}),'revision_conflict');
 rejects(()=>l.append(owner,input('b'),{at:0}),'invalid_integer');
 const before=structuredClone(l.j);l.j.events[0].version=2;rejects(()=>l.replay(),'journal_gap');l.j=before;
 assert.doesNotThrow(()=>l.replay());
});
test('two workers can prepare the same provisional CAS, but only one SQLite insert wins; replays after commit never send',()=>{
 const l=ledger();stage(l,'leased');const rev=l.j.events.length;
 const make=id=>decide(l.j,{auth:primary,command:ev('begin',id),expectedVersion:rev,at:8,profile:profile()});
 const staleA=make('send-a'),staleB=make('send-b');
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE events(version INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  const insert=db.prepare('INSERT INTO events VALUES(?,?)');
  for(const e of l.j.events)insert.run(e.version,JSON.stringify(e));
  function commit(d){db.exec('BEGIN IMMEDIATE');try{const n=db.prepare('SELECT MAX(version) v FROM events').get().v;
      if(n!==d.permit.expectedVersion){db.exec('ROLLBACK');return null;}
      insert.run(d.version,JSON.stringify(d.event));db.exec('COMMIT');return d.permit;
    }catch(e){db.exec('ROLLBACK');throw e;}}
  assert.equal(commit(staleA).key,attemptKey(scope,'t',1));assert.equal(commit(staleB),null);
  const saved={...l.j,events:db.prepare('SELECT body FROM events ORDER BY version').all().map(r=>JSON.parse(r.body))};
  assert.equal(decide(saved,{auth:primary,command:ev('begin','send-a'),expectedVersion:rev,at:8}).permit,null);
  rejects(()=>decide(saved,{auth:primary,command:ev('begin','send-b'),expectedVersion:rev,at:8,profile:profile()}),'revision_conflict');
 }finally{db.close();}
});
test('synthetic DAG demo is reproducible in a browser or Node, retains regional boundary, and the held branch never sends twice',async()=>{
 const {runCoordinationExample}=await import('../examples/coordination-board-demo.mjs');
 const d=runCoordinationExample();assert.deepEqual(d,runCoordinationExample());assert.equal(d.providerRequests,0);
 assert.deepEqual(d.phases.map(s=>s.cards.find(c=>c.task==='editorial').state),['blocked','blocked','blocked','blocked','submitting','accepted']);
 assert.equal(d.journal.events.filter(e=>e.command.task==='overseas-a'&&e.command.type==='begin').length,1);
 assert.equal(d.journal.events.find(e=>e.command.task==='cn-notes'&&e.command.type==='claim').meta.route.dataRegions[0],'cn-mainland');
});
test('safe local cancellation applies only pre-submit; provider-confirmed failure releases its lane and never unlocks dependent tasks',()=>{
 const a=ledger();a.append(owner,input('t'));a.append(owner,ev('canceled','drop',{fence:0}));assert.equal(a.replay().cards[0].state,'canceled');rejects(()=>a.append(primary,claim()),'not_claimable');
 const b=ledger();stage(b,'leased');b.append(owner,ev('canceled'));rejects(()=>b.append(primary,ev('begin')),'not_leased');
 const c=ledger();stage(c,'running');c.append(owner,input('b',{requires:['t']}));
 rejects(()=>c.append(owner,ev('canceled')),'cannot_cancel');
 c.append(primary,ev('failed','fail',{receipt:'up-job',evidence:H2}));
 assert.deepEqual(c.replay().cards.map(x=>x.state),['blocked','failed']);rejects(()=>c.append(primary,claim('t','second-try')),'not_claimable');
 const e=ledger();stage(e);e.append(primary,ev('uncertain'));
 e.append(owner,ev('reconcile','resolve',{attestation:H2}),{attestation:attest({verdict:'failure_verified',receipt:'remote-r',evidence:H2})});
 assert.equal(e.replay().cards[0].state,'failed');
});
