// No real URL, secret or HTTP client. Response projection is from a fixture,
// not a claim that every provider wire schema is publicly available.
import {createHash} from 'node:crypto';
export const sha=x=>createHash('sha256').update(x).digest('hex');
const id=x=>typeof x==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,94}$/.test(x);
const text=(x,max)=>typeof x==='string'&&!!x.trim()&&Buffer.byteLength(x,'utf8')<=max;
const prefix='/api/public/v1',scope=['runs:create','runs:read','threads:create'];
function context({binding:b,task}){
 if(b?.enabled!==true||b.mode!=='offline-fixture'||b.provider!=='viktor-rest'||b.keyKind!=='personal-key'||
 b.publicTextOnly!==true||b.dedicated!==true||b.connectionsDisabled!==true||b.region!=='us-reviewed-fixture'||
 ![b.workspace,b.actor,b.lane,task].every(id)||!Array.isArray(b.scopes)||
 JSON.stringify([...b.scopes].sort())!==JSON.stringify(scope))
 throw new TypeError('Viktor lab seat unavailable');
 const values=[b.workspace,b.actor,b.lane,task];
 return {key:sha(JSON.stringify(['viktor-rest-v1',values])),scope:values};
}
const readRequest=(entry,kind='status')=>({workspace:entry.scope[0],actor:entry.scope[1],method:'GET',
 path:prefix+'/runs/'+entry.run+(kind==='result'?'/result':'')});
const sameRequest=(actual,expected)=>actual?.workspace===expected.workspace&&actual.actor===expected.actor&&
 actual.method===expected.method&&actual.path===expected.path;
export function makeViktorRestFixture({sql,transactionSync}){
 if(typeof sql?.exec!=='function'||typeof transactionSync!=='function')throw TypeError('transactional lab seat required');
 transactionSync(()=>sql.exec('CREATE TABLE IF NOT EXISTS lab_viktor_rest_v1 (key TEXT PRIMARY KEY, rev INTEGER NOT NULL, entry TEXT NOT NULL)'));
 function current(ctx){
  const row=[...sql.exec('SELECT rev,entry FROM lab_viktor_rest_v1 WHERE key=?',ctx.key)][0];
  if(!row)return null;
  const entry=JSON.parse(row.entry);
  if(!Number.isSafeInteger(row.rev)||row.rev<0||JSON.stringify(entry.scope)!==JSON.stringify(ctx.scope))throw Error('bad Viktor lab entry');
  return {revision:row.rev,entry};
 }
 const meta=r=>r?{revision:r.revision,state:r.entry.state}:null;
 const mutation=(args,op)=>{
  const ctx=context(args);
  if(!Number.isSafeInteger(args.expectedRevision)||args.expectedRevision<0)throw TypeError('current Viktor revision required');
  return transactionSync(()=>{
   const r=current(ctx);
   if(!r||r.revision!==args.expectedRevision)return {committed:false,reason:'stale',...meta(r)};
   const entry=op(r.entry);
   if(!entry)return {committed:false,reason:'needs_verification',...meta(r)};
   const revision=r.revision+1;
   sql.exec('UPDATE lab_viktor_rest_v1 SET rev=?,entry=? WHERE key=? AND rev=?',revision,JSON.stringify(entry),ctx.key,r.revision);
   return {committed:true,revision,state:entry.state};
  });
 };
 return Object.freeze({
  reserve(args){
   const ctx=context(args),{approvedText,inputDigest}=args;
   if(!text(approvedText,3000)||sha(approvedText)!==inputDigest)throw TypeError('Viktor task body not approved');
   const key='rv-viktor-'+ctx.key;
   const body={message:approvedText,speed:'smarter'};
   const request={workspace:ctx.scope[0],actor:ctx.scope[1],path:prefix+'/threads',method:'POST',headers:{'Idempotency-Key':key},body};
   const stamp=sha(JSON.stringify(['mock-operation-v1',ctx.key,request]));
   return transactionSync(()=>{
    const row=current(ctx);
    if(row){
     if(row.entry.stamp!==stamp)throw Error('original Viktor task is locked');
     return {committed:false,reason:'no_replay',...meta(row)};
    }
    const entry={scope:ctx.scope,stamp,inputDigest,state:'sending',thread:null,message:null,run:null,terminal:null,resultDigest:null};
    sql.exec('INSERT INTO lab_viktor_rest_v1 (key,rev,entry) VALUES (?,0,?)',ctx.key,JSON.stringify(entry));
    return {committed:true,revision:0,state:'sending',mockTicket:stamp,mockRequest:request};
   });
  },
  observeCreate(args){
   return mutation(args,entry=>{
    if(!['sending','unknown'].includes(entry.state)||entry.stamp!==args.mockTicket)return null;
    const o=args.observation;
    if(o?.source!=='mock-original-create'||o.workspace!==entry.scope[0]||o.actor!==entry.scope[1])return null;
    const j=o.json;
    if(o.status!==202||![j?.thread?.id,j?.message?.id,j?.run?.id].every(id))
     return entry.state==='sending'?{...entry,state:'unknown'}:null;
    return {...entry,state:'acknowledged',thread:j.thread.id,message:j.message.id,run:j.run.id};
   });
  },
  readPlan(args){
   const ctx=context(args);
   return transactionSync(()=>{
    const row=current(ctx),entry=row?.entry;
    if(!row||row.revision!==args.expectedRevision||!entry.run)return {...meta(row),reason:'no_verified_run'};
    if(['result_available','question_available'].includes(entry.state))return {...meta(row),mockRequest:readRequest(entry,'result')};
    if(entry.state==='acknowledged')return {...meta(row),mockRequest:readRequest(entry)};
    return {...meta(row),reason:'stop'};
   });
  },
  observeStatus(args){
   return mutation(args,entry=>{
    const o=args.observation;
    if(entry.state!=='acknowledged'||o?.source!=='mock-verified-run'||o.httpStatus!==200||
       !sameRequest(o.request,readRequest(entry))||o.runId!==entry.run||o.threadId!==entry.thread)return null;
    const status=o.status;
    if(o.waitTimedOut===true||['queued','in_progress','running'].includes(status))return null;
    if(['failed','cancelled','timed_out'].includes(status))return {...entry,state:'terminal_needs_evidence',terminal:status};
    if(!['completed','requires_action'].includes(status)||o.resultAvailable!==true)return null;
    return {...entry,state:status==='requires_action'?'question_available':'result_available',terminal:status};
   });
  },
  observeResult(args){
   return mutation(args,entry=>{
    const o=args.observation;
    if(!['result_available','question_available'].includes(entry.state)||o?.source!=='mock-verified-result'||o.httpStatus!==200||
       !sameRequest(o.request,readRequest(entry,'result'))||o.runId!==entry.run||o.threadId!==entry.thread||
       o.status!==entry.terminal||o.kind!=='text/plain'||o.files?.length!==0||!Array.isArray(o.files)||!text(o.content,3000))return null;
    // Keep content out of the journal. A separate trusted inbox obtains it
    // using this digest; a provider result never automatically accepts a task.
    return {...entry,state:entry.state==='question_available'?'owner_input_required':'awaiting_main_agent',resultDigest:sha(o.content)};
   });
  },
  view(args){
   const ctx=context(args);
   return transactionSync(()=>{
    const row=current(ctx),e=row?.entry;
    return row?{...meta(row),thread:e.thread,message:e.message,run:e.run,digest:e.resultDigest}:null;
   });
  },
 });
}
