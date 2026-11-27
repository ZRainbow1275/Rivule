// Server-only, opt-in DuMate adapter. No default network transport or secret source.
// The host supplies an authenticated grant resolver and a durable, atomic write gate.
class StreamInterrupted extends Error{}
const BASE='https://api.dumate.cn/api/dma/v1';
const RX=/^[A-Za-z0-9_-]{1,128}$/;
const id=(v,p='')=>typeof v==='string'&&RX.test(v)&&v.startsWith(p)&&v.length>p.length;
const compact=(v,n)=>typeof v==='string'&&v.length>0&&v.length<=n;
const noItems=v=>Array.isArray(v)&&v.length===0;
const enc=new TextEncoder();
const sha=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
const problem=(state,reason)=>Object.freeze({state,reason});
const LIMIT=128*1024, MAX_EVENTS=1600, MAX_PAGES=32;
const fields=['principal','project','bindingId','region','credentialRef','agentId','agentVersion','environmentId','budgetPoints'];
const same=(a,b)=>fields.every(k=>a[k]===b[k]);
const signedFields=['taskId','fence','inputDigest'];
const fail=()=>{throw new Error('invalid provider receipt')};
const textBlock=(a)=>Array.isArray(a)&&a.length===1&&a[0]?.type==='text'?a[0].text:undefined;
const resultText=a=>Array.isArray(a)&&a.length>0&&a.every(b=>b?.type==='text'&&typeof b.text==='string')?a.map(b=>b.text).join(''):null;
const emptyAgent=a=>a?.multiagent===null&&['tools','mcp_servers','skills','files'].every(k=>noItems(a[k]));
const budget=b=>({type:'limit',max_list_cost:{amount:String(b.budgetPoints),currency:'POINT'}});
const phaseNew=()=>({seen:new Map(),own:false,ran:false,output:null,lastId:null,state:'enqueued',reason:null,terminal:false});
function stop(f,state,reason){f.state=state;f.reason=reason;f.terminal=true}
function publicPhase(f){
  const p={state:f.state,reason:f.reason,lastEventId:f.lastId};
  if(f.state==='awaiting_review')p.candidate=Object.freeze({...f.output});
  return Object.freeze(p);
}
const EVENT=/^[a-z][a-z0-9_.]{0,90}$/;
function validEvent(e){return e&&id(e.id,'sevt_')&&typeof e.type==='string'&&EVENT.test(e.type)&&typeof e.processed_at==='string'&&/^\d{4}-\d\d-\d\dT[^\s]{8,28}Z$/.test(e.processed_at)&&Number.isFinite(Date.parse(e.processed_at))}
async function fold(f,e,r){
  if(f.terminal)return;
  if(!validEvent(e))fail();
  const {id:eid,type:t}=e;
  // Compare the material properties when accepting replay; do not retain opaque tool payloads.
  const key=await sha(JSON.stringify([t,e.processed_at,e.stop_reason?.type??null,
    ['user.message','agent.message'].includes(t)?(e.content??[]).map(b=>[b?.type,b?.text]):null,e.retry_status?.type??null]));
  if(f.seen.has(eid)){if(f.seen.get(eid)!==key)stop(f,'needs_review','event_id_conflict');return}
  if(f.seen.size>=MAX_EVENTS)fail();
  f.seen.set(eid,key);f.lastId=eid;
  if(t==='user.message'){
    if(eid!==r.ack||textBlock(e.content)!==r.text||f.own){stop(f,'needs_review','another_or_mismatched_input');return}
    f.own=true;f.state='input_observed';return;
  }
  if(t==='session.updated'||t==='user.interrupt'||t==='session.deleted'||t==='session.status_terminated'){
    stop(f,'needs_review','session_changed_or_closed');return;
  }
  // This adapter binds a dedicated, single-agent, text-only version.
  if(t.startsWith('agent.thread_')||t.startsWith('session.thread_')||t.startsWith('user.tool')||t==='user.custom_tool_result'||/^agent\.(?:mcp_|custom_)?tool_/.test(t)){
    stop(f,'needs_review','outside_text_only_binding');return;
  }
  if(!f.own)return;
  if(t==='session.status_running'){f.ran=true;f.state='running';return}
  if(t==='session.error'&&['terminal','exhausted'].includes(e.retry_status?.type)){
    stop(f,'provider_stopped','provider_error');return;
  }
  if(t==='agent.message'){
    const out=resultText(e.content);
    if(f.ran&&typeof out==='string'&&out.trim()&&enc.encode(out).length<=32*1024)f.output={eventId:eid,text:out};
    else stop(f,'needs_review','unusable_agent_artifact');
    return;
  }
  if(t!=='session.status_idle')return;
  const reason=e.stop_reason?.type;
  if(reason==='requires_action')stop(f,'needs_owner_action',reason);
  else if(['budget_reached','refusal','retries_exhausted'].includes(reason))stop(f,'provider_stopped',reason);
  else if(reason==='end_turn'&&f.ran&&f.output)stop(f,'awaiting_review','provider_ended_turn');
  else stop(f,'needs_review','idle_without_correlated_artifact');
}
async function safeJSON(res){
  if(!/^application\/json(?:\s*;|$)/i.test(res.headers.get('content-type')??'')){await cancel(res);fail()}
  if(!res.body||Number(res.headers.get('content-length')??0)>LIMIT){await cancel(res);fail()}
  const reader=res.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;if(!(value instanceof Uint8Array)||(size+=value.byteLength)>LIMIT)fail();chunks.push(value)}
    const bytes=new Uint8Array(size);let i=0;for(const c of chunks){bytes.set(c,i);i+=c.length}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }finally{try{await reader.cancel()}catch{}reader.releaseLock()}
}
async function cancel(res){try{await res?.body?.cancel()}catch{}}
async function* frames(response){
  const reader=response.body.getReader(),dec=new TextDecoder('utf-8',{fatal:true});
  let pending='',omitLF=false,event=null,eid=null,data=[],size=0,lines=0,wireBytes=0;
  function line(s){
    if(s===''){
      let value=null;
      if(data.length){
        if(event==='event_delta'||event==='event_start'){} // Preview frames are not receipts and carry no resume cursor.
        else{
          const e=JSON.parse(data.join('\n'));
          if(!validEvent(e)||e.type!==event||e.id!==eid)fail();value=e;
        }
      }else if(event!==null||eid!==null)fail();
      event=null;eid=null;data=[];size=0;lines=0;return value;
    }
    if(++lines>4096||(size+=s.length)>LIMIT)fail();
    if(s[0]===':')return null;
    const split=s.indexOf(':'),field=split<0?s:s.slice(0,split);
    let v=split<0?'':s.slice(split+1);if(v.startsWith(' '))v=v.slice(1);
    if(field==='event'){if(event!==null)fail();event=v}
    else if(field==='id'){if(eid!==null)fail();eid=v}
    else if(field==='data'){data.push(v)}
    return null;
  }
  try{for(;;){
    let next;try{next=await reader.read()}catch{throw new StreamInterrupted()}
    const {value,done}=next;
    if(!done&&(!(value instanceof Uint8Array)||(wireBytes+=value.byteLength)>4*1024*1024))fail();
    const chunk=done?dec.decode():dec.decode(value,{stream:true});
    for(const ch of chunk){
      if(ch==='\n'&&omitLF){omitLF=false;continue}omitLF=ch==='\r';
      if(ch==='\n'||ch==='\r'){const e=line(pending);pending='';if(e)yield e}
      else{pending+=ch;if(pending.length>LIMIT)fail()}
    }
    if(done)break; // An incomplete final SSE frame is never acknowledged.
  }}finally{try{await reader.cancel()}catch{}reader.releaseLock()}
}
export const duMateCapability=Object.freeze({
  provider:'baidu-dumate',region:'CN',defaultEnabled:false,mode:'server-only/text-only',
  evidence:'mock-contract-tests',providerBase:BASE,automaticWrites:0,
});
export function makeDuMateAdapter(options={}){
  if(options.enabled!==true){
    const disabled=async()=>problem('disabled','binding_not_enabled');
    return Object.freeze({dispatch:disabled,observe:disabled,reconcile:disabled,restore:disabled});
  }
  const {fetcher,getToken,authorize,claimWrite,recordReceipt,loadReceipt,now=Date.now,timeoutMs=12000}=options;
  if(![fetcher,getToken,authorize,claimWrite,recordReceipt,loadReceipt,now].every(fn=>typeof fn==='function')||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new TypeError('injected server bindings required');
  const b=Object.freeze(Object.fromEntries(fields.map(k=>[k,options.binding?.[k]])));
  if(!['principal','project','bindingId','credentialRef'].every(k=>id(b[k]))||b.region!=='CN'||
    !id(b.agentId,'agt_')||!id(b.environmentId,'env_')||
    !Number.isSafeInteger(b.agentVersion)||b.agentVersion<1||!Number.isSafeInteger(b.budgetPoints)||b.budgetPoints<1)throw new TypeError('invalid CN binding');
  const handles=new WeakMap();
  const scope=(r,action)=>Object.freeze({...b,provider:'baidu-dumate',taskId:r.taskId,fence:r.fence,inputDigest:r.digest,action});
  async function grant(r,action){
    const s=scope(r,action),g=await authorize(s);
    if(!g||!same(g,b)||!signedFields.every(k=>g[k]===s[k])||g.provider!==s.provider||g.action!==s.action||
      !Number.isSafeInteger(g.expiresAt)||g.expiresAt<=now())throw new Error('scope not authorized');
    return g.expiresAt;
  }
  async function wire(r,method,path,action,{body,stream=false,lastId}={}){
    let token,validUntil;try{
      validUntil=await grant(r,action);
      token=await getToken(Object.freeze({principal:b.principal,project:b.project,bindingId:b.bindingId,region:b.region,credentialRef:b.credentialRef}));
      if(!compact(token,4096)||!/^[\x21-\x7e]+$/.test(token)||validUntil<=now())throw new Error();
    }catch{return {error:problem('blocked','binding_unauthorized')}}
    const headers={Authorization:'Bearer '+token,Accept:stream?'text/event-stream':'application/json'};
    if(body)headers['Content-Type']='application/json';
    if(lastId)headers['Last-Event-ID']=lastId;
    const ac=new AbortController();
    const signal=AbortSignal.any([ac.signal,AbortSignal.timeout(Math.max(1,Math.min(timeoutMs,validUntil-now())))]);
    try{
      const res=await fetcher(BASE+path,{method,headers,body:body?JSON.stringify(body):undefined,redirect:'error',credentials:'omit',cache:'no-store',signal});
      const ct=res.headers.get('content-type')??'';
      if(res.redirected||res.status<200||res.status>=300||(res.url&&res.url!==BASE+path)||
        stream&&(res.status!==200||!/^text\/event-stream(?:\s*;|$)/i.test(ct)||!res.body)){
        await cancel(res);ac.abort();
        const code=res.status;
        if(stream&&lastId&&(code===400||code===409))return {error:problem('history_required','resume_cursor_rejected')};
        if(code===429)return {error:problem('rate_limited','provider_throttled')};
        const known=[400,401,403,404,422].includes(code);
        return {error:problem(method==='GET'?'read_failed':known?'rejected':'uncertain','provider_response')};
      }
      if(stream)return {res,ac,signal};
      try{return {json:await safeJSON(res)}}finally{ac.abort()}
    }catch{ac.abort();return {error:problem(method==='GET'?'read_failed':'uncertain','transport_or_response_unknown')}}
  }
  async function lock(r,stage){
    try{await grant(r,'dispatch-approved-text');
      return await claimWrite(Object.freeze({principal:b.principal,project:b.project,taskId:r.taskId,fence:r.fence,
        stage,bindingId:b.bindingId,inputDigest:r.digest}))===true;
    }catch{return false}
  }
  async function record(r,phase){
    try{return await recordReceipt(Object.freeze({...scope(r,'read-receipts'),phase,sessionId:r.sid,inputEventId:r.ack}))===true}catch{return false}
  }
  async function makeRun(taskId,fence,text){
    if(!id(taskId)||!Number.isSafeInteger(fence)||fence<1||!compact(text,3000)||!text.trim())throw new TypeError('invalid packet');
    return {taskId,fence,text,digest:await sha(text),sid:null,ack:null,fold:phaseNew(),feed:null,historyOnly:false,reading:false};
  }
  const path=r=>'/sessions/'+r.sid+'/events';
  function handle(r){const h=Object.freeze({});handles.set(h,r);return h}
  function lookup(h){const r=handles.get(h);if(!r)throw new TypeError('handle belongs to another binding');return r}
  async function open(r,resume){
    return wire(r,'GET',path(r)+'/stream','read-receipts',{stream:true,lastId:resume?r.fold.lastId:null});
  }
  async function dispatch({taskId,fence,text}={}){
    const r=await makeRun(taskId,fence,text);
    if(!await lock(r,'create-session'))return problem('not_sent','no_write_permit');
    const created=await wire(r,'POST','/sessions','dispatch-approved-text',{body:{agent:{type:'agent',id:b.agentId,version:b.agentVersion},
      environment_id:b.environmentId,budget:budget(b)}});
    if(created.error)return Object.freeze({...created.error,stage:'create_session',messageSent:false});
    const c=created.json;
    if(!c||c.type!=='session'||!id(c.id,'ses_')||c.environment_id!==b.environmentId||c.agent?.id!==b.agentId||c.agent?.version!==b.agentVersion||
      c.agent?.type!=='agent'||!emptyAgent(c.agent)||!noItems(c.vault_ids)||!noItems(c.resources)||c.status!=='idle'||
      c.budget?.type!=='limit'||c.budget?.max_list_cost?.currency!=='POINT'||c.budget.max_list_cost.amount!==String(b.budgetPoints))
      return problem('needs_review','new_session_binding_mismatch');
    r.sid=c.id;
    if(!await record(r,'session_opened'))return Object.freeze({state:'needs_review',reason:'session_journal_unavailable',sessionId:r.sid,messageSent:false});
    const feed=await open(r,false);
    if(feed.error)return Object.freeze({...feed.error,sessionId:r.sid,messageSent:false});
    r.feed=feed;
    if(feed.signal.aborted||!await lock(r,'send-message')||feed.signal.aborted){feed.ac.abort();await cancel(feed.res);return problem('not_sent','stream_or_write_permit_unavailable')}
    const ack=await wire(r,'POST',path(r),'dispatch-approved-text',{body:{events:[{type:'user.message',content:[{type:'text',text}]}]}});
    const e=ack.json?.data?.[0];
    if(ack.error||!Array.isArray(ack.json?.data)||ack.json.data.length!==1||
      e?.type!=='user.message'||!id(e.id,'sevt_')||e.processed_at!==null||textBlock(e.content)!==text){
      feed.ac.abort();await cancel(feed.res);
      r.feed=null;r.historyOnly=true;
      const failure=ack.error??problem('uncertain','invalid_enqueue_echo');
      return Object.freeze({...failure,sessionId:r.sid,messageReceipt:null,...(failure.state==='uncertain'?{handle:handle(r)}:{})});
    }
    r.ack=e.id;
    const saved=await record(r,'provider_enqueued');
    return Object.freeze({state:'enqueued',durability:saved?'recorded':'needs_reconciliation',sessionId:r.sid,inputEventId:r.ack,handle:handle(r)});
  }
  async function restore({taskId,fence,text}={}){
    const r=await makeRun(taskId,fence,text),s=scope(r,'read-receipts');let j;
    try{await grant(r,'read-receipts');j=await loadReceipt(s)}catch{return problem('blocked','binding_or_journal_unavailable')}
    if(!j||!same(j,b)||j.provider!==s.provider||j.action!==s.action||!signedFields.every(k=>j[k]===s[k])||
      !id(j.sessionId,'ses_')||!(j.phase==='session_opened'&&j.inputEventId===null||j.phase==='provider_enqueued'&&id(j.inputEventId,'sevt_')))
      return problem('blocked','no_matching_bound_receipt');
    r.sid=j.sessionId;r.ack=j.inputEventId;r.historyOnly=true;
    return Object.freeze({state:'restored_readonly',handle:handle(r)});
  }
  async function observe(h){
    const r=lookup(h);if(r.reading)return problem('busy','read_in_progress');
    r.reading=true;
    try{
      let expires;try{expires=await grant(r,'read-receipts')}catch{if(r.feed){r.feed.ac.abort();await cancel(r.feed.res);r.feed=null}return problem('blocked','binding_unauthorized')}
      if(r.fold.terminal)return publicPhase(r.fold);
      if(r.historyOnly)return problem('history_required','use_readonly_history');
      let feed=r.feed;r.feed=null;
      if(!feed){
        if(!r.fold.lastId){r.historyOnly=true;return problem('history_required','no_resume_cursor')}
        feed=await open(r,true);
        if(feed.error){if(feed.error.state==='history_required')r.historyOnly=true;return feed.error}
      }
      try{
        for await(const e of frames(feed.res)){
          if(now()>=expires){r.historyOnly=true;return problem('blocked','read_grant_expired')}
          await fold(r.fold,e,r);
          if(r.fold.terminal)return publicPhase(r.fold);
        }
        return Object.freeze({state:'stream_interrupted',lastKnownState:r.fold.state,lastEventId:r.fold.lastId});
      }catch(e){if(e instanceof StreamInterrupted)return Object.freeze({state:'stream_interrupted',lastKnownState:r.fold.state,lastEventId:r.fold.lastId});r.historyOnly=true;return problem('history_required','stream_unreadable')}
      finally{feed.ac.abort()}
    }finally{r.reading=false}
  }
  async function reconcile(h){
    const r=lookup(h);if(r.reading)return problem('busy','read_in_progress');r.reading=true;
    try{
      try{await grant(r,'read-receipts')}catch{return problem('blocked','binding_unauthorized')}
      if(r.fold.terminal)return publicPhase(r.fold);
      if(r.feed){r.feed.ac.abort();await cancel(r.feed.res);r.feed=null}
      // Use an uncursored, ascending full scan; no gaps between history and a new unanchored stream.
      r.historyOnly=true;const f=phaseNew(),pages=new Set(),found=new Set();let cursor=null,scanned=0;
      const consistent=()=>[...r.fold.seen].every(([k,v])=>f.seen.get(k)===v);
      for(let page=0;page<MAX_PAGES;page++){
        const q=new URLSearchParams({order:'asc',limit:'50'});if(cursor!==null)q.set('page',cursor);
        const x=await wire(r,'GET',path(r)+'?'+q,'read-receipts');
        if(x.error)return x.error;
        const d=x.json;
        if(!Array.isArray(d?.data)||d.data.length>50||!(d.next_page===null||compact(d.next_page,2048)))fail();
        for(const e of d.data){
          if(++scanned>MAX_EVENTS||!validEvent(e))fail();
          if(!r.ack){if(e.type==='user.message'&&textBlock(e.content)===r.text)found.add(e.id);continue}
          await fold(f,e,r);if(f.terminal){if(!consistent())return problem('needs_review','history_missing_prior_evidence');r.fold=f;return publicPhase(f)}
        }
        if(d.next_page===null){
          // A partial/eventually stale read cannot erase already verified stream evidence.
          if(!r.ack)return Object.freeze({state:'needs_review',reason:found.size===1?'matching_input_seen_without_ack':found.size?'ambiguous_input_history':'not_observed_no_resend',candidateInputEventIds:Object.freeze([...found])});
          if(!consistent())return problem('needs_review','history_missing_prior_evidence');
          r.fold=f;return publicPhase(f);
        }
        if(pages.has(d.next_page))fail();pages.add(d.next_page);cursor=d.next_page;
      }
      return problem('needs_review','history_bound_exceeded');
    }catch{return problem('needs_review','invalid_history')}finally{r.reading=false}
  }
  return Object.freeze({dispatch,observe,reconcile,restore});
}
