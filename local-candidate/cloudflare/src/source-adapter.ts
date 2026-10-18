/** Transport-independent PA ingestion port. Authentication belongs at both
 * ingress and owner boundaries; callers never choose a destination or owner.
 * Implementing this interface does not enable a provider or grant any access. */
import type {Event,Source} from './contracts.ts';
import type {NotificationMode} from './notification-policy.ts';
export type SourceAdapterPort={
 publish:(source:Source,event:Event,mode:NotificationMode)=>Promise<unknown>;
 delivery:(source:Source,receiptId:string)=>Promise<unknown>;
};
export type SourceAdapterEvidence={
 authentication:'not_tested'|'verified';
 ingestion:'not_tested'|'accepted';
 delivery:'not_tested'|'pending'|'sent'|'uncertain'|'blocked';
 lifecycle:'explicit_calls_only'|'verified_subscription';
 upstreamApproval:'return_to_source';
};
