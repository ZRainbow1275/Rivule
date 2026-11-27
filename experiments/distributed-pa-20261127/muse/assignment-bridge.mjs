// A server-side, credential-free seam for the consumer Muse Custom Connector.
// resolve(currentRequest) is the host's verified per-source OAuth principal.
// A display name or upstream model-issued identifier must never act as uid.
const ids=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const eventKey=async(kind, owner, clientId)=>{
 const b=new TextEncoder().encode(JSON.stringify([owner.board,owner.subject,clientId]));
 const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',b));
 return 'muse-'+kind+'-'+Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');
};
const roles=(s,expected)=>s?.scopes?.has?.(expected)===true;
const hostError=code=>Object.assign(new Error(code),{code});
const check=(ok,code)=>{if(!ok)throw hostError(code);};
const descriptors=[
 {name:'list_my_assignments',readOnly:true,scope:'pa:assignment:read'},
 {name:'claim_assignment',readOnly:false,scope:'pa:assignment:claim'},
 {name:'submit_artifact',readOnly:false,scope:'pa:assignment:report'}
].map(o=>Object.freeze(o));
export const assignmentToolDescriptors=Object.freeze(descriptors);

export function makeMuseAssignmentBridge({resolve,load,append}){
 check([resolve,load,append].every(x=>typeof x==='function'),'host_binding_required');
 async function authenticate(request,scope){
  const owner=await resolve(request);
  check(ids(owner?.board)&&ids(owner?.subject)&&owner?.provider==='muse-personal'&&owner.active===true&&roles(owner,scope),'not_authorized');
  const profile=owner.profile;
  check(profile?.provider==='muse-personal'&&profile.worker===owner.subject&&profile.authorized===true&&profile.ready===true&&ids(profile.lane),'unavailable');
  check(owner.taskIds instanceof Set&&[...owner.taskIds].every(ids),'assignment_scope_unavailable');
  return {owner,profile};
 }
 function requestScope(task,owner){check(ids(task)&&owner.taskIds.has(task),'not_authorized');}
 function hostCommand(kind,input){
  check(input&&typeof input==='object'&&Object.getPrototypeOf(input)===Object.prototype,'invalid_input');
  const fields=kind==='claim'?['task','eventId','expectedVersion']:['task','eventId','expectedVersion','fence','receipt','artifact'];
  check(Object.keys(input).length===fields.length&&fields.every(x=>Object.hasOwn(input,x))&&ids(input.eventId)&&input.eventId.length<=55&&
        Number.isSafeInteger(input.expectedVersion)&&input.expectedVersion>=0,'invalid_input');
  if(kind==='report')check(Number.isSafeInteger(input.fence)&&input.fence>0&&ids(input.receipt)&&digest(input.artifact),'invalid_input');
  return input;
 }
 return Object.freeze({
  async list(request){
   const {owner}=await authenticate(request,'pa:assignment:read');
   // Host load must use the same authorized selection and never load raw tasks to return to clients.
   const p=await load({scope:owner.board,subject:owner.subject,selected:[...owner.taskIds],readable:[...owner.taskIds]});
   check(p?.scope===owner.board&&Number.isSafeInteger(p.asOfVersion)&&Array.isArray(p.cards),'view_unavailable');
   return {asOfVersion:p.asOfVersion,cards:p.cards.filter(c=>owner.taskIds.has(c.task)&&(!c.worker||c.worker===owner.subject)&&
          ['ready','leased','submitting','running','needs_review','reported','accepted'].includes(c.state)).map(c=>({
    task:c.task,state:c.state,fence:c.fence,taskVersion:c.taskVersion,
   }))};
  },
  async claim(request,input){
   const {owner,profile}=await authenticate(request,'pa:assignment:claim');
   const x=hostCommand('claim',input);requestScope(x.task,owner);
   const result=await append({auth:{scope:owner.board,subject:owner.subject,role:'worker'},profile,expectedVersion:x.expectedVersion,
          command:{type:'claim',id:await eventKey('claim',owner,x.eventId),task:x.task,worker:owner.subject,leaseMs:120000}});
   // append returns only after authenticated CAS in the assignment's authority.
   check(result?.committed||result?.duplicate,'lease_conflict');
   return {state:result.duplicate?'already_observed':'leased',version:result.version};
  },
  async report(request,input){
   const {owner,profile}=await authenticate(request,'pa:assignment:report');
   const x=hostCommand('report',input);requestScope(x.task,owner);
   // Report refers to an already committed dispatch receipt from the same attempt.
   const result=await append({auth:{scope:owner.board,subject:owner.subject,role:'worker'},profile,expectedVersion:x.expectedVersion,
          command:{type:'reported',id:await eventKey('report',owner,x.eventId),task:x.task,fence:x.fence,receipt:x.receipt,artifact:x.artifact}});
   check(result?.committed||result?.duplicate,'report_conflict');
   return {state:result.duplicate?'already_observed':'awaiting_coordinator_review',version:result.version};
  },
 });
}
