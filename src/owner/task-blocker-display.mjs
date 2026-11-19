// A source may report an obstacle alongside its final outcome. Keep the
// source's wording, but do not turn a completed, failed or cancelled task
// back into an active blockage.
export function taskBlockerDisplay(status, value) {
  const detail = typeof value === 'string' && value.trim() ? value : '';
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  return { active: terminal ? '' : detail, note: terminal ? detail : '' };
}
