// Observational only: no initialization, DDL, cleanup, scheduling or delivery.
// Probe the existing status/next_at index, never historical terminal rows/payloads.
const LIMIT = 100;
const STATES = ['queued', 'retry_wait', 'sending', 'uncertain', 'blocked'];
const finiteTime = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const rows = (storage, sql, ...args) => storage.sql.exec(sql, ...args).toArray();
export const DISCORD_DIAGNOSTIC_QUERY = `SELECT COUNT(*) AS owner_jobs,
  COALESCE(SUM(CASE WHEN e.source_id=? THEN 1 ELSE 0 END),0) AS source_jobs,
  MIN(CASE WHEN e.source_id=? THEN o.next_at END) AS source_earliest_at
  FROM (SELECT receipt,next_at FROM outbox INDEXED BY outbox_due WHERE status=? ORDER BY next_at,id LIMIT ?) o
  LEFT JOIN events e ON e.receipt=o.receipt`;

export async function readDiscordDeliveryDiagnostics(storage, {tables, sourceId, deliveryEnabled, now = Date.now()}) {
  const base = {scope: 'current_owner_dispatch_gate_and_selected_source_not_historical_cause', source_id: sourceId,
    observed_at: new Date(now).toISOString(), delivery_enabled: deliveryEnabled === true,
    recipient_confirmation: 'not_observed', per_status_row_limit: LIMIT, sentinel_rows: 1};
  if (!tables.has('outbox') || !tables.has('events')) return {...base, state: 'unavailable', reason: 'schema_unavailable'};
  try {
    const sourceCounts = {}, quarantine = {}, pending = []; let sourceTruncated = false, gateTruncated = false;
    for (const status of STATES) {
      // Limit candidate jobs BEFORE joining source identity. Missing event rows
      // still count toward the owner gate. Other sources' IDs never leave SQL.
      const row = rows(storage, DISCORD_DIAGNOSTIC_QUERY, sourceId, sourceId, status, LIMIT + 1)[0];
      const truncated = row.owner_jobs > LIMIT;
      sourceCounts[status] = {count: row.source_jobs, has_more: truncated};
      sourceTruncated ||= truncated;
      if (['sending','uncertain','blocked'].includes(status)) {
        quarantine[status] = {count: row.owner_jobs, has_more: truncated}; gateTruncated ||= truncated;
      } else if (finiteTime(row.source_earliest_at) !== null) pending.push(row.source_earliest_at);
    }
    const rawRate = tables.has('meta') ? rows(storage, "SELECT value FROM meta WHERE key='rate_until'")[0]?.value : undefined;
    const rate = rawRate === undefined ? 0 : typeof rawRate === 'string' && /^\d{1,16}$/.test(rawRate) ? finiteTime(Number(rawRate)) : null;
    let alarm = {state: 'unavailable', scheduled_at: null};
    if (typeof storage.getAlarm === 'function') {
      try { const at = await storage.getAlarm(); alarm = at === null ? {state: 'not_scheduled', scheduled_at: null} : finiteTime(at) !== null ? {state: 'scheduled', scheduled_at: at} : alarm; } catch {}
    }
    return {...base, state: 'observed', source_queue: {counts: sourceCounts, truncated: sourceTruncated,
      counts_semantics: sourceTruncated ? 'lower_bounds_candidate_limit' : 'complete_active_statuses',
      earliest_sampled_pending_at: pending.length ? Math.min(...pending) : null},
      owner_dispatch_gate: {scope: 'owner_wide_counts_only', quarantine_counts: quarantine,
        quarantine_present: Object.values(quarantine).some(v => v.count > 0), truncated: gateTruncated,
        rate_until: rate, rate_state: rate === null ? 'unavailable' : rate > now ? 'waiting' : 'not_waiting'}, alarm};
  } catch { return {...base, state: 'unavailable', reason: 'state_unavailable'}; }
}
