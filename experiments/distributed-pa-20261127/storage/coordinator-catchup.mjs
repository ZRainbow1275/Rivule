// Sync-only lab authority view. An outbox entry invalidates a read model,
// never dispatches or replays a provider action. No PA surface uses this.
import {makeScopedValidator} from '../src/sdk/scoped-validator.mjs';
import {makeSqlJournal} from './sql-journal.mjs';

const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(x);
const proof=x=>typeof x==='string'&&/^sv1-[\w-]{43}$/.test(x);
const rev=x=>Number.isSafeInteger(x)&&x>=0&&x<=4096;
const err=code=>Object.assign(new Error(code),{code});
const requireThat=(ok,code)=>{if(!ok)throw err(code)};
const validCursor=c=>c&&Object.getPrototypeOf(c)===Object.prototype&&Object.keys(c).length===2&&rev(c.version)&&proof(c.proof);

export function makeCoordinatorCatchup({enabled=false,sql,transactionSync,resolve,validatorKey,limit=40}){
 requireThat(enabled===true&&typeof transactionSync==='function'&&typeof resolve==='function','catchup_disabled');
 requireThat(Number.isSafeInteger(limit)&&limit>=1&&limit<=100,'invalid_window');
 const digest=makeScopedValidator(validatorKey);
 let depth=0;
 const atom=f=>depth?f():transactionSync(()=>{depth++;try{return f()}finally{depth--}});
 const journal=makeSqlJournal({sql,transactionSync:atom});
 journal.prepare();
 function grant(req){
  const p=resolve(req);
  requireThat(p?.active===true&&p.role==='coordinator'&&p.fullBoard===true&&
   [p.board,p.subject,p.policyEpoch,p.view].every(id)&&p.rights instanceof Set&&p.rights.has('coordinator:board:replay'),
   'not_authorized');
  return [p.board,p.subject,p.policyEpoch,p.view];
 }
 const release=(req,prior,value)=>{
  const current=grant(req);
  requireThat(prior.every((v,i)=>v===current[i]),'grant_changed');
  return value;
 };
 const channel=s=>digest('coord-channel',s,null);
 const cursor=(s,version)=>({version,proof:digest('coord-cursor',s,version)});
 const frame=(scope,mode,p)=>({channel:channel(scope),mode,cursor:cursor(scope,p.asOfVersion),snapshot:p});
 return Object.freeze({
  bootstrap(req){
   return atom(()=>{
    const s=grant(req);
    return release(req,s,frame(s,'snapshot',journal.projectAll(s[0])));
   });
  },
  poll(req,previous){
   return atom(()=>{
    const s=grant(req);
    requireThat(validCursor(previous)&&previous.proof===cursor(s,previous.version).proof,'invalid_cursor');
    // Canonical snapshot and durable outbox page share the exact same read txn.
    // A commit immediately after it remains discoverable through this cursor.
    const p=journal.projectAll(s[0]),n=p.asOfVersion,old=previous.version;
    requireThat(old<=n,'cursor_ahead');
    if(old===n)return release(req,s,{channel:channel(s),mode:'unchanged',cursor:cursor(s,n)});
    const rows=journal.outboxAfter(s[0],old,limit);
    const expected=Math.min(n-old,limit);
    const contiguous=rows.length===expected&&rows.every((r,i)=>r.version===old+i+1);
    return release(req,s,frame(s,contiguous?(n-old>limit?'coalesced':'advanced'):'reset',p));
   });
  },
 });
}
// Client-only reducer; pin channel from a freshly authenticated bootstrap in
// the active view. Never downgrade the same view based on a late response.
export function receiveCoordinatorFrame(current,activeChannel,response){
 if(!proof(activeChannel)||response?.channel!==activeChannel||!validCursor(response.cursor)||
  !['snapshot','advanced','coalesced','reset','unchanged'].includes(response.mode))return current;
 if(!current&&response.mode!=='snapshot')return current;
 if(current&&(current.channel!==activeChannel||response.cursor.version<=current.cursor.version))return current;
 if(response.mode==='unchanged'||response.snapshot?.asOfVersion!==response.cursor.version||!Array.isArray(response.snapshot?.cards))return current;
 return {channel:activeChannel,cursor:{...response.cursor},snapshot:structuredClone(response.snapshot)};
}


// One lifecycle per browser window. Ignore old callbacks even if a transport
// could not cancel them. Denial or explicit revoke clears captured UI state
// before any re-authenticated bootstrap, never treating old data as stale cache.
export function makeCoordinatorViewSession(){
 let generation=Object.freeze({}),snapshot=null,phase='awaiting_bootstrap';
 const reset=next=>{generation=Object.freeze({});snapshot=null;phase=next;};
 return Object.freeze({
  start(){reset('awaiting_bootstrap');return generation;},
  revoke(){reset('revoked');},
  pollTicket(){return phase==='active'?generation:null;},
  current(){return {phase,board:snapshot?structuredClone(snapshot.snapshot):null};},
  cursor(){return phase==='active'?{...snapshot.cursor}:null;},
  receive(ticket,response){
   if(ticket!==generation||phase==='revoked')return false;
   if(['not_authorized','invalid_cursor','grant_changed'].includes(response?.error)){
    reset('revoked');return true;
   }
   if(phase==='awaiting_bootstrap'&&response?.mode!=='snapshot')return false;
   if(phase==='active'&&response?.mode==='snapshot')return false;
   const next=receiveCoordinatorFrame(snapshot,snapshot?.channel??response?.channel,response);
   if(next===snapshot)return false;
   snapshot=next;phase='active';return true;
  },
 });
}
