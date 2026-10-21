import test from 'node:test';
import assert from 'node:assert/strict';
import {createTasks,taskSchema,patchSchema,claimTask,heartbeat,completeTask,controlTask,resolveTask,patchTask,expireLeases,member,executor,findTask,viewTask,Problem,type Workspace,type Identity,type NewTask} from '../src/core';
import {exportCsv,importCsv,parseCsv} from '../src/csv';
import {dashboardJs} from '../src/ui';
import {Script,createContext} from 'node:vm';
const alice:Identity={userId:'alice',email:'alice@example.test',kind:'session',sourceId:'dashboard',scopes:['bridge:read','bridge:write','bridge:control']};
const bob:Identity={...alice,userId:'bob',email:'bob@example.test'};
function workspace():Workspace{return {id:crypto.randomUUID(),name:'Test project',ownerId:'alice',members:{[alice.email]:'owner'},sources:[{id:'chatgpt',ownerId:'alice',label:'Pro',platform:'chatgpt'},{id:'gemini',ownerId:'alice',label:'Tasks',platform:'gemini'},{id:'public-web',ownerId:'alice',label:'Public',platform:'worker'}],tasks:[]};}
function input(patch:Partial<NewTask>={}):NewTask{return taskSchema.parse({title:'分析',input:'真实任务内容',sourceId:'chatgpt',operation:'conversation',...patch});}
function success(w:Workspace,t:ReturnType<typeof createTasks>[0],at=1000){const c=claimTask(w,t.id,at)!;return completeTask(w,{job_id:c.lease!.jobId,lease_token:c.lease!.token,status:'succeeded',result:{text:'已完成'}},at+100);}
function code(code:string){return (e:unknown)=>e instanceof Problem&&e.code===code;}
test('members and source bindings reject cross-tenant / forged identity',()=>{
  const w=workspace();assert.throws(()=>member(w,bob),code('not_member'));assert.throws(()=>member(w,{...alice,workspaceId:crypto.randomUUID()}),code('workspace_binding'));
  w.members[bob.email]='member';assert.throws(()=>member(w,{...bob,kind:'mcp',sourceId:'chatgpt',workspaceId:w.id}),code('source_binding'));
});
test('a generic MCP grant cannot certify the designated browser product',()=>{const w=workspace();assert.throws(()=>executor(w,{...alice,kind:'mcp',sourceId:'chatgpt',workspaceId:w.id}),code('executor_platform'));assert.doesNotThrow(()=>executor(w,{...alice,kind:'connector',sourceId:'chatgpt',workspaceId:w.id}));});
test('source-scoped reads do not expose an unrelated task',()=>{
  const w=workspace();const [a,b]=createTasks(w,alice,[input(),input({sourceId:'gemini'})],1000);
  const p={...alice,kind:'mcp' as const,sourceId:'chatgpt',workspaceId:w.id};
  assert.equal(findTask(w,p,a!.id).id,a!.id);assert.throws(()=>findTask(w,p,b!.id),code('task_not_found'));
});
test('dependencies gate claims and completion releases the next node',()=>{
  const w=workspace();const [a]=createTasks(w,alice,[input()],1000);const [b]=createTasks(w,alice,[input({sourceId:'gemini',dependencies:[a!.id]})],1001);
  assert.equal(b!.status,'blocked');assert.equal(claimTask(w,b!.id,1002),null);success(w,a!);assert.equal(b!.status,'pending');assert.ok(claimTask(w,b!.id,1200));
});
test('cycle edits and missing dependencies leave the existing graph unchanged',()=>{
  const w=workspace();const [a]=createTasks(w,alice,[input()],1000);const [b]=createTasks(w,alice,[input({dependencies:[a!.id]})],1001);
  assert.throws(()=>patchTask(w,alice,a!.id,a!.revision,{dependencies:[b!.id]},1100),code('dependency_cycle'));assert.deepEqual(a!.dependencies,[]);
  assert.throws(()=>createTasks(w,alice,[input({dependencies:['missing']})],1101),code('missing_dependency'));assert.equal(w.tasks.length,2);
});
test('revision guards, argument schemas, source type and quota fail explicitly',()=>{
  assert.deepEqual(patchSchema.parse({title:'新标题'}),{title:'新标题'});
  const w=workspace();const [a]=createTasks(w,alice,[input()],1000);assert.throws(()=>patchTask(w,alice,a!.id,99,{title:'覆盖'},1100),code('revision_conflict'));
  const t=patchTask(w,alice,a!.id,a!.revision,{title:'新标题'},1101);assert.equal(t.input,'真实任务内容');assert.equal(t.sourceId,'chatgpt');
  assert.throws(()=>createTasks(w,alice,[input({operation:'regional_search',arguments:{query:'词',engine:'baidu'}})],1102),code('operation_source'));
  assert.throws(()=>createTasks(w,alice,[input({operation:'fetch_public_page',sourceId:'public-web',arguments:{url:'https://user:pass@example.com'}})],1103));
  assert.throws(()=>createTasks(w,alice,Array.from({length:100},()=>input()),1104),code('workspace_capacity'));
});
test('pause revokes the active lease, stale results never release dependents',()=>{
  const w=workspace();const [a]=createTasks(w,alice,[input()],1000);const [b]=createTasks(w,alice,[input({dependencies:[a!.id]})],1001);claimTask(w,a!.id,1100);const lease={...a!.lease!};
  controlTask(w,alice,a!.id,'pause',a!.revision,1200);assert.equal(a!.status,'paused');assert.throws(()=>heartbeat(w,lease.jobId,lease.token,1300),code('lease_revoked'));
  assert.throws(()=>completeTask(w,{job_id:lease.jobId,lease_token:lease.token,status:'succeeded'},1301),code('lease_revoked'));assert.equal(b!.status,'blocked');
  controlTask(w,alice,a!.id,'resume',a!.revision,1400);assert.ok(claimTask(w,a!.id,1401));
});
test('interrupting a possibly sent conversation requires explicit reconciliation, no replay',()=>{
  const w=workspace();const [a]=createTasks(w,alice,[input()],1000);claimTask(w,a!.id,1100);const lease={...a!.lease!};heartbeat(w,lease.jobId,lease.token,1200,'sending');
  controlTask(w,alice,a!.id,'pause',a!.revision,1300);assert.equal(a!.status,'unknown');assert.equal(claimTask(w,a!.id,1400),null);
  assert.throws(()=>controlTask(w,alice,a!.id,'resume',a!.revision,1500),code('control_state'));const runId=a!.runId;
  controlTask(w,alice,a!.id,'retry',a!.revision,1600);assert.equal(a!.run,2);assert.notEqual(a!.runId,runId);assert.ok(claimTask(w,a!.id,1700));
});
test('lease expiry persists unknown/failed and heartbeat extends the deadline',()=>{
  const w=workspace();const [a,b]=createTasks(w,alice,[input(),input({sourceId:'public-web',operation:'regional_search',input:'',arguments:{query:'中俄',engine:'yandex'}})],1000);
  claimTask(w,a!.id,1100);claimTask(w,b!.id,1100);const token=a!.lease!.token;heartbeat(w,a!.lease!.jobId,token,80000,'observing');assert.equal(a!.lease!.expiresAt,170000);
  assert.throws(()=>heartbeat(w,a!.lease!.jobId,token,81000,'claimed'),code('phase_regression'));
  expireLeases(w,171000);assert.equal(a!.status,'unknown');assert.equal(b!.status,'failed');assert.equal(claimTask(w,a!.id,172000),null);
});
test('read views never serialize lease tokens',()=>{
  const w=workspace();const [a]=createTasks(w,alice,[input()],1000);claimTask(w,a!.id,1100);assert.ok(!JSON.stringify(viewTask(a!)).includes(a!.lease!.token));
});
test('a human can reconcile unknown without resending, preserving source restrictions',()=>{
  const w=workspace();const [a]=createTasks(w,alice,[input()],1000);const [b]=createTasks(w,alice,[input({dependencies:[a!.id]})],1001);claimTask(w,a!.id,1100);expireLeases(w,100000);
  assert.throws(()=>resolveTask(w,{...alice,kind:'mcp'},a!.id,a!.revision,'succeeded','原文',100001),code('session_required'));
  resolveTask(w,alice,a!.id,a!.revision,'succeeded','人工核对原页面真实结果',100002);assert.equal(a!.status,'succeeded');assert.equal(b!.status,'pending');assert.equal(a!.run,1);
});
test('CSV quoted newlines, unicode and formula-safe cells round trip with remapped DAG IDs',()=>{
  const w=workspace();const [a]=createTasks(w,alice,[input({title:'=危险公式',input:'中文,"引号"\n俄文 Привет'})],1000);createTasks(w,alice,[input({title:"'原始单引号",dependencies:[a!.id]})],1001);
  const csv=exportCsv(w.tasks);assert.match(csv,/"'=危险公式"/);const batch=importCsv(csv);const w2=workspace();const imported=createTasks(w2,alice,batch.inputs,2000,batch.ids);assert.equal(imported[0]!.title,'=危险公式');assert.equal(imported[0]!.input,w.tasks[0]!.input);assert.equal(imported[1]!.title,"'原始单引号");assert.deepEqual(imported[1]!.dependencies,[imported[0]!.id]);
  assert.throws(()=>parseCsv('a,"未闭合'),code('invalid_csv'));assert.throws(()=>parseCsv('"a"x,b'),code('invalid_csv'));
});
test('dashboard shipped JavaScript parses without template escaping errors',()=>{assert.doesNotThrow(()=>new Script(dashboardJs));});
test('dashboard ignores stale workspace responses and blocks writes during a switch',async()=>{
  const elements=new Map<string,any>();const element=(id:string)=>{if(!elements.has(id))elements.set(id,{value:'',hidden:false,files:[],addEventListener(){},replaceChildren(){}});return elements.get(id);};
  const pending=new Map<string,(value:any)=>void>();
  const context=createContext({document:{getElementById:element,addEventListener(){},hidden:false},fetch:(url:string)=>new Promise(resolve=>{pending.set(url,(body:any)=>resolve({ok:true,headers:{get:()=> 'application/json'},json:async()=>body}));}),setInterval(){},console,sessionStorage:{getItem(){},setItem(){},removeItem(){}}});
  new Script(dashboardJs+'\nrender=()=>{};globalThis.hooks={load,base,getWorkspace:()=>workspace};').runInContext(context);
  const hooks=context.hooks as any;element('workspace').value='A';const first=hooks.load();
  element('workspace').value='B';const second=hooks.load();assert.throws(()=>hooks.base(),/加载完成/);
  pending.get('/api/workspaces/B')!({workspace:{id:'B'}});await second;assert.equal(hooks.base(),'/api/workspaces/B');
  pending.get('/api/workspaces/A')!({workspace:{id:'A'}});await first;assert.equal(hooks.getWorkspace().id,'B');
  element('workspace').value='';await hooks.load();assert.throws(()=>hooks.base(),/加载完成/);
});
test('dashboard defaults to an operation the selected source can actually execute',()=>{
  const div={hidden:false};const elements:any={};const get=(id:string)=>elements[id]??={value:'',options:[],hidden:false,addEventListener(){},closest:()=>div};
  const context=createContext({document:{getElementById:get,addEventListener(){}},fetch:()=>new Promise(()=>{}),setInterval(){},console});
  new Script(dashboardJs+'\nglobalThis.hooks={syncOperation,setWorkspace:v=>workspace=v};').runInContext(context);const hooks=context.hooks as any;
  hooks.setWorkspace({sources:[{id:'public-web',platform:'worker'},{id:'pro',platform:'chatgpt'}]});get('task-source').value='public-web';get('task-operation').options=['conversation','regional_search','fetch_public_page'].map(value=>({value}));get('task-operation').value='conversation';
  hooks.syncOperation();assert.equal(get('task-operation').value,'regional_search');assert.equal(get('task-operation').options[0].disabled,true);assert.equal(div.hidden,false);
  get('task-operation').value='fetch_public_page';hooks.syncOperation();assert.equal(get('task-operation').value,'fetch_public_page');assert.equal(div.hidden,true);
  get('task-source').value='pro';hooks.syncOperation();assert.equal(get('task-operation').value,'conversation');assert.equal(get('task-operation').options[1].disabled,true);
});
