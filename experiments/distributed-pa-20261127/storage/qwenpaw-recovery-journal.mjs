import {scopeFor,sha,prepare,verifiedBinding,attachOnly,exactHistory,historyArtifact} from '../adapter/qwenpaw-recovery.mjs';

export function makeQwenPawTrial({sql,transactionSync}){
 if(typeof sql?.exec!=='function'||typeof transactionSync!=='function')throw TypeError('QwenPaw transaction required');
 transactionSync(()=>sql.exec('CREATE TABLE IF NOT EXISTS lab_qwenpaw_v1 (key TEXT PRIMARY KEY, rev INTEGER NOT NULL, entry TEXT NOT NULL)'));
 const context=args=>{
  const scope=scopeFor(args.binding,args.task);
  return {scope,key:sha(JSON.stringify(['qwenpaw-fixture-v1',scope]))};
 };
 const read=({key,scope})=>{
  const row=[...sql.exec('SELECT rev,entry FROM lab_qwenpaw_v1 WHERE key=?',key)][0];
  if(!row)return null;
  const {rev}=row,entry=JSON.parse(row.entry);
  if(!Number.isSafeInteger(rev)||rev<0||JSON.stringify(entry.scope)!==JSON.stringify(scope))throw Error('bad QwenPaw state');
  return {rev,entry};
 };
 const state=row=>row?{revision:row.rev,phase:row.entry.phase}:null;
 const mutation=(args,fn)=>{
  const ctx=context(args);
  if(!Number.isSafeInteger(args.expectedRevision)||args.expectedRevision<0)throw TypeError('expected QwenPaw revision required');
  return transactionSync(()=>{
   const prev=read(ctx), expected=args.expectedRevision;
   if(!prev||prev.rev!==expected)return {committed:false,...state(prev),reason:'stale'};
   const answer=fn(prev.entry);
   if(!answer)return {committed:false,...state(prev),reason:'manual_review'};
   const {entry,request}=answer;
   const revision=expected+1;
   sql.exec('UPDATE lab_qwenpaw_v1 SET rev=?,entry=? WHERE key=? AND rev=?',revision,JSON.stringify(entry),ctx.key,expected);
   return {committed:true,revision,phase:entry.phase,...(request?{mockRequest:request}:{})};
  });
 };
 return Object.freeze({
  reserve(args){
   const ctx=context(args),next=prepare(ctx.scope,args.approvedText,args.inputDigest);
   return transactionSync(()=>{
    const prev=read(ctx);
    if(prev){
     if(prev.entry.inputDigest!==next.entry.inputDigest)throw Error('original prompt locked');
     return {committed:false,...state(prev),reason:'already_reserved'};
    }
    sql.exec('INSERT INTO lab_qwenpaw_v1 (key,rev,entry) VALUES (?,0,?)',ctx.key,JSON.stringify(next.entry));
    return {committed:true,revision:0,phase:next.entry.phase,mockRequest:next.request};
   });
  },
  bind(args){
   return mutation(args,entry=>entry.phase==='awaiting_binding'&&verifiedBinding(entry,args.proof,args.now)?
    {entry:{...entry,phase:'bound',chat:args.proof.chat}}:null);
  },
  reattach(args){
   return mutation(args,entry=>entry.phase==='bound'&&!entry.attached&&verifiedBinding(entry,args.proof,args.now)?
    {entry:{...entry,attached:true},request:attachOnly(entry)}:null);
  },
  history(args){
   const ctx=context(args);
   return transactionSync(()=>{
    const row=read(ctx);
    return row?.rev===args.expectedRevision&&row?.entry.phase==='bound'&&verifiedBinding(row.entry,args.proof,args.now)?
     {revision:row.rev,mockRequest:exactHistory(row.entry)}:{...state(row),reason:'manual_review'};
   });
  },
  reconcile(args){
   return mutation(args,entry=>{
    if(!verifiedBinding(entry,args.proof,args.now))return null;
    const artifact=historyArtifact(entry,args.observation);
    return artifact?{entry:{...entry,artifact,phase:'awaiting_main_agent'}}:null;
   });
  },
  view(args){
   const ctx=context(args);
   return transactionSync(()=>{
    const row=read(ctx);
    return row?{...state(row),artifact:row.entry.artifact}:null;
   });
  },
 });
}
