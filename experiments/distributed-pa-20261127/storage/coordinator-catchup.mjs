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
 const channel=s=>digest('coord-channel',s,null);
 const cursor=(s,version)=>({version,proof:digest('coord-cursor',s,version)});
 const frame=(scope,mode,p)=>({channel:channel(scope),mode,cursor:cursor(scope,p.asOfVersion),snapshot:p});
 return Object.freeze({
  bootstrap(req){
   return atom(()=>{
    const s=grant(req);
    return frame(s,'snapshot',journal.projectAll(s[0]));
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
    if(old===n)return {channel:channel(s),mode:'unchanged',cursor:cursor(s,n)};
    const rows=journal.outboxAfter(s[0],old,limit);
    const expected=Math.min(n-old,limit);
    const contiguous=rows.length===expected&&rows.every((r,i)=>r.version===old+i+1);
    return frame(s,contiguous?(n-old>limit?'coalesced':'advanced'):'reset',p);
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
