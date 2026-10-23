// Read current proof only: no diagnostic history, task discovery, initialization or refresh.
export const SOURCE_PROOF_MAX_AGE_MS = 86400000;
export function readDashboardSourceProof(storage, source, expectedBinding, now = Date.now(), authorizedSourceIds = ['zot-main']) {
  const base = {status:'unknown',evidence_kind:null,last_verified_at:null,proof_max_age_ms:SOURCE_PROOF_MAX_AGE_MS};
  if (!authorizedSourceIds.includes(source?.source_id)) throw Error('dashboard_source_not_authorized');
  if (!source.enabled) return {...base,status:'disabled'};
  const rows=(sql,...args)=>storage.sql.exec(sql,...args).toArray();
  if (!rows("SELECT name FROM sqlite_master WHERE type='table' AND name='source_connections'").length) return base;
  const columns=new Set(rows("SELECT name FROM pragma_table_info('source_connections')").map(r=>r.name));
  if (!['source_id','binding','generation','evidence_kind','last_verified_at','revoked'].every(c=>columns.has(c))) return base;
  const row=rows('SELECT binding,evidence_kind,last_verified_at,generation,revoked FROM source_connections WHERE source_id=?',source.source_id)[0];
  if (!row || typeof expectedBinding !== 'string' || row.binding !== expectedBinding || !Number.isSafeInteger(row.generation) || row.generation < 1) return base;
  if (row.revoked === 1) return {...base,status:'revoked'};
  if (row.revoked !== 0 || !['accepted_event','initialize','tools/list','read_probe'].includes(row.evidence_kind) || !Number.isSafeInteger(row.last_verified_at) || row.last_verified_at < 0 || row.last_verified_at > now) return base;
  return {...base,status:now-row.last_verified_at<SOURCE_PROOF_MAX_AGE_MS?'verified':'stale',evidence_kind:row.evidence_kind,last_verified_at:new Date(row.last_verified_at).toISOString()};
}
export function dashboardProducerStatus(producer) {
  const reasons=new Set(['not_activated','provider_outcome_unknown','grant_expired','preflight_not_sent','bridge_outcome_unknown','source_unverified','token_unavailable','grant_inactive','connection_unavailable','policy_changed','permission_changed','runtime_budget_unavailable','state_unavailable']);
  return {status:producer?.active===true?'active':producer?.active===false?'paused':'unknown',reason:producer?.active===true?null:reasons.has(producer?.reason)?producer.reason:'state_unavailable',scope:'owner_producer_only'};
}
