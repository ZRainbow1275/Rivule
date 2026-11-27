import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {makeDuMateAdapter,duMateCapability} from '../adapter/dumate.mjs';

const BASE=duMateCapability.providerBase;
const AT='2026-11-27T01:02:03.000Z';
const B={principal:'owner',project:'rivule',bindingId:'domestic-one',region:'CN',credentialRef:'ref_cn',agentId:'agt_localA',agentVersion:2,environmentId:'env_cn',budgetPoints:30};
const packet={taskId:'doc-jp14',fence:3,text:'列出公开规格。'};
const dummy='mock-only-not-a-secret';
const budget={type:'limit',max_list_cost:{amount:'30',currency:'POINT'}};
const session=()=>({type:'session',id:'ses_demo',agent:{type:'agent',id:B.agentId,version:2,multiagent:null,skills:[],tools:[],files:[],mcp_servers:[]},environment_id:B.environmentId,vault_ids:[],resources:[],budget:structuredClone(budget),status:'idle'});
const user=(eid='sevt_request',s=packet.text)=>({id:eid,type:'user.message',processed_at:AT,content:[{type:'text',text:s}]});
const evt=(id,type,more={})=>({id:'sevt_'+id,type,processed_at:AT,...more});
const run=evt('run','session.status_running');
const out=evt('answer','agent.message',{content:[{type:'text',text:'尺寸 14 × 22。'}]});
const idle=(r='end_turn')=>evt('end','session.status_idle',{stop_reason:{type:r}});
const j=(o,status=200)=>new Response(JSON.stringify(o),{status,headers:{'content-type':'application/json'}});
const echo=()=>j({data:[{...user(),processed_at:null}]});
const frame=(e,sep='\n')=>['event: '+e.type,'id: '+e.id,'data: '+JSON.stringify(e),'',''].join(sep);
const stream=(s,step=0)=>{const bytes=new TextEncoder().encode(s);return new Response(new ReadableStream({
  start(c){if(step){for(let i=0;i<bytes.length;i+=step)c.enqueue(bytes.slice(i,i+step))}else if(bytes.length)c.enqueue(bytes);c.close()}
}),{headers:{'content-type':'text/event-stream; charset=utf-8'}})};
const asStream=(es,sep)=>stream(es.map(e=>frame(e,sep)).join(''));
function rig(opt={}){
  const calls=[],grants=[],tokens=[],locks=[],store=opt.store??new Set(),journal=opt.journal??new Map();
  const cfg={enabled:true,binding:B,now:()=>1234,timeoutMs:5000,
    authorize:async s=>{grants.push(s);return opt.grant?opt.grant(s):{...s,expiresAt:9876543210000}},
    getToken:async s=>{tokens.push(s);return opt.token??dummy},
    recordReceipt:async s=>{journal.set(s.taskId+'/'+s.fence,s);return true},
    loadReceipt:async s=>journal.get(s.taskId+'/'+s.fence),
    claimWrite:async s=>{const key=[s.principal,s.project,s.taskId,s.fence,s.stage].join('/');locks.push(key);if(store.has(key))return false;store.add(key);return true},
    fetcher:async(url,init)=>{
      calls.push({url,init});const {pathname:p,search}=new URL(url);assert.equal(new URL(url).origin,'https://api.dumate.cn');
      if(init.method==='POST'&&p==='/api/dma/v1/sessions')return opt.create?opt.create():j(session(),201);
      if(init.method==='GET'&&p.endsWith('/events/stream'))return opt.sse?opt.sse(calls,init):(asStream([user(),run,out,idle()]));
      if(init.method==='POST'&&p.endsWith('/events'))return opt.send?opt.send():echo();
      if(init.method==='GET'&&p.endsWith('/events'))return opt.history?opt.history(search):j({data:[user(),run,out,idle()],next_page:null});
      assert.fail('undocumented call');
    }};
  return {a:makeDuMateAdapter({...cfg,...opt.config}),calls,grants,tokens,locks,journal};
}

test('off by default, ignores credentials and transport when not explicitly enabled',async()=>{
  const a=makeDuMateAdapter({fetcher:assert.fail,getToken:assert.fail});assert.equal((await a.dispatch()).state,'disabled');assert.equal((await a.observe()).state,'disabled');
  assert.equal(duMateCapability.defaultEnabled,false);assert.throws(()=>makeDuMateAdapter({enabled:true}));
});
test('reject invalid domestic binding, invented provider IDs and absent version before network',()=>{
  for(const b of [{region:'global'},{agentId:'agt_a/else'},{agentVersion:0},{environmentId:'cn'},{budgetPoints:0}])assert.throws(()=>rig({config:{binding:{...B,...b}}}));
});
test('authorized text only: independently signed provider, principal, lane, fence, digest, permission and expiry',async()=>{
  const fields={project:'other',bindingId:'default',principal:'outsider',region:'US',credentialRef:'other',agentId:'agt_b',agentVersion:3,
    environmentId:'env_else',budgetPoints:999,provider:'muse',taskId:'old',fence:2,inputDigest:'fake',action:'read-receipts',expiresAt:1234};
  for(const [field,value] of Object.entries(fields)){const r=rig({grant:s=>({...s,expiresAt:99999,[field]:value})});
    assert.equal((await r.a.dispatch(packet)).state,'not_sent',field);assert.equal(r.calls.length,0,field)}
});
test('create verifies exact pinned agent/environment/no tools/no vaults/budget/idle before sharing text',async()=>{
  const mutations=[c=>c.environment_id='env_other',c=>c.agent.version=1,c=>c.agent.mcp_servers=['m'],c=>c.agent.tools=[{}],
    c=>c.agent.skills=[{}],c=>c.agent.multiagent={},c=>c.agent.files=['f'],c=>c.vault_ids=['vault_x'],c=>c.resources=[{}],
    c=>c.budget.max_list_cost.currency='USD',c=>c.budget.max_list_cost.amount='300',c=>c.status='running',c=>c.id='../other'];
  for(const mutate of mutations){const c=session();mutate(c);const r=rig({create:()=>j(c)});assert.equal((await r.a.dispatch(packet)).state,'needs_review');assert.equal(r.calls.length,1)}
});
test('only three documented write path steps, fixed authority, no initial event/caller header or real auth',async()=>{
  const r=rig();const x=await r.a.dispatch({...packet,host:'https://else.invalid',tools:['other'],sessionId:'ses_unauthorized'});
  assert.equal(x.state,'enqueued');assert.equal(x.inputEventId,'sevt_request');
  assert.deepEqual(r.calls.map(c=>[c.init.method,c.url.slice(BASE.length)]),[['POST','/sessions'],['GET','/sessions/ses_demo/events/stream'],['POST','/sessions/ses_demo/events']]);
  assert.deepEqual(JSON.parse(r.calls[0].init.body),{agent:{type:'agent',id:B.agentId,version:2},environment_id:B.environmentId,budget});
  assert.deepEqual(JSON.parse(r.calls[2].init.body),{events:[{type:'user.message',content:[{type:'text',text:packet.text}]}]});
  assert.ok(r.calls.every(c=>c.init.headers.Authorization==='Bearer '+dummy&&c.init.redirect==='error'&&c.init.credentials==='omit'&&!c.init.headers['Idempotency-Key']));
  assert.equal(r.calls[1].init.headers.Accept,'text/event-stream');assert.equal(r.calls[1].init.headers['Last-Event-ID'],undefined);
  assert.ok(r.grants.every(g=>g.inputDigest===createHash('sha256').update(packet.text).digest('hex')&&!Object.hasOwn(g,'text')));
  assert.ok(r.tokens.every(t=>t.credentialRef===B.credentialRef&&t.region==='CN'));assert.ok(!JSON.stringify(x).includes(dummy));
});
test('claim before both remote writes; duplicate concurrent/cross-process dispatch stopped at shared insert-only ledger',async()=>{
  const store=new Set(),a=rig({store}),b=rig({store});const xs=await Promise.all([a.a.dispatch(packet),b.a.dispatch(packet)]);
  assert.deepEqual(xs.map(x=>x.state).sort(),['enqueued','not_sent']);assert.equal(a.calls.length+b.calls.length,3);
  assert.equal((await a.a.dispatch(packet)).state,'not_sent');assert.equal(store.size,2);
});
test('revoke between creating and sending, transport never receives text',async()=>{
  let n=0;const r=rig({grant:s=>s.action==='dispatch-approved-text'&&++n>=3?null:{...s,expiresAt:99999}});assert.equal((await r.a.dispatch(packet)).state,'not_sent');
  assert.equal(r.calls.length,2);assert.equal(r.calls[1].init.method,'GET');
});
test('redirect, invalid MIME, overlarge JSON, unknown POST outcome do not trigger another create/send',async()=>{
  for(const create of [()=>new Response(null,{status:302,headers:{location:'https://else.invalid'}}),()=>new Response('{}'),()=>j({foo:'a'.repeat(140000)}),()=>{throw Error('lost')}]) {
    const r=rig({create});assert.equal((await r.a.dispatch(packet)).state,'uncertain');assert.equal((await r.a.dispatch(packet)).state,'not_sent');assert.equal(r.calls.length,1);
  }
  const r=rig({sse:()=>new Response('not sse')});const result=await r.a.dispatch(packet);assert.equal(result.messageSent,false);assert.equal(r.calls.length,2);
});
test('provider 429 remains on its bound lane; no token swap or repost',async()=>{
  const r=rig({send:()=>j({},429)});assert.equal((await r.a.dispatch(packet)).state,'rate_limited');assert.equal((await r.a.dispatch(packet)).state,'not_sent');
  assert.ok(r.tokens.every(t=>t.credentialRef==='ref_cn'));assert.equal(r.calls.filter(c=>c.init.method==='POST').length,2);
});
test('malformed or mismatched enqueue echo = uncertain, never equate HTTP 200 with queued',async()=>{
  for(const modify of [o=>o.data[0].id='no-prefix',o=>o.data[0].processed_at=AT,o=>o.data[0].content=[{type:'text',text:'other'}],o=>o.data.push(user()),o=>o.data=[]]){
    const o={data:[{...user(),processed_at:null}]};modify(o);const r=rig({send:()=>j(o)});assert.equal((await r.a.dispatch(packet)).state,'uncertain');
  }
});
test('separate opaque handles, revalidate read rights even when state already cached',async()=>{
  let allow=true;const a=rig({grant:s=>allow?{...s,expiresAt:99999}:null}),b=rig();
  const x=await a.a.dispatch(packet);await assert.rejects(b.a.observe(x.handle));await assert.rejects(a.a.observe({}));assert.equal((await a.a.observe(x.handle)).state,'awaiting_review');
  allow=false;assert.equal((await a.a.observe(x.handle)).state,'blocked');assert.equal((await a.a.reconcile(x.handle)).state,'blocked');
});
test('byte-fragmented UTF-8, split CRLF, heartbeat, preview ignored, duplicate replay coalesced; outcome waits for manual review',async()=>{
  const preview='event: event_delta\r\ndata: {"type":"event_delta","delta":{"text":"忽略"}}\r\n\r\n';
  const lines=': keepalive\r\n\r\n'+[user(),run].map(e=>frame(e,'\r\n')).join('')+preview+[out,out,idle()].map(e=>frame(e,'\r\n')).join('');
  const r=rig({sse:()=>stream(lines,1)});const x=await r.a.dispatch(packet);assert.equal(x.state,'enqueued');
  const y=await r.a.observe(x.handle);assert.equal(y.state,'awaiting_review');assert.deepEqual(y.candidate,{eventId:out.id,text:out.content[0].text});
});
test('candidate only after matching own event, running phase, full agent output and end_turn; idle alone is insufficient',async()=>{
  for(const [events,state] of [[[idle()], 'enqueued'],[[user(),run,idle()],'needs_review'],[[user(),out,idle()],'needs_review'],
    [[user(),run,out],'running'],[[user('sevt_other'),run,out,idle()],'needs_review'],[[user('sevt_request','other text'),run,out,idle()],'needs_review'],
    [[user(),run,user('sevt_interloper'),out,idle()],'needs_review'],[[user(),run,evt('tool','agent.mcp_tool_use'),out,idle()],'needs_review'],
    [[user(),run,evt('a','session.updated'),out,idle()],'needs_review'],[[user(),run,out,{...out,content:[{type:'text',text:'reused id'}]},idle()],'needs_review']]){
    const r=rig({sse:()=>asStream(events)}),x=await r.a.dispatch(packet),y=await r.a.observe(x.handle);
    assert.equal(y.state==='stream_interrupted'?y.lastKnownState:y.state,state,JSON.stringify(events));assert.equal(y.candidate,undefined);
  }
});
test('refusal/budget/retry exhaustion/provider errors are not success; requires_action never auto-confirms',async()=>{
  for(const [stop,state] of [['requires_action','needs_owner_action'],['retries_exhausted','provider_stopped'],['budget_reached','provider_stopped'],['refusal','provider_stopped']]){
    const r=rig({sse:()=>asStream([user(),run,out,idle(stop)])}),x=await r.a.dispatch(packet),y=await r.a.observe(x.handle);assert.equal(y.state,state);assert.equal(y.candidate,undefined);assert.equal(r.calls.length,3)
  }
  const r=rig({sse:()=>asStream([user(),run,evt('err','session.error',{retry_status:{type:'terminal'}})])});assert.equal((await r.a.observe((await r.a.dispatch(packet)).handle)).state,'provider_stopped');
});
test('explicit reconnect only uses session-owned last full ID and never repeats POST',async()=>{
  let count=0;const r=rig({sse:(_,init)=>{if(++count===1)return asStream([user(),run]);assert.equal(init.headers['Last-Event-ID'],run.id);return asStream([run,out,idle()])}});
  const x=await r.a.dispatch(packet);assert.equal((await r.a.observe(x.handle)).lastKnownState,'running');assert.equal(count,1);
  assert.equal((await r.a.observe(x.handle)).state,'awaiting_review');assert.equal(count,2);assert.equal(r.calls.filter(c=>c.init.method==='POST').length,2);
});
test('400/409 disables rejected resume cursor; ascending paginated history → review, no POST or cursor reuse',async()=>{
 for(const code of [400,409]){let count=0;const r=rig({sse:()=>++count===1?asStream([user(),run]):j({},code),
    history:q=>q.includes('page=')?j({data:[out,idle()],next_page:null}):j({data:[user(),run],next_page:'p+1/2'})});
   const x=await r.a.dispatch(packet);await r.a.observe(x.handle);assert.equal((await r.a.observe(x.handle)).state,'history_required');
   assert.equal((await r.a.observe(x.handle)).reason,'use_readonly_history');assert.equal((await r.a.reconcile(x.handle)).state,'awaiting_review');
   assert.equal(count,2);assert.equal(r.calls.filter(c=>c.init.method==='POST').length,2);
   assert.ok(r.calls.at(-1).url.endsWith('?order=asc&limit=50&page=p%2B1%2F2'))}
});
test('no last full cursor or truncated SSE frame: history required, no fresh subscription gap',async()=>{
  const r=rig({sse:()=>stream(frame(user()).trimEnd())});const x=await r.a.dispatch(packet);
  assert.equal((await r.a.observe(x.handle)).lastKnownState,'enqueued');assert.equal((await r.a.observe(x.handle)).state,'history_required');
  assert.equal((await r.a.reconcile(x.handle)).state,'awaiting_review');assert.equal(r.calls.length,4);
});
test('stream wire ID/type must agree with JSON; only complete event recovers via history',async()=>{
  const r=rig({sse:()=>stream(frame(user()).replace('id: sevt_request','id: sevt_untrusted'))});const x=await r.a.dispatch(packet);
  assert.equal((await r.a.observe(x.handle)).reason,'stream_unreadable');assert.equal((await r.a.reconcile(x.handle)).state,'awaiting_review');
});
test('stale/contradictory history cannot override previously seen valid events or promote a truncated candidate',async()=>{
  const r=rig({sse:()=>asStream([user(),run,evt('usage','session.usage')]),history:()=>j({data:[user(),run,out,idle()],next_page:null})});
  const x=await r.a.dispatch(packet);await r.a.observe(x.handle);assert.equal((await r.a.reconcile(x.handle)).reason,'history_missing_prior_evidence');
});
test('lost write echo: single exact history match stays needs_review, absence also never causes resend',async()=>{
  for(const [rows,reason] of [[[user(),run,out,idle()],'matching_input_seen_without_ack'],[[],'not_observed_no_resend'],[[user(),user('sevt_another')],'ambiguous_input_history']]){
    const r=rig({send:()=>{throw Error('POST timeout')},history:()=>j({data:rows,next_page:null})}),x=await r.a.dispatch(packet);
    assert.equal(x.state,'uncertain');assert.equal((await r.a.observe(x.handle)).state,'history_required');
    const y=await r.a.reconcile(x.handle);assert.equal(y.reason,reason);assert.equal(y.candidate,undefined);
    assert.equal((await r.a.dispatch(packet)).state,'not_sent');assert.equal(r.calls.filter(c=>c.init.method==='POST').length,2);
  }
});
test('bad/repeated history pagination fails bounded and never leaks token or more HTTP writes',async()=>{
  const r=rig({history:()=>j({data:[user()],next_page:'loop'})}),x=await r.a.dispatch(packet);const y=await r.a.reconcile(x.handle);
  assert.equal(y.reason,'invalid_history');assert.equal(r.calls.length,5);assert.ok(!JSON.stringify(y).includes(dummy));
});
test('restore after process reset reads only a trusted binding-and-digest-linked ledger row; never repeats POST',async()=>{
  const journal=new Map(),store=new Set(),first=rig({journal,store}),second=rig({journal,store});const x=await first.a.dispatch(packet);
  assert.equal(x.durability,'recorded');assert.equal((await second.a.restore({...packet,text:'another packet'})).state,'blocked');
  assert.equal((await second.a.restore({...packet,fence:4})).state,'blocked');
  const y=await second.a.restore({...packet,sessionId:'ses_attacker'});assert.equal(y.state,'restored_readonly');assert.equal((await second.a.reconcile(y.handle)).state,'awaiting_review');
  assert.deepEqual(second.calls.map(c=>c.init.method),['GET']);assert.ok(!JSON.stringify([...journal.values()]).includes(packet.text));
  const z=rig({journal,store,config:{binding:{...B,credentialRef:'different'}}});assert.equal((await z.a.restore(packet)).state,'blocked');assert.equal(z.calls.length,0);
});
test('cannot release packet before recording session; lost final journal ACK produces visible degradation and no replay',async()=>{
  let n=0;const r=rig({config:{recordReceipt:async()=>false}});const x=await r.a.dispatch(packet);assert.equal(x.messageSent,false);assert.equal(r.calls.length,1);
  const b=rig({config:{recordReceipt:async()=>++n===1}});const y=await b.a.dispatch(packet);assert.equal(y.state,'enqueued');assert.equal(y.durability,'needs_reconciliation');assert.equal((await b.a.dispatch(packet)).state,'not_sent');
});
test('network disconnect after a complete SSE event keeps the verified cursor, partial bytes excluded',async()=>{
  let count=0;const r=rig({sse:(_,init)=>{
      if(++count===1){let step=0;return new Response(new ReadableStream({pull(c){if(step++===0)c.enqueue(new TextEncoder().encode(frame(user())+'event: session.status_'));else c.error(Error('mock disconnect'))}}),{headers:{'Content-Type':'text/event-stream'}})}
      assert.equal(init.headers['Last-Event-ID'],user().id);return asStream([run,out,idle()]);
  }});const x=await r.a.dispatch(packet),y=await r.a.observe(x.handle);assert.equal(y.state,'stream_interrupted');assert.equal(y.lastEventId,user().id);assert.equal((await r.a.observe(x.handle)).state,'awaiting_review');
});
