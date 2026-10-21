import {z} from 'zod';

export type Identity = {userId:string; email:string; sourceId:string; workspaceId?:string; kind:'session'|'mcp'|'connector'; scopes:string[]};
export type Source = {id:string; ownerId:string; label:string; platform:'chatgpt'|'gemini'|'mcp'|'worker'};
export type Status = 'pending'|'running'|'paused'|'blocked'|'succeeded'|'failed'|'cancelled'|'unknown';
export type Operation = 'conversation'|'regional_search'|'fetch_public_page';
export type Lease = {token:string; jobId:string; expiresAt:number; ttlMs:number; phase:'claimed'|'sending'|'observing'};
export type Task = {
  id:string; projectId:string; runId:string; branchId:string; title:string; input:string; operation:Operation; arguments:Record<string,unknown>;
  sourceId:string; creatorId:string; creatorSourceId:string; dependencies:string[];
  status:Status; reason?:string; revision:number; run:number; createdAt:number; updatedAt:number;
  lease?:Lease; lastJobId?:string; summary?:string;
};
export type Audit = {id:string; at:number; actor:string; taskId?:string; action:string; detail?:string};
export type Workspace = {id:string; name:string; ownerId:string; members:Record<string,'owner'|'member'>; sources:Source[]; tasks:Task[]};
export class Problem extends Error {
  constructor(public status:number, public code:string, message:string) {super(message);}
}
export function demand(ok:unknown, status:number, code:string, message:string):asserts ok {
  if(!ok) throw new Problem(status,code,message);
}
export const idSchema=z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const publicUrl=z.string().max(4096).url().refine(value=>{
  const u=new URL(value); return ['http:','https:'].includes(u.protocol) && !u.username && !u.password && (!u.port || ['80','443'].includes(u.port));
},'仅允许没有凭据的 HTTP/HTTPS 公共网页 URL');
export const taskSchema=z.object({
  title:z.string().trim().min(1).max(200), input:z.string().max(16000).default(''),
  operation:z.enum(['conversation','regional_search','fetch_public_page']),
  sourceId:idSchema, dependencies:z.array(idSchema).max(16).default([]),
  branchId:idSchema.default('main'),
  arguments:z.record(z.string(),z.unknown()).default({}),
}).strict();
export type NewTask=z.infer<typeof taskSchema>;
export const patchSchema=taskSchema.partial().extend({
  input:taskSchema.shape.input.removeDefault().optional(),
  dependencies:taskSchema.shape.dependencies.removeDefault().optional(),
  branchId:taskSchema.shape.branchId.removeDefault().optional(),
  arguments:taskSchema.shape.arguments.removeDefault().optional(),
}).strict();
export function validateArguments(operation:Operation, input:string, args:Record<string,unknown>):Record<string,unknown> {
  if(operation==='regional_search') return z.object({query:z.string().trim().min(1).max(2000),engine:z.enum(['baidu','yandex']),limit:z.number().int().min(1).max(10).default(5),language:z.enum(['zh','ru']).optional()}).strict().parse(args);
  if(operation==='fetch_public_page') return z.object({url:publicUrl,screenshot:z.boolean().optional()}).strict().parse(args);
  demand(input.trim(),400,'empty_input','对话任务需要输入内容');
  return z.object({}).strict().parse(args);
}
export function member(w:Workspace,p:Identity):void {
  demand(!p.workspaceId || p.workspaceId===w.id,403,'workspace_binding','凭据绑定到另一个工作空间');
  demand(w.members[p.email.toLowerCase()],403,'not_member','当前账户不是这个工作空间的成员');
  if(p.kind!=='session') demand(w.sources.some(s=>s.id===p.sourceId && s.ownerId===p.userId),403,'source_binding','来源不属于当前账户');
}
export function owner(w:Workspace,p:Identity):void {member(w,p);demand(w.ownerId===p.userId,403,'owner_required','只有工作空间所有者可以执行此操作');}
export function scope(p:Identity, value:string):void {demand(p.scopes.includes(value),403,'scope_required',`需要 ${value} 权限`);}
export function executor(w:Workspace,p:Identity):void {
  member(w,p);scope(p,'bridge:write');const platform=w.sources.find(s=>s.id===p.sourceId)?.platform;
  demand((p.kind==='mcp'&&platform==='mcp')||(p.kind==='connector'&&(platform==='chatgpt'||platform==='gemini')),403,'executor_platform','指定网页来源必须通过已绑定的浏览器执行；通用 MCP 执行只适用于其他 MCP 助手来源');
}
export function visible(t:Task,p:Identity):boolean {return p.kind==='session' || t.sourceId===p.sourceId || t.creatorSourceId===p.sourceId;}
export function findTask(w:Workspace,p:Identity,id:string):Task {member(w,p);scope(p,'bridge:read');const t=w.tasks.find(t=>t.id===id);demand(t && visible(t,p),404,'task_not_found','任务不存在或不可见');return t;}
function canControl(w:Workspace,p:Identity,t:Task):void {
  member(w,p);scope(p,'bridge:control');
  demand(w.ownerId===p.userId || (t.creatorId===p.userId && (p.kind==='session'||t.creatorSourceId===p.sourceId)),403,'control_denied','只有所有者或创建来源可以控制任务');
}
export function dependencyState(w:Workspace,t:Task):{ready:boolean; reason?:string} {
  const deps=t.dependencies.map(id=>w.tasks.find(d=>d.id===id));
  if(deps.some(d=>!d)) return {ready:false,reason:'missing_dependency'};
  if(deps.some(d=>['failed','cancelled','unknown'].includes(d!.status))) return {ready:false,reason:'dependency_needs_attention'};
  if(deps.some(d=>d!.status!=='succeeded')) return {ready:false,reason:'awaiting_dependencies'};
  return {ready:true};
}
export function refreshDependencies(w:Workspace,now:number):void {
  for(const t of w.tasks) if(t.status==='pending' || (t.status==='blocked' && ['awaiting_dependencies','dependency_needs_attention','missing_dependency'].includes(t.reason||''))) {
    const d=dependencyState(w,t);const next=d.ready?'pending':'blocked';
    if(t.status!==next || t.reason!==d.reason) {t.status=next;t.reason=d.reason;t.revision++;t.updatedAt=now;}
  }
}
export function validateGraph(w:Workspace):void {
  const map=new Map(w.tasks.map(t=>[t.id,t]));const visiting=new Set<string>();const done=new Set<string>();
  function visit(id:string) {demand(!visiting.has(id),400,'dependency_cycle','依赖关系形成了环');if(done.has(id))return;const t=map.get(id);demand(t,400,'missing_dependency',`依赖任务不存在：${id}`);visiting.add(id);for(const d of t.dependencies)visit(d);visiting.delete(id);done.add(id);}
  for(const id of map.keys())visit(id);
}
export function createTasks(w:Workspace,p:Identity,inputs:NewTask[],now:number,ids=inputs.map(()=>crypto.randomUUID())):Task[] {
  member(w,p);scope(p,'bridge:write');demand(w.tasks.length+inputs.length<=100,409,'workspace_capacity','工作空间最多保留 100 个任务；请为新项目创建工作空间');
  const tasks=inputs.map((raw,i)=>{
    const n=taskSchema.parse(raw);const s=w.sources.find(s=>s.id===n.sourceId);demand(s,400,'source_not_found','请先注册目标来源');
    demand((n.operation==='conversation')===(s.platform!=='worker'),400,'operation_source','公开网页任务只能分配到 public-web，对话任务只能分配到对话来源');
    const args=validateArguments(n.operation,n.input,n.arguments);
    return {id:ids[i]!,projectId:w.id,runId:crypto.randomUUID(),...n,arguments:args,creatorId:p.userId,creatorSourceId:p.sourceId,status:'pending' as const,revision:1,run:1,createdAt:now,updatedAt:now};
  });
  demand(new Set([...w.tasks,...tasks].map(t=>t.id)).size===w.tasks.length+tasks.length,409,'duplicate_task','任务 ID 重复');
  const candidate={...w,tasks:[...w.tasks,...tasks]};validateGraph(candidate);refreshDependencies(candidate,now);w.tasks=candidate.tasks;return tasks;
}
function replaceTask(w:Workspace,t:Task,n:NewTask,now:number):Task {
  const source=w.sources.find(s=>s.id===n.sourceId);demand(source && ((n.operation==='conversation')===(source.platform!=='worker')),400,'operation_source','目标来源不支持这个任务');
  const updated={...t,...n,arguments:validateArguments(n.operation,n.input,n.arguments),revision:t.revision+1,updatedAt:now};
  const candidate={...w,tasks:w.tasks.map(x=>x.id===t.id?updated:x)};validateGraph(candidate);refreshDependencies(candidate,now);w.tasks=candidate.tasks;return updated;
}
export function patchTask(w:Workspace,p:Identity,id:string,revision:number,patch:Partial<NewTask>,now:number):Task {
  const t=findTask(w,p,id);canControl(w,p,t);demand(t.revision===revision,409,'revision_conflict','任务已被修改，请刷新后重试');
  demand(!t.lease && ['pending','paused','blocked'].includes(t.status),409,'task_started','已开始或已结束的输入不能原地改写；请创建后续任务');
  return replaceTask(w,t,taskSchema.parse({title:t.title,input:t.input,operation:t.operation,sourceId:t.sourceId,dependencies:t.dependencies,arguments:t.arguments,branchId:t.branchId,...patch}),now);
}
export function controlTask(w:Workspace,p:Identity,id:string,action:'pause'|'resume'|'cancel'|'retry',revision:number,now:number):Task {
  const t=findTask(w,p,id);canControl(w,p,t);demand(t.revision===revision,409,'revision_conflict','任务已被修改，请刷新后重试');
  const done=['succeeded','failed','cancelled','unknown'].includes(t.status);
  if(action==='pause') {
    demand(!done && t.status!=='paused',409,'control_state','当前任务不能暂停');
    t.status=t.lease && t.lease.phase!=='claimed'?'unknown':'paused';t.reason=t.status==='unknown'?'delivery_interrupted':'user_paused';
  } else if(action==='resume') {demand(t.status==='paused',409,'control_state','只有暂停中的任务可以继续');t.status='pending';delete t.reason;delete t.lastJobId;}
  else if(action==='cancel') {demand(!done,409,'control_state','任务已经结束');t.status='cancelled';t.reason='user_cancelled';}
  else {demand(['failed','blocked','unknown'].includes(t.status),409,'control_state','只有失败、阻塞或结果未知的任务可以显式重试');t.status='pending';delete t.reason;t.run++;t.runId=crypto.randomUUID();delete t.summary;delete t.lastJobId;}
  delete t.lease;t.revision++;t.updatedAt=now;refreshDependencies(w,now);return t;
}
export function resolveTask(w:Workspace,p:Identity,id:string,revision:number,status:'succeeded'|'failed'|'cancelled',note:string,now:number):Task {
  demand(p.kind==='session',403,'session_required','结果未知时请由用户在工作台核对');const t=findTask(w,p,id);canControl(w,p,t);
  demand(t.revision===revision,409,'revision_conflict','任务已被修改，请刷新后重试');demand(t.status==='unknown',409,'resolve_state','只有结果未知的任务需要人工核对');
  demand(note.trim()&&note.length<=16000,400,'resolution_note','请记录原页面的真实结果或核对说明（最多 16000 字）');
  t.status=status;t.reason='manual_resolution';t.summary=note.slice(0,1000);t.updatedAt=now;t.revision++;delete t.lease;refreshDependencies(w,now);return t;
}
export function expireLeases(w:Workspace,now:number):string[] {
  const expired:string[]=[];
  for(const t of w.tasks) if(t.lease && t.lease.expiresAt<=now) {t.status=t.operation==='conversation'?'unknown':'failed';t.reason='lease_expired';delete t.lease;t.revision++;t.updatedAt=now;expired.push(t.id);}
  if(expired.length)refreshDependencies(w,now);return expired;
}
export function claimTask(w:Workspace,id:string,now:number,ttlMs=90000):Task|null {
  expireLeases(w,now);const t=w.tasks.find(t=>t.id===id);if(!t || t.status!=='pending' || !dependencyState(w,t).ready)return null;
  t.lease={token:crypto.randomUUID(),jobId:`${w.id}_${crypto.randomUUID()}`,expiresAt:now+ttlMs,ttlMs,phase:'claimed'};t.lastJobId=t.lease.jobId;t.status='running';t.revision++;t.updatedAt=now;return t;
}
export function leasedTask(w:Workspace,jobId:string,token:string,now:number):Task {
  const t=w.tasks.find(t=>t.lastJobId===jobId);demand(t,404,'job_not_found','任务不存在');
  demand(t.lease?.token===token && t.lease.jobId===jobId,409,'lease_revoked','租约已撤销；停止本次执行，不要重新发送');
  demand(t.lease.expiresAt>now,410,'lease_expired','租约已过期；停止本次执行，不要重新发送');return t;
}
export function heartbeat(w:Workspace,jobId:string,token:string,now:number,phase?:Lease['phase']):Task {
  const t=leasedTask(w,jobId,token,now);if(phase) {const rank={claimed:0,sending:1,observing:2};demand(rank[phase]>=rank[t.lease!.phase],409,'phase_regression','发送阶段不能回退');t.lease!.phase=phase;}
  t.lease!.expiresAt=now+t.lease!.ttlMs;t.updatedAt=now;return t;
}
export const reportSchema=z.object({job_id:idSchema,lease_token:idSchema,status:z.enum(['succeeded','failed','blocked','unknown']),result:z.record(z.string(),z.unknown()).optional(),error:z.object({code:z.string().max(100),message:z.string().max(2000)}).strict().optional()}).strict();
export type Report=z.infer<typeof reportSchema>;
export function completeTask(w:Workspace,report:Report,now:number):Task {
  const t=leasedTask(w,report.job_id,report.lease_token,now);
  t.status=report.status;t.reason=report.error?.code;
  t.summary=(typeof report.result?.content==='string'?report.result.content:typeof report.result?.text==='string'?report.result.text:report.error?.message||JSON.stringify(report.result||{})).slice(0,1000);
  delete t.lease;t.revision++;t.updatedAt=now;refreshDependencies(w,now);return t;
}
export function viewTask(t:Task):Omit<Task,'lease'> & {lease?:{jobId:string; expiresAt:number; phase:Lease['phase']}} {
  const {lease,...rest}=t;return {...rest,...(lease?{lease:{jobId:lease.jobId,expiresAt:lease.expiresAt,phase:lease.phase}}:{})};
}
export function jobView(w:Workspace,t:Task) {demand(t.lease,409,'no_lease','没有有效租约');return {job_id:t.lease.jobId,workspace_id:w.id,task_id:t.id,operation:t.operation,arguments:t.operation==='conversation'?{input:t.input,title:t.title,run:t.run}:t.arguments,lease_token:t.lease.token,lease_expires_at:new Date(t.lease.expiresAt).toISOString()};}
