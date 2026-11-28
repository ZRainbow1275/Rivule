// No socket, payload, paid provider or callback. This is a local delivery
// *simulation*. All methods are invoked inside the calling SQL transaction.
import {BoardConflict} from '../src/sdk/coordination-board.mjs';

// Called by the legacy facade only for acknowledgement or reconciliation.
 // The registry exists exclusively after opt-in setup.
export function isRegisteredMockEgress(sql,scope,task,fence){
 const exists=[...sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='lab_coord_mock_egress'")][0];
 if(!exists)return false;
 return [...sql.exec('SELECT begin_v FROM lab_coord_mock_egress WHERE board=? AND task=? AND fence=?',scope,task,fence)].length>0;
}

export function makeReviewedMockEgress(sql,mark,options){
 if(options===undefined)return null;
 const {clock,outcome}=options??{};
 if(typeof clock!=='function'||!['accepted','unknown'].includes(outcome)||Object.keys(options).length!==2)
  throw new TypeError('mock egress requires a host clock and a fixed local outcome');
 function prepare(){
  sql.exec("CREATE TABLE IF NOT EXISTS lab_coord_mock_egress (board TEXT NOT NULL, task TEXT NOT NULL, fence INTEGER NOT NULL, reviewer TEXT NOT NULL, alias TEXT NOT NULL, begin_v INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','accepted','unknown')), receipt TEXT, PRIMARY KEY(board,task,fence), CHECK((state='accepted')=(receipt IS NOT NULL)))");
  // A second table preserves the exact original table and its CHECK constraint,
  // so pending/accepted/unknown rows from v9 need no rewrite.
  sql.exec('CREATE TABLE IF NOT EXISTS lab_coord_mock_closure (board TEXT NOT NULL, task TEXT NOT NULL, fence INTEGER NOT NULL, close_v INTEGER NOT NULL, PRIMARY KEY(board,task,fence))');
 }
 const arm=({scope,task,fence,reviewer,alias,beginVersion})=>sql.exec("INSERT INTO lab_coord_mock_egress (board,task,fence,reviewer,alias,begin_v,state,receipt) VALUES (?,?,?,?,?,?,'pending',NULL)",scope,task,fence,reviewer,alias,beginVersion);
 function read({scope,task,fence,reviewer,alias}){
  if(!Number.isSafeInteger(fence)||fence<1)throw new BoardConflict('invalid_integer');
  const [row]=[...sql.exec('SELECT e.reviewer,e.alias,e.begin_v,e.state,e.receipt,c.close_v FROM lab_coord_mock_egress e LEFT JOIN lab_coord_mock_closure c ON c.board=e.board AND c.task=e.task AND c.fence=e.fence WHERE e.board=? AND e.task=? AND e.fence=?',scope,task,fence)];
  if(row&&(row.reviewer!==reviewer||row.alias!==alias))throw new BoardConflict('not_authorized');
  if(row?.close_v!==null&&row?.close_v!==undefined){
   if(row.state!=='pending'||row.receipt!==null)throw new BoardConflict('mock_closure_corrupt');
   return {...row,state:'closed_no_send'};
  }
  return row??null;
 }
 const project=row=>row?{state:row.state,receipt:row.receipt,simulation:true}:null;
 function consume(slot,row,facts){
  if(!row||row.state!=='pending'||row.begin_v!==facts.beginVersion)throw new BoardConflict('mock_egress_not_armed');
  const receipt=outcome==='accepted'?mark('mock-egress-receipt',[slot.scope,slot.reviewer],[facts.key,facts.beginVersion]):null;
  sql.exec("UPDATE lab_coord_mock_egress SET state=?,receipt=? WHERE board=? AND task=? AND fence=? AND state='pending'",outcome,receipt,slot.scope,slot.task,slot.fence);
  const stored=read(slot);
  if(stored?.state!==outcome||stored.receipt!==receipt)throw new BoardConflict('mock_egress_write_failed');
  return {...project(stored),duplicate:false};
 }
 function close(slot,row,closeVersion){
  if(row?.state!=='pending'||row.receipt!==null)throw new BoardConflict('mock_not_closable');
  sql.exec('INSERT INTO lab_coord_mock_closure (board,task,fence,close_v) VALUES (?,?,?,?)',slot.scope,slot.task,slot.fence,closeVersion);
  const stored=read(slot);
  if(stored?.state!=='closed_no_send'||stored.close_v!==closeVersion)throw new BoardConflict('mock_egress_write_failed');
  return project(stored);
 }
 return Object.freeze({prepare,arm,read,project,consume,close,clock});
}
