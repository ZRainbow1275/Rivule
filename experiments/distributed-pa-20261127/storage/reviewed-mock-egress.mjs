// No socket, payload, paid provider or callback. This is a local delivery
// *simulation*. All methods are invoked inside the calling SQL transaction.
import {BoardConflict} from '../src/sdk/coordination-board.mjs';

export function makeReviewedMockEgress(sql,mark,options){
 if(options===undefined)return null;
 const {clock,outcome}=options??{};
 if(typeof clock!=='function'||!['accepted','unknown'].includes(outcome)||Object.keys(options).length!==2)
  throw new TypeError('mock egress requires a host clock and a fixed local outcome');
 const prepare=()=>sql.exec("CREATE TABLE IF NOT EXISTS lab_coord_mock_egress (board TEXT NOT NULL, task TEXT NOT NULL, fence INTEGER NOT NULL, reviewer TEXT NOT NULL, alias TEXT NOT NULL, begin_v INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','accepted','unknown')), receipt TEXT, PRIMARY KEY(board,task,fence), CHECK((state='accepted')=(receipt IS NOT NULL)))");
 const arm=({scope,task,fence,reviewer,alias,beginVersion})=>sql.exec("INSERT INTO lab_coord_mock_egress (board,task,fence,reviewer,alias,begin_v,state,receipt) VALUES (?,?,?,?,?,?,'pending',NULL)",scope,task,fence,reviewer,alias,beginVersion);
 function read({scope,task,fence,reviewer,alias}){
  if(!Number.isSafeInteger(fence)||fence<1)throw new BoardConflict('invalid_integer');
  const [row]=[...sql.exec('SELECT reviewer,alias,begin_v,state,receipt FROM lab_coord_mock_egress WHERE board=? AND task=? AND fence=?',scope,task,fence)];
  if(row&&(row.reviewer!==reviewer||row.alias!==alias))throw new BoardConflict('not_authorized');
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
 return Object.freeze({prepare,arm,read,project,consume,clock});
}
