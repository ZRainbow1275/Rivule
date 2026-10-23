import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardQQSettings} from '../src/owner/dashboard-settings.mjs';
const csrf='c'.repeat(64),binding='binding',scope='b'.repeat(64),guard='d'.repeat(64);
function fixture(){
 let time=1_800_000_000_000,calls=[],q=Promise.resolve();const data=new Map(),sessionKey='session',session={csrf,binding,expires:time+900000};data.set(sessionKey,session);
 const storage={async get(k){return structuredClone(data.get(k));},async put(k,v){data.set(k,structuredClone(v));},async delete(k){data.delete(k);},async list({prefix,limit}){return new Map([...data].filter(([k])=>k.startsWith(prefix)).slice(0,limit));},transaction(fn){const p=q.then(()=>fn(storage));q=p.catch(()=>{});return p;}};
 const settings={bound:true,recipient_label:'本人 QQ',budget:{mode:'warn',minutes:120,revision:0},notification:{state:'paused'},policy:{source_mode:'all_currently_verified',project_ids:['p'],new_only:true},can_enable:true};
 let hook=null;
 const ctx={env:{DASHBOARD_QQ_SETTINGS_ENABLED:'true'},storage,session,sessionKey,binding,now:()=>time,headers:()=>({'cache-control':'no-store'}),manageQQ:async(op,payload)=>{calls.push({op,payload});if(hook)return hook(op,payload);return op==='inspect'?{scope,guard,settings}: {state:payload.operation==='enable'?'active':payload.operation==='budget'?'saved':'paused'};}};
 async function call(path='',body){return dashboardQQSettings(new Request('https://owner.internal/dashboard/qq-settings'+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),ctx);}
 return {ctx,data,calls,settings,call,advance:n=>time+=n,setHook:fn=>hook=fn,access:()=>call('/access',{csrf,confirm:true}),prepare:operation=>call('/prepare',{csrf,operation}),budget:extra=>call('/prepare',{csrf,operation:'budget',mode:'stop',minutes:60,revision:0,...extra})};
}
test('new management scope is explicit, expires, and old sessions remain incapable',async()=>{
 const f=fixture();assert.equal((await (await f.call()).json()).state,'access_required');assert.equal(f.calls.length,0);
 assert.equal((await f.prepare('pause')).status,403);assert.equal((await f.call('/access',{csrf,confirm:false})).status,403);
 await f.access();assert.equal((await (await f.call()).json()).state,'ready');f.advance(300001);assert.equal((await (await f.call()).json()).state,'access_required');
 delete f.ctx.session.csrf;assert.equal((await f.call()).status,401);
});
test('strict schemas, CSRF and budget validation reject coercion, clamp and parameter injection',async()=>{
 const f=fixture();await f.access();
 for(const extra of [{minutes:'60'},{minutes:0},{minutes:1441},{minutes:1.5},{mode:'off'},{revision:1},{recipient:'someone'}])assert.ok((await f.budget(extra)).status>=400);
 assert.equal((await f.call('/prepare',{csrf:'x',operation:'pause'})).status,403);
 assert.equal((await f.call('/prepare',{csrf,operation:'enable',confirm:true})).status,422);
 const p=await (await f.budget({minutes:1})).json();assert.deepEqual(p.confirmation.budget,{mode:'stop',minutes:1,revision:0});assert.equal(p.confirmation.sends_verification,false);
 assert.equal(f.calls.filter(c=>c.op==='commit').length,0);
});
test('prepare only reads and commit consumes once under simultaneous duplicates',async()=>{
 const f=fixture();await f.access();const p=await (await f.prepare('enable')).json();assert.equal(p.confirmation.sends_verification,true);assert.ok(!JSON.stringify(p).includes(guard));
 const request={csrf,operation_ref:p.operation_ref,confirm:true};
 const results=await Promise.all([f.call('/commit',request),f.call('/commit',request)]);assert.ok(results.every(r=>r.ok));assert.equal(f.calls.filter(c=>c.op==='commit').length,1);
 assert.equal((await (await f.call('/commit',request)).json()).state,'active');assert.equal(f.calls.filter(c=>c.op==='commit').length,1);
 assert.equal((await f.call('/commit',{...request,operation:'pause'})).status,422);
});
test('lost result is retained and never replayed, regrant invalidates previous references',async()=>{
 const f=fixture();await f.access();const p=await (await f.prepare('enable')).json();f.setHook(()=>{throw Error('secret-network-detail');});
 const body={csrf,operation_ref:p.operation_ref,confirm:true};const first=await (await f.call('/commit',body)).json();assert.equal(first.state,'uncertain');assert.ok(!JSON.stringify(first).includes('secret'));
 await f.call('/commit',body);assert.equal(f.calls.filter(c=>c.op==='commit').length,1);
 f.setHook(null);await f.access();assert.equal((await f.call('/commit',body)).status,409);
});
test('scope change and expired action prevent writes; prepared operations are bounded',async()=>{
 const f=fixture();await f.access();const p=await (await f.prepare('pause')).json();f.advance(300001);assert.equal((await f.call('/commit',{csrf,operation_ref:p.operation_ref,confirm:true})).status,403);
 await f.access();f.setHook(()=>({scope:'e'.repeat(64),guard,settings:f.settings}));assert.equal((await f.prepare('pause')).status,409);
 f.setHook(null);for(let i=0;i<32;i++)assert.equal((await f.prepare('pause')).status,200);assert.equal((await f.prepare('pause')).status,409);
 assert.equal(f.calls.filter(c=>c.op==='commit').length,0);
});
