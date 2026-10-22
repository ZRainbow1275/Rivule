// Private, exact-receipt selection only. Never expose this as a public lookup API.
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(value);
export function validateDashboardTestReceipt(value) {
  if (value === null) return null;
  if (!value || Array.isArray(value) || Object.keys(value).length !== 4 ||
      typeof value.receipt_id !== 'string' || !/^rcpt_[a-f0-9]{32}$/.test(value.receipt_id) ||
      !id(value.event_id) || !id(value.run_id) || !Number.isSafeInteger(value.revision) || value.revision < 1)
    throw Error('dashboard_receipt_unavailable');
  return { receipt_id:value.receipt_id, event_id:value.event_id, run_id:value.run_id, revision:value.revision };
}
export function readDashboardTestReceipt(storage, bindings, source, raw) {
  const selector = validateDashboardTestReceipt(raw);
  const current = bindings.sources.find(s => s.source_id === 'zot-main');
  if (!selector || !current?.enabled || source?.source_id !== 'zot-main' || JSON.stringify(current) !== JSON.stringify(source))
    throw Error('dashboard_receipt_unavailable');
  const rows = (sql,...args) => storage.sql.exec(sql,...args).toArray();
  const tables = new Set(rows("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('meta','events')").map(r=>r.name));
  if (tables.has('meta')) {
    const identity = rows("SELECT value FROM meta WHERE key='identity'")[0];
    if (identity && identity.value !== JSON.stringify([bindings.ownerId,bindings.appId,bindings.userId,bindings.dmId])) throw Error('dashboard_receipt_unavailable');
  }
  if (!tables.has('events')) throw Error('dashboard_receipt_unavailable');
  const matches = rows('SELECT source_id,event_id,revision,branch_key,payload FROM events WHERE receipt=? AND source_id=? LIMIT 1',selector.receipt_id,'zot-main');
  const row = matches[0];
  if (!row || row.source_id !== 'zot-main' || row.event_id !== selector.event_id || row.revision !== selector.revision)
    throw Error('dashboard_receipt_unavailable');
  const payload = JSON.parse(row.payload);
  if (!payload || payload.source_id !== 'zot-main' || payload.event_id !== selector.event_id || payload.run_id !== selector.run_id ||
      !['project_id','task_id','run_id','branch_id'].every(k=>id(payload[k])) || !bindings.allowedProjectIds.includes(payload.project_id) ||
      row.branch_key !== JSON.stringify(['zot-main',payload.task_id,payload.run_id,payload.branch_id])) throw Error('dashboard_receipt_unavailable');
  return Object.fromEntries(['project_id','task_id','run_id','branch_id'].map(k=>[k,payload[k]]));
}
