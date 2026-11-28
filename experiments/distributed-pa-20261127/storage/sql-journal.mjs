// Isolated SQL adapter for the coordination experiment. Host provides its own
// serialized, all-or-nothing transaction implementation. No credentials, body,
// notifications or network requests are persisted here.
import {BoardConflict,createJournal,decide,projectBoard,projectDispatchPreview,reviewedDispatchFacts,reviewedSubmissionFacts} from '../src/sdk/coordination-board.mjs';
import {makeReviewedMockEgress} from './reviewed-mock-egress.mjs';
import {makeScopedValidator} from '../src/sdk/scoped-validator.mjs';
const valid=x=>typeof x==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(x);
export function makeSqlJournal({sql,transactionSync,reviewedDispatch}) {
 if(typeof sql?.exec!=='function'||typeof transactionSync!=='function')throw new TypeError('transactional SQL required');
 const resolver=reviewedDispatch?.resolve;
 if(reviewedDispatch!==undefined&&typeof resolver!=='function')throw TypeError('host dispatch resolver required');
 const mark=reviewedDispatch===undefined?null:makeScopedValidator(reviewedDispatch.validatorKey);
 const mock=makeReviewedMockEgress(sql,mark,reviewedDispatch?.mockEgress);
 // Explicit setup only in a sandbox or by a separately reviewed migration.
 function prepare(){
  return transactionSync(()=>{
   sql.exec('CREATE TABLE IF NOT EXISTS lab_coord_event (board TEXT NOT NULL, v INTEGER NOT NULL, event_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(board,v), UNIQUE(board,event_id))');
   sql.exec('CREATE TABLE IF NOT EXISTS lab_coord_outbox (board TEXT NOT NULL, v INTEGER NOT NULL, phase TEXT NOT NULL, task TEXT NOT NULL, PRIMARY KEY(board,v))');
   mock?.prepare();
  });
 }
 function read(board){
  if(!valid(board))throw new TypeError('invalid authority');
  const rows=[...sql.exec('SELECT v, body FROM lab_coord_event WHERE board = ? ORDER BY v ASC LIMIT 4097',board)];
  if(rows.length>4096)throw new Error('lab journal ceiling passed');
  const j=createJournal(board);
  for (let i=0;i<rows.length;i++){
   const o=JSON.parse(rows[i].body);
   if(rows[i].v!==i+1||o.version!==i+1)throw new Error('journal sequence corrupt');
   j.events.push(o);
  }
  return j;
 }
 function commit(decision,journal=read(decision.auth?.scope)){
  const scope=journal.scope;
  const result=decide(journal,decision);
  if(!result.event)return {...result,committed:false};
  const e=result.event;
  sql.exec('INSERT INTO lab_coord_event (board, v, event_id, body) VALUES (?,?,?,?)',scope,e.version,e.command.id,JSON.stringify(e));
  // This outbox is a projection/wakeup metadata queue, not a second sender.
  // A recovery process may reconcile an already committed begin but never
  // manufactures a new post permission from this row.
  sql.exec('INSERT INTO lab_coord_outbox (board, v, phase, task) VALUES (?,?,?,?)',scope,e.version,e.command.type,e.command.task);
  return {...result,committed:true};
 }
 // A bare journal writer cannot supply the extra review for a pinned lease.
 const append=({review:ignored,...decision})=>transactionSync(()=>commit(decision));

 function identity(request,{scope,task,alias,phase}){
  if(!mark)throw new BoardConflict('reviewed_dispatch_disabled');
  if(![scope,task,alias].every(valid))throw new BoardConflict('not_authorized');
  // The resolver belongs to the host and must use the same transactional
  // authority as this journal, not an HTTP cache or client-supplied profile.
  const a=resolver(request,{scope,task,alias,phase});
  if(a?.auth?.scope!==scope||a.auth.role!=='coordinator'||!valid(a.auth.subject)||
     !Array.isArray(a.readable)||!a.readable.includes(task)||a.alias!==alias)
   throw new BoardConflict('not_authorized');
  return a;
 }
 function current(a,alias){
  if(a.budgetReviewed!==true)throw new BoardConflict('budget_unreviewed');
  const review={alias,reviewer:a.auth.subject,authorityEpoch:a.authorityEpoch,budgetEpoch:a.budgetEpoch,inputDigest:a.inputDigest};
  return {a,review};
 }
 function reviewPin(journal,task,a,review){
  const facts=reviewedDispatchFacts(journal,{auth:a.auth,task,readable:a.readable,profile:a.profile,review});
  return mark('dispatch-choice',[journal.scope,a.auth.subject],facts);
 }
 const inspectChoice=(request,{scope,task,alias})=>transactionSync(()=>{
  const {a,review}=current(identity(request,{scope,task,alias,phase:'inspect'}),alias);
  return {task,alias,selection:reviewPin(read(scope),task,a,review)};
 });
 const claimChoice=(request,{scope,task,alias,selection,id,at,expectedVersion,leaseMs})=>transactionSync(()=>{
  const {a,review}=current(identity(request,{scope,task,alias,phase:'claim'}),alias),j=read(scope);
  if(reviewPin(j,task,a,review)!==selection)throw new BoardConflict('dispatch_review_changed');
  const auth={scope,role:'worker',subject:a.profile.worker};
  return commit({auth,command:{type:'claim',id,task,worker:auth.subject,leaseMs},at,expectedVersion,profile:a.profile,review},j);
 });
 const beginChoice=(request,{scope,task,alias,id,at,expectedVersion,fence})=>transactionSync(()=>{
  const {a,review}=current(identity(request,{scope,task,alias,phase:'begin'}),alias);
  const result=commit({auth:{scope,role:'worker',subject:a.profile?.worker},command:{type:'begin',id,task,fence},
   at,expectedVersion,profile:a.profile,review});
  if(!mock||!result.committed)return result;
  mock.arm({scope,task,fence,alias,reviewer:a.auth.subject,beginVersion:result.version});
  return {...result,permit:null,simulation:'pending'};
 });
 function mockSlot(request,{scope,task,alias,fence},phase){
  if(!mock)throw new BoardConflict('mock_egress_disabled');
  const a=identity(request,{scope,task,alias,phase});
  const slot={scope,task,alias,fence,reviewer:a.auth.subject};
  return {a,slot,row:mock.read(slot)};
 }
 const inspectMockEgress=(request,input)=>transactionSync(()=>{
  const {row}=mockSlot(request,input,'mock-readback');
  return mock.project(row);
 });
 const consumeMockEgress=(request,input)=>transactionSync(()=>{
  const {a,slot,row}=mockSlot(request,input,'mock-consume');
  if(!row)throw new BoardConflict('mock_egress_not_armed');
  if(row.state!=='pending')return {...mock.project(row),duplicate:true};
  const {review}=current(a,slot.alias);
  const facts=reviewedSubmissionFacts(read(slot.scope),{auth:a.auth,task:slot.task,
   readable:a.readable,profile:a.profile,review,fence:slot.fence,at:mock.clock()});
  return mock.consume(slot,row,facts);
 });
 const project=input=>transactionSync(()=>projectBoard(read(input.scope),input));
 // Host-only complete projection; wrappers must explicitly authorize the
 // board and choose which (if any) readers can receive this snapshot.
 const projectAll=scope=>transactionSync(()=>{
  const j=read(scope),all=j.events.filter(e=>e.command.type==='add').map(e=>e.command.task);
  return projectBoard(j,{scope,selected:all,readable:all});
 });
 // Host code must derive approved active user, task scope and seat aliases
 // before this call. Do not expose these arguments as a client payload.
 const preview=input=>transactionSync(()=>projectDispatchPreview(read(input.auth?.scope),input));
 const outboxAfter=(board,after=0,limit=40)=>transactionSync(()=>{
  if(!valid(board)||!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new TypeError('invalid projection cursor');
  return [...sql.exec('SELECT v, phase, task FROM lab_coord_outbox WHERE board=? AND v>? ORDER BY v LIMIT ?',board,after,limit)]
   .map(row=>({version:row.v,phase:row.phase,task:row.task}));
 });
 return Object.freeze({prepare,append,project,projectAll,preview,outboxAfter,inspectChoice,claimChoice,beginChoice,inspectMockEgress,consumeMockEgress});
}
