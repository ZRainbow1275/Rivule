// Durable offline OpenAssistant create/process experiment. No credentials,
// external execution, or ability to send requests. Tickets are correlations.
import {createHash} from 'node:crypto';
import {prepareOpenAssistant,classifyOpenAssistant,classifyOpenAssistantRead} from '../adapter/openassistant-task-contract.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const name=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,96}$/.test(x);
const validTime=x=>Number.isSafeInteger(x)&&x>=0;
const proofSpan=30_000;
export function makeOpenAssistantTaskJournal({sql,transactionSync,resolveProcessEvidence}){
 if(typeof sql?.exec!=='function'||typeof transactionSync!=='function'||typeof resolveProcessEvidence!=='function')
  throw TypeError('trusted offline transaction host required');
 transactionSync(()=>sql.exec('CREATE TABLE IF NOT EXISTS lab_openassistant_v1 (key TEXT PRIMARY KEY, rev INTEGER NOT NULL, entry TEXT NOT NULL)'));
 function ctx({binding:b,root}){
  if(b?.enabled!==true||b.mode!=='offline-fixture'||b.provider!=='openassistant-rest'||b.keyMode!=='verified-user-key'||
     b.dedicated!==true||b.connectionsDisabled!==true||b.scope!=='public-text'||![b.ownerRef,b.assistantRef,b.lane,root].every(name))
   throw TypeError('OpenAssistant fixture disabled or unbound');
  const scope=[b.ownerRef,b.assistantRef,b.lane,root];
  return {scope,key:sha(JSON.stringify(['lab-openassistant-v1',scope]))};
 }
 const load=c=>{
  const row=[...sql.exec('SELECT rev,entry FROM lab_openassistant_v1 WHERE key=?',c.key)][0];
  if(!row)return null;
  const entry=JSON.parse(row.entry);
  if(!validTime(row.rev)||JSON.stringify(entry.scope)!==JSON.stringify(c.scope))throw Error('corrupt OpenAssistant record');
  return {revision:row.rev,entry};
 };
 const meta=row=>row?{revision:row.revision,state:row.entry.state,taskId:row.entry.taskId}:null;
 function update(c,row,entry){
  const revision=row.revision+1;
  sql.exec('UPDATE lab_openassistant_v1 SET rev=?,entry=? WHERE key=? AND rev=?',revision,JSON.stringify(entry),c.key,row.revision);
  return {committed:true,revision,state:entry.state,taskId:entry.taskId};
 }
 function proof(c,row,args){
  if(!validTime(args.now)||!name(args.approvalId))return false;
  const p=resolveProcessEvidence({scope:[...c.scope],taskId:row.entry.taskId,revision:row.revision,approvalId:args.approvalId});
  return p?.source==='mock-owner-registry'&&JSON.stringify(p.scope)===JSON.stringify(c.scope)&&p.taskId===row.entry.taskId&&
   p.revision===row.revision&&p.approvalId===args.approvalId&&p.approvedDigest===args.approvedDigest&&
   p.explicitProcessApproval===true&&p.verifiedNoExecution===true&&validTime(p.verifiedAt)&&args.now>=p.verifiedAt&&args.now-p.verifiedAt<=proofSpan;
 }
 return Object.freeze({
  async reserveCreate(args){
   const c=ctx(args);if(!validTime(args.now))throw TypeError('clock required');
   const op=await prepareOpenAssistant({...args,phase:'create',clock:args.now});
   return transactionSync(()=>{
    const row=load(c);
    if(row){
     if(row.entry.create.stamp!==op.entry.stamp)throw Error('original OpenAssistant create input is locked');
     return {committed:false,reason:'no_create_replay',...meta(row)};
    }
    const entry={scope:c.scope,state:'create_sending',taskId:null,create:op.entry,process:null,executionId:null};
    sql.exec('INSERT INTO lab_openassistant_v1 (key,rev,entry) VALUES (?,0,?)',c.key,JSON.stringify(entry));
    return {committed:true,revision:0,state:entry.state,mockTicket:op.entry.stamp,mockRequest:op.mockRequest};
   });
  },
  async reserveProcess(args){
   const c=ctx(args),row=transactionSync(()=>load(c));
   const denied=()=>({committed:false,reason:'no_process_permit',...meta(row)});
   if(!row||row.revision!==args.expectedRevision||row.entry.state!=='task_created'||!proof(c,row,args))return denied();
   const [ownerRef,assistantRef,lane,root]=c.scope;
   const created={state:'task_created',journalVerified:true,root,ownerRef,assistantRef,lane,taskId:row.entry.taskId,
    explicitProcessApproval:true,verifiedNoExecution:true};
   const op=await prepareOpenAssistant({...args,phase:'process',created,clock:args.now});
   return transactionSync(()=>{
    const fresh=load(c);
    if(!fresh||fresh.revision!==row.revision||fresh.entry.state!=='task_created'||!proof(c,fresh,args))return denied();
    const entry={...fresh.entry,state:'process_sending',process:op.entry};
    return {...update(c,fresh,entry),mockTicket:op.entry.stamp,mockRequest:op.mockRequest};
   });
  },
  observe(args){
   const c=ctx(args);
   return transactionSync(()=>{
    const row=load(c),ob=args.observation,phase=args.phase;
    if(!row||row.revision!==args.expectedRevision||!['create','process'].includes(phase)||
      ![phase+'_sending',phase+'_unknown'].includes(row.entry.state)||
      ob?.source!=='mock-bound-response'||JSON.stringify(ob.scope)!==JSON.stringify(c.scope)||
      row.entry[phase]?.stamp!==args.mockTicket||ob.path!==(phase==='create'?'/api/tasks':'/api/tasks/'+row.entry.taskId+'/process'))
      return {committed:false,reason:'receipt_not_original',...meta(row)};
    const classified=classifyOpenAssistant({entry:row.entry[phase],response:ob.response}),e=row.entry;
    if(phase==='create'&&classified.state==='task_created')return update(c,row,{...e,state:'task_created',taskId:classified.taskId});
    if(phase==='process'&&classified.state==='execution_acknowledged')
      return update(c,row,{...e,state:classified.state,executionId:classified.executionId});
    const state=classified.state==='owner_review_no_replay'?phase+'_collision':phase+'_unknown';
    return e.state===state?{committed:false,reason:'still_waiting',...meta(row)}:update(c,row,{...e,state});
   });
  },
  readPlan(args){
   const c=ctx(args);
   return transactionSync(()=>{
    const row=load(c),e=row?.entry;
    if(!e?.taskId||row.revision!==args.expectedRevision)return {state:'verify_original_attempt'};
    return {...meta(row),mockRequest:{method:'GET',path:'/api/tasks/'+e.taskId,ownerRef:c.scope[0]}};
   });
  },
  classifyResult(args){
   const c=ctx(args);
   return transactionSync(()=>{
    const row=load(c),o=args.observation;
    if(!row?.entry.taskId||row.revision!==args.expectedRevision||o?.source!=='mock-original-read'||
       JSON.stringify(o.scope)!==JSON.stringify(c.scope)||o.method!=='GET'||o.path!=='/api/tasks/'+row.entry.taskId)
     return {state:'verify_original_attempt'};
    // A third-party GET, status text, or artifact claim does not authorize process.
    return classifyOpenAssistantRead({binding:args.binding,receipt:{ownerRef:c.scope[0],assistantRef:c.scope[1],
      lane:c.scope[2],taskId:row.entry.taskId},response:o.response,actualArtifactVerified:false});
   });
  },
  view(args){const c=ctx(args);return transactionSync(()=>meta(load(c)));},
 });
}
