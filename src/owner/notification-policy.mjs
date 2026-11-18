import { sourceBrand } from "./brand-identity.mjs";
// Routine progress shares a bounded window. Decisions and terminal events bypass it.
export const PROGRESS_WINDOW_MS = 60_000;
export function isRoutineProgress(event) {
  return event?.kind === 'progress' && event.source_status === 'running' && !event.action && !event.blocker;
}
export function sameNotificationBranch(a, b) {
  return ['source_id', 'project_id', 'task_id', 'run_id', 'branch_id'].every(key => typeof a?.[key] === 'string' && a[key] === b?.[key]);
}
export function routineDueAt(event, receivedAt) {
  return receivedAt + (isRoutineProgress(event) ? PROGRESS_WINDOW_MS : 0);
}
const QQ_TEXT_LIMIT = 4000;
let graphemes;
function fitQQSummary(text, room) {
  if (text.length <= room) return text;
  if (room === 0) return '';
  const end = room - 1; // Keep the transport's UTF-16 cap, but only cut between visible characters.
  if (typeof globalThis.Intl?.Segmenter !== 'function') {
    // In small runtimes, a boundary between two ordinary ASCII/Han characters is safe.
    // For an entirely complex run we cannot segment, keep the facts and only show the ellipsis.
    const plain = /^[\t\n -~\u3400-\u4dbf\u4e00-\u9fff]$/;
    let safe = end;
    while (safe > 0 && !(plain.test(text[safe - 1]) && plain.test(text[safe]))) safe--;
    return text.slice(0, safe) + '…';
  }
  graphemes ??= new Intl.Segmenter('und', { granularity: 'grapheme' });
  let whole = 0;
  for (const { index, segment } of graphemes.segment(text)) {
    if (index + segment.length > end) break;
    whole = index + segment.length;
  }
  return text.slice(0, whole) + '…';
}

export function formatQQNotification(event, source, now, { includeSourceUrl = false, replyContextRef = null } = {}) {
  const deadline = event.action?.expires_at;
  const end = deadline == null ? NaN : Date.parse(deadline);
  const clock = now instanceof Date ? now.getTime() : now;
  const comparable = Number.isFinite(end) && Number.isFinite(clock);
  const pending = event.action && (deadline == null || (comparable && clock < end)) ? event.action : null;
  // Only the reported deadline can expire a request. Source reachability and blockers are separate.
  const deadlineLabel = event.source_status === 'needs_input' && deadline != null && !pending
    ? (comparable ? '⌛ 请求期限已过 · 原平台待核对' : '⚠️ 回复期限待核对') : null;
  const states = {running:'⏳ 进行中', needs_input:'⚠️ 等待输入', completed:'✅ 已完成', failed:'⚠️ 失败', cancelled:'⏹ 已取消', proposed:'○ 待开始'};
  const label = deadlineLabel ?? (event.blocker && !['completed','cancelled','failed'].includes(event.source_status) ? '⚠️ 受阻' : pending ? '⚠️ 待你处理' : states[event.source_status] ?? '状态更新');
  const brand = sourceBrand(source);
  const identity = [brand.emoji, brand.name].filter(Boolean).join(' ');
  const compose = summary => [
    identity + ' → 🐧 QQ', label + ' · ' + event.project_name,
    event.task_name + (event.branch_name && event.branch_name !== '主路线' ? ' / ' + event.branch_name : ''),
    '', summary,
    event.progress ? `进展  ${event.progress.done}${event.progress.total == null ? '' : ' / ' + event.progress.total} ${event.progress.unit}` : event.phase_label ? '阶段  ' + event.phase_label : null,
    event.blocker ? '受阻  ' + event.blocker : null,
    pending ? '\n待办  ' + pending.question + '\n到原助手查看并回复' : null,
    includeSourceUrl ? event.source_url : null,
    replyContextRef ? '\n回复指令：/rivule ' + replyContextRef + ' <指令>' : null
  ].filter(v => v !== null && v !== undefined).join('\n');
  const full = compose(event.summary);
  if (full.length <= QQ_TEXT_LIMIT) return full;
  const room = QQ_TEXT_LIMIT - compose('').length;
  if (room < 0) throw Error('qq_notification_required_content_too_long');
  return compose(fitQQSummary(String(event.summary ?? ''), room));
}
