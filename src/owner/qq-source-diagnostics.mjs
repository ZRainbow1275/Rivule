// Configuration observation only. This deliberately does not resolve recipient,
// activation, permissions, capabilities, project policy or source proof.
export function readQQSourceConfiguration(env, sourceId) {
  const base = {scope: 'current_source_allowlist_only_not_delivery_authorization_or_historical_cause', source_id: sourceId};
  try {
    const raw = env.QQ_ALLOWED_SOURCE_IDS ?? '[]';
    // Bound diagnostic parsing independently of admission. Oversized config is
    // unknown here, never a claim that admission permits or denies this source.
    if (typeof raw !== 'string' || raw.length > 65536) throw Error('unavailable');
    const allowed = JSON.parse(raw);
    // Match bridgeConfig's list shape/uniqueness checks, without loading any
    // identity, secret, gateway or recipient configuration.
    if (!Array.isArray(allowed) || allowed.some(v => typeof v !== 'string') || new Set(allowed).size !== allowed.length) throw Error('unavailable');
    const included = allowed.includes(sourceId);
    return {...base, source_allowed_in_configuration: included, reason: included ? 'source_in_allowlist' : 'source_not_in_allowlist'};
  } catch {
    return {...base, source_allowed_in_configuration: null, reason: 'configuration_unavailable'};
  }
}
