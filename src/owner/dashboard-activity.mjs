// Owner-only selected-branch history. No task discovery, writes, credentials or raw errors.
const fields = ['project_id','task_id','run_id','branch_id'];
const statuses = new Set(['proposed','running','needs_input','completed','failed','cancelled']);
const kinds = new Set(['registered','started','progress','needs_input','completed','failed','cancelled','heartbeat','correction']);
export function dashboardText(value, limit = 1200) {
  if (typeof value !== 'string') return '';
  if (/(?:-----BEGIN[\s\S]*PRIVATE KEY|(?:token|password|secret|api[_-]?key|authorization|recipient[_-]?id|user[_-]?id|chat[_-]?id|dm[_-]?id)[\"']?\s*[:=])/i.test(value)) return '[包含私密字段，内容已隐藏]';
  return value.replace(/\bBearer\s+\S+/gi,'[已隐藏凭证]')
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}/g,'[已隐藏凭证]')
    .replace(/\b(?:token|password|secret|api[_-]?key|authorization|recipient[_-]?id|user[_-]?id|chat[_-]?id|dm[_-]?id)\s*[:=]\s*["']?[^\s,"';]+/gi,'[已隐藏私密字段]')
    .replace(/<@!?\d+>/g,'[已隐藏接收人]').replace(/\b\d{15,25}\b/g,'[已隐藏标识]')
    .replace(/https?:\/\/[^\s]+/gi,'[链接已省略]').slice(0,limit);
}
export function dashboardProgress(value) {
  if (!value || !Number.isFinite(value.done) || value.done < 0 ||
      value.total !== null && (!Number.isFinite(value.total) || value.total <= 0 || value.done > value.total) ||
      typeof value.unit !== 'string' || !value.unit.trim()) return null;
  return {done:value.done,total:value.total,unit:dashboardText(value.unit,40)};
}
export function readDashboardActivity(storage, bindings, source, query, now = Date.now()) {
  const current = bindings.sources.find(s=>s.source_id===source?.source_id);
  if (!current?.enabled || JSON.stringify(current)!==JSON.stringify(source) ||
      !query || Object.keys(query).length!==4 || fields.some(k=>typeof query[k]!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(query[k])) ||
      !bindings.allowedProjectIds.includes(query.project_id)) throw Error('activity_unavailable');
  const rows=(sql,...args)=>storage.sql.exec(sql,...args).toArray();
  const tables=new Set(rows("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('meta','events','outbox')").map(r=>r.name));
  const identity=tables.has('meta') && rows("SELECT value FROM meta WHERE key='identity'")[0];
  if (!identity || identity.value!==JSON.stringify([bindings.ownerId,bindings.appId,bindings.userId,bindings.dmId])) throw Error('activity_unavailable');
  const base={state:'available',observed_at:new Date(now).toISOString(),scope:'selected_branch',delivery_scope:'discord_outbox_not_recipient_confirmation',items:[],truncated:false,withheld_count:0};
  if (!tables.has('events')) return {...base,state:'unavailable'};
  const key=JSON.stringify([source.source_id,query.task_id,query.run_id,query.branch_id]);
  const events=rows('SELECT source_id,event_id,revision,branch_key,payload,receipt,received_at,decision FROM events WHERE source_id=? AND branch_key=? ORDER BY revision DESC LIMIT 31',source.source_id,key);
  base.truncated=events.length>30;
  for (const row of events.slice(0,30)) {
    const p=JSON.parse(row.payload);
    if(row.decision==='bridge_response' && p.kind==='response') {base.withheld_count++;continue;} // Separate message bridge log, not a task-state update.
    if(row.source_id!==source.source_id || row.branch_key!==key || p.source_id!==source.source_id || fields.some(k=>p[k]!==query[k]) || p.event_id!==row.event_id || !Number.isSafeInteger(row.revision) || row.revision<1 || !Number.isFinite(row.received_at) || !/^rcpt_[a-f0-9]{32}$/.test(row.receipt)) throw Error('activity_unavailable');
    if(p.sensitivity!=='normal') {base.withheld_count++;continue;}
    if(!statuses.has(p.source_status) || !kinds.has(p.kind) || !Number.isFinite(Date.parse(p.occurred_at))) throw Error('activity_unavailable');
    // Read only status enums from jobs for this exact receipt. Never payload/error/message IDs.
    const delivery=tables.has('outbox') ? rows('SELECT status FROM outbox WHERE receipt=? ORDER BY id DESC LIMIT 10',row.receipt).map(r=>r.status) : [];
    const known=new Set(['pending','sending','sent','failed','uncertain','superseded','cancelled','blocked','dead_letter','coalesced','suppressed']);
    base.items.push({revision:row.revision,kind:p.kind,source_status:p.source_status,summary:dashboardText(p.summary),phase_label:dashboardText(p.phase_label,100),progress:dashboardProgress(p.progress),occurred_at:p.occurred_at,received_at:new Date(row.received_at).toISOString(),projection_applied:row.decision==='applied',delivery:delivery.length? [...new Set(delivery.map(s=>s==='sending'?'uncertain':known.has(s)?s:'unknown'))]:['not_recorded']});
  }
  return base;
}
