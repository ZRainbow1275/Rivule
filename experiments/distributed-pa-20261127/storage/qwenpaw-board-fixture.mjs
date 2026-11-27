// Off by default, one lab SQLite database. No outbound transport, paid seat,
// account discovery, room-wide disclosure or production board changes.
import {attemptKey} from '../src/sdk/coordination-board.mjs';
import {sha,scopeFor} from '../adapter/qwenpaw-recovery.mjs';
import {makeSqlJournal} from './sql-journal.mjs';
import {makeQwenPawTrial} from './qwenpaw-recovery-journal.mjs';

export function makeQwenPawBoardFixture({enabled=false,sql,transactionSync,resolve}){
 if(enabled!==true||typeof resolve!=='function'||typeof transactionSync!=='function')throw TypeError('offline bridge not enabled');
 // The outer BEGIN owns commit; inner operations never nest BEGIN or expose a
 // send to the host before the outer transaction succeeds.
 let depth=0;
 const atom=fn=> depth?fn():transactionSync(()=>{
  depth++;
  try{return fn()}finally{depth--}
 });
 const common={sql,transactionSync:atom},board=makeSqlJournal(common),qp=makeQwenPawTrial(common);
 board.prepare();
 const by=(args,role)=>{
  const {auth,task,fence}=args;
  if(auth?.role!==role||!Number.isSafeInteger(fence)||fence<1||!Number.isSafeInteger(args.at)||args.at<0)
   throw TypeError('bound role and clock required');
  const key=attemptKey(auth.scope,task,fence);
  // Registry is supplied by the trusted fixture host, never from a provider
  // response or a worker request. Require explicit coordinator enrollment.
  const row=resolve({scope:auth.scope,task});
  if(!row||row.scope!==auth.scope||row.task!==task||row.profile?.provider!=='qwenpaw'||row.profile.authorized!==true||row.profile.ready!==true||
     row.profile.lane!==row.binding.lane||
     (role==='worker'?auth.subject!==row.profile.worker:auth.subject!==row.coordinator))
   throw TypeError('QwenPaw board enrollment missing');
  const adapterTask='qp-'+sha(JSON.stringify([key]));
  scopeFor(row.binding,adapterTask);
  return {...row,key,qa:{binding:row.binding,task:adapterTask}};
 };
 const card=(scope,task)=>board.project({scope,selected:[task],readable:[task]});
 const append=(args,type,fields,extra)=>board.append({auth:args.auth,expectedVersion:args.expectedBoardVersion,
  at:args.at,command:{type,id:args.eventId,task:args.task,fence:args.fence,...fields},...extra});
 const check=(args,r)=>{
  const p=card(args.auth.scope,args.task),c=p.cards[0];
  if(p.asOfVersion!==args.expectedBoardVersion||!c||c.state!=='needs_review'||c.fence!==args.fence||
    c.worker!==r.profile.worker)return false;
  return true;
 };
 const gate=(args,fn)=>atom(()=>{
  const r=by(args,'coordinator');
  if(!check(args,r))return {committed:false,reason:'stale_board'};
  return fn(r, {...r.qa,expectedRevision:args.expectedProviderRevision,proof:args.proof,now:args.at});
 });
 return Object.freeze({
  board,
  start(args){
   return atom(()=>{
    const r=by(args,'worker'),c=append(args,'begin',{}, {profile:r.profile});
    if(c.duplicate)return {committed:false,reason:'duplicate'};
    if(!c.committed||!c.permit||c.permit.key!==r.key||c.permit.lane!==r.binding.lane||
       c.permit.provider!=='qwenpaw')throw Error('QwenPaw permit mismatch');
    const v=qp.reserve({...r.qa,approvedText:args.approvedText,inputDigest:c.permit.inputDigest});
    if(!v.committed||!v.mockRequest)throw Error('one-shot provider reservation missing');
    return {committed:true,boardVersion:c.version,providerRevision:v.revision,mockRequest:v.mockRequest};
   });
  },
  markUncertain(args){return atom(()=>{const r=by(args,'worker');if(!qp.view(r.qa))throw Error('no original QwenPaw reservation');return append(args,'uncertain',{},{});});},
  bind(args){return gate(args,(_r,qa)=>qp.bind(qa));},
  attach(args){return gate(args,(_r,qa)=>qp.reattach(qa));},
  history(args){return gate(args,(_r,qa)=>qp.history(qa));},
  reconcile(args){
   return gate(args,(r,qa)=>{
    const v=qp.reconcile({...qa,observation:args.observation});
    if(!v.committed)return v;
    const artifact=qp.view(r.qa).artifact.digest,receipt=args.proof.chat;
    const digest=sha(JSON.stringify(['qp-board-fixture-v1',r.key,receipt,artifact,v.revision]));
    const c=append(args,'reconcile',{attestation:digest},{attestation:{
      verified:true,scope:args.auth.scope,task:args.task,fence:args.fence,worker:r.profile.worker,
      provider:'qwenpaw',lane:r.profile.lane,key:r.key,digest,verdict:'result_verified',receipt,artifact}});
    if(!c?.committed)throw Error('QwenPaw board reconcile did not commit');
    return {committed:true,boardVersion:c.version,providerRevision:v.revision,phase:'awaiting_main_agent',artifact};
   });
  },
 });
}
