/** Advertise optional OAuth scopes without making both mandatory for every MCP request. */
import {PA_SCOPES} from './oauth.ts';
export function withScopeGuidance(request:Request,response:Response):Response{
 const path=new URL(request.url).pathname;
 if(response.status!==401||request.headers.has('authorization')||!(path==='/mcp'||path.startsWith('/mcp/')))return response;
 const challenge=response.headers.get('www-authenticate');
 if(!challenge||!/^Bearer\s/i.test(challenge)||/(?:^|,)\s*scope\s*=/i.test(challenge.replace(/^Bearer\s+/i,'')))return response;
 const headers=new Headers(response.headers);headers.set('www-authenticate',challenge+', scope="'+PA_SCOPES.join(' ')+'"');
 return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
