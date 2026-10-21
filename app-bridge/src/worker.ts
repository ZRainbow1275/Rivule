import {timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {createAuthenticatedWorker,getPrincipal,validateCsrf,allowInvitedEmail,issueConnector,revokeConnector,AuthError,type AuthEnv} from './auth';
import {Problem,demand,reportSchema,type Identity} from './core';
import {WorkspaceObject,DirectoryObject,internal,directory,problemResponse,type StoreEnv} from './store';
import {mcpHandler} from './mcp';
import {dashboardHtml,dashboardJs} from './ui';
import {sourceBundle} from './source.generated';
export {WorkspaceObject,DirectoryObject};
export interface Env extends StoreEnv,AuthEnv {WORKER_TOKEN?:string}

async function bytes(request:Request,max:number):Promise<Uint8Array> {
  const length=request.headers.get('content-length');demand(!length||Number(length)<=max,413,'body_too_large',`请求体最大 ${max} 字节`);
  const reader=request.body?.getReader();if(!reader)return new Uint8Array();const chunks:Uint8Array[]=[];let n=0;
  try {while(true){const item=await reader.read();if(item.done)break;n+=item.value.length;demand(n<=max,413,'body_too_large',`请求体最大 ${max} 字节`);chunks.push(item.value);}}catch(e){await reader.cancel();throw e;}
  const result=new Uint8Array(n);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}
async function json(request:Request):Promise<any> {demand(request.headers.get('content-type')?.split(';')[0]==='application/json',415,'json_required','请发送 application/json');try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(await bytes(request,262144)));}catch(e){if(e instanceof Problem)throw e;throw new Problem(400,'invalid_json','请求不是有效的 UTF-8 JSON');}}
function workspaceFromJob(jobId:string):string {const match=/^([0-9a-f-]{36})_[0-9a-f-]{36}$/.exec(jobId);demand(match,400,'invalid_job_id','执行 ID 格式无效');return z.string().uuid().parse(match[1]);}
function workerAuth(request:Request,env:Env):void {demand(env.WORKER_TOKEN,503,'worker_unconfigured','公开网页 worker 尚未配置');const actual=new TextEncoder().encode(request.headers.get('authorization')||'');const expected=new TextEncoder().encode('Bearer '+env.WORKER_TOKEN);demand(actual.length===expected.length && timingSafeEqual(actual,expected),401,'worker_unauthorized','worker 凭据无效');}
function secured(response:Response):Response {const h=new Headers(response.headers);h.set('Cache-Control','no-store');h.set('X-Content-Type-Options','nosniff');h.set('Referrer-Policy','no-referrer');h.set('X-Frame-Options','DENY');return new Response(response.body,{status:response.status,headers:h});}

async function publicWorker(request:Request,env:Env):Promise<Response> {
  workerAuth(request,env);const path=new URL(request.url).pathname;
  if(path==='/api/worker/claim' && request.method==='POST') {
    const capabilities=z.object({capabilities:z.array(z.enum(['regional_search','fetch_public_page'])).min(1).max(2)}).strict().parse(await json(request));
    const queue=await directory(env,'public-queue','candidates',capabilities);
    for(const item of queue.items) {
      const {job}=await internal(env,item.workspaceId,'worker-claim',{taskId:item.taskId,run:item.run});
      await directory(env,'public-queue','remove',{key:item.key});if(job)return Response.json({job});
    }return Response.json({job:null});
  }
  const artifact=/^\/api\/worker\/artifacts\/([^/]+)\/([^/]+)$/.exec(path);
  if(artifact && request.method==='PUT') {
    const [jobId,filename]=[artifact[1]!,artifact[2]!];const workspace=workspaceFromJob(jobId);const lease=request.headers.get('x-worker-lease');demand(lease,401,'lease_required','需要执行租约');
    const body=await bytes(request,8388608);const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',body))).map(x=>x.toString(16).padStart(2,'0')).join('');
    const reserved=await internal(env,workspace,'artifact-reserve',{job_id:jobId,lease_token:lease,filename,digest,size:body.length,mediaType:request.headers.get('content-type')||'application/octet-stream'});
    await env.ARTIFACTS.put(reserved.key,body,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/octet-stream'},customMetadata:{digest}});
    await internal(env,workspace,'artifact-ready',{job_id:jobId,lease_token:lease,artifact_id:reserved.artifact.id});
    return Response.json({artifact_id:reserved.artifact.id});
  }
  if(path==='/api/worker/heartbeat' && request.method==='POST') {const data=z.object({job_id:z.string(),lease_token:z.string()}).strict().parse(await json(request));return Response.json(await internal(env,workspaceFromJob(data.job_id),'heartbeat',data));}
  if(path==='/api/worker/result' && request.method==='POST') {const report=reportSchema.parse(await json(request));return Response.json(await internal(env,workspaceFromJob(report.job_id),'complete',{report}));}
  throw new Problem(404,'not_found','worker 路由不存在');
}

const app:ExportedHandler<Env>={async fetch(request,env,ctx) {
  try {
    const url=new URL(request.url);const path=url.pathname;
    if(path==='/robots.txt'&&request.method==='GET')return secured(new Response('User-agent: *\nDisallow: /api/\nDisallow: /auth/\nDisallow: /oauth/\nDisallow: /mcp\nAllow: /health\nAllow: /auth/status\nAllow: /source\n',{headers:{'Content-Type':'text/plain; charset=utf-8'}}));
    if(path==='/source' && request.method==='GET')return secured(new Response(JSON.stringify(sourceBundle),{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="rivule-bridge-source.json"'}}));
    if(path==='/health' && request.method==='GET')return secured(Response.json({ok:true,service:'rivule-bridge',version:'0.1.0',googleConfigured:!!(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET),workerConfigured:!!env.WORKER_TOKEN}));
    if(path==='/' && request.method==='GET')return secured(new Response(dashboardHtml,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"}}));
    if(path==='/dashboard.js' && request.method==='GET')return secured(new Response(dashboardJs,{headers:{'Content-Type':'text/javascript; charset=utf-8'}}));
    if(path.startsWith('/api/worker/'))return secured(await publicWorker(request,env));
    const principal=await getPrincipal(request,env,ctx) as Identity|null;demand(principal,401,'authentication_required','请先登录或完成来源 OAuth 授权');
    if(path==='/mcp') {demand(principal.kind==='mcp',403,'oauth_required','MCP 入口需要标准 OAuth 来源授权');return secured(await mcpHandler(env,principal).fetch(request));}
    if(!['GET','HEAD'].includes(request.method))demand(await validateCsrf(request,env,ctx),403,'csrf_failed','请求来源或 CSRF 凭据无效，请刷新页面');
    if(path==='/api/workspaces' && request.method==='GET') {demand(principal.kind==='session',403,'session_required','工作空间目录需要网页登录');return secured(Response.json(await directory(env,'user:'+principal.email.toLowerCase(),'list',{})));}
    if(path==='/api/workspaces' && request.method==='POST') {demand(principal.kind==='session',403,'session_required','创建工作空间需要网页登录');const d=z.object({name:z.string()}).strict().parse(await json(request));const id=crypto.randomUUID();const result=await internal(env,id,'create',{id,name:d.name,principal});await directory(env,'user:'+principal.email.toLowerCase(),'workspace',{id,name:result.workspace.name});return secured(Response.json(result,{status:201}));}
    if(path==='/api/connector/claim' && request.method==='POST') {demand(principal.kind==='connector'&&principal.workspaceId,403,'connector_required','需要绑定的浏览器连接器');z.object({}).strict().parse(await json(request));return secured(Response.json(await internal(env,principal.workspaceId,'claim',{principal})));}
    if(path==='/api/connector/heartbeat' && request.method==='POST') {demand(principal.kind==='connector'&&principal.workspaceId,403,'connector_required','需要绑定的浏览器连接器');const d=z.object({job_id:z.string(),lease_token:z.string(),phase:z.enum(['claimed','sending','observing']).optional()}).strict().parse(await json(request));demand(workspaceFromJob(d.job_id)===principal.workspaceId,403,'job_binding','租约不属于当前工作空间');return secured(Response.json(await internal(env,principal.workspaceId,'heartbeat',{...d,principal})));}
    if(path==='/api/connector/result' && request.method==='POST') {demand(principal.kind==='connector'&&principal.workspaceId,403,'connector_required','需要绑定的浏览器连接器');const report=reportSchema.parse(await json(request));demand(workspaceFromJob(report.job_id)===principal.workspaceId,403,'job_binding','租约不属于当前工作空间');return secured(Response.json(await internal(env,principal.workspaceId,'complete',{report,principal})));}
    const route=/^\/api\/workspaces\/([^/]+)(?:\/(.*))?$/.exec(path);demand(route,404,'not_found','路由不存在');const workspace=z.string().uuid().parse(route[1]);const suffix=route[2]||'';
    const call=(action:string,data:unknown={})=>internal(env,workspace,action,{...(data as object),principal});
    if(suffix===''&&request.method==='GET')return secured(Response.json(await call('view')));
    if(suffix==='sources'&&request.method==='POST')return secured(Response.json(await call('source',{source:await json(request)}),{status:201}));
    if(suffix==='members'&&request.method==='POST') {const d=z.object({email:z.string().email()}).strict().parse(await json(request));const invited=await call('member',d);await allowInvitedEmail(invited.email,env);return secured(Response.json(invited));}
    if(suffix==='connectors'&&request.method==='POST') {demand(principal.kind==='session',403,'session_required','需要网页登录');const d=z.object({sourceId:z.string()}).strict().parse(await json(request));const binding=await call('binding',d);demand(binding.allowed&&['chatgpt','gemini'].includes(binding.platform),403,'source_binding','来源必须是自己的 ChatGPT / Gemini 网页来源');return secured(Response.json(await issueConnector(principal,env,{workspaceId:workspace,sourceId:d.sourceId})));}
    if(suffix.startsWith('connectors/')&&request.method==='DELETE') {demand(principal.kind==='session',403,'session_required','需要网页登录');await call('view');await revokeConnector(principal,env,suffix.slice(11));return secured(Response.json({revoked:true}));}
    if(suffix==='tasks'&&request.method==='POST') {const d=z.object({idempotencyKey:z.string(),input:z.unknown()}).strict().parse(await json(request));return secured(Response.json(await call('create-tasks',d),{status:201}));}
    if(suffix==='csv'&&request.method==='GET') {const d=await call('export');return secured(new Response(d.csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="rivule-tasks.csv"'}}));}
    if(suffix==='csv'&&request.method==='POST') {const d=z.object({idempotencyKey:z.string(),csv:z.string()}).strict().parse(await json(request));return secured(Response.json(await call('import',d),{status:201}));}
    if(suffix==='audit'&&request.method==='GET')return secured(Response.json(await call('audit',{after:url.searchParams.get('after')})));
    const task=/^tasks\/([^/]+)(?:\/(control))?$/.exec(suffix);
    if(task && request.method==='GET'&&!task[2])return secured(Response.json(await call('task',{id:task[1],job_id:url.searchParams.get('job_id')})));
    if(task && request.method==='PATCH'&&!task[2]) {const d=z.object({revision:z.number().int(),patch:z.unknown()}).strict().parse(await json(request));return secured(Response.json(await call('update',{...d,id:task[1]})));}
    if(task && request.method==='POST'&&task[2]==='control') {const d=z.object({revision:z.number().int(),action:z.string()}).strict().parse(await json(request));return secured(Response.json(await call('control',{...d,id:task[1]})));}
    const runs=/^tasks\/([^/]+)\/runs$/.exec(suffix);if(runs&&request.method==='GET')return secured(Response.json(await call('runs',{id:runs[1],after:url.searchParams.get('after')})));
    const resolve=/^tasks\/([^/]+)\/resolve$/.exec(suffix);if(resolve&&request.method==='POST'){const d=z.object({revision:z.number().int(),status:z.enum(['succeeded','failed','cancelled']),note:z.string()}).strict().parse(await json(request));return secured(Response.json(await call('resolve',{id:resolve[1],...d})));}
    const artifact=/^artifacts\/([^/]+)$/.exec(suffix);
    if(artifact&&request.method==='GET') {const d=await call('artifact-read',{id:artifact[1]});const object=await env.ARTIFACTS.get(d.key);demand(object,404,'artifact_not_found','附件不存在');return secured(new Response(object.body,{headers:{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="${d.artifact.filename}"`}}));}
    throw new Problem(404,'not_found','路由不存在');
  }catch(e){return secured(problemResponse(e instanceof AuthError?new Problem(e.status,'auth_error',e.message):e));}
}};

export default createAuthenticatedWorker(app,{
  authorizeBinding:async(principal,binding,env)=>{try{return (await internal(env as Env,binding.workspaceId,'binding',{sourceId:binding.sourceId,principal})).allowed===true;}catch{return false;}},
  consumeOnce:async(key,expiresAt,env)=>(await directory(env as Env,'auth-consume','consume',{key,expiresAt})).consumed===true,
});
