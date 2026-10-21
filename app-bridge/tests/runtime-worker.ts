// Local-only integration entrypoint. Production wrangler.jsonc points at src/worker.ts.
import app,{WorkspaceObject as ProductionWorkspaceObject,DirectoryObject,type Env} from '../src/worker';
import {internal,problemResponse} from '../src/store';
import {mcpHandler} from '../src/mcp';
import {issueConnector} from '../src/auth';
import type {Identity} from '../src/core';
export {DirectoryObject};
export class WorkspaceObject extends ProductionWorkspaceObject {
  flushCalls=0;
  override async flush(){this.flushCalls++;return super.flush();}
  override async fetch(request:Request){if(new URL(request.url).pathname==='/__inspect')return Response.json({flushCalls:this.flushCalls,alarm:await this.ctx.storage.getAlarm()});return super.fetch(request);}
}
const identity=(who='alice'):Identity=>({userId:who,email:who+'@example.test',sourceId:'dashboard',kind:'session',scopes:['bridge:read','bridge:write','bridge:control']});
export default {async fetch(request:Request,env:Env,ctx:ExecutionContext) {
  const url=new URL(request.url);
  if(url.pathname==='/__fixture/signin'&&request.method==='GET'){
    const token=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).map(n=>n.toString(16).padStart(2,'0')).join('');
    await env.AUTH_KV.put('auth:session:'+hash,JSON.stringify({principal:identity(),csrfToken:crypto.randomUUID(),expiresAt:Date.now()+3600000}),{expirationTtl:3600});
    return new Response(null,{status:302,headers:{Location:'/', 'Set-Cookie':`__Host-rivule_session=${token}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`}});
  }
  if(url.pathname==='/__fixture') {
    try {
      const d=await request.json() as any;const principal={...identity(d.who),...(d.binding||{})};
      if(d.action==='connector')return Response.json(await issueConnector(principal,env,{workspaceId:d.workspace,sourceId:d.sourceId}));
      if(d.action==='mcp')return mcpHandler(env,principal).fetch(new Request(url.origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-03-26'},body:JSON.stringify(d.rpc)}));
      return Response.json(await internal(env,d.workspace,d.action,{...d.data,principal}));
    }catch(e){return problemResponse(e);}
  }
  return app.fetch!(request as Request<unknown,IncomingRequestCfProperties>,env,ctx);
}} satisfies ExportedHandler<Env>;
