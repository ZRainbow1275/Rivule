import {DurableObject} from 'cloudflare:workers';
import {z} from 'zod';
import {Problem,demand,member,owner,scope,executor,visible,findTask,taskSchema,patchSchema,createTasks,patchTask,controlTask,resolveTask,expireLeases,claimTask,heartbeat,leasedTask,reportSchema,completeTask,viewTask,jobView,type Identity,type Workspace,type Task} from './core';
import {exportCsv,importCsv} from './csv';

export interface StoreEnv {WORKSPACES:DurableObjectNamespace;DIRECTORY:DurableObjectNamespace;ARTIFACTS:R2Bucket}
const reply=(value:unknown,status=200)=>Response.json(value,{status});
export const READ_ACTIONS=new Set(['view','binding','audit','task','runs','export','artifact-read']);
export function problemResponse(e:unknown):Response {
  if(e instanceof Problem)return reply({error:{code:e.code,message:e.message}},e.status);
  if(e instanceof z.ZodError)return reply({error:{code:'invalid_input',message:e.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')}},400);
  console.error('bridge internal error',e instanceof Error?e.name:'unknown');
  return reply({error:{code:'internal_error',message:'服务暂时不可用，请稍后重试'}},500);
}
export async function internal(env:StoreEnv,name:string,action:string,data:unknown):Promise<any> {
  const stub=env.WORKSPACES.get(env.WORKSPACES.idFromName(name));
  const response=await stub.fetch('https://workspace.internal/'+action,{method:'POST',body:JSON.stringify(data)});
  const body:any=await response.json();if(!response.ok)throw new Problem(response.status,body.error?.code||'workspace_error',body.error?.message||'工作空间请求失败');return body;
}
export async function directory(env:StoreEnv,name:string,action:string,data:unknown):Promise<any> {
  const response=await env.DIRECTORY.get(env.DIRECTORY.idFromName(name)).fetch('https://directory.internal/'+action,{method:'POST',body:JSON.stringify(data)});
  const body:any=await response.json();if(!response.ok)throw new Problem(response.status,body.error?.code||'directory_error',body.error?.message||'目录请求失败');return body;
}
type Payload={principal?:Identity; [key:string]:any};
export class WorkspaceObject extends DurableObject<StoreEnv> {
  constructor(ctx:DurableObjectState,env:StoreEnv) {
    super(ctx,env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source_id TEXT NOT NULL, operation TEXT NOT NULL, lease_token TEXT NOT NULL); CREATE TABLE IF NOT EXISTS reports (job_id TEXT PRIMARY KEY, lease_token TEXT NOT NULL, body TEXT NOT NULL, task_id TEXT NOT NULL, source_id TEXT NOT NULL, operation TEXT NOT NULL, applied INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, body TEXT NOT NULL, task_ids TEXT NOT NULL); CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, task_id TEXT, action TEXT NOT NULL, detail TEXT); CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, task_id TEXT NOT NULL, filename TEXT NOT NULL, digest TEXT NOT NULL, size INTEGER NOT NULL, media_type TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0, UNIQUE(job_id,filename));');
    if(!ctx.storage.sql.exec<{name:string}>('PRAGMA table_info(jobs)').toArray().some(c=>c.name==='snapshot'))ctx.storage.sql.exec('ALTER TABLE jobs ADD COLUMN snapshot TEXT');
  }
  load():Workspace|undefined {
    const meta=this.ctx.storage.sql.exec<{json:string}>('SELECT json FROM meta WHERE id=1').toArray()[0];if(!meta)return;
    return {...JSON.parse(meta.json),tasks:this.ctx.storage.sql.exec<{json:string}>('SELECT json FROM tasks ORDER BY rowid').toArray().map(t=>JSON.parse(t.json))};
  }
  save(w:Workspace):void {const {tasks,...meta}=w;this.ctx.storage.sql.exec('INSERT OR REPLACE INTO meta VALUES (1,?)',JSON.stringify(meta));for(const t of tasks)this.ctx.storage.sql.exec('INSERT OR REPLACE INTO tasks VALUES (?,?)',t.id,JSON.stringify(t));}
  audit(p:string,action:string,taskId?:string,detail?:string):void {this.ctx.storage.sql.exec('INSERT INTO audit(at,actor,task_id,action,detail) VALUES (?,?,?,?,?)',Date.now(),p,taskId||null,action,detail||null);}
  async fetch(request:Request):Promise<Response> {
    try {
      const action=new URL(request.url).pathname.slice(1);const data=await request.json() as Payload;
      const result=this.ctx.storage.transactionSync(()=>this.apply(action,data));
      if(!READ_ACTIONS.has(action)) {await this.ctx.storage.setAlarm(Date.now()+30000);this.ctx.waitUntil(this.flush());}
      return reply(result);
    }catch(e){return problemResponse(e);}
  }
  apply(action:string,d:Payload):unknown {
    const now=Date.now();let w=this.load();const p=d.principal;
    if(action==='create') {
      demand(!w,409,'workspace_exists','工作空间已经存在');demand(p?.kind==='session',403,'session_required','需要登录后创建工作空间');
      w={id:z.string().uuid().parse(d.id),name:z.string().trim().min(1).max(100).parse(d.name),ownerId:p.userId,members:{[p.email.toLowerCase()]:'owner'},sources:[{id:'public-web',ownerId:p.userId,label:'公开网页 worker',platform:'worker'}],tasks:[]};this.save(w);this.audit(p.userId,'workspace_created');return {workspace:w};
    }
    demand(w,404,'workspace_not_found','工作空间不存在');
    const workerAction=['worker-claim','heartbeat','complete','artifact-reserve','artifact-ready'].includes(action);
    if(!workerAction) {demand(p,401,'authentication_required','需要身份认证');member(w,p);}
    const expired=READ_ACTIONS.has(action)?[]:expireLeases(w,now);for(const id of expired)this.audit('system','lease_expired',id);
    if(expired.length)this.save(w);
    if(action==='binding') {const s=w.sources.find(s=>s.id===d.sourceId&&s.ownerId===p!.userId&&s.platform!=='worker');return {allowed:!!s,platform:s?.platform};}
    if(action==='view') {
      scope(p!,'bridge:read');const tasks=w.tasks.filter(t=>visible(t,p!)).map(viewTask);return {workspace:p!.kind==='session'?{...w,tasks}:{id:w.id,name:w.name,sources:w.sources.map(({id,label,platform})=>({id,label,platform})),tasks}};
    }
    if(action==='member') {
      owner(w,p!);demand(p!.kind==='session',403,'session_required','成员管理需要网页登录');const email=z.string().email().max(254).parse(d.email).toLowerCase();
      demand(Object.keys(w.members).length<20 || w.members[email],409,'member_capacity','工作空间最多 20 个成员');w.members[email]='member';this.audit(p!.userId,'member_invited',undefined,email);this.save(w);return {email};
    }
    if(action==='source') {
      scope(p!,'bridge:write');demand(p!.kind==='session',403,'session_required','请在面板中绑定来源');demand(w.sources.length<30,409,'source_capacity','来源数量已达上限');
      const n=z.object({label:z.string().trim().min(1).max(80),platform:z.enum(['chatgpt','gemini','mcp'])}).strict().parse(d.source);
      const source={...n,id:crypto.randomUUID(),ownerId:p!.userId};w.sources.push(source);this.audit(p!.userId,'source_created',undefined,source.id);this.save(w);return {source};
    }
    if(action==='create-tasks' || action==='import') {
      scope(p!,'bridge:write');const key=z.string().min(8).max(128).parse(d.idempotencyKey);const receiptId=p!.userId+':'+p!.sourceId+':'+key;const body=JSON.stringify(d.input??d.csv);
      const old=this.ctx.storage.sql.exec<{body:string;task_ids:string}>('SELECT body,task_ids FROM receipts WHERE id=?',receiptId).toArray()[0];
      if(old) {demand(old.body===body,409,'idempotency_conflict','幂等键已用于不同输入');return {tasks:JSON.parse(old.task_ids).map((id:string)=>viewTask(findTask(w!,p!,id))),replayed:true};}
      const batch=action==='import'?importCsv(z.string().parse(d.csv)):{inputs:[taskSchema.parse(d.input)],ids:undefined};
      const tasks=createTasks(w,p!,batch.inputs,now,batch.ids);this.save(w);for(const t of tasks)this.audit(p!.userId,'task_created',t.id);
      this.ctx.storage.sql.exec('INSERT INTO receipts VALUES (?,?,?)',receiptId,body,JSON.stringify(tasks.map(t=>t.id)));return {tasks:tasks.map(viewTask)};
    }
    if(action==='task') {const task=findTask(w,p!,d.id);const job=d.job_id||task.lastJobId;const row=job?this.ctx.storage.sql.exec<{body:string;applied:number;snapshot:string|null}>('SELECT reports.body,reports.applied,jobs.snapshot FROM reports LEFT JOIN jobs ON reports.job_id=jobs.job_id WHERE reports.job_id=? AND reports.task_id=?',job,task.id).toArray()[0]:undefined;if(d.job_id)demand(row,404,'report_not_found','执行回执不存在');const report=row?JSON.parse(row.body):null;if(report)delete report.lease_token;return {task:viewTask(task),report,applied:row?!!row.applied:null,execution:row?.snapshot?JSON.parse(row.snapshot):null};}
    if(action==='runs') {const task=findTask(w,p!,d.id);return {runs:this.ctx.storage.sql.exec('SELECT reports.rowid seq,reports.job_id,applied,json_extract(jobs.snapshot,\'$.runId\') run_id,json_extract(body,\'$.status\') status,json_extract(body,\'$.error.code\') reason FROM reports LEFT JOIN jobs ON reports.job_id=jobs.job_id WHERE reports.task_id=? AND reports.rowid>? ORDER BY reports.rowid LIMIT 20',task.id,Math.max(0,Number(d.after)||0)).toArray()};}
    if(action==='update') {const patch=patchSchema.parse(d.patch);const task=patchTask(w,p!,d.id,z.number().int().parse(d.revision),patch,now);this.save(w);this.audit(p!.userId,'task_updated',task.id);return {task:viewTask(task)};}
    if(action==='control') {const task=controlTask(w,p!,d.id,z.enum(['pause','resume','cancel','retry']).parse(d.action),z.number().int().parse(d.revision),now);this.save(w);this.audit(p!.userId,d.action,task.id);return {task:viewTask(task)};}
    if(action==='resolve') {const status=z.enum(['succeeded','failed','cancelled']).parse(d.status);const note=z.string().min(1).max(16000).parse(d.note);const task=resolveTask(w,p!,d.id,z.number().int().parse(d.revision),status,note,now);const jobId=`${w.id}_${crypto.randomUUID()}`;task.lastJobId=jobId;const report={job_id:jobId,status,result:{text:note,manual:true,resolvedBy:p!.userId}};this.ctx.storage.sql.exec('INSERT INTO reports VALUES (?,?,?,?,?,?,1)',jobId,'manual',JSON.stringify(report),task.id,task.sourceId,task.operation);this.save(w);this.audit(p!.userId,'manual_resolution_'+status,task.id);return {task:viewTask(task)};}
    if(action==='export') {scope(p!,'bridge:read');return {csv:exportCsv(w.tasks.filter(t=>visible(t,p!)))};}
    if(action==='audit') {scope(p!,'bridge:read');demand(p!.kind==='session',403,'session_required','审计日志仅供面板成员查看');return {events:this.ctx.storage.sql.exec('SELECT * FROM audit WHERE seq>? ORDER BY seq LIMIT 200',Math.max(0,Number(d.after)||0)).toArray()};}
    if(action==='claim' || action==='worker-claim') {
      if(p)executor(w,p);
      if(p&&w.tasks.some(t=>t.lease&&t.sourceId===p.sourceId))return {job:null};
      const t=w.tasks.find(t=>t.status==='pending' && (p?t.sourceId===p.sourceId&&t.operation==='conversation':t.operation!=='conversation'&&t.id===d.taskId&&t.run===d.run));
      const ttl=p?.kind==='mcp'?z.number().int().min(90).max(10800).default(900).parse(d.lease_seconds)*1000:90000;
      const task=t?claimTask(w,t.id,now,ttl):null;if(task){if(p?.kind==='mcp')task.lease!.phase='observing';this.ctx.storage.sql.exec('INSERT INTO jobs (job_id,task_id,source_id,operation,lease_token,snapshot) VALUES (?,?,?,?,?,?)',task.lease!.jobId,task.id,task.sourceId,task.operation,task.lease!.token,JSON.stringify(viewTask(task)));this.save(w);this.audit(p?.sourceId||'public-worker','claimed',task.id);}return {job:task?jobView(w,task):null};
    }
    if(action==='heartbeat') {
      const known=this.ctx.storage.sql.exec<{task_id:string;lease_token:string}>('SELECT task_id,lease_token FROM jobs WHERE job_id=?',d.job_id).toArray()[0];const active=known?w.tasks.find(t=>t.id===known.task_id):undefined;demand(known?.lease_token===d.lease_token&&active?.lease?.jobId===d.job_id,409,'lease_revoked','租约已撤销；停止本次执行');
      if(p){executor(w,p);const t=leasedTask(w,d.job_id,d.lease_token,now);demand(t.sourceId===p.sourceId && t.operation==='conversation',403,'job_binding','该租约不属于当前来源');}
      else {demand(leasedTask(w,d.job_id,d.lease_token,now).operation!=='conversation',403,'job_binding','公开 worker 不能执行对话任务');}
      const task=heartbeat(w,d.job_id,d.lease_token,now,d.phase?z.enum(['claimed','sending','observing']).parse(d.phase):undefined);this.save(w);return {lease_expires_at:new Date(task.lease!.expiresAt).toISOString()};
    }
    if(action==='complete') {
      const report=reportSchema.parse(d.report);const serialized=JSON.stringify(report);
      const job=this.ctx.storage.sql.exec<{task_id:string;source_id:string;operation:string;lease_token:string}>('SELECT * FROM jobs WHERE job_id=?',report.job_id).toArray()[0];demand(job&&job.lease_token===report.lease_token,409,'job_binding','执行与租约不匹配');
      if(p){executor(w,p);demand(job.source_id===p.sourceId&&job.operation==='conversation',403,'job_binding','该租约不属于当前来源');}else demand(job.operation!=='conversation'&&report.status!=='unknown',403,'job_binding','公开 worker 不支持这个回执');
      const old=this.ctx.storage.sql.exec<{lease_token:string;body:string;applied:number}>('SELECT lease_token,body,applied FROM reports WHERE job_id=?',report.job_id).toArray()[0];
      if(old){demand(old.lease_token===report.lease_token&&old.body===serialized,409,'result_conflict','这个执行已经有不同的回执');return {accepted:true,replayed:true,applied:!!old.applied};}
      const t=w.tasks.find(t=>t.id===job.task_id)!;const applied=t.lease?.jobId===report.job_id&&t.lease.token===report.lease_token&&t.lease.expiresAt>now;
      if(applied){completeTask(w,report,now);this.save(w);}
      this.ctx.storage.sql.exec('INSERT INTO reports VALUES (?,?,?,?,?,?,?)',report.job_id,report.lease_token,serialized,job.task_id,job.source_id,job.operation,applied?1:0);this.audit(p?.sourceId||'public-worker',(applied?'result_':'late_result_')+report.status,t.id);return {accepted:true,applied};
    }
    if(action==='artifact-reserve') {
      const t=leasedTask(w,d.job_id,d.lease_token,now);demand(t.operation!=='conversation',403,'job_binding','公开 worker 不能访问对话任务');
      const filename=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/).parse(d.filename);const digest=z.string().regex(/^[0-9a-f]{64}$/).parse(d.digest);const size=z.number().int().min(0).max(8388608).parse(d.size);const mediaType=z.string().max(100).parse(d.mediaType);
      let artifact=this.ctx.storage.sql.exec<any>('SELECT * FROM artifacts WHERE job_id=? AND filename=?',d.job_id,filename).toArray()[0];
      if(artifact)demand(artifact.digest===digest && artifact.size===size,409,'artifact_conflict','同名附件已使用不同内容');
      else {demand(this.ctx.storage.sql.exec<{n:number}>('SELECT COUNT(*) n FROM artifacts WHERE job_id=?',d.job_id).toArray()[0]!.n<16,409,'artifact_capacity','每次执行最多 16 个附件');const id=crypto.randomUUID();this.ctx.storage.sql.exec('INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,0)',id,d.job_id,t.id,filename,digest,size,mediaType);artifact={id,job_id:d.job_id,task_id:t.id,filename,digest,size,media_type:mediaType,ready:0};}
      return {artifact,key:`${w.id}/${t.id}/${artifact.id}`,task_id:t.id};
    }
    if(action==='artifact-ready') {leasedTask(w,d.job_id,d.lease_token,now);this.ctx.storage.sql.exec('UPDATE artifacts SET ready=1 WHERE id=? AND job_id=?',d.artifact_id,d.job_id);return {accepted:true};}
    if(action==='artifact-read') {
      const a=this.ctx.storage.sql.exec<any>('SELECT * FROM artifacts WHERE id=? AND ready=1',d.id).toArray()[0];demand(a,404,'artifact_not_found','附件不存在');const t=findTask(w,p!,a.task_id);return {artifact:a,key:`${w.id}/${t.id}/${a.id}`};
    }
    throw new Problem(404,'action_not_found','操作不存在');
  }
  async flush():Promise<void> {
    const w=this.load();if(!w)return;
    await Promise.all(Object.keys(w.members).map(email=>directory(this.env,'user:'+email,'workspace',{id:w.id,name:w.name})));
    const tasks=w.tasks.filter(t=>t.operation!=='conversation'&&t.status==='pending');
    if(tasks.length)await directory(this.env,'public-queue','enqueue',{items:tasks.map(t=>({key:`${w.id}/${t.id}/${t.run}`,workspaceId:w.id,taskId:t.id,run:t.run,operation:t.operation}))});
  }
  async alarm():Promise<void> {const w=this.load();if(!w)return;const expired=expireLeases(w,Date.now());if(expired.length){this.ctx.storage.transactionSync(()=>{this.save(w);for(const id of expired)this.audit('system','lease_expired',id);});}try{await this.flush();}finally{if(w.tasks.some(t=>t.lease || t.status==='pending'))await this.ctx.storage.setAlarm(Date.now()+30000);}}
}

export class DirectoryObject extends DurableObject<StoreEnv> {
  constructor(ctx:DurableObjectState,env:StoreEnv){super(ctx,env);ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, json TEXT NOT NULL, expires INTEGER);');}
  async fetch(request:Request):Promise<Response> {
    try {const a=new URL(request.url).pathname.slice(1);const d=await request.json() as any;return reply(this.ctx.storage.transactionSync(()=>{
      if(a==='consume') {const key=z.string().min(1).max(300).parse(d.key);const expires=z.number().int().parse(d.expiresAt);demand(expires>Date.now() && expires<Date.now()+3600000,400,'consume_expiry','一次性凭据的过期时间无效');this.ctx.storage.sql.exec('DELETE FROM entries WHERE expires IS NOT NULL AND expires<?',Date.now());if(this.ctx.storage.sql.exec('SELECT id FROM entries WHERE id=?',key).toArray().length)return {consumed:false};this.ctx.storage.sql.exec('INSERT INTO entries VALUES (?, ?, ?)',key,'{}',expires);return {consumed:true};}
      if(a==='workspace') {this.ctx.storage.sql.exec('INSERT OR REPLACE INTO entries VALUES (?, ?, NULL)',d.id,JSON.stringify({id:d.id,name:d.name}));return {accepted:true};}
      if(a==='list')return {workspaces:this.ctx.storage.sql.exec<{json:string}>('SELECT json FROM entries ORDER BY rowid LIMIT 100').toArray().map(x=>JSON.parse(x.json))};
      if(a==='enqueue') {for(const item of d.items)this.ctx.storage.sql.exec('INSERT OR IGNORE INTO entries VALUES (?, ?, NULL)',item.key,JSON.stringify(item));return {accepted:true};}
      if(a==='candidates')return {items:this.ctx.storage.sql.exec<{json:string}>('SELECT json FROM entries WHERE json_extract(json,\'$.operation\') IN (?,?) ORDER BY rowid LIMIT 30',d.capabilities?.[0]||'',d.capabilities?.[1]||'').toArray().map(x=>JSON.parse(x.json))};
      if(a==='remove') {this.ctx.storage.sql.exec('DELETE FROM entries WHERE id=?',d.key);return {accepted:true};}
      throw new Problem(404,'action_not_found','目录操作不存在');
    }));}catch(e){return problemResponse(e);}
  }
}
