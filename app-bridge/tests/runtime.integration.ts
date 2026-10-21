import test from 'node:test';import assert from 'node:assert/strict';import {unstable_dev} from 'wrangler';
async function rpcBody(response:{headers:{get(name:string):string|null};json():Promise<any>;text():Promise<string>},id:number):Promise<any>{
  if(response.headers.get('Content-Type')?.includes('application/json'))return response.json();
  const frames=(await response.text()).replaceAll('\r\n','\n').split('\n\n');
  for(const frame of frames){const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(data){const body=JSON.parse(data);if(body.id===id)return body;}}
  assert.fail('MCP wire did not return the matching response');
}
test('real workerd / SQLite / KV / R2 / MCP integration with labelled identities',async()=>{
  process.env.NODE_ENV='test';
  const worker=await unstable_dev('tests/runtime-worker.ts',{config:'wrangler.jsonc',port:8792,ip:'127.0.0.1',local:true,persist:false,vars:{PUBLIC_ORIGIN:'http://127.0.0.1:8792',WORKER_TOKEN:'runtime-fixture-only'},logLevel:'warn',experimental:{disableExperimentalWarning:true,disableDevRegistry:true,watch:false}});
  const web=(path:string,init?:Parameters<typeof worker.fetch>[1])=>worker.fetch('http://127.0.0.1:8792'+path,init);
  let count=0;
  try {
    const fixture=async(workspace:string,action:string,data:any={},who='alice',binding?:any)=>{
      const r=await web('/__fixture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspace,action,data,who,binding})});const body:any=await r.json();return {r,body};
    };
    const post=async(path:string,data:any,token='runtime-fixture-only')=>{const r=await web(path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(data)});return {r,body:await r.json() as any};};
    const a=crypto.randomUUID(),b=crypto.randomUUID();
    assert.equal((await fixture(a,'create',{id:a,name:'Fixture A'})).r.status,200);count++;
    assert.equal((await fixture(b,'create',{id:b,name:'Fixture B'},'bob')).r.status,200);count++;
    assert.equal((await fixture(a,'view',{},'bob')).r.status,403);count++;
    assert.equal((await web('/api/workspaces/'+a,{headers:{'X-User-Id':'alice','X-Workspace-Id':a}})).status,401);count++;
    await fixture(a,'member',{email:'bob@example.test'});assert.equal((await fixture(a,'view',{},'bob')).r.status,200);count++;
    const source=(await fixture(a,'source',{source:{label:'Pro fixture',platform:'chatgpt'}})).body.source;
    const other=(await fixture(a,'source',{source:{label:'Generic MCP fixture',platform:'mcp'}},'bob')).body.source;
    const key=crypto.randomUUID();const input={title:'真实队列边界测试',operation:'regional_search',sourceId:'public-web',arguments:{query:'Moli browser',engine:'baidu',limit:2}};
    const first=await fixture(a,'create-tasks',{idempotencyKey:key,input});assert.equal(first.r.status,200);const task=first.body.tasks[0];count++;
    assert.equal((await fixture(a,'create-tasks',{idempotencyKey:key,input})).body.replayed,true);count++;
    assert.equal((await fixture(a,'create-tasks',{idempotencyKey:key,input:{...input,title:'不同内容'}})).r.status,409);count++;
    await new Promise(resolve=>setTimeout(resolve,200));
    const claimed=await post('/api/worker/claim',{capabilities:['regional_search','fetch_public_page']});assert.equal(claimed.r.status,200);const job=claimed.body.job;assert.equal(job.task_id,task.id);count++;
    assert.equal((await post('/api/worker/claim',{capabilities:['regional_search','fetch_public_page']})).body.job,null);count++;
    const heartbeat=await post('/api/worker/heartbeat',{job_id:job.job_id,lease_token:job.lease_token});assert.equal(heartbeat.r.status,200);assert.ok(Date.parse(heartbeat.body.lease_expires_at)>Date.now());count++;
    const upload=async(value:string)=>web('/api/worker/artifacts/'+job.job_id+'/content.txt',{method:'PUT',headers:{Authorization:'Bearer runtime-fixture-only','X-Worker-Lease':job.lease_token,'Content-Type':'text/plain'},body:value});
    const file=await upload('真实 HTTP 附件');assert.equal(file.status,200);const artifact:any=await file.json();assert.equal((await upload('真实 HTTP 附件')).status,200);assert.equal((await upload('不同附件')).status,409);count++;
    const token=await fixture(a,'connector',{},'alice');assert.equal(token.r.status,400); // Missing binding cannot mint a credential.
    const credentialsResponse=await web('/__fixture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspace:a,action:'connector',sourceId:source.id})});const credentials:any=await credentialsResponse.json();assert.equal(credentialsResponse.status,200);count++;
    const download=await web('/api/workspaces/'+a+'/artifacts/'+artifact.artifact_id,{headers:{Authorization:'Bearer '+credentials.token}});assert.equal(download.status,404); // source-scoped connector cannot read a dashboard-created worker task.
    const report={job_id:job.job_id,lease_token:job.lease_token,status:'succeeded',result:{content:'保留回执',artifacts:[{artifact_id:artifact.artifact_id}]}};
    assert.equal((await post('/api/worker/result',report)).r.status,200);assert.equal((await post('/api/worker/result',report)).body.replayed,true);assert.equal((await post('/api/worker/result',{...report,result:{content:'冲突'}})).r.status,409);count++;
    const get=await fixture(a,'task',{id:task.id});assert.equal(get.body.report.result.content,'保留回执');assert.equal(get.body.task.status,'succeeded');count++;
    const beforeRead=(await fixture(a,'__inspect')).body;await fixture(a,'task',{id:task.id});await fixture(a,'view');await fixture(a,'export');const afterRead=(await fixture(a,'__inspect')).body;assert.deepEqual(afterRead,beforeRead);count++;
    const convo=(await fixture(a,'create-tasks',{idempotencyKey:crypto.randomUUID(),input:{title:'Pro fixture task',operation:'conversation',input:'仅本地测试，不发往真实产品',sourceId:source.id}})).body.tasks[0];
    const browserJob=(await post('/api/connector/claim',{},credentials.token)).body.job;assert.equal(browserJob.task_id,convo.id);count++;
    assert.equal((await post('/api/worker/heartbeat',{job_id:browserJob.job_id,lease_token:browserJob.lease_token})).r.status,403);count++;
    assert.equal((await post('/api/connector/heartbeat',{job_id:browserJob.job_id,lease_token:browserJob.lease_token,phase:'sending'},credentials.token)).r.status,200);count++;
    const current=(await fixture(a,'task',{id:convo.id})).body.task;await fixture(a,'control',{id:convo.id,revision:current.revision,action:'pause'});
    assert.equal((await post('/api/connector/heartbeat',{job_id:browserJob.job_id,lease_token:browserJob.lease_token},credentials.token)).r.status,409);assert.equal((await fixture(a,'task',{id:convo.id})).body.task.status,'unknown');count++;
    const late={job_id:browserJob.job_id,lease_token:browserJob.lease_token,status:'unknown',error:{code:'interrupted',message:'fixture'}};
    const lateResult=await post('/api/connector/result',late,credentials.token);assert.equal(lateResult.body.applied,false);assert.equal(lateResult.r.status,200);count++;
    const oldCurrent=(await fixture(a,'task',{id:convo.id})).body.task;await fixture(a,'control',{id:convo.id,revision:oldCurrent.revision,action:'retry'});
    const newer=(await post('/api/connector/claim',{},credentials.token)).body.job;assert.notEqual(newer.job_id,browserJob.job_id);assert.equal((await post('/api/connector/result',late,credentials.token)).body.replayed,true);count++;
    assert.equal((await post('/api/connector/heartbeat',{job_id:browserJob.job_id,lease_token:browserJob.lease_token},credentials.token)).r.status,409);const history=(await fixture(a,'task',{id:convo.id,job_id:browserJob.job_id})).body;assert.equal(history.execution.run,1);assert.notEqual(history.execution.runId,(await fixture(a,'task',{id:convo.id})).body.task.runId);assert.equal(JSON.stringify(history.execution).includes(browserJob.lease_token),false);count++;
    const extensionHeartbeat=await web('/api/connector/heartbeat',{method:'POST',headers:{'Content-Type':'application/json',Origin:'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',Authorization:'Bearer '+credentials.token},body:JSON.stringify({job_id:newer.job_id,lease_token:newer.lease_token})});assert.equal(extensionHeartbeat.status,200);count++;
    const mcp=await web('/__fixture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspace:a,action:'mcp',binding:{kind:'mcp',sourceId:source.id,workspaceId:a},rpc:{jsonrpc:'2.0',id:1,method:'tools/list',params:{}}})});
    assert.equal(mcp.status,200);const rpc:any=await rpcBody(mcp,1);assert.deepEqual(rpc.result.tools.map((t:any)=>t.name).sort(),['claim_task','control_task','dispatch_task','get_task','heartbeat_task','list_inbox','report_task','update_task']);count++;
    let rpcId=10;const tool=async(who:string,sourceId:string,name:string,args:any,scopes=['bridge:read','bridge:write','bridge:control'])=>{const id=rpcId++;const r=await web('/__fixture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspace:a,who,action:'mcp',binding:{kind:'mcp',sourceId,workspaceId:a,scopes},rpc:{jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}}})});assert.equal(r.status,200);return (await rpcBody(r,id)).result;};
    const dispatched=await tool('alice',source.id,'dispatch_task',{idempotencyKey:crypto.randomUUID(),input:{title:'MCP round trip',sourceId:other.id,operation:'conversation',input:'仅本地夹具回路，不发真实产品'}});const mcpTask=dispatched.structuredContent.tasks[0];count++;
    assert.equal((await tool('alice',source.id,'claim_task',{})).isError,true);count++;
    const denied=await tool('bob',other.id,'claim_task',{},['bridge:read']);assert.equal(denied.isError,true);count++;
    const nativeJob=(await tool('bob',other.id,'claim_task',{})).structuredContent.job;assert.equal(nativeJob.task_id,mcpTask.id);assert.ok(Date.parse(nativeJob.lease_expires_at)>Date.now()+800000);count++;
    assert.ok((await tool('bob',other.id,'heartbeat_task',{job_id:nativeJob.job_id,lease_token:nativeJob.lease_token})).structuredContent.lease_expires_at);count++;
    const nativeReport={job_id:nativeJob.job_id,lease_token:nativeJob.lease_token,status:'succeeded',result:{text:'MCP fixture completed'}};assert.equal((await tool('bob',other.id,'report_task',{report:nativeReport})).structuredContent.applied,true);count++;
    const observed=(await tool('alice',source.id,'get_task',{id:mcpTask.id})).structuredContent;assert.equal(observed.task.status,'succeeded');assert.equal(observed.report.result.text,'MCP fixture completed');assert.equal(observed.report.lease_token,undefined);count++;
    const again=await tool('alice',source.id,'dispatch_task',{idempotencyKey:crypto.randomUUID(),input:{title:'MCP pause fixture',sourceId:other.id,operation:'conversation',input:'仅本地中断夹具'}});const interruptedTask=again.structuredContent.tasks[0];await tool('bob',other.id,'claim_task',{});
    const interruptedCurrent=(await fixture(a,'task',{id:interruptedTask.id})).body.task;assert.equal(interruptedCurrent.lease.phase,'observing');
    assert.equal((await fixture(a,'control',{id:interruptedTask.id,revision:interruptedCurrent.revision,action:'pause'})).body.task.status,'unknown');const unknown=(await fixture(a,'task',{id:interruptedTask.id})).body.task;
    assert.equal((await fixture(a,'control',{id:interruptedTask.id,revision:unknown.revision,action:'resume'})).r.status,409);count++;
    const resolved=await fixture(a,'resolve',{id:interruptedTask.id,revision:unknown.revision,status:'succeeded',note:'人工核对夹具结果，不重新发送'});assert.equal(resolved.body.task.status,'succeeded');assert.equal((await fixture(a,'task',{id:interruptedTask.id})).body.report.result.manual,true);count++;
    const scoped=await fixture(a,'task',{id:task.id},'alice',{kind:'mcp',sourceId:source.id,workspaceId:a});assert.equal(scoped.r.status,404);assert.equal((await fixture(b,'view',{},'alice',{kind:'mcp',sourceId:source.id,workspaceId:a})).r.status,403);count++;
    const csv=await fixture(a,'export');assert.ok(csv.body.csv.includes('真实队列边界测试'));const audits=await fixture(a,'audit');assert.ok(audits.body.events.some((e:any)=>e.action==='result_succeeded'));count++;
    const health=await web('/health');assert.equal(health.status,200);const html=await web('/');assert.equal(html.status,200);assert.ok((await html.text()).includes('任务路线'));count++;
    assert.equal((await web('/robots.txt')).status,200);count++;
    console.log(JSON.stringify({checks:count,runtime:'real local workerd',storage:['SQLite DO','KV','R2'],identity:'labelled test principals; not real Google or product UI'},null,2));
  }finally{await worker.stop();}
});
