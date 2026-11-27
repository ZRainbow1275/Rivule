// Local, default-off SQLite facade. The host resolver is synchronous inside
// the same authority transaction. There is no network client or dispatch path.
import {createHash} from 'node:crypto';
import {makeScopedValidator} from '../src/sdk/scoped-validator.mjs';
import {makeSqlJournal} from './sql-journal.mjs';
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(x);
const artifact=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const seal=x=>typeof x==='string'&&/^sv1-[\w-]{43}$/.test(x);
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const error=code=>Object.assign(new Error(code),{code});
const need=(ok,code)=>{if(!ok)throw error(code)};
const own=(o,k)=>Object.hasOwn(o,k)&&'value'in Object.getOwnPropertyDescriptor(o,k);
const read='pa:assignment:read';

export function makeMuseScopedFixture({enabled=false,sql,transactionSync,resolve,clock,validatorKey}){
 need(enabled===true&&[transactionSync,resolve,clock].every(x=>typeof x==='function'),'offline_bridge_disabled');
 const validate=makeScopedValidator(validatorKey);
 let depth=0;
 const atom=fn=>depth?fn():transactionSync(()=>{depth++;try{return fn()}finally{depth--}});
 const board=makeSqlJournal({sql,transactionSync:atom});
 atom(()=>{
  board.prepare();
  sql.exec('CREATE TABLE IF NOT EXISTS lab_muse_lease (board TEXT NOT NULL,task TEXT NOT NULL,fence INTEGER NOT NULL,binding TEXT NOT NULL, PRIMARY KEY(board,task,fence))');
  sql.exec('CREATE TABLE IF NOT EXISTS lab_muse_intent (key TEXT PRIMARY KEY,payload TEXT NOT NULL)');
 });
 function access(req,right){
  const p=resolve(req),profile=p?.profile;
  need(p?.active===true&&p.provider==='muse-personal'&&[p.board,p.subject,p.policyEpoch].every(id)&&
   p.rights instanceof Set&&p.rights.has(read)&&p.rights.has(right)&&p.taskIds instanceof Set&&p.taskIds.size<=128&&
   [...p.taskIds].every(id)&&profile?.provider==='muse-personal'&&profile.worker===p.subject&&profile.authorized===true&&
   profile.ready===true&&id(profile.lane)&&Array.isArray(profile.dataRegions)&&Array.isArray(profile.capabilities),'not_authorized');
  const scope=[p.board,p.subject,p.policyEpoch,profile.lane,[...profile.dataRegions].sort(),[...profile.capabilities].sort()];
  return {p,profile,scope,binding:hash(scope)};
 }
 const project=(a,ids)=>board.project({scope:a.p.board,selected:ids,readable:ids});
 const visible=(a,c)=>c&&(!c.worker||c.worker===a.p.subject)&&!['failed','canceled'].includes(c.state);
 // An opaque precondition covers only this task and authorized effective scope.
 const validateCard=(a,c)=>validate('muse-task',a.scope,[c.task,c.state,c.fence,c.taskVersion]);
 function submit(req,kind,x){
  const claim=kind==='claim';
  const fields=claim?['task','eventId','validator']:['task','eventId','validator','fence','receipt','artifact'];
  need(x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).length===fields.length&&fields.every(k=>own(x,k))&&
   id(x.task)&&id(x.eventId)&&seal(x.validator),'invalid_input');
  if(!claim)need(Number.isSafeInteger(x.fence)&&x.fence>0&&id(x.receipt)&&artifact(x.artifact),'invalid_input');
  return atom(()=>{
   const a=access(req,'pa:assignment:'+kind);
   need(a.p.taskIds.has(x.task),'not_authorized');
   const event=hash([a.binding,kind,x.eventId]),exact=hash(fields.map(k=>x[k]));
   const check=[...sql.exec('SELECT payload FROM lab_muse_intent WHERE key=?',event)][0];
   if(check){need(check.payload===exact,'assignment_conflict');return {state:'already_observed'};}
   const p=project(a,[x.task]),card=p.cards[0];
   need(visible(a,card)&&validateCard(a,card)===x.validator,'assignment_conflict');
   if(claim)need(card.state==='ready','assignment_conflict');
   else{
    const lease=[...sql.exec('SELECT binding FROM lab_muse_lease WHERE board=? AND task=? AND fence=?',a.p.board,x.task,x.fence)][0];
    need(card.state==='running'&&card.fence===x.fence&&lease?.binding===a.binding,'assignment_conflict');
   }
   const shared={task:x.task,id:'msc-'+event};
   const command=claim?{...shared,type:'claim',worker:a.p.subject,leaseMs:120000}:
    {...shared,type:'reported',fence:x.fence,receipt:x.receipt,artifact:x.artifact};
   let r;
   try{r=board.append({auth:{scope:a.p.board,subject:a.p.subject,role:'worker'},profile:a.profile,at:clock(),
    expectedVersion:p.asOfVersion,command});}
   catch(e){if(e.name==='BoardConflict')throw error('assignment_conflict');throw e}
   need(r?.committed===true&&!r.permit,'assignment_conflict');
   if(claim)sql.exec('INSERT INTO lab_muse_lease (board,task,fence,binding) VALUES (?,?,?,?)',a.p.board,x.task,card.fence+1,a.binding);
   sql.exec('INSERT INTO lab_muse_intent (key,payload) VALUES (?,?)',event,exact);
   return {state:claim?'leased':'awaiting_coordinator_review'};
  });
 }
 return Object.freeze({
  list(req){
   return atom(()=>{
    const a=access(req,read),p=project(a,[...a.p.taskIds]);
    const cards=p.cards.filter(c=>visible(a,c)).map(c=>({task:c.task,state:c.state,fence:c.fence,validator:validateCard(a,c)}));
    return {cards,validator:validate('muse-list',a.scope,cards)};
   });
  },
  claim:(req,x)=>submit(req,'claim',x),report:(req,x)=>submit(req,'report',x),
 });
}
