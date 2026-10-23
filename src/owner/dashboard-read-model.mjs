import { dashboardText, dashboardProgress } from './dashboard-activity.mjs';
// Server-side adapter only. Do not bundle authenticated readers or credentials into a browser.
const fields = ['project_id', 'task_id', 'run_id', 'branch_id'];
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(value);
const statuses = new Set(['proposed', 'running', 'needs_input', 'completed', 'failed', 'cancelled']);
const text = dashboardText;

/** Read a caller-selected watchlist through one already-authenticated source.
 * This does not authenticate a web visitor or authorize sharing the returned data.
 * The host must enforce owner-only access and Cache-Control: no-store.
 */
export async function readDashboardWatchlist({ sourceId, watchlist, readSnapshot, readActivity, authorizedSourceIds = ['zot-main'] }) {
  if (!authorizedSourceIds.includes(sourceId) || typeof readSnapshot !== 'function' || !Array.isArray(watchlist) || watchlist.length > 20)
    throw new Error('invalid_dashboard_watchlist');
  const queries = watchlist.map(query => {
    if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).length !== fields.length ||
        fields.some(key => !Object.hasOwn(query, key) || !id(query[key]))) throw new Error('invalid_dashboard_watchlist');
    return Object.fromEntries(fields.map(key => [key, query[key]]));
  });
  if (new Set(queries.map(query => JSON.stringify(query))).size !== queries.length) throw new Error('duplicate_dashboard_branch');
  const items = [];
  for (const query of queries) {
    const base = { source_id: sourceId, ...query };
    try {
      const response = await readSnapshot({ ...query });
      if (!response || response.schema_version !== '1.0' || response.source_id !== sourceId ||
          fields.some(key => response[key] !== query[key]) || !Number.isFinite(Date.parse(response.observed_at)))
        throw new Error('invalid_snapshot');
      if (response.found === false && response.snapshot === null) {
        items.push({ ...base, state: 'not_found', observed_at: response.observed_at });
        continue;
      }
      const snapshot = response.snapshot;
      if (response.found !== true || !snapshot || !statuses.has(snapshot.source_status)) throw new Error('invalid_snapshot');
      // Restricted/secret data needs a separate, explicitly authorized presentation policy.
      if (snapshot.sensitivity !== 'normal') {
        items.push({ ...base, state: 'withheld', observed_at: response.observed_at });
        continue;
      }
      if (typeof snapshot.stale !== 'boolean' || typeof snapshot.archived !== 'boolean' ||
          !Number.isFinite(Date.parse(snapshot.last_confirmed_at)) ||
          !Number.isSafeInteger(snapshot.pending_actions?.stored_pending_count) || snapshot.pending_actions.stored_pending_count < 0)
        throw new Error('invalid_snapshot');
      items.push({ ...base, state: 'available', observed_at: response.observed_at,
        source_status: snapshot.source_status, project_name: text(snapshot.project_name, 120),
        task_name: text(snapshot.task_name, 120), branch_name: text(snapshot.branch_name, 80),
        summary: text(snapshot.summary, 1200), phase_label: text(snapshot.phase_label,100), progress: dashboardProgress(snapshot.progress), blocker: text(snapshot.blocker,400), stale: snapshot.stale, archived: snapshot.archived,
        last_confirmed_at: snapshot.last_confirmed_at, pending_action_count: snapshot.pending_actions.stored_pending_count });
    } catch {
      // Never serialize raw transport errors, tokens, action payloads or sequence advice.
      items.push({ ...base, state: 'unavailable' });
    }
  }
  for (const item of items) if (item.state === 'available') {
    try { item.activity = readActivity ? await readActivity(Object.fromEntries(fields.map(k=>[k,item[k]]))) : {state:'unavailable',items:[]}; }
    catch { item.activity = {state:'unavailable',items:[]}; }
  }
  return { schema_version: '1.0', source_id: sourceId, state: items.some(item => item.state === 'unavailable') ? 'error' : 'connected', mode: 'read_only_watchlist',
    discovery_supported: false, live_subscription: false, items };
}

// Presentation states are explicit; never substitute demo rows on failure.
export function dashboardViewState(model) {
  if (!model) return { state: 'unconfigured', label: '尚未连接真实任务服务', items: [] };
  if (model.schema_version !== '1.0' || model.source_id !== 'zot-main' ||
      model.mode !== 'read_only_watchlist' || !Array.isArray(model.items) ||
      !['connected', 'error'].includes(model.state))
    return { state: 'error', label: '任务状态读取失败，不能视为没有任务', items: [] };
  return { state: model.state, label: model.state === 'error' ? '部分或全部任务读取失败，请稍后重新读取' : '已读取所选任务快照；不是实时订阅', items: model.items };
}
