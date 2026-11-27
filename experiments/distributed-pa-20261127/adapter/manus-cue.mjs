// Official Manus V2 Cue adapter. An owner-bound transport, not a general URL or shell tool.
const api = 'https://api.manus.ai/v2/';
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const display = v => typeof v === 'string' ? v.slice(0, 140) : '';
const bounded = (v, n) => typeof v === 'string' && v.length > 0 && v.length <= n;
const knownRejection = new Set(['invalid_argument','permission_denied','not_found','unauthenticated','failed_precondition','resource_exhausted']);
export const cueCapability = Object.freeze({
  provider: 'cue', integration: 'official-manus-v2', direction: 'push', recipientScope: 'dedicated-agent-main-task',
  sessionConcurrency: 1, defaultEnabled: false,
  scopes: Object.freeze(['discover','dispatch-approved-text','reconcile-readonly']),
});
const failure = (state, reason) => ({state, reason});

function ticketRef(ref) {
  if (!id(ref)) throw new TypeError('invalid attempt reference');
  return '[rivule-attempt:' + ref + ']';
}

export function makeCueAdapter({fetcher, credential, bindings = [], timeoutMs=12000}) {
  if (typeof fetcher !== 'function') throw new TypeError('server-side fetch required');
  if (!credential || !['api-key','trusted-oauth'].includes(credential.kind) ||
      !bounded(credential.value,4096) || /[\r\n]/.test(credential.value)) throw new TypeError('invalid auth binding');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('invalid timeout');
  const auth = credential.kind === 'api-key' ? {'x-manus-api-key': credential.value} : {authorization:'Bearer '+credential.value};
  const allowed = new Map(), uniqueThreads = new Set();
  for (const b of bindings) {
    if (!id(b?.agentId) || !id(b?.threadId) || allowed.has(b.agentId) ||
        uniqueThreads.has(b.threadId) || b.dedicated !== true || b.ownedByCredential !== true || b.regionVerified !== true)
      throw new TypeError('dedicated, region-verified Cue binding owned by credential required');
    allowed.set(b.agentId,b.threadId); uniqueThreads.add(b.threadId);
  }
  const request = async (path, query, body) => {
    const url = new URL(path,api);
    for (const [k,v] of Object.entries(query??{})) url.searchParams.set(k,String(v));
    const init = {method:body?'POST':'GET',headers:{...auth,accept:'application/json'},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(timeoutMs)};
    if (body) { init.headers['content-type']='application/json'; init.body=JSON.stringify(body); }
    try {
      const r = await fetcher(url.toString(),init);
      if (r.status===429) return failure(body?'throttled':'read_failed','rate_limited');
      if (r.status>=500 || r.status===408 || r.status===425) return failure(body?'unknown':'read_failed','transport_uncertain');
      const j = await r.json();
      if (!r.ok || j?.ok !== true) {
        return body ? knownRejection.has(j?.error?.code)
          ? failure('rejected',j.error.code) : failure('unknown','unexpected_response')
          : failure('read_failed','provider_rejected');
      }
      return {state:'ok',j};
    } catch { return failure(body?'unknown':'read_failed','transport_uncertain'); }
  };
  const thread = agentId => {
    if (!allowed.has(agentId)) throw new TypeError('Cue agent is not bound');
    return allowed.get(agentId);
  };
  return Object.freeze({
    async discover(){
      const r=await request('agent.list');
      if (r.state!=='ok') return r;
      if (!Array.isArray(r.j.data)) return failure('read_failed','unexpected_response');
      const seen = new Set(), seenThreads = new Set(), agents=[];
      for (const row of r.j.data) {
        if (!id(row?.id) || !id(row?.task_id) || seen.has(row.id) || seenThreads.has(row.task_id))
          return failure('read_failed','unexpected_response');
        seen.add(row.id); seenThreads.add(row.task_id);
        if(allowed.get(row.id)===row.task_id) agents.push({agentId:row.id,threadId:row.task_id,nickname:display(row.nickname),bound:true});
      }
      return {state:'discovered',agents};
    },
    async dispatch({agentId,attemptRef,approvedText,approval}){
      const task_id=thread(agentId), marker=ticketRef(attemptRef);
      if (approval!=='authorized-text-only' || !bounded(approvedText,3000) || !approvedText.trim() ||
          approvedText.includes('[rivule-attempt:')) throw new TypeError('invalid approved work packet');
      const r=await request('task.sendMessage',null,{task_id,clear_connectors:true,message:{content:marker+'\n'+approvedText}});
      if (r.state!=='ok') return r;
      const {task_id:got,status,request_id}=r.j;
      if (got!==task_id || !id(request_id) || !['delivered','pending_owner_review'].includes(status))
        return failure('unknown','mismatched_acknowledgment');
      return {state:status==='delivered'?'delivered':'owner_review',requestId:request_id};
    },
    async observe({agentId,attemptRef,approvedText,cursor}){
      const task_id=thread(agentId), marker=ticketRef(attemptRef);
      if (!bounded(approvedText,3000) || (cursor!==undefined && !bounded(cursor,2048))) throw new TypeError('invalid observation cursor or packet');
      const r=await request('task.listMessages',{task_id,order:'desc',limit:40,...(cursor===undefined?{}:{cursor})});
      if (r.state!=='ok') return r;
      const j=r.j;
      if (j.task_id!==task_id || !Array.isArray(j.messages) ||
          typeof j.has_more!=='boolean' || (j.has_more && (!bounded(j.next_cursor,2048)||j.next_cursor===cursor)))
        return failure('read_failed','unexpected_response');
      const exact=marker+'\n'+approvedText;
      const matches=j.messages.filter(x=>x?.type==='user_message' && x.user_message?.content===exact);
      if (matches.length && (matches.length!==1 || !id(matches[0].id))) return failure('needs_review','duplicate_or_invalid_receipt');
      // A matching user message proves delivery, never marks an assistant result complete.
      return {state:matches.length?'observed_delivery':'not_observed', ...(matches.length?{messageId:matches[0].id}:{}),
        nextCursor:j.has_more?j.next_cursor:null};
    },
  });
}
