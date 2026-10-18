/** Read-only OAuth grant inventory fingerprint via the official provider API.
 * No token values or encrypted props are read. Client authentication hashes are
 * used only in a private final digest, never exposed or persisted separately.
 * Bounded scans fail closed instead of silently trusting incomplete results.
 */
import {canonical,digest,Rejected,sourceAllows} from './contracts.ts';
import type {Source} from './contracts.ts';
import {loadOAuthConfig} from './oauth.ts';
import type {OAuthHelpers} from '@cloudflare/workers-oauth-provider';
export async function oauthGrantRevision(source:Source,env:Record<string,any>,api:Pick<OAuthHelpers,'listUserGrants'|'lookupClient'>,now=Date.now()):Promise<string>{
 if(env.OAUTH_ENABLED!=='true'||!sourceAllows(source,'oauth'))return 'oauth-disabled';
 const config=loadOAuthConfig(env),bound=new Set(config.clients.filter(c=>c.source_id===source.source_id).map(c=>c.client_id));
 const grants:{id:string;clientId:string;scope:string[];expiresAt:number|null}[]=[];let cursor:string|undefined;const cursors=new Set<string>();
 for(let page=0;page<10;page++){
  const response=await api.listUserGrants(config.ownerSubject,{limit:100,cursor});
  if(!response||!Array.isArray(response.items)||response.items.length>100)throw new Rejected('verification_grants_unavailable',503);
  for(const grant of response.items){
   if(typeof grant.id!=='string'||typeof grant.clientId!=='string'||grant.userId!==config.ownerSubject||!Array.isArray(grant.scope)||grant.scope.some(s=>typeof s!=='string'))throw new Rejected('verification_grants_unavailable',503);
   if(grant.expiresAt!==undefined&&(!Number.isFinite(grant.expiresAt)||grant.expiresAt*1000<=now))continue;
   if(config.allowDynamicClients||bound.has(grant.clientId))grants.push({id:grant.id,clientId:grant.clientId,scope:[...grant.scope].sort(),expiresAt:grant.expiresAt??null});
  }
  if(!response.cursor){
   const ids=[...new Set([...bound,...grants.map(g=>g.clientId)])].sort();if(ids.length>100)throw new Rejected('verification_grants_unavailable',503);
   const clients=[];
   for(const id of ids){const client=await api.lookupClient(id);clients.push(client?{id,secret_hash:client.clientSecret??null,redirects:client.redirectUris,grant_types:client.grantTypes??null,response_types:client.responseTypes??null,auth_method:client.tokenEndpointAuthMethod,jwks:client.jwksUri??null}: {id,missing:true});}
   return digest(canonical({grants:grants.sort((a,b)=>a.id.localeCompare(b.id)),clients}));
  }
  if(typeof response.cursor!=='string'||cursors.has(response.cursor))throw new Rejected('verification_grants_unavailable',503);
  cursor=response.cursor;cursors.add(cursor);
 }
 throw new Rejected('verification_grants_unavailable',503);
}
