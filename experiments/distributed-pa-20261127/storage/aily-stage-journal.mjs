// Experimental mock journal. Never opens a provider connection or stores task body.
import {createHash} from 'node:crypto';
import {openAilyTrial,reserveAilyWrite,observeAilyWrite,planAilyRead,reconcileAilyRun,projectAilyArtifact} from '../adapter/feishu-aily-contract.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const rev=x=>Number.isSafeInteger(x)&&x>=0;
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const validTask=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(x);
const laneKey=seed=>sha(JSON.stringify(['rivule-lab-aily',...seed.scope]));
const receipt=(key,v,entry)=>sha(JSON.stringify(['mock-stage-v1',key,v,entry.state,entry.marker]));
const sending=s=>s==='session_sending'||s==='message_sending'||s==='run_sending';
export function makeAilyStageJournal({sql,transactionSync}){
 if(typeof sql?.exec!=='function'||typeof transactionSync!=='function')throw TypeError('transactional SQL required');
 const prep=()=>transactionSync(()=>{
  sql.exec('CREATE TABLE IF NOT EXISTS lab_aily_stage (key TEXT PRIMARY KEY, rev INTEGER NOT NULL, entry TEXT NOT NULL, mock_ticket TEXT)');
  sql.exec('CREATE TABLE IF NOT EXISTS lab_aily_transition (key TEXT NOT NULL, rev INTEGER NOT NULL, phase TEXT NOT NULL, PRIMARY KEY(key,rev))');
 });
 const context=async ({binding,task})=>{
  if(!validTask(task))throw TypeError('invalid task');
  const seed=await openAilyTrial({binding,task,inputDigest:'0'.repeat(64)});
  return {key:laneKey(seed),scope:JSON.stringify(seed.scope)};
 };
 const readInside=({key,scope})=>{
  const rows=[...sql.exec('SELECT rev,entry,mock_ticket FROM lab_aily_stage WHERE key=?',key)];
  if(!rows.length)return null;
  const row=rows[0],entry=JSON.parse(row.entry);
  if(!rev(row.rev)||JSON.stringify(entry.scope)!==scope||!hex(entry.inputDigest)||
     (sending(entry.state)?!hex(row.mock_ticket):row.mock_ticket!==null))throw Error('bad Aily journal');
  return {revision:row.rev,entry,mockTicket:row.mock_ticket};
 };
 const metadata=row=>row?{revision:row.revision,state:row.entry.state}:null;
 const get=c=>transactionSync(()=>readInside(c));
 const initialize=async args=>{
  const seed=await openAilyTrial(args),key=laneKey(seed),scope=JSON.stringify(seed.scope);
  return transactionSync(()=>{
   const row=readInside({key,scope});
   if(row){
    if(row.entry.inputDigest!==seed.inputDigest)throw Error('Aily task input was already locked');
    return {committed:false,...metadata(row)};
   }
   sql.exec('INSERT INTO lab_aily_stage (key,rev,entry,mock_ticket) VALUES (?,0,?,NULL)',key,JSON.stringify(seed));
   sql.exec('INSERT INTO lab_aily_transition (key,rev,phase) VALUES (?,0,?)',key,seed.state);
   return {committed:true,revision:0,state:seed.state};
  });
 };
 const hydrate=async (args)=>{
  if(!rev(args.expectedRevision))throw TypeError('current Aily revision required');
  const ctx=await context(args),row=get(ctx);
  return {ctx,row,ok:row?.revision===args.expectedRevision};
 };
 const stale=row=>({committed:false,reason:row?'changed':'not_found',...metadata(row)});
 const noChange=row=>({committed:false,reason:'no_transition',...metadata(row)});
 function commit(ctx,previous,entry,mockRequest=null){
  return transactionSync(()=>{
   const current=readInside(ctx);
   if(!current||current.revision!==previous.revision||current.mockTicket!==previous.mockTicket)return stale(current);
   if(entry===previous.entry)return noChange(current);
   const v=current.revision+1;
   const ticket=mockRequest?receipt(ctx.key,v,entry):null;
   if(sending(entry.state)!==!!ticket)throw Error('invalid stage transition');
   sql.exec('UPDATE lab_aily_stage SET rev=?,entry=?,mock_ticket=? WHERE key=? AND rev=?',
    v,JSON.stringify(entry),ticket,ctx.key,current.revision);
   sql.exec('INSERT INTO lab_aily_transition (key,rev,phase) VALUES (?,?,?)',ctx.key,v,entry.state);
   return {committed:true,revision:v,state:entry.state,...(mockRequest?{mockTicket:ticket,mockRequest}: {})};
  });
 }
 const reserve=async(args)=>{
  const {ctx,row,ok}=await hydrate(args);
  if(!ok)return stale(row);
  const {entry,mockRequest}=await reserveAilyWrite({binding:args.binding,entry:row.entry,
   approvedText:args.approvedText,at:args.at,manualReplay:args.manualReplay===true});
  // Return the one-shot mock envelope only after synchronous transaction commits.
  return commit(ctx,row,entry,mockRequest);
 };
 const observe=async(args)=>{
  const {ctx,row,ok}=await hydrate(args);
  if(!ok)return stale(row);
  if(!row.mockTicket||args.mockTicket!==row.mockTicket)return {committed:false,reason:'different_attempt',...metadata(row)};
  const entry=await observeAilyWrite({binding:args.binding,entry:row.entry,response:args.response});
  return commit(ctx,row,entry);
 };
 const recoverAmbiguous=async(args)=>{
  // If the sending process disappeared, we cannot infer whether it actually sent.
  const {ctx,row,ok}=await hydrate(args);
  if(!ok)return stale(row);
  if(!row.mockTicket)return noChange(row);
  const entry=await observeAilyWrite({binding:args.binding,entry:row.entry,response:undefined});
  return commit(ctx,row,entry);
 };
 const view=async(args)=>{
  const row=get(await context(args));
  return row?{...metadata(row),plannedReads:planAilyRead({binding:args.binding,entry:row.entry})}:null;
 };
 const reconcile=async(args)=>{
  const {ctx,row,ok}=await hydrate(args);
  if(!ok)return stale(row);
  if(row.mockTicket)return noChange(row);
  return commit(ctx,row,reconcileAilyRun({binding:args.binding,entry:row.entry,response:args.response}));
 };
 const artifact=async(args)=>{
  const {ctx,row,ok}=await hydrate(args);
  if(!ok)return {state:'result_unverified'};
  // Transfer for a review only. Neither text nor acceptance is auto-written.
  return projectAilyArtifact({binding:args.binding,entry:row.entry,response:args.response});
 };
 return Object.freeze({prepare:prep,initialize,reserve,observe,recoverAmbiguous,view,reconcile,artifact});
}
