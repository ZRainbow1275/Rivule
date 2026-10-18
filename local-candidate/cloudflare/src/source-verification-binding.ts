/** Server-only fingerprints. No credential, digest or environment field is returned
 * in snapshots. Recompute when the Worker environment/configuration changes. */
import {canonical,digest,Rejected} from './contracts.ts';
import type {Source} from './contracts.ts';
import type {Bindings} from './auth.ts';
import type {VerificationBinding} from './source-verification.ts';
export async function currentVerificationBinding(b:Bindings,source:Source,env:Record<string,any>,grantRevision='not-applicable'):Promise<VerificationBinding>{
 let revocations:Record<string,string>={};
 try{revocations=JSON.parse(env.SOURCE_VERIFICATION_REVOCATIONS_JSON??'{}');}catch{throw new Rejected('verification_config_invalid',503);}
 if(!revocations||Array.isArray(revocations)||typeof revocations!=='object'||Object.values(revocations).some(v=>typeof v!=='string'||v.length>128))throw new Rejected('verification_config_invalid',503);
 const config={source,owner:b.ownerId,app:b.appId,user:b.userId,dm:b.dmId,origin:b.publicOrigin,projects:b.allowedProjectIds,oauth_enabled:env.OAUTH_ENABLED??'false',oauth_clients:env.OAUTH_CLIENT_BINDINGS_JSON??'',oauth_dynamic:env.OAUTH_ALLOW_DYNAMIC_CLIENTS??'false',muse_enabled:env.MUSE_API_ENABLED??'false'};
 // These digests remain private DB keys, not diagnostic data or authentication.
 const credentials={hmac:env[source.secret_name]??null,muse:source.source_id==='muse-main'?env.PA_MUSE_API_KEY??null:null,oauth_epoch:env.OAUTH_CREDENTIAL_REVISION??null};
 return {owner_id:b.ownerId,source_id:source.source_id,enabled:source.enabled,config_revision:await digest(canonical(config)),auth_revision:await digest(canonical(credentials)),revocation_revision:await digest(canonical([revocations[source.source_id]??'0',grantRevision]))};
}
