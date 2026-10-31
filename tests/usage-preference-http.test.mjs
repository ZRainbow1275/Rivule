import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createUnboundUsagePreferenceController} from '../src/owner/usage-preference-draft.mjs';
import {createUsagePreferenceHandler} from '../src/owner/usage-preference-http.mjs';
const origin='https://owner.example', csrf='a'.repeat(64), path='/dashboard/usage-preference';
function fixture(){
 let tail=Promise.resolve(),onPut=()=>{},onGet=()=>{};const data=new Map();
 const context={authorized:true,authorization_expires_at:10000,csrf,owner_binding:'owner',session_binding:'session',account_binding:'fixture-account',metric_id:'fixture-count',analytics_grant:null};
 const storage={async get(k){onGet();return structuredClone(data.get(k));},transaction(fn){const p=tail.then(async()=>{const staged=new Map(data);const result=await fn({get:async k=>structuredClone(staged.get(k)),put:async(k,v)=>{staged.set(k,structuredClone(v));onPut();}});data.clear();for(const [k,v] of staged)data.set(k,v);return result;});tail=p.catch(()=>{});return p;}};
 const handler=createUsagePreferenceHandler({origin,storage,authenticate:async()=>context,now:()=>1000});
 const req=(body,headers={},suffix='')=>new Request(origin+path+suffix,{method:body===undefined?'GET':'POST',headers:{'sec-fetch-site':'same-origin',origin,'content-type':'application/json',...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
 const body=(revision=0)=>({csrf,expected_revision:revision,threshold_percent:80});
 return {handler,req,body,context,data,onPut:fn=>onPut=fn,onGet:fn=>onGet=fn};
}
test('unconnected read defaults disabled and unknown; read and save do not need Analytics grant',async()=>{
 const f=fixture();let r=await f.handler(f.req());assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(f.data.size,0);
 assert.deepEqual(await r.json(),{revision:0,draft:null,state:'unbound_draft',monitoring:'not_connected',notifications_enabled:false,usage:null,quota:null,csrf});
 r=await f.handler(f.req(f.body()));assert.equal(r.status,200);const v=await r.json();assert.equal(v.revision,1);assert.equal(v.notifications_enabled,false);assert.equal([...f.data.values()][0].threshold_percent,80);
});
test('strict same-origin and current owner management checks precede persistence',async()=>{
 for(const headers of [{'sec-fetch-site':'cross-site'},{origin:'null'},{origin:'https://evil.example'}]){const f=fixture();assert.equal((await f.handler(f.req(f.body(),headers))).status,403);assert.equal(f.data.size,0);}
 for(const change of [c=>c.authorized=false,c=>c.authorization_expires_at=1000,c=>c.csrf='invalid']){const f=fixture();change(f.context);assert.notEqual((await f.handler(f.req(f.body()))).status,200);assert.equal(f.data.size,0);}
 const f=fixture();const r=f.req(f.body());r.headers.delete('origin');assert.equal((await f.handler(r)).status,403);
});
test('only exact preference POST fields accepted; no enable, binding, recipient or grant inputs',async()=>{
 for(const key of ['enabled','confirm','account_binding','metric_id','recipient','analytics_grant']){const f=fixture();assert.equal((await f.handler(f.req({...f.body(),[key]:true}))).status,422);assert.equal(f.data.size,0);}
 const f=fixture();assert.equal((await f.handler(f.req({...f.body(),csrf:'b'.repeat(64)}))).status,403);
 for(const suffix of ['/arm','/save','?enabled=true'])assert.equal((await f.handler(f.req(f.body(),{},suffix))).status,404);
});
test('body limits, malformed JSON, invalid thresholds and revisions fail closed',async()=>{
 const f=fixture();assert.equal((await f.handler(f.req(' '.repeat(2049)))).status,413);assert.equal((await f.handler(f.req('{'))).status,422);assert.equal((await f.handler(f.req(f.body(),{'content-type':'text/plain'}))).status,415);
 for(const body of [{...f.body(),threshold_percent:0},{...f.body(),expected_revision:-1},{...f.body(),threshold_percent:101}])assert.equal((await f.handler(f.req(body))).status,422);assert.equal(f.data.size,0);
});
test('CAS rejects duplicate/replayed saves and races without overwriting',async()=>{
 const f=fixture();const results=await Promise.all([f.handler(f.req(f.body())),f.handler(f.req(f.body()))]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal([...f.data.values()][0].revision,1);assert.equal((await f.handler(f.req(f.body()))).status,409);
});
test('revoked or rotated owner session/CSRF before commit rolls back',async()=>{
 for(const change of [c=>c.authorized=false,c=>c.csrf='b'.repeat(64),c=>c.session_binding='rotated',c=>c.authorization_expires_at=999]){const f=fixture();f.onPut(()=>change(f.context));assert.equal((await f.handler(f.req(f.body()))).status,403);assert.equal(f.data.size,0);}
 const f=fixture();f.onGet(()=>f.context.authorized=false);assert.equal((await f.handler(f.req())).status,403);
});
test('adapter failures expose bounded errors; no operational imports or arming API',async()=>{
 const handler=createUsagePreferenceHandler({origin,storage:{},authenticate:async()=>{throw Error('secret');},now:()=>1000});const f=fixture();const r=await handler(f.req());assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/secret/);
 const source=readFileSync(new URL('../src/owner/usage-preference-http.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/\.arm\s*\(|\bfetch\s*\(|setAlarm|setTimeout/);
 for(const file of ['worker.js','dashboard.mjs'])assert.doesNotMatch(readFileSync(new URL('../src/owner/'+file,import.meta.url),'utf8'),/usage-preference-http/);
});

test('unbound preferences need no account/metric/grant and never touch bound policy storage',async()=>{const f=fixture();delete f.context.account_binding;delete f.context.metric_id;delete f.context.analytics_grant;const old={enabled:true,untouched:true};f.data.set('usage-alerts:draft:v1',old);assert.equal((await f.handler(f.req(f.body()))).status,200);assert.deepEqual(f.data.get('usage-alerts:draft:v1'),old);const saved=f.data.get('usage-preferences:unbound:v1');assert.deepEqual(Object.keys(saved).sort(),['owner_binding','revision','threshold_percent','version']);});
test('corrupt or different-owner stored preferences fail closed; revision never wraps',async()=>{
 for(const mutate of [r=>r.version=2,r=>r.threshold_percent=101,r=>r.enabled=true,r=>r.revision=-1,r=>r.owner_binding='another-owner']){const f=fixture();await f.handler(f.req(f.body()));mutate(f.data.get('usage-preferences:unbound:v1'));const before=structuredClone([...f.data]);assert.notEqual((await f.handler(f.req())).status,200);assert.notEqual((await f.handler(f.req(f.body(1)))).status,200);assert.deepEqual([...f.data],before);}
 const f=fixture();await f.handler(f.req(f.body()));f.data.get('usage-preferences:unbound:v1').revision=Number.MAX_SAFE_INTEGER;assert.equal((await f.handler(f.req(f.body(Number.MAX_SAFE_INTEGER)))).status,409);assert.equal(f.data.get('usage-preferences:unbound:v1').revision,Number.MAX_SAFE_INTEGER);
});


test('direct controller snapshots threshold and CAS revision before awaiting context',async()=>{
 const data=new Map();let release,entered;
 const paused=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 let pause=false;
 const context={authorized:true,authorization_expires_at:10000,owner_binding:'owner',session_binding:'session'};
 const storage={get:async key=>structuredClone(data.get(key)),transaction:async fn=>{const staged=new Map(data);const result=await fn({get:async key=>structuredClone(staged.get(key)),put:async(key,value)=>staged.set(key,structuredClone(value))});data.clear();for(const [key,value] of staged)data.set(key,value);return result;}};
 const controller=createUnboundUsagePreferenceController({storage,now:()=>1000,getContext:async()=>{if(pause){pause=false;entered();await paused;}return context;}});
 pause=true;
 const input={expected_revision:0,threshold_percent:80},pending=controller.saveDraft(input);
 await started;input.threshold_percent=200;input.expected_revision=99;release();
 const result=await pending;
 assert.equal(result.revision,1);assert.equal(result.draft.threshold_percent,80);
 assert.equal(data.get('usage-preferences:unbound:v1').threshold_percent,80);
 // A stale caller cannot update its supplied revision while authentication waits.
 let resume,seen;const wait=new Promise(resolve=>resume=resolve),ready=new Promise(resolve=>seen=resolve);let first=true;
 const staleController=createUnboundUsagePreferenceController({storage,now:()=>1000,getContext:async()=>{if(first){first=false;seen();await wait;}return context;}});
 const stale={expected_revision:0,threshold_percent:60},attempt=staleController.saveDraft(stale);
 await ready;stale.expected_revision=1;resume();
 await assert.rejects(attempt,{code:'revision_conflict'});
 assert.equal(data.get('usage-preferences:unbound:v1').revision,1);
 assert.equal(data.get('usage-preferences:unbound:v1').threshold_percent,80);
});
