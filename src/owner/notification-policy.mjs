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
export function formatQQNotification(event, source, now, { includeSourceUrl = false } = {}) {
  const pending = event.action && (!event.action.expires_at || Date.parse(event.action.expires_at) > now) ? event.action : null;
  const states = {running:'⏳ 进行中', needs_input:'⚠️ 等待输入', completed:'✅ 已完成', failed:'⚠️ 失败', cancelled:'⏹ 已取消', proposed:'○ 待开始'};
  const label = event.blocker && !['completed','cancelled','failed'].includes(event.source_status) ? '⚠️ 受阻' : pending ? '⚠️ 待你处理' : states[event.source_status] ?? '状态更新';
  const brand = sourceBrand(source);
  const identity = [brand.emoji, brand.name].filter(Boolean).join(' ');
  const compose = summary => [identity + ' → 🐧 QQ', label + ' · ' + event.project_name, event.task_name + (event.branch_name && event.branch_name !== '主路线' ? ' / ' + event.branch_name : ''), '', summary, event.progress ? `进展  ${event.progress.done}${event.progress.total == null ? '' : ' / ' + event.progress.total} ${event.progress.unit}` : event.phase_label ? '阶段  ' + event.phase_label : null, event.blocker ? '受阻  ' + event.blocker : null, pending ? '\n待办  ' + pending.question + '\n到原助手查看并回复' : null, includeSourceUrl ? event.source_url : null].filter(v => v !== null && v !== undefined).join('\n');
  let content = compose(event.summary);
  if (content.length > 4000) {
    const budget = Math.max(0, String(event.summary ?? '').length - (content.length - 4000) - 1);
    const summary = String(event.summary ?? '').slice(0, budget).replace(/[\uD800-\uDBFF]$/, '');
    content = compose(summary + '…');
  }
  if (content.length > 4000) throw Error('qq_notification_required_content_too_long');
  return content;
}
