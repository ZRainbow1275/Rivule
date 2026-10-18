/** Read-only QQ setup preflight. Never reads AppSecret, requests a token or sends a message. */
import {loadQQConfig} from './qq-service.ts';
import type {QQEnvironment} from './qq-service.ts';
export type QQReadiness={state:'disabled'|'blocked'|'ready_for_explicit_test';blockers:string[];secret_checked:false;account_verified:false};
export function inspectQQReadiness(env:QQEnvironment,ownerId:string,now=Date.now()):QQReadiness{
 const base={secret_checked:false as const,account_verified:false as const};
 try{
  const c=loadQQConfig(env,ownerId);if(!c)return {...base,state:'disabled',blockers:['qq_not_enabled']};
  const blockers:string[]=[];
  if(!c.enabled)blockers.push('delivery_not_enabled');
  if(!c.allowedSources.length)blockers.push('source_scope_missing');
  if(!c.allowedProjects.length)blockers.push('project_scope_missing');
  const e=c.evidence();
  if(!Number.isFinite(now)||!Number.isFinite(e.checkedAt)||!Number.isFinite(e.validUntil)||e.checkedAt>now||e.validUntil<=now||e.checkedAt>=e.validUntil)blockers.push('capability_evidence_expired');
  if(!e.identity)blockers.push('identity_evidence_missing');
  if(!e.proactive)blockers.push('proactive_evidence_missing');
  return {...base,state:blockers.length?'blocked':'ready_for_explicit_test',blockers};
 }catch{return {...base,state:'blocked',blockers:['configuration_invalid']};}
}
