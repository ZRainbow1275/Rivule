import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dashboardResponse, isDashboardRoute } from '../src/owner/dashboard.mjs';
const origin = 'https://rivule.example.test';
const query = { project_id: 'project', task_id: 'task', run_id: 'run', branch_id: 'main' };
function fixture() {
  const data = new Map();let queue = Promise.resolve(), time = 1_800_000_000_000;
  const storage = { async get(k) { return data.get(k); }, async put(k,v) { data.set(k,structuredClone(v)); }, async delete(k) { data.delete(k); },
    async list({prefix,limit}) { return new Map([...data].filter(([k])=>k.startsWith(prefix)).slice(0,limit)); },
    transaction(fn) { const result = queue.then(()=>fn(storage));queue=result.catch(()=>{});return result; } };
  const bindings = { ownerId:'owner',appId:'123',userId:'456',publicOrigin:origin,allowedProjectIds:['project'],sources:[{source_id:'zot-main',enabled:true}] };
  const env = { DASHBOARD_ENABLED:'true', DASHBOARD_WATCHLIST_JSON:JSON.stringify([query]) };
  let exchanges = 0, reads = 0;
  const ctx = { env,bindings,storage,now:()=>time,identity:{
    async authorizationUrl(state) { const u=new URL('https://discord.com/oauth2/authorize');u.search=new URLSearchParams({state,scope:'identify',client_id:bindings.appId,redirect_uri:origin+'/callback'});return u.href; },
    async authenticate(code) { exchanges++;assert.equal(code,'code');return {subject:bindings.userId}; }
  },readSnapshot:async(source,q)=>{reads++;assert.equal(source.source_id,'zot-main');assert.deepEqual(q,query);return {schema_version:'1.0',source_id:'zot-main',...query,observed_at:new Date(time).toISOString(),found:false,snapshot:null};}};
  const req=(path,method='GET',cookie='',extra={})=>new Request('https://owner.internal'+path,{method,headers:{...(method==='POST'?{origin}:{}),...(cookie?{cookie}:{}),...extra}});
  const send=(...args)=>dashboardResponse(req(...args),ctx);
  const pick=(r,name)=>r.headers.getSetCookie().find(v=>v.startsWith(name+'=')).split(';')[0];
  async function login() { const r=await send('/dashboard/login','POST');assert.equal(r.status,303);return {state:new URL(r.headers.get('location')).searchParams.get('state'),cookie:pick(r,'__Host-rivule-dashboard-login')}; }
  async function complete(p=undefined) { p??=await login();const r=await send('/callback?state='+p.state+'&code=code','GET',p.cookie);assert.equal(r.status,303);return {response:r,cookie:pick(r,'__Host-rivule-dashboard-session')}; }
  return {ctx,data,send,req,login,complete,get reads(){return reads;},get exchanges(){return exchanges;},advance(ms){time+=ms;}};
}
test('dashboard remains disabled and ordinary MCP callback is not intercepted', async()=>{
 const f=fixture();f.ctx.env.DASHBOARD_ENABLED='false';assert.equal((await f.send('/dashboard')).status,404);
 assert.equal(isDashboardRoute(new URL(origin+'/callback?state=ordinary-oauth')),false);
 assert.equal(isDashboardRoute(new URL(origin+'/callback?state=rd_invalid')),true);
 assert.equal((await dashboardResponse(new Request(origin+'/dashboard'),f.ctx)).status,403);
 assert.equal(f.reads,0);
});
test('login CSRF, missing browser binding, malformed and replayed states fail closed',async()=>{
 const f=fixture();assert.equal((await f.send('/dashboard/login','POST','',{origin:'https://evil.test'})).status,403);
 const p=await f.login();assert.equal((await f.send('/callback?state='+p.state+'&code=code')).status,403);
 assert.equal((await f.send('/callback?state='+p.state+'&state='+p.state+'&code=code','GET',p.cookie)).status,403);
 assert.equal((await f.send('/callback?state=rd_bad&code=code','GET',p.cookie)).status,403);
 const first=await f.complete(p);assert.ok(first.response.headers.getSetCookie().some(v=>v.includes('HttpOnly')&&v.includes('Secure')&&v.includes('SameSite=Strict')));
 assert.equal((await f.send('/callback?state='+p.state+'&code=code','GET',p.cookie)).status,403);assert.equal(f.exchanges,1);
});
test('concurrent callback replay consumes state exactly once',async()=>{
 const f=fixture(),p=await f.login();const responses=await Promise.all([f.send('/callback?state='+p.state+'&code=code','GET',p.cookie),f.send('/callback?state='+p.state+'&code=code','GET',p.cookie)]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[303,403]);assert.equal(f.exchanges,1);
});
test('expired, cancelled, failed and wrong-owner authentication cannot create a session',async()=>{
 for(const mode of ['expired','cancelled','failed','wrong-owner']){const f=fixture(),p=await f.login();if(mode==='expired')f.advance(300001);
 if(mode==='failed')f.ctx.identity.authenticate=async()=>{throw Error('secret-token');};if(mode==='wrong-owner')f.ctx.identity.authenticate=async()=>({subject:'attacker'});
 const r=await f.send('/callback?state='+p.state+(mode==='cancelled'?'&error=access_denied':'&code=code'),'GET',p.cookie);
 assert.equal(r.status,403);assert.equal([...f.data.keys()].filter(k=>k.startsWith('dashboard:session:')).length,0);assert.ok(!(await r.text()).includes('secret-token'));}
});
test('reads require valid same-origin session, expose no write controls and expire without refresh',async()=>{
 const f=fixture();assert.equal((await f.send('/dashboard/data','GET','',{'sec-fetch-site':'same-origin'})).status,401);
 const session=await f.complete();assert.equal((await f.send('/dashboard/data','GET',session.cookie,{'sec-fetch-site':'cross-site'})).status,403);
 assert.equal((await f.send('/dashboard/data','GET',session.cookie,{'sec-fetch-site':'same-origin',origin:'https://evil.test'})).status,403);
 assert.equal((await f.send('/dashboard/data?task=other','GET',session.cookie,{'sec-fetch-site':'same-origin'})).status,400);
 assert.equal((await f.send('/dashboard/data','POST',session.cookie)).status,405);
 const r=await f.send('/dashboard/data','GET',session.cookie,{'sec-fetch-site':'same-origin'});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
 const model=await r.json();assert.equal(model.items[0].state,'not_found');assert.equal(f.reads,1);assert.equal(model.live_subscription,false);
 assert.ok(!JSON.stringify([...f.data]).includes(session.cookie.split('=')[1]));
 f.advance(900001);assert.equal((await f.send('/dashboard/data','GET',session.cookie,{'sec-fetch-site':'same-origin'})).status,401);assert.equal(f.reads,1);
});
test('configuration changes revoke sessions and logout is same-origin and effective',async()=>{
 const f=fixture(),session=await f.complete();
 assert.equal((await f.send('/dashboard/logout','POST',session.cookie,{origin:'https://evil.test'})).status,403);
 assert.equal((await f.send('/dashboard/logout','POST',session.cookie)).status,303);
 assert.equal((await f.send('/dashboard/data','GET',session.cookie,{'sec-fetch-site':'same-origin'})).status,401);
 const second=await f.complete();f.ctx.bindings.ownerId='different';assert.equal((await f.send('/dashboard/data','GET',second.cookie,{'sec-fetch-site':'same-origin'})).status,401);
});
test('login requests and retained owner sessions are bounded',async()=>{
 const f=fixture();for(let i=0;i<6;i++)await f.login();assert.equal((await f.send('/dashboard/login','POST')).status,429);
 const g=fixture();for(let i=0;i<19;i++){await g.complete();g.advance(11000);}assert.ok([...g.data.keys()].filter(k=>k.startsWith('dashboard:session:')).length<=16);
});
test('page has nonce CSP, no embedded task data, and safe text rendering',async()=>{
 const f=fixture(),r=await f.send('/dashboard'),html=await r.text();assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(r.headers.get('content-security-policy'),/script-src 'nonce-/);
 assert.match(r.headers.get('content-security-policy'), /form-action 'self' https:\/\/discord\.com\/oauth2\/authorize/);assert.ok(!html.includes('innerHTML'));assert.ok(html.includes('textContent'));assert.ok(!html.includes('Bearer'));assert.equal(f.reads,0);
 const worker=readFileSync(new URL('../src/owner/worker.js',import.meta.url),'utf8');
 const start=worker.indexOf('    async fetch(request) {\n        if (isDashboardRoute');assert.ok(start>0);const block=worker.slice(start,worker.indexOf('    async alarm()',start));assert.ok(block.indexOf('dashboardResponse')<block.indexOf('initializeLegacy'));
});

test('dashboard callback and routes skip legacy diagnostic storage',()=>{
 const worker=readFileSync(new URL('../src/owner/worker.js',import.meta.url),'utf8');
 assert.match(worker,/async function suppressTaskSnapshotTrace\(request, trace\) \{\s*if \(isDashboardRoute\(new URL\(request.url\)\)\) \{\s*trace.skip\(\);\s*return;/);
});
test('login state cannot be exchanged between browsers and redirect target is allowlisted',async()=>{
 const f=fixture(),a=await f.login(),b=await f.login();
 assert.equal((await f.send('/callback?state='+a.state+'&code=code','GET',b.cookie)).status,403);
 assert.equal(f.exchanges,0);await f.complete(a);
 const g=fixture();g.ctx.identity.authorizationUrl=async()=> 'https://evil.test/steal';
 assert.equal((await g.send('/dashboard/login','POST')).status,503);assert.equal(g.exchanges,0);
});
test('watchlist/source changes revoke sessions; invalid or disallowed config fails closed',async()=>{
 for(const change of [f=>{f.ctx.env.DASHBOARD_WATCHLIST_JSON='[]';},f=>{f.ctx.bindings.sources[0].display_name='changed';}]){
 const f=fixture(),s=await f.complete();change(f);assert.equal((await f.send('/dashboard/data','GET',s.cookie,{'sec-fetch-site':'same-origin'})).status,401);assert.equal(f.reads,0);}
 for(const list of ['bad',JSON.stringify([{...query,project_id:'other'}]),JSON.stringify([query,query])]){const f=fixture();f.ctx.env.DASHBOARD_WATCHLIST_JSON=list;assert.equal((await f.send('/dashboard')).status,503);assert.equal(f.reads,0);}
});
test('receipt selection resolves only after owner auth, labels test data, and config revokes session',async()=>{
 const f=fixture(),selector={receipt_id:'rcpt_'+'b'.repeat(32),event_id:'test-event',run_id:query.run_id,revision:12};let resolves=0;
 f.ctx.env.DASHBOARD_TEST_RECEIPT_JSON=JSON.stringify(selector);f.ctx.env.DASHBOARD_WATCHLIST_JSON='[]';
 f.ctx.readTestReceipt=async(source,s)=>{resolves++;assert.equal(source.source_id,'zot-main');assert.deepEqual(s,selector);return {...query};};
 assert.equal((await f.send('/dashboard/data','GET','',{'sec-fetch-site':'same-origin'})).status,401);assert.equal(resolves,0);
 const session=await f.complete();assert.equal(resolves,0);
 const response=await f.send('/dashboard/data','GET',session.cookie,{'sec-fetch-site':'same-origin'});assert.equal(response.status,200);assert.equal((await response.json()).items[0].selection_kind,'verified_test');assert.equal(resolves,1);
 f.ctx.readTestReceipt=async()=>{throw Error('private payload must not escape');};const failure=await f.send('/dashboard/data','GET',session.cookie,{'sec-fetch-site':'same-origin'});assert.equal(failure.status,503);assert.equal(await failure.text(),JSON.stringify({error:'dashboard_receipt_unavailable'}));
 f.ctx.env.DASHBOARD_TEST_RECEIPT_JSON=JSON.stringify({...selector,revision:13});assert.equal((await f.send('/dashboard/data','GET',session.cookie,{'sec-fetch-site':'same-origin'})).status,401);
});
test('HTML preserves native same-origin form Origin without relaxing POST CSRF guards',async()=>{
 const f=fixture(),page=await f.send('/dashboard');
 assert.equal(page.headers.get('referrer-policy'),'same-origin');
 assert.match(await page.text(),/method="post" action="\/dashboard\/login"/);
 for(const origin of ['null','https://evil.test','https://rivule.example.test.evil.test','']) {
   const response=await f.send('/dashboard/login','POST','',{origin});assert.equal(response.status,403);
   assert.equal(response.headers.get('referrer-policy'),'no-referrer');
 }
 assert.equal(f.data.size,0);assert.equal(f.exchanges,0);
 const login=await f.send('/dashboard/login','POST');assert.equal(login.status,303);
 assert.equal(login.headers.get('referrer-policy'),'no-referrer');
 assert.equal(new URL(login.headers.get('location')).origin,'https://discord.com');
});
test('connection metadata is read only after owner session and read failures stay unknown',async()=>{
 const f=fixture();let reads=0;f.ctx.readConnection=async source=>{reads++;assert.equal(source.source_id,'zot-main');return {source:{status:'verified'},qq:{status:'paused',scope:'owner_producer_only'}};};
 assert.equal((await f.send('/dashboard/data','GET','',{'sec-fetch-site':'same-origin'})).status,401);assert.equal(reads,0);
 const session=await f.complete();assert.equal(reads,0);
 const response=await f.send('/dashboard/data','GET',session.cookie,{'sec-fetch-site':'same-origin'});assert.equal((await response.json()).connection.source.status,'verified');assert.equal(reads,1);
 f.ctx.readConnection=async()=>{throw Error('private binding');};const failed=await f.send('/dashboard/data','GET',session.cookie,{'sec-fetch-site':'same-origin'});const model=await failed.json();assert.equal(model.connection.source.status,'unknown');assert.equal(model.connection.qq.status,'unknown');assert.equal(JSON.stringify(model).includes('private binding'),false);
});
test('QQ settings share owner/same-origin checks without upgrading old read-only sessions',async()=>{
 const f=fixture();f.ctx.env.DASHBOARD_QQ_SETTINGS_ENABLED='true';let gateway=0;f.ctx.manageQQ=async()=>{gateway++;throw Error('unexpected gateway access');};
 const h={'sec-fetch-site':'same-origin'};
 assert.equal((await f.send('/dashboard/qq-settings','GET','',h)).status,401);
 const session=await f.complete();assert.equal((await f.send('/dashboard/qq-settings','GET',session.cookie,{'sec-fetch-site':'cross-site'})).status,403);
 assert.equal((await f.send('/dashboard/qq-settings/access','POST',session.cookie,{...h,origin:'https://evil.test'})).status,403);
 assert.equal((await (await f.send('/dashboard/qq-settings','GET',session.cookie,h)).json()).state,'access_required');assert.equal(gateway,0);
 for(const [key,value] of f.data)if(key.startsWith('dashboard:session:')){delete value.csrf;f.data.set(key,value);}
 assert.equal((await f.send('/dashboard/qq-settings','GET',session.cookie,h)).status,401);
 assert.equal((await f.send('/dashboard/data','GET',session.cookie,h)).status,200);assert.equal(gateway,0);
});
test('QQ capabilities and 32 prepared operations cannot be mistaken for login sessions',async()=>{
 const f=fixture();f.ctx.env.DASHBOARD_QQ_SETTINGS_ENABLED='true';f.ctx.manageQQ=async()=>({scope:'a'.repeat(64),guard:'b'.repeat(64),settings:{bound:true,recipient_label:'本人 QQ',budget:{mode:'warn',minutes:120,revision:0},policy:{source_mode:'all_currently_verified',project_ids:['project']},can_enable:true}});
 const session=await f.complete(),h={'sec-fetch-site':'same-origin'},access=await (await f.send('/dashboard/qq-settings','GET',session.cookie,h)).json();
 const send=body=>dashboardResponse(new Request('https://owner.internal/dashboard/qq-settings/'+(body.operation?'prepare':'access'),{method:'POST',headers:{origin,cookie:session.cookie,'sec-fetch-site':'same-origin','content-type':'application/json'},body:JSON.stringify(body)}),f.ctx);
 assert.equal((await send({csrf:access.csrf,confirm:true})).status,200);for(let i=0;i<32;i++)assert.equal((await send({csrf:access.csrf,operation:'pause'})).status,200);
 assert.equal([...f.data.keys()].filter(k=>k.startsWith('dashboard:session:')).length,1);
 assert.equal([...f.data.keys()].filter(k=>k.startsWith('dashboard:qq-operation:')).length,32);
 await f.complete();assert.equal([...f.data.keys()].filter(k=>k.startsWith('dashboard:session:')).length,2);
 assert.equal((await f.send('/dashboard/data','GET',session.cookie,h)).status,200);assert.equal([...f.data.keys()].filter(k=>k.startsWith('dashboard:qq-operation:')).length,32);
});

test('additional PA selectors use their exact existing source and are bound to the owner session',async()=>{
 const f=fixture(),source={source_id:'muse-main',enabled:true,provider:'muse',name:'Muse'};
 f.ctx.bindings.sources.push(source);f.ctx.env.DASHBOARD_SOURCE_WATCHLISTS_JSON=JSON.stringify({'muse-main':[query]});
 const calls=[];f.ctx.readSnapshot=async(s,q)=>{calls.push([s.source_id,q]);return {schema_version:'1.0',source_id:s.source_id,...q,observed_at:new Date().toISOString(),found:false,snapshot:null};};
 const {cookie}=await f.complete();const result=await (await f.send('/dashboard/data','GET',cookie,{'sec-fetch-site':'same-origin'})).json();
 assert.deepEqual(calls,[['zot-main',query],['muse-main',query]]);assert.equal(result.sources[0].source_id,'muse-main');assert.equal(result.sources[0].provider,'muse');
 f.ctx.env.DASHBOARD_SOURCE_WATCHLISTS_JSON='{}';assert.equal((await f.send('/dashboard/data','GET',cookie,{'sec-fetch-site':'same-origin'})).status,401);
});
test('additional PA config rejects foreign, disabled, duplicate and oversized selectors',async()=>{
 for(const additional of [{'foreign':[query]},{'muse-main':[query,query]},{'muse-main':[{...query,source_id:'zot-main'}]},{'muse-main':[{...query,project_id:'foreign'}]}]){
 const f=fixture();f.ctx.bindings.sources.push({source_id:'muse-main',enabled:true});f.ctx.env.DASHBOARD_SOURCE_WATCHLISTS_JSON=JSON.stringify(additional);assert.equal((await f.send('/dashboard')).status,503);assert.equal(f.reads,0);
 }
 const f=fixture();f.ctx.bindings.sources.push({source_id:'muse-main',enabled:true});const {cookie}=await f.complete();const result=await (await f.send('/dashboard/data','GET',cookie,{'sec-fetch-site':'same-origin'})).json();assert.deepEqual(result.sources[0].items,[]);
});
