import {DatabaseSync} from 'node:sqlite';
import {makeQwenPawTrial} from '../../storage/qwenpaw-recovery-journal.mjs';
export function open(path,abort=()=>false){
 const db=new DatabaseSync(path);db.exec('PRAGMA busy_timeout=5000');
 const store=makeQwenPawTrial({
  sql:{exec(q,...xs){return q.startsWith('SELECT')?db.prepare(q).all(...xs):(db.prepare(q).run(...xs),[])}},
  transactionSync(fn){
   db.exec('BEGIN IMMEDIATE');
   try{const out=fn();if(abort())throw Error('injected precommit loss');db.exec('COMMIT');return out}
   catch(e){db.exec('ROLLBACK');throw e}
  }
 });
 return {db,store};
}
if(process.send){
 const {db,store}=open(process.argv[2]);
 process.once('message',({method,args})=>{
  try{
   if(!['reserve','reattach','reconcile'].includes(method))throw Error('bad fixture method');
   const r=store[method](args);
   process.send({committed:r.committed,oneShot:!!r.mockRequest,phase:r.phase},()=>{db.close();process.disconnect()});
  }catch(e){process.send({error:e.message},()=>{db.close();process.disconnect()})}
 });
 process.send({ready:true});
}
