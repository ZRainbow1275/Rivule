import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dashboardResponse } from '../src/owner/dashboard.mjs';
import { readDashboardCatalog,readDashboardCatalogSelection } from '../src/owner/dashboard-catalog.mjs';
const origin='https://rivule.example.test';
function fixture(count=3) {
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE branches(branch_key TEXT PRIMARY KEY,source_id TEXT,project_id TEXT,payload TEXT,seq INTEGER,state_version INTEGER,revision INTEGER,last_confirmed REAL,archived INTEGER)');
 const data=new Map(),calls=[];let time=1800000000000,queue=Promise.resolve(),snapshotReads=0;
 const bindings={ownerId:'owner',appId:'123',userId:'456',dmId:'789',publicOrigin:origin,allowedProjectIds:['project'],sources:[{source_id:'zot-main',enabled:true},{source_id:'muse-main',enabled:true,provider:'muse'}]};
 db.prepare('INSERT INTO meta VALUES (?,?)').run('identity',JSON.stringify(['owner','123','456','789']));
 const queries=[];
 function add(i,source='zot-main',patch={},rowPatch={}) {
  const query={project_id:'project',task_id:'task'+String(i).padStart(3,'0'),run_id:'run',branch_id:'main'};
  const payload={...query,source_id:source,source_seq:1,sensitivity:'normal',source_status:'running',project_name:'Project',task_name:'Task '+i,branch_name:'Main',occurred_at:new Date(time).toISOString(),summary:'PRIVATE SUMMARY',blocker:'PRIVATE BLOCKER',...patch};
  const row={branch_key:JSON.stringify([source,query.task_id,query.run_id,query.branch_id]),source_id:source,project_id:payload.project_id,payload:JSON.stringify(payload),seq:1,state_version:1,revision:1,last_confirmed:time,archived:0,...rowPatch};
  db.prepare('INSERT INTO branches VALUES (?,?,?,?,?,?,?,?,?)').run(...Object.values(row));return query;
 }
 for(let i=0;i<count;i++)queries.push(add(i));
 const storage={sql:{exec(sql,...args){calls.push(sql);assert.match(sql,/^SELECT /);return {toArray:()=>db.prepare(sql).all(...args)};}},async get(k){return structuredClone(data.get(k));},async put(k,v){assert.ok(k.startsWith('dashboard:'));data.set(k,structuredClone(v));},async delete(k){data.delete(k);},async list({prefix,limit}){return new Map([...data].filter(([k])=>k.startsWith(prefix)).slice(0,limit));},transaction(fn){const p=queue.then(()=>fn(storage));queue=p.catch(()=>{});return p;}};
 const env={DASHBOARD_ENABLED:'true',DASHBOARD_WATCHLIST_JSON:'[]'};
 const ctx={env,bindings,storage,now:()=>time,identity:{async authorizationUrl(state){return 'https://discord.com/oauth2/authorize?'+new URLSearchParams({state,scope:'identify',client_id:bindings.appId,redirect_uri:origin+'/callback'});},async authenticate(){return {subject:bindings.userId};}},readCatalog:(s,a)=>readDashboardCatalog(storage,bindings,s,a,time),readSelection:(s,q)=>readDashboardCatalogSelection(storage,bindings,s,q,time),readSnapshot:async(s,q)=>{snapshotReads++;return {schema_version:'1.0',source_id:s.source_id,...q,observed_at:new Date(time).toISOString(),found:false,snapshot:null};}};
 async function send(path,cookie='',body,extra={}) {return dashboardResponse(new Request('https://owner.internal'+path,{method:body===undefined?'GET':'POST',headers:{cookie,'sec-fetch-site':'same-origin',...(body===undefined?{}:{origin,'content-type':'application/json'}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})}),ctx);}
 const pick=(r,n)=>r.headers.getSetCookie().find(c=>c.startsWith(n+'=')).split(';')[0];
 async function login(){const r=await send('/dashboard/login','',{}),state=new URL(r.headers.get('location')).searchParams.get('state');const complete=await send('/callback?state='+state+'&code=code',pick(r,'__Host-rivule-dashboard-login'));return pick(complete,'__Host-rivule-dashboard-session');}
 async function chooser(cookie,source_id='zot-main',request_id='a'.repeat(32)) {const scope=await (await send('/dashboard/task-picker',cookie)).json();const base={csrf:scope.csrf,source_id,request_id};return {base,scope,access:()=>send('/dashboard/task-picker/access',cookie,{...base,confirm:true}),post:(path,body={})=>send('/dashboard/task-picker/'+path,cookie,{...base,...body})};}
 return {db,data,calls,bindings,storage,ctx,queries,add,send,login,chooser,advance(ms){time+=ms;},get reads(){return snapshotReads;},get now(){return time;}};
}
test('no catalog reads before explicit source-specific opt-in; minimal redacted catalog, SELECT only',async()=>{
 const f=fixture(),c=await f.login();await f.send('/dashboard/data',c);const p=await f.chooser(c);assert.equal(f.calls.length,0);assert.equal(p.scope.sources.length,2);
 const r=await p.access();assert.equal(r.status,200);const page=await r.json();assert.equal(page.items.length,3);assert.equal(page.items[0].ref.length,32);
 const text=JSON.stringify(page);for(const secret of ['PRIVATE SUMMARY','PRIVATE BLOCKER','task_id','project_id','run_id','receipt','recipient'])assert.ok(!text.includes(secret));
 assert.ok(f.calls.every(s=>s.startsWith('SELECT ')));assert.ok(f.calls.some(s=>s.includes('LIMIT 26')));assert.equal(f.reads,0);
 const applied=await p.post('apply',{refs:[page.items[0].ref]});assert.equal(applied.status,200);await f.send('/dashboard/data',c);assert.equal(f.reads,1);
});
test('POST schema, origin, CSRF, explicit consent and source isolation fail closed without reads',async()=>{
 const f=fixture(),c=await f.login(),p=await f.chooser(c);
 for(const [body,status] of [[{...p.base},403],[{...p.base,confirm:false},403],[{...p.base,confirm:true,extra:true},403],[{...p.base,confirm:true,csrf:'bad'},403],[{...p.base,confirm:true,source_id:'foreign'},403]])assert.equal((await f.send('/dashboard/task-picker/access',c,body)).status,status);
 assert.equal((await f.send('/dashboard/task-picker/access',c,{...p.base,confirm:true},{origin:'https://evil.test'})).status,403);
 assert.equal((await f.send('/dashboard/task-picker/access',c,{...p.base,confirm:true},{'content-type':'text/plain'})).status,415);
 assert.equal(f.calls.length,0);
});
test('strict owner identity, source, project, malformed rows and restricted metadata',async()=>{
 for(const mutate of [f=>f.db.exec("DELETE FROM meta"),f=>f.db.exec("UPDATE meta SET value='foreign'"),f=>f.db.exec("UPDATE branches SET payload='invalid'"),f=>f.db.exec("UPDATE branches SET revision=0"),f=>f.db.exec("UPDATE branches SET branch_key='invalid'"),f=>f.db.exec("UPDATE branches SET last_confirmed=9999999999999")]) {
  const f=fixture(1),c=await f.login(),p=await f.chooser(c);mutate(f);assert.equal((await p.access()).status,503);
 }
 const f=fixture(0);f.add(1,'zot-main',{sensitivity:'restricted',task_name:'SECRET NAME'});f.add(2,'zot-main',{project_id:'foreign',task_name:'FOREIGN NAME'});f.add(3,'muse-main',{task_name:'OTHER SOURCE'});
 const c=await f.login(),p=await f.chooser(c),r=await p.access();const page=await r.json();assert.deepEqual(page.items,[]);assert.ok(!JSON.stringify(page).includes('withheld'));assert.ok(!JSON.stringify(page).includes('SECRET'));
});
test('bounded stable keyset pagination, filtered empty pages, source/session/cursor/ref isolation',async()=>{
 const f=fixture(55);f.db.exec("UPDATE branches SET payload=json_set(payload,'$.sensitivity','restricted') WHERE branch_key < '[\"zot-main\",\"task025\"'");
 const c=await f.login(),p=await f.chooser(c),first=await (await p.access()).json();assert.equal(first.items.length,0);assert.ok(first.next_cursor);
 const second=await (await p.post('page',{cursor:first.next_cursor})).json();assert.equal(second.items.length,25);assert.ok(second.next_cursor);
 assert.equal((await p.post('page',{cursor:first.next_cursor})).status,403);
 const last=await (await p.post('page',{cursor:second.next_cursor})).json();assert.equal(last.items.length,5);assert.equal(last.next_cursor,null);
 const other=await f.login(),otherPicker=await f.chooser(other);await otherPicker.access();assert.equal((await otherPicker.post('apply',{refs:[second.items[0].ref]})).status,403);
 assert.equal((await f.send('/dashboard/task-picker/apply',c,{...p.base,source_id:'muse-main',refs:[second.items[0].ref]})).status,403);
 assert.equal((await p.post('apply',{refs:['f'.repeat(32)]})).status,403);
 assert.equal((await p.post('apply',{refs:[second.items[0].ref,second.items[0].ref]})).status,422);
});
test('finite traversal, global configured/test/dynamic selection limit and bounded stored state',async()=>{
 const f=fixture(275),c=await f.login(),p=await f.chooser(c);let page=await (await p.access()).json(),count=page.items.length;
 while(page.next_cursor){page=await (await p.post('page',{cursor:page.next_cursor})).json();count+=page.items.length;}
 assert.equal(count,250);assert.equal(page.scan_limit_reached,true);
 const session=[...f.data.values()].find(v=>v.taskPicker);assert.equal(session.taskPicker.refs.length,250);assert.ok(Buffer.byteLength(JSON.stringify(session))<96*1024);
 const g=fixture(22);g.ctx.env.DASHBOARD_WATCHLIST_JSON=JSON.stringify(g.queries.slice(0,19));const gc=await g.login(),gp=await g.chooser(gc),catalog=await (await gp.access()).json();
 assert.equal(catalog.items.filter(i=>i.configured).length,19);assert.equal((await gp.post('apply',{refs:catalog.items.slice(19,21).map(i=>i.ref)})).status,409);
 assert.equal((await gp.post('apply',{refs:[catalog.items[19].ref]})).status,200);
});
test('selection revalidates sensitivity/source/project on apply and every dynamic data read',async()=>{
 const f=fixture(),c=await f.login(),p=await f.chooser(c),page=await (await p.access()).json();
 f.db.exec("UPDATE branches SET payload=json_set(payload,'$.sensitivity','restricted')");assert.equal((await p.post('apply',{refs:[page.items[0].ref]})).status,409);
 f.db.exec("UPDATE branches SET payload=json_set(payload,'$.sensitivity','normal')");assert.equal((await p.post('apply',{refs:[page.items[0].ref]})).status,200);
 f.db.exec("UPDATE branches SET payload=json_set(payload,'$.sensitivity','restricted')");assert.equal((await f.send('/dashboard/data',c)).status,409);assert.equal(f.reads,0);
});
test('existing off-page selection references survive reopen/apply; cancellation preserves old selection',async()=>{
 const f=fixture(30),c=await f.login(),p=await f.chooser(c),first=await (await p.access()).json(),last=await (await p.post('page',{cursor:first.next_cursor})).json();
 assert.equal((await p.post('apply',{refs:[last.items[4].ref]})).status,200);
 const next=await f.chooser(c,'zot-main','b'.repeat(32)),page=await (await next.access()).json();assert.equal(page.selected_refs.length,1);assert.ok(!page.items.some(i=>i.ref===page.selected_refs[0]));
 assert.equal((await next.post('apply',{refs:page.selected_refs})).status,200);await f.send('/dashboard/data',c);assert.equal(f.reads,1);
 const cancel=await f.chooser(c,'zot-main','c'.repeat(32));await cancel.access();await cancel.post('cancel');await f.send('/dashboard/data',c);assert.equal(f.reads,2);
});
test('cancel-before-access and stale source cancels cannot grant or revoke a newer chooser',async()=>{
 const f=fixture(),c=await f.login(),p=await f.chooser(c);assert.equal((await p.post('cancel')).status,200);assert.equal((await p.access()).status,409);assert.equal(f.calls.length,0);
 const newer=await f.chooser(c,'zot-main','b'.repeat(32)),page=await (await newer.access()).json();await p.post('cancel');assert.equal((await newer.post('apply',{refs:[page.items[0].ref]})).status,200);
});
test('binding includes destination/project/source/selectors; TTL and cross-session revoke selection',async()=>{
 for(const change of [f=>f.bindings.dmId='different',f=>f.bindings.allowedProjectIds.push('other'),f=>f.bindings.sources[1].display_name='changed',f=>f.ctx.env.DASHBOARD_WATCHLIST_JSON=JSON.stringify([f.queries[0]])]){
  const f=fixture(),c=await f.login(),p=await f.chooser(c),page=await (await p.access()).json();await p.post('apply',{refs:[page.items[0].ref]});change(f);assert.equal((await f.send('/dashboard/data',c)).status,401);
 }
 const f=fixture(),c=await f.login(),p=await f.chooser(c),page=await (await p.access()).json();await p.post('apply',{refs:[page.items[0].ref]});const other=await f.login();assert.equal((await (await f.send('/dashboard/data',other)).json()).items.length,0);f.advance(900001);assert.equal((await f.send('/dashboard/data',c)).status,401);
});
test('serialized session mutations preserve unrelated state and logout prevents late session resurrection',async()=>{
 const f=fixture(),c=await f.login(),p=await f.chooser(c);const key=[...f.data.keys()].find(k=>k.startsWith('dashboard:session:'));f.data.get(key).unrelated={qq:'keep'};
 const responses=await Promise.all([p.access(),f.send('/dashboard/logout',c,{})]);assert.equal(responses[0].status,200);assert.equal(responses[1].status,303);assert.equal(f.data.has(key),false);assert.equal((await p.access()).status,401);
 const g=fixture(),gc=await g.login(),gp=await g.chooser(gc),gkey=[...g.data.keys()].find(k=>k.startsWith('dashboard:session:'));g.data.get(gkey).unrelated={qq:'keep'};await gp.access();assert.deepEqual(g.data.get(gkey).unrelated,{qq:'keep'});
 const worker=readFileSync(new URL('../src/owner/worker.js',import.meta.url),'utf8');const block=worker.slice(worker.indexOf('    async fetch(request) {\n        if (isDashboardRoute'));assert.ok(block.indexOf('readCatalog:')<block.indexOf('initializeLegacy'));
});
test('revoked or deleted selections can be explicitly removed without disclosing stale metadata',async()=>{
 for(const removed of ['restricted','deleted']){
  const f=fixture(2),c=await f.login(),p=await f.chooser(c),page=await (await p.access()).json();await p.post('apply',{refs:page.items.map(i=>i.ref)});
  if(removed==='deleted')f.db.exec("DELETE FROM branches WHERE payload LIKE '%task000%'");else f.db.exec("UPDATE branches SET payload=json_set(payload,'$.sensitivity','restricted','$.task_name','PRIVATE RESTRICTED') WHERE payload LIKE '%task000%'");
  assert.equal((await f.send('/dashboard/data',c)).status,409);const next=await f.chooser(c,'zot-main','b'.repeat(32)),reopened=await (await next.access()).json();
  assert.equal(reopened.unavailable_selected_refs.length,1);assert.equal(reopened.selected_refs.length,2);assert.ok(!JSON.stringify(reopened).includes('PRIVATE RESTRICTED'));
  assert.equal((await next.post('apply',{refs:reopened.selected_refs})).status,409);
  assert.equal((await next.post('apply',{refs:reopened.selected_refs.filter(r=>!reopened.unavailable_selected_refs.includes(r))})).status,200);
  assert.equal((await (await f.send('/dashboard/data',c)).json()).items.length,1);
 }
});
test('valid ingestion clock skew is tolerated but not unbounded future timestamps',async()=>{
 const f=fixture(1);f.db.exec('UPDATE branches SET last_confirmed=last_confirmed+300000');const c=await f.login(),p=await f.chooser(c);assert.equal((await p.access()).status,200);
});
test('oversized catalog state fails without evicting issued refs or selections',async()=>{
 const f=fixture(0);f.bindings.allowedProjectIds=['p'.repeat(100)];
 for(let i=0;i<180;i++){
  const p={project_id:'p'.repeat(100),task_id:'t'+String(i).padStart(3,'0')+'x'.repeat(96),run_id:'r'.repeat(100),branch_id:'b'.repeat(100),source_id:'zot-main',source_seq:1,sensitivity:'normal',source_status:'running',occurred_at:new Date(f.now).toISOString()};
  const key=JSON.stringify([p.source_id,p.task_id,p.run_id,p.branch_id]);f.db.prepare('INSERT INTO branches VALUES (?,?,?,?,?,?,?,?,?)').run(key,p.source_id,p.project_id,JSON.stringify(p),1,1,1,f.now,0);
 }
 const c=await f.login(),p=await f.chooser(c);let response=await p.access(),page=await response.json(),stored;
 while(response.status===200 && page.next_cursor){stored=structuredClone([...f.data.values()].find(s=>s.taskPicker));response=await p.post('page',{cursor:page.next_cursor});page=await response.json();}
 assert.equal(response.status,409);assert.equal(page.error,'task_picker_capacity');assert.deepEqual([...f.data.values()].find(s=>s.taskPicker),stored);assert.ok(Buffer.byteLength(JSON.stringify(stored.taskPicker))<=64*1024);
});
test('QQ capability and picker grants coexist without stale-session replacement',async()=>{
 const f=fixture(),c=await f.login(),p=await f.chooser(c);f.ctx.env.DASHBOARD_QQ_SETTINGS_ENABLED='true';f.ctx.manageQQ=async()=>({scope:'existing-qq-binding',settings:{bound:true}});
 const responses=await Promise.all([p.access(),f.send('/dashboard/qq-settings/access',c,{csrf:p.base.csrf,confirm:true})]);assert.deepEqual(responses.map(r=>r.status),[200,200]);
 assert.equal([...f.data.keys()].filter(k=>k.startsWith('dashboard:qq-capability:')).length,1);assert.ok([...f.data.values()].some(s=>s.taskPicker));
});
test('catalog names redact credential-shaped strings and private destination IDs',async()=>{
 const f=fixture(0);f.add(1,'zot-main',{project_name:'token=private-token',task_name:'recipient_id=123456789012345678',branch_name:'Bearer private-token'});const c=await f.login(),p=await f.chooser(c),r=await p.access();assert.equal(r.status,200);const text=await r.text();assert.ok(!text.includes('private-token'));assert.ok(!text.includes('123456789012345678'));
});
test('catalog rejects foreign tuple payload, noncanonical ordering, malformed scope and disabled sources',()=>{
 const f=fixture(1),source=f.bindings.sources[0];
 assert.throws(()=>readDashboardCatalog(f.storage,f.bindings,{...source,enabled:false},'',f.now));
 assert.throws(()=>readDashboardCatalog(f.storage,{...f.bindings,dmId:''},source,'',f.now));
 assert.throws(()=>readDashboardCatalog(f.storage,f.bindings,source,'x'.repeat(421),f.now));
 f.db.exec("UPDATE branches SET payload=json_set(payload,'$.source_id','foreign')");assert.throws(()=>readDashboardCatalog(f.storage,f.bindings,source,'',f.now));
});
