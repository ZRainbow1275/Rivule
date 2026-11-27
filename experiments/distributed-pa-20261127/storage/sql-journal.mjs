// Isolated SQL adapter for the coordination experiment. Host provides its own
// serialized, all-or-nothing transaction implementation. No credentials, body,
// notifications or network requests are persisted here.
import {createJournal,decide,projectBoard} from '../src/sdk/coordination-board.mjs';
const valid=x=>typeof x==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(x);
export function makeSqlJournal({sql,transactionSync}) {
 if(typeof sql?.exec!=='function'||typeof transactionSync!=='function')throw new TypeError('transactional SQL required');
 // Explicit setup only in a sandbox or by a separately reviewed migration.
 function prepare(){
  return transactionSync(()=>{
   sql.exec('CREATE TABLE IF NOT EXISTS lab_coord_event (board TEXT NOT NULL, v INTEGER NOT NULL, event_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(board,v), UNIQUE(board,event_id))');
   sql.exec('CREATE TABLE IF NOT EXISTS lab_coord_outbox (board TEXT NOT NULL, v INTEGER NOT NULL, phase TEXT NOT NULL, task TEXT NOT NULL, PRIMARY KEY(board,v))');
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
 const append=decision=>transactionSync(()=>{
  const {scope}=decision.auth??{};
  const result=decide(read(scope),decision);
  if(!result.event)return {...result,committed:false};
  const e=result.event;
  sql.exec('INSERT INTO lab_coord_event (board, v, event_id, body) VALUES (?,?,?,?)',scope,e.version,e.command.id,JSON.stringify(e));
  // This outbox is a projection/wakeup metadata queue, not a second sender.
  // A recovery process may reconcile an already committed begin but never
  // manufactures a new post permission from this row.
  sql.exec('INSERT INTO lab_coord_outbox (board, v, phase, task) VALUES (?,?,?,?)',scope,e.version,e.command.type,e.command.task);
  return {...result,committed:true};
 });
 const project=input=>transactionSync(()=>projectBoard(read(input.scope),input));
 const outboxAfter=(board,after=0,limit=40)=>transactionSync(()=>{
  if(!valid(board)||!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new TypeError('invalid projection cursor');
  return [...sql.exec('SELECT v, phase, task FROM lab_coord_outbox WHERE board=? AND v>? ORDER BY v LIMIT ?',board,after,limit)]
   .map(row=>({version:row.v,phase:row.phase,task:row.task}));
 });
 return Object.freeze({prepare,append,project,outboxAfter});
}
