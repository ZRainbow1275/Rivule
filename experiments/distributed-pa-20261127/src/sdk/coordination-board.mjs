// A bounded, deterministic v1 decision log. No I/O, tokens, provider SDK or timers.
// The store must CAS append one decision before permitting one external call.
const MAX_EVENTS = 4096, MAX_TASKS = 128, MAX_LEASE_MS = 3600000;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const plain = v => v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
export class BoardConflict extends Error {
  constructor(code) { super(code); this.name = 'BoardConflict'; this.code = code; }
}
function requireThat(ok, code) { if (!ok) throw new BoardConflict(code); }
function shape(o, keys) {
  requireThat(plain(o) && Object.keys(o).length === keys.length && keys.every(k => own(o, k)), 'invalid_shape');
}
function id(s) { requireThat(typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/u.test(s), 'invalid_id'); return s; }
function digest(s) { requireThat(typeof s === 'string' && /^[a-f0-9]{64}$/u.test(s), 'invalid_digest'); return s; }
function int(n, min, max = Number.MAX_SAFE_INTEGER) { requireThat(Number.isSafeInteger(n) && n >= min && n <= max, 'invalid_integer'); return n; }
function list(v, min, max, parse = id) {
  requireThat(Array.isArray(v) && v.length >= min && v.length <= max, 'invalid_list');
  const a = Array.from(v, parse);
  requireThat(new Set(a).size === a.length, 'duplicate_list_member');
  return a.sort();
}
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (plain(v)) return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}
const encode = v => JSON.stringify(canonical(v));
const copy = v => JSON.parse(JSON.stringify(v));
// Exact, deliberately finite egress policy vocabulary. Add a jurisdiction only
// after the route operator can identify every processing and retention boundary.
const supportedRegions = new Set(['cn-mainland','hk','mo','tw','us','sg','jp','kr','au','ca','gb','de','fr','ie','nl','eu-eea','ch','in','br']);
function region(s) { requireThat(supportedRegions.has(s), 'unknown_region'); return s; }
const kinds = {
  add: ['capability','allowedRegions','inputDigest','requires'],
  claim: ['worker','leaseMs'], renew: ['fence','leaseMs'],
  begin: ['fence'], acknowledged: ['fence','receipt'], reported: ['fence','receipt','artifact'],
  uncertain: ['fence'], expire: ['fence'], canceled: ['fence'], failed: ['fence','receipt','evidence'],
  reconcile: ['fence','attestation'], accept: ['fence','artifact']
};
function normalize(raw) {
  requireThat(plain(raw) && own(kinds,raw.type), 'unknown_command');
  const names = ['type','id','task',...kinds[raw.type]];
  shape(raw, names);
  const c = {type:raw.type,id:id(raw.id),task:id(raw.task)};
  for (const k of kinds[c.type]) {
    const v = raw[k];
    if(k==='fence') c[k]=int(v,raw.type==='canceled'?0:1);
    else if(k==='leaseMs') c[k]=int(v,1,MAX_LEASE_MS);
    else if(k==='allowedRegions') c[k]=list(v,1,12,region);
    else if(k==='requires') c[k]=list(v,0,24);
    else if(['inputDigest','artifact','attestation','evidence'].includes(k)) c[k]=digest(v);
    else c[k]=id(v);
  }
  return c;
}
export function createJournal(scope) { return {schema:1,scope:id(scope),events:[]}; }
function sidecar() { return {tasks:new Map(),commands:new Map(),lanes:new Map(),clock:0,rev:0}; }
function allowedRoute(profile, task, worker) {
  // Sourced from the authenticated registry, never accepted as command input.
  requireThat(plain(profile) && profile.worker===worker && profile.ready===true && profile.authorized===true,'worker_unavailable');
  const lane=id(profile.lane), provider=id(profile.provider);
  const regions=list(profile.dataRegions,1,12,region);
  requireThat(list(profile.capabilities,1,32).includes(task.capability),'capability_mismatch');
  requireThat(regions.every(region=>task.allowedRegions.includes(region)),'region_mismatch');
  return {worker,lane,provider,dataRegions:regions,capability:task.capability};
}
function sameScope(auth, scope) {
  requireThat(plain(auth) && auth.scope===scope && ['coordinator','worker'].includes(auth.role),'scope_or_role');
  id(auth.subject);
}
function validAttestation(x, scope, t, c) {
  requireThat(plain(x)&&x.verified===true&&x.scope===scope&&x.task===t.task&&x.fence===t.fence&&x.worker===t.route.worker&&x.provider===t.route.provider&&x.lane===t.route.lane&&x.key===attemptKey(scope,t.task,t.fence)&&x.digest===c.attestation,'invalid_attestation');
  if(x.verdict==='closed_not_sent'){
    // A poll returning 'not found' is not a proof: the old sender may still wake.
    requireThat(!t.receipt&&x.submitterQuiesced===true&&x.remoteRequestClosed===true,'not_proven_closed');
    return {verdict:x.verdict};
  }
  if(x.verdict==='failure_verified'){
    requireThat(!t.receipt||x.receipt===t.receipt,'receipt_mismatch');
    return {verdict:x.verdict,receipt:id(x.receipt),evidence:digest(x.evidence)};
  }
  requireThat(x.verdict==='result_verified' && (!t.receipt||x.receipt===t.receipt),'receipt_mismatch');
  return {verdict:x.verdict,receipt:id(x.receipt),artifact:digest(x.artifact)};
}
export function attemptKey(scope, task, fence) { return [id(scope),id(task),int(fence,1)].join('/'); }
function fold(j) {
  shape(j,['schema','scope','events']); id(j.scope);
  requireThat(j.schema===1 && Array.isArray(j.events) && j.events.length<=MAX_EVENTS,'invalid_journal');
  const v=sidecar();
  for(const e of j.events) {
    // Replay only authority-produced, access-controlled rows. No provider action on replay.
    requireThat(plain(e)&&e.version===v.rev+1&&e.scope===j.scope,'journal_gap');
    int(e.at,v.clock); const c=normalize(e.command);
    requireThat(!v.commands.has(c.id),'journal_duplicate');
    const auth={scope:j.scope,subject:e.subject,role:e.role};sameScope(auth,j.scope);
    const meta=derive(v,j.scope,auth,c,e.at,e.meta,true);
    requireThat(encode(meta)===encode(e.meta),'invalid_journal_evidence');
    apply(v,j.scope,c,meta,e.version,e.at);
    v.commands.set(c.id,{command:c,subject:auth.subject,role:auth.role,version:e.version});
  }
  return v;
}
function derive(v,scope,auth,c,at,context,replay=false) {
  const owner=['add','expire','reconcile','accept','canceled'].includes(c.type);
  requireThat(auth.role===(owner?'coordinator':'worker'),'wrong_role');
  const t=v.tasks.get(c.task);
  if(c.type==='add') {
    requireThat(!t&&v.tasks.size<MAX_TASKS,'task_exists_or_capacity');
    requireThat(c.requires.every(x=>v.tasks.has(x)),'unknown_dependency');
    return {};
  }
  requireThat(t,'unknown_task');
  if(c.type==='claim') {
    requireThat(c.worker===auth.subject && t.state==='ready','not_claimable');
    requireThat(t.requires.every(x=>v.tasks.get(x).state==='accepted'),'dependencies_open');
    const route=replay?context.route:allowedRoute(context.profile,t,c.worker);
    validateStoredRoute(route,t,c.worker);
    requireThat(!v.lanes.has(route.lane),'lane_busy');
    int(at+c.leaseMs,at+1);
    return {route};
  }
  if(c.type==='canceled'){
    // No RPC has begun, or this path is ineligible. Never present cancellation
    // after a remote request as confirmed without a provider-specific receipt.
    requireThat(c.fence===t.fence,'stale_fence');
    requireThat(t.state==='ready'||t.state==='leased','cannot_cancel');return {};
  }
  requireThat(c.fence===t.fence&&t.route,'stale_fence');
  if(!owner) {
    requireThat(auth.subject===t.route.worker,'wrong_worker');
    requireThat(at<t.until,'lease_expired');
  }
  if(c.type==='renew') {
    requireThat(['leased','submitting','running'].includes(t.state),'not_renewable');
    int(at+c.leaseMs,t.until+1); // renewal cannot shorten the reservation
  } else if(c.type==='begin') {
    requireThat(t.state==='leased','not_leased');
    if(!replay) {
      const current=allowedRoute(context.profile,t,auth.subject);
      requireThat(encode(current)===encode(t.route),'route_changed');
    }
  } else if(c.type==='acknowledged') {
    requireThat(t.state==='submitting','not_submitting');
  } else if(c.type==='reported'||c.type==='failed') {
    requireThat(t.state==='running'&&c.receipt===t.receipt,'receipt_mismatch');
  } else if(c.type==='uncertain') {
    requireThat(t.state==='submitting'||t.state==='running','not_in_flight');
  } else if(c.type==='expire') {
    requireThat(at>=t.until&&['leased','submitting','running'].includes(t.state),'not_expirable');
  } else if(c.type==='reconcile') {
    requireThat(t.state==='needs_review','not_under_review');
    const answer=replay?context.answer:validAttestation(context.attestation,scope,t,c);
    if(answer.verdict==='closed_not_sent'){shape(answer,['verdict']);requireThat(!t.receipt,'receipt_exists');}
    else if(answer.verdict==='failure_verified'){shape(answer,['verdict','receipt','evidence']);requireThat(!t.receipt||t.receipt===answer.receipt,'receipt_mismatch');id(answer.receipt);digest(answer.evidence);}
    else{shape(answer,['verdict','receipt','artifact']);requireThat(answer.verdict==='result_verified'&&(!t.receipt||t.receipt===answer.receipt),'receipt_mismatch');id(answer.receipt);digest(answer.artifact);}
    return {answer};
  } else if(c.type==='accept') requireThat(t.state==='reported'&&c.artifact===t.artifact,'artifact_mismatch');
  return {};
}
function validateStoredRoute(r,t,worker) {
  shape(r,['worker','provider','capability','lane','dataRegions']);
  requireThat(r.worker===worker&&r.capability===t.capability,'route_mismatch');
  id(r.provider); id(r.lane);list(r.dataRegions,1,12,region);
  requireThat(r.dataRegions.every(x=>t.allowedRegions.includes(x)),'region_mismatch');
}
function apply(v,scope,c,meta,version,at){
  const t=v.tasks.get(c.task);
  if(c.type==='add'){
    v.tasks.set(c.task,{task:c.task,capability:c.capability,allowedRegions:[...c.allowedRegions],inputDigest:c.inputDigest,requires:[...c.requires],
      state:'ready',fence:0,until:0,route:null,receipt:null,artifact:null,failureDigest:null,version});
  }else{
    if(c.type==='claim'){
      t.state='leased';t.route=copy(meta.route);t.fence++;t.until=at+c.leaseMs;t.receipt=null;t.artifact=null;
      v.lanes.set(t.route.lane,t.task);
    }else if(c.type==='renew')t.until=at+c.leaseMs;
    else if(c.type==='begin')t.state='submitting';
    else if(c.type==='acknowledged'){t.state='running';t.receipt=c.receipt;}
    else if(c.type==='canceled'){t.state='canceled';if(t.route)v.lanes.delete(t.route.lane);}
    else if(c.type==='failed'){t.state='failed';t.failureDigest=c.evidence;v.lanes.delete(t.route.lane);}
    else if(c.type==='reported'){t.state='reported';t.artifact=c.artifact;v.lanes.delete(t.route.lane);}
    else if((c.type==='expire'&&t.state==='leased')||(c.type==='reconcile'&&meta.answer.verdict==='closed_not_sent')){
      v.lanes.delete(t.route.lane);t.state='ready';t.route=null;t.until=0;
    }else if(c.type==='expire'||c.type==='uncertain')t.state='needs_review';
    else if(c.type==='reconcile'&&meta.answer.verdict==='failure_verified'){t.state='failed';t.receipt=meta.answer.receipt;t.failureDigest=meta.answer.evidence;v.lanes.delete(t.route.lane);}
    else if(c.type==='reconcile'){t.state='reported';t.receipt=meta.answer.receipt;t.artifact=meta.answer.artifact;v.lanes.delete(t.route.lane);}
    else if(c.type==='accept')t.state='accepted';
    t.version=version;
  }
  v.clock=at;v.rev=version;
}
// A fresh begin returns only a *provisional* permit. Deliver only after a durable
// parent-version CAS confirmed this exact, freshly inserted decision.
export function decide(journal,{auth,command,expectedVersion,at,profile,attestation}){
  const v=fold(journal), c=normalize(command);
  sameScope(auth,journal.scope);
  int(expectedVersion,0);
  const old=v.commands.get(c.id);
  if(old){
    requireThat(old.subject===auth.subject&&old.role===auth.role&&encode(old.command)===encode(c),'idempotency_conflict');
    return {duplicate:true,version:old.version,event:null,permit:null};
  }
  requireThat(expectedVersion===v.rev,'revision_conflict');
  requireThat(v.rev<MAX_EVENTS,'journal_capacity');
  int(at,v.clock);
  const meta=derive(v,journal.scope,auth,c,at,{profile,attestation});
  const event={scope:journal.scope,version:v.rev+1,at,subject:auth.subject,role:auth.role,command:c,meta};
  const permit=c.type==='begin'?{key:attemptKey(journal.scope,c.task,c.fence),task:c.task,fence:c.fence,worker:auth.subject,
    provider:v.tasks.get(c.task).route.provider,lane:v.tasks.get(c.task).route.lane,expiresAt:v.tasks.get(c.task).until,
    inputDigest:v.tasks.get(c.task).inputDigest,expectedVersion:v.rev,decisionVersion:event.version}:null;
  return {duplicate:false,version:event.version,event,permit};
}
export function projectBoard(journal,{scope,selected,readable}){
  requireThat(scope===journal.scope,'scope_or_role');
  // Both sets come from the existing owner/read-model authorization boundary.
  const choice=list(selected,0,MAX_TASKS), access=new Set(list(readable,0,MAX_TASKS));
  const v=fold(journal), chosen=new Set(choice.filter(x=>access.has(x)));
  const cards=[];
  for(const key of choice){
    if(!chosen.has(key))continue;
    const t=v.tasks.get(key); if(!t)continue;
    const closed=t.requires.every(k=>v.tasks.get(k).state==='accepted');
    const dependencies=t.requires.filter(k=>chosen.has(k)).map(k=>({task:k,state:v.tasks.get(k).state,version:v.tasks.get(k).version}));
    cards.push({task:t.task,capability:t.capability,state:t.state==='ready'&&!closed?'blocked':t.state,
      worker:t.route?.worker??null,fence:t.fence,taskVersion:t.version,dependencies});
  }
  return {schema:1,scope,asOfVersion:v.rev,cards};
}
