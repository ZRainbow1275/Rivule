// Separate disabled-by-default board bridge, canonical state and provider receipt
// commit together. Only mock requests are emitted, and only after commit.
import {attemptKey} from '../src/sdk/coordination-board.mjs';
import {makeSqlJournal} from './sql-journal.mjs';
import {makeViktorRestFixture,sha} from './viktor-rest-fixture.mjs';

export function makeViktorBoardFixture({enabled=false,sql,transactionSync,resolve}){
 if(enabled!==true||typeof resolve!=='function'||typeof transactionSync!=='function')throw TypeError('offline Viktor bridge not enabled');
 let depth=0;
 const atom=fn=>depth?fn():transactionSync(()=>{depth++;try{return fn()}finally{depth--}});
 const common={sql,transactionSync:atom},board=makeSqlJournal(common),vk=makeViktorRestFixture(common);
 board.prepare();
 function bind(args,role){
  const {auth,task,fence,at}=args;
  if(auth?.role!==role||!Number.isSafeInteger(at)||at<0)throw TypeError('bound role and clock required');
  const key=attemptKey(auth.scope,task,fence),r=resolve({scope:auth.scope,task});
  if(!r||r.scope!==auth.scope||r.task!==task||r.profile?.provider!=='viktor-rest'||r.profile.authorized!==true||
   r.profile.ready!==true||r.profile.lane!==r.binding?.lane||r.profile.dataRegions?.length!==1||
   r.profile.dataRegions[0]!=='us'||(role==='worker'?r.profile.worker!==auth.subject:r.coordinator!==auth.subject))
   throw TypeError('Viktor board enrollment missing');
  return {...r,key,va:{binding:r.binding,task:'vb-'+sha(key),expectedRevision:args.expectedProviderRevision}};
 }
 function gate(args,role,states,fn){
  return atom(()=>{
   const r=bind(args,role);
   const p=board.project({scope:args.auth.scope,selected:[args.task],readable:[args.task]}),c=p.cards[0];
   if(p.asOfVersion!==args.expectedBoardVersion||c?.fence!==args.fence||c.worker!==r.profile.worker||
      !states.includes(c.state)||c.deliveryState==='owner_input_required')return {committed:false,reason:'stale_or_held_board'};
   return fn(r);
  });
 }
 function append(a,type,fields,extra){
  return board.append({auth:a.auth,expectedVersion:a.expectedBoardVersion,at:a.at,
   command:{type,id:a.eventId,task:a.task,fence:a.fence,...fields},...extra});
 }
 return Object.freeze({
  board,
  start(args){
   return gate(args,'worker',['leased'],r=>{
    const c=append(args,'begin',{}, {profile:r.profile});
    if(!c.committed||c.permit?.key!==r.key||c.permit.provider!=='viktor-rest'||c.permit.lane!==r.binding.lane)
     throw Error('Viktor board permit mismatch');
    const v=vk.reserve({...r.va,inputDigest:c.permit.inputDigest,approvedText:args.approvedText});
    if(!v.committed)throw Error('Viktor one-shot reservation missing');
    return {...v,boardVersion:c.version};
   });
  },
  observeCreate(args){
   return gate(args,'worker',['submitting'],r=>{
    const v=vk.observeCreate({...r.va,mockTicket:args.mockTicket,observation:args.observation});
    if(!v.committed||v.state!=='acknowledged')return v;
    const receipt=vk.view(r.va).run;
    const c=append(args,'acknowledged',{receipt},{});
    if(!c.committed)throw Error('Viktor board acknowledgment missing');
    return {...v,boardVersion:c.version};
   });
  },
  readPlan(args){return gate(args,'coordinator',['running','needs_review'],r=>vk.readPlan(r.va));},
  observeStatus(args){
   return gate(args,'coordinator',['running','needs_review'],r=>vk.observeStatus({...r.va,observation:args.observation}));
  },
  checkpoint(args){
   return gate(args,'coordinator',['running','needs_review'],r=>{
    const v=vk.observeResult({...r.va,observation:args.observation});
    if(!v.committed)return v;
    const observed=vk.view(r.va),artifact=observed.digest,receipt=observed.run;
    const verdict=v.state==='owner_input_required'?'owner_input_required':'result_verified';
    const digest=sha(JSON.stringify(['viktor-board-v1',r.key,receipt,artifact,v.revision,verdict]));
    const c=append(args,'viktor_checkpoint',{attestation:digest},{attestation:{verified:true,scope:args.auth.scope,
     task:args.task,fence:args.fence,worker:r.profile.worker,provider:r.profile.provider,lane:r.binding.lane,
     key:r.key,digest,verdict,receipt,artifact}});
    if(!c.committed)throw Error('Viktor board checkpoint missing');
    return {committed:true,boardVersion:c.version,providerRevision:v.revision,phase:v.state};
   });
  },
 });
}
