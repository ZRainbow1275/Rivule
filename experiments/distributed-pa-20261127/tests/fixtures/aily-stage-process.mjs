// Node SQLite race fixture; execute only as a child of the host test.
import {DatabaseSync} from 'node:sqlite';
import {makeAilyStageJournal} from '../../storage/aily-stage-journal.mjs';
if(typeof process.send!=='function')throw Error('fixture requires IPC');
const db=new DatabaseSync(process.argv[2]);db.exec('PRAGMA busy_timeout=3000');
const store=makeAilyStageJournal({
 sql:{exec(q,...xs){return q.startsWith('SELECT')?db.prepare(q).all(...xs):(db.prepare(q).run(...xs),[])}},
 transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const out=fn();db.exec('COMMIT');return out}catch(e){db.exec('ROLLBACK');throw e}}
});
process.once('message',async(args)=>{
 try{
  const r=await store.reserve(args);
  process.send({committed:r.committed,oneShot:!!r.mockRequest,reason:r.reason,state:r.state},()=>{db.close();process.disconnect();});
 }catch(e){process.send({error:e.name},()=>{db.close();process.disconnect();});}
});
process.send({ready:true});
