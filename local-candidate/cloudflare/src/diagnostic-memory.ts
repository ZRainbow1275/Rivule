/** Ephemeral owner-instance diagnostics only: deliberately no Storage/KV/SQL API. */
import {sanitizeDiagnosticRecord} from './diagnostics.ts';
import {validateDiagnosticQuery,DIAGNOSTIC_TTL_MS,DIAGNOSTIC_MAX_RECORDS,DIAGNOSTIC_PER_MINUTE,DIAGNOSTIC_PER_DAY} from './diagnostic-store.ts';
export class DiagnosticMemory{
 sources:ReadonlySet<string>;records:any[]=[];sequence=0;budgetDay=-1;budgetCount=0;
 readonly instanceId=crypto.randomUUID();readonly startedAt:number;
 constructor(sources:ReadonlySet<string>,now:number){this.sources=sources;this.startedAt=now;}
 prune(now:number){this.records=this.records.filter(r=>r.at>now-DIAGNOSTIC_TTL_MS).slice(-DIAGNOSTIC_MAX_RECORDS);if(this.budgetDay!==Math.floor(now/86400000)){this.budgetDay=Math.floor(now/86400000);this.budgetCount=0;}}
 insert(raw:unknown,now:number){
  const safe=sanitizeDiagnosticRecord(raw,this.sources);if(!safe||!Number.isFinite(now))return {stored:false,reason:'invalid_record'};this.prune(now);
  if(this.records.some(r=>r.record.request_id===safe.request_id))return {stored:false,reason:'duplicate'};
  if(this.records.filter(r=>r.at>now-60000).length>=DIAGNOSTIC_PER_MINUTE)return {stored:false,reason:'rate_limited'};
  if(this.budgetCount>=DIAGNOSTIC_PER_DAY)return {stored:false,reason:'daily_limited'};
  this.budgetCount++;this.records.push({sequence:++this.sequence,at:now,record:safe});this.prune(now);return {stored:true,storage:'volatile_memory'};
 }
 query(raw:unknown,now:number){
  const q=validateDiagnosticQuery(raw,this.sources);this.prune(now);
  const selected=this.records.filter(r=>(!q.source_id||r.record.source===q.source_id)&&(!q.request_id||r.record.request_id===q.request_id)&&(!q.before||r.sequence<q.before)).slice().reverse();
  const visible=selected.slice(0,q.limit);
  return {records:visible.map(r=>({sequence:r.sequence,observed_at:new Date(r.at).toISOString(),...structuredClone(r.record)})),next_before:selected.length>q.limit?visible.at(-1)?.sequence:null,
   storage:'volatile_memory',instance_id:this.instanceId,instance_started_at:new Date(this.startedAt).toISOString(),history_lost_on_restart:true,retention_hours_max:72,max_records:DIAGNOSTIC_MAX_RECORDS,
   collection_limits_per_instance:{per_minute:DIAGNOSTIC_PER_MINUTE,per_utc_day:DIAGNOSTIC_PER_DAY},absence_is_not_proof_of_no_request:true,read_excluded_from_diagnostics:true,scope:'this_owner_connection_diagnostics_only',historical_requests_before_enable:'not_available'};
 }
}
