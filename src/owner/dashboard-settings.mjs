// Owner-session-only QQ management. No credentials or gateway controls reach the browser.
const TTL = 5 * 60_000;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2,'0')).join('');
const exact = (v, keys) => v && !Array.isArray(v) && typeof v === 'object' && Object.keys(v).sort().join(',') === keys.sort().join(',');
export const isQQSettingsPath = path => ['/dashboard/qq-settings','/dashboard/qq-settings/access','/dashboard/qq-settings/prepare','/dashboard/qq-settings/commit'].includes(path);
export async function dashboardQQSettings(request, {env,storage,session,sessionKey,binding,now,manageQQ,headers}) {
  const reply = (body,status=200) => new Response(JSON.stringify(body),{status,headers:headers()});
  const fail = (error,status=403) => reply({error},status);
  if(env.DASHBOARD_QQ_SETTINGS_ENABLED!=='true' || typeof manageQQ!=='function') return fail('qq_settings_disabled',404);
  const path=new URL(request.url).pathname, read=path==='/dashboard/qq-settings';
  if(request.method !== (read?'GET':'POST')) return fail('method_not_allowed',405);
  if(!hex(session.csrf)) return fail('dashboard_login_required',401);
  const sessionId=sessionKey.replace(/^dashboard:session:/,'');
  const capKey='dashboard:qq-capability:'+sessionId, operationPrefix='dashboard:qq-operation:'+sessionId+':';
  const access=await storage.get(capKey);
  const valid=access && access.expires>now() && access.binding===binding;
  if(read && !valid) return reply({state:'access_required',scope:'qq_settings',csrf:session.csrf});
  let body;
  if(!read) {
    if(request.headers.get('content-type')?.split(';')[0]!=='application/json') return fail('json_required',415);
    const reader=request.body?.getReader();let data='',size=0;
    if(!reader)return fail('invalid_settings_request',422);
    try {const decoder=new TextDecoder('utf-8',{fatal:true});for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2048){await reader.cancel();return fail('body_too_large',413);}data+=decoder.decode(value,{stream:true});}data+=decoder.decode();body=JSON.parse(data);}catch{return fail('invalid_settings_request',422);}
    if(!body || body.csrf!==session.csrf) return fail('csrf_required');
  }
  if(path.endsWith('/access')) {
    if(!exact(body,['csrf','confirm']) || body.confirm!==true) return fail('explicit_access_required');
    let snapshot;try{snapshot=await manageQQ('inspect',null);}catch{return fail('qq_settings_unavailable',503);}
    if(!snapshot?.scope || !snapshot.settings?.bound) return fail('qq_binding_required',409);
    const capability={id:random(),binding,scope:snapshot.scope,expires:Math.min(session.expires,now()+TTL)};
    const granted=await storage.transaction(async tx=>{
      const all=await tx.list({prefix:'dashboard:qq-capability:',limit:65});let live=0;
      for(const [key,value] of all){if(value.expires<=now())await tx.delete(key);else live++;}
      const operations=await tx.list({prefix:'dashboard:qq-operation:',limit:1025});let retained=0;
      for(const [key,value] of operations){if(value.expires<=now())await tx.delete(key);else retained++;}
      if((live>=32&&!await tx.get(capKey))||retained>=1024)return false;
      await tx.put(capKey,capability);return true;
    });
    if(!granted)return fail('settings_operation_capacity',409);
    return reply({state:'authorized',access_expires_at:new Date(capability.expires).toISOString()});
  }
  if(!valid)return fail('qq_settings_access_required');
  if(path.endsWith('/commit')) {
    if(!exact(body,['csrf','operation_ref','confirm']) || !hex(body.operation_ref) || body.confirm!==true)return fail('invalid_settings_request',422);
    const key=operationPrefix+body.operation_ref;
    const claimed=await storage.transaction(async tx=>{
      const current=await tx.get(capKey), activeSession=await tx.get(sessionKey), op=await tx.get(key);
      if(!current || current.id!==access.id || current.expires<=now() || !activeSession || activeSession.expires<=now() || activeSession.binding!==binding)return {error:'qq_settings_access_required'};
      if(!op || op.capability!==access.id || op.binding!==binding)return {error:'operation_not_found'};
      if(op.result)return {result:op.result};
      if(op.expires<=now())return {error:'operation_expired'};
      op.result={state:'uncertain',reason:'operation_in_progress_or_unknown'};
      await tx.put(key,op);return {op};
    });
    if(claimed.error)return fail(claimed.error,409);
    if(claimed.result)return reply(claimed.result);
    let result;
    try {result=await manageQQ('commit',{...claimed.op.payload,scope:access.scope,operationId:body.operation_ref});}
    catch {result={state:'uncertain',reason:'settings_outcome_unknown'};}
    const allowed=new Set(['saved','paused','active','uncertain','not_sent','blocked']);
    if(!result || !allowed.has(result.state))result={state:'uncertain',reason:'settings_outcome_unknown'};
    // The broker returns a small safe contract, never raw exception/provider payloads.
    result={state:result.state,...typeof result.reason==='string'&&/^[a-z_]{1,80}$/.test(result.reason)?{reason:result.reason}:{}};
    await storage.transaction(async tx=>{const op=await tx.get(key);if(op){op.result=result;await tx.put(key,op);}});
    return reply(result);
  }
  let snapshot;try{snapshot=await manageQQ('inspect',null);}catch{return fail('qq_settings_unavailable',503);}
  if(snapshot?.scope!==access.scope)return fail('qq_settings_scope_changed',409);
  if(read)return reply({state:'ready',csrf:session.csrf,access_expires_at:new Date(access.expires).toISOString(),settings:snapshot.settings});
  const operation=body.operation;
  if(!['budget','pause','enable'].includes(operation) || !exact(body,operation==='budget'?['csrf','operation','mode','minutes','revision']:['csrf','operation']))return fail('invalid_settings_request',422);
  if(operation==='budget' && (!['warn','stop'].includes(body.mode) || !Number.isSafeInteger(body.minutes) || body.minutes<1 || body.minutes>1440 || !Number.isSafeInteger(body.revision) || body.revision!==snapshot.settings.budget.revision))return fail('invalid_budget_or_revision',409);
  if(operation==='enable'&&!snapshot.settings.can_enable)return fail('qq_enable_blocked',409);
  const operation_ref=random(), expires=Math.min(access.expires,now()+TTL);
  const payload={operation,guard:snapshot.guard,expiresAt:expires,...operation==='budget'?{mode:body.mode,minutes:body.minutes,revision:body.revision}:{}};
  const stored=await storage.transaction(async tx=>{
    const current=await tx.get(capKey);if(current?.id!==access.id || current.expires<=now())return false;
    const prefix=operationPrefix, all=await tx.list({prefix,limit:65});let live=0;
    for(const [key,value] of all){if(value.expires<=now())await tx.delete(key);else live++;}
    if(live>=32)return false;
    await tx.put(prefix+operation_ref,{capability:access.id,binding,expires,payload,result:null});return true;
  });
  if(!stored)return fail('settings_operation_capacity',409);
  return reply({state:'prepared',operation_ref,expires_at:new Date(expires).toISOString(),confirmation:{operation,recipient_label:snapshot.settings.recipient_label,policy:snapshot.settings.policy,...operation==='budget'?{budget:{mode:body.mode,minutes:body.minutes,revision:body.revision}}:{},sends_verification:operation==='enable'}});
}
