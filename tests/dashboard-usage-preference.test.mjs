import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardResponse} from '../src/owner/dashboard.mjs';
const origin='https://rivule.example.test';
function fixture(){
 const data=new Map();let tail=Promise.resolve(),time=1800000000000,hook=()=>{},unknown=false;
 const storage={get:async k=>structuredClone(data.get(k)),transaction(fn){const p=tail.then(async()=>{const staged=new Map([...data].map(([k,v])=>[k,structuredClone(v)]));const tx={get:async k=>structuredClone(staged.get(k)),put:async(k,v)=>{staged.set(k,structuredClone(v));hook(k,staged);},delete:async k=>staged.delete(k),list:async({prefix,limit})=>new Map([...staged].filter(([k])=>k.startsWith(prefix)).slice(0,limit))};const result=await fn(tx);data.clear();for(const [k,v]of staged)data.set(k,v);if(unknown){unknown=false;throw Error('private post-commit failure');}return result;});tail=p.catch(()=>{});return p;}};
 const bindings={ownerId:'owner',appId:'123',userId:'456',publicOrigin:origin,allowedProjectIds:['project'],sources:[{source_id:'zot-main',enabled:true}]};
 const ctx={env:{DASHBOARD_ENABLED:'true'},bindings,storage,now:()=>time,identity:{authorizationUrl(state){const u=new URL('https://discord.com/oauth2/authorize');u.search=new URLSearchParams({state,scope:'identify',client_id:'123',redirect_uri:origin+'/callback'});return u.href;},authenticate:async()=>({subject:'456'})}};
 const request=(path,body,cookie='',extra={})=>new Request('https://owner.internal'+path,{method:body===undefined?'GET':'POST',headers:{'sec-fetch-site':'same-origin',origin,...cookie?{cookie}:{},'content-type':'application/json',...extra},...body===undefined?{}:{body:JSON.stringify(body)}});
 const send=(path,body,cookie='',extra={})=>dashboardResponse(request(path,body,cookie,extra),ctx);
 const pick=(r,name)=>r.headers.getSetCookie().find(v=>v.startsWith(name+'=')).split(';')[0];
 async function login(){let r=await send('/dashboard/login',{});const state=new URL(r.headers.get('location')).searchParams.get('state'),cookie=pick(r,'__Host-rivule-dashboard-login');r=await send('/callback?state='+state+'&code=code',undefined,cookie);return pick(r,'__Host-rivule-dashboard-session');}
 const read=c=>send('/dashboard/usage-preference',undefined,c);
 const access=(c,csrf)=>send('/dashboard/usage-preference/access',{csrf,confirm:true},c);
 const save=(c,view,revision=view.revision,value=80)=>send('/dashboard/usage-preference',{csrf:view.csrf,capability_id:view.access?.capability_id,expected_revision:revision,threshold_percent:value},c);
 return {ctx,data,send,login,read,access,save,hook:fn=>hook=fn,advance:n=>time+=n,unknown:()=>unknown=true};
}
async function ready(f){const cookie=await f.login(),initial=await (await f.read(cookie)).json(),view=await(await f.access(cookie,initial.csrf)).json();return {cookie,initial,view};}
test('real opaque-cookie dashboard route reads unknown unbound draft and never grants editing on GET',async()=>{
 const f=fixture();assert.equal((await f.read('')).status,401);const c=await f.login(),before=f.data.size,r=await f.read(c);assert.equal(r.status,200);const v=await r.json();assert.deepEqual({...v,csrf:'redacted'},{revision:0,draft:null,state:'unbound_draft',monitoring:'not_connected',notifications_enabled:false,usage:null,quota:null,csrf:'redacted',access:null});assert.equal(f.data.size,before);assert.equal(r.headers.get('cache-control'),'no-store');
 assert.equal((await f.send('/dashboard/usage-preference',undefined,c,{'sec-fetch-site':'cross-site'})).status,403);
 assert.equal((await f.send('/dashboard/usage-preference',{},c,{origin:'null'})).status,403);
 assert.equal((await f.read(c+'; '+c)).status,401);
});
test('preference-only capability is generation/session bound; save returns no private bindings',async()=>{
 const f=fixture(),{cookie,initial,view}=await ready(f);assert.equal(view.access.expires_at,1800000300000);assert.match(view.access.capability_id,/^[a-f0-9]{64}$/);
 assert.equal((await f.save(cookie,initial)).status,422);let r=await f.save(cookie,view);assert.equal(r.status,200);const saved=await r.json();assert.deepEqual(Object.keys(saved).sort(),['access','csrf','draft','monitoring','notifications_enabled','quota','revision','state','usage']);assert.equal(saved.revision,1);assert.deepEqual(saved.draft,{threshold_percent:80});assert.equal(saved.notifications_enabled,false);
 assert.equal((await f.save(cookie,view)).status,409);await f.access(cookie,view.csrf);assert.equal((await f.save(cookie,view,1)).status,403);
 const other=await f.login(),otherView=await (await f.read(other)).json();assert.equal((await f.save(other,{...otherView,access:view.access},1)).status,403);
 const keys=[...f.data.keys()];assert.equal(keys.some(k=>k.startsWith('usage-alerts:')||k.startsWith('dashboard:qq-capability:')),false);
});
test('CSRF, session logout/expiry, config rotation and preference capability expiry reject writes',async()=>{
 for(const mode of ['csrf','logout','expiry','config','cap-expiry']){const f=fixture(),{cookie,view}=await ready(f);if(mode==='csrf')view.csrf='0'.repeat(64);if(mode==='logout')await f.send('/dashboard/logout',{},cookie);if(mode==='expiry')f.advance(900001);if(mode==='cap-expiry')f.advance(300001);if(mode==='config')f.ctx.bindings.allowedProjectIds.push('changed');assert.ok([401,403].includes((await f.save(cookie,view)).status));assert.equal(f.data.has('usage-preferences:unbound:v1'),false);}
});
test('session/capability revocation while staging preference rolls back atomically',async()=>{
 for(const mode of ['delete','csrf','capability','expires']){const f=fixture(),{cookie,view}=await ready(f);const before=structuredClone([...f.data]);f.hook((key,staged)=>{if(key!=='usage-preferences:unbound:v1')return;const sk=[...staged.keys()].find(k=>k.startsWith('dashboard:session:')),ck=[...staged.keys()].find(k=>k.startsWith('dashboard:usage-preference-capability:'));if(mode==='delete')staged.delete(sk);if(mode==='csrf')staged.get(sk).csrf='f'.repeat(64);if(mode==='capability')staged.get(ck).id='f'.repeat(64);if(mode==='expires')f.advance(300001);});assert.ok([401,403].includes((await f.save(cookie,view)).status));assert.deepEqual([...f.data],before);}
});
test('atomic CAS permits one concurrent save; uncertain committed result recovered read-only',async()=>{
 const f=fixture(),{cookie,view}=await ready(f);const results=await Promise.all([f.save(cookie,view),f.save(cookie,view)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);const current=await(await f.read(cookie)).json();f.unknown();const unknown=await f.save(cookie,current,1,90);assert.equal(unknown.status,503);assert.doesNotMatch(await unknown.text(),/private/);const reread=await(await f.read(cookie)).json();assert.equal(reread.revision,2);assert.equal(reread.draft.threshold_percent,90);assert.equal((await f.save(cookie,current,1,90)).status,409);
});
test('wrong keys, notification/account inputs, malformed values and query strings fail closed',async()=>{
 const f=fixture(),{cookie,view}=await ready(f);for(const key of ['enabled','account_binding','metric_id','recipient']){const body={csrf:view.csrf,capability_id:view.access.capability_id,expected_revision:0,threshold_percent:80,[key]:true};assert.equal((await f.send('/dashboard/usage-preference',body,cookie)).status,422);}assert.equal((await f.send('/dashboard/usage-preference?x=1',undefined,cookie)).status,400);assert.equal((await f.send('/dashboard/usage-preference/arm',{},cookie)).status,404);assert.equal((await f.save(cookie,view,0,0)).status,422);assert.equal(f.data.has('usage-preferences:unbound:v1'),false);
});
