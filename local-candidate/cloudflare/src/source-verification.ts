/** Local reconstruction candidate. Pure policy only; not connected to production.
 * Callers supply server-owned opaque revisions, never credentials or client claims.
 * Successful authentication alone is deliberately not source-use evidence.
 */
import {canonical,digest} from './contracts.ts';
export type VerificationBinding={owner_id:string;source_id:string;config_revision:string;auth_revision:string;revocation_revision:string;enabled:boolean};
export type VerificationKind='accepted_event'|'mcp_initialize'|'mcp_tools_list'|'mcp_read'|'muse_own_receipt';
export type VerificationEvidence={schema:1;source_id:string;binding_digest:string;kind:VerificationKind;verified_at:number};
export type VerificationStatus='verified'|'needs_reverification'|'unverified'|'disabled';
const kinds=new Set<VerificationKind>(['accepted_event','mcp_initialize','mcp_tools_list','mcp_read','muse_own_receipt']);
function validBinding(binding:VerificationBinding):boolean {
 return typeof binding?.enabled==='boolean'&&['owner_id','source_id','config_revision','auth_revision','revocation_revision'].every(k=>typeof (binding as any)[k]==='string'&&(binding as any)[k].length>0&&(binding as any)[k].length<=256);
}
export async function verificationBindingDigest(binding:VerificationBinding):Promise<string>{
 if(!validBinding(binding))throw new Error('verification_binding_invalid');
 return digest(canonical(binding));
}
export async function recordSourceVerification(binding:VerificationBinding,kind:VerificationKind,verifiedAt:number):Promise<VerificationEvidence>{
 if(!validBinding(binding)||!binding.enabled||!kinds.has(kind)||!Number.isSafeInteger(verifiedAt)||verifiedAt<0)throw new Error('verification_evidence_invalid');
 return {schema:1,source_id:binding.source_id,binding_digest:await verificationBindingDigest(binding),kind,verified_at:verifiedAt};
}
export async function sourceVerificationStatus(binding:VerificationBinding,evidence:VerificationEvidence|null|undefined,now:number):Promise<VerificationStatus>{
 if(!validBinding(binding)||!Number.isSafeInteger(now)||now<0)throw new Error('verification_binding_invalid');
 if(!binding.enabled)return 'disabled';
 if(!evidence)return 'unverified';
 if(evidence.schema!==1||evidence.source_id!==binding.source_id||!kinds.has(evidence.kind)||!Number.isSafeInteger(evidence.verified_at)||evidence.verified_at<0||evidence.verified_at>now||evidence.binding_digest!==await verificationBindingDigest(binding))return 'needs_reverification';
 return 'verified';
}
/** Hide unverified configuration entries, retain historical task sources with a
 * clear stale label. History never upgrades verification or grants permissions. */
export function sourceVerificationPresentation(status:VerificationStatus,hasHistory:boolean){
 return {selectable:status==='verified',visible:status==='verified'||hasHistory,label:status==='verified'?'已验证来源':status==='disabled'?'来源已停用':hasHistory?'待重新验证':'来源未验证'};
}
