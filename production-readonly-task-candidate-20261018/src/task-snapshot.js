// Source-scoped snapshot: synchronous SELECTs only, including cold / empty SQLite.
// This code intentionally does not construct OwnerCore, reconcile connections,
// expire requests, record proofs/diagnostics, reserve sequences, or schedule work.
var taskSnapshotFields = ["project_id", "task_id", "run_id", "branch_id"];
var taskSnapshotInputSchema = {
  type: "object", additionalProperties: false, required: taskSnapshotFields,
  properties: Object.fromEntries(taskSnapshotFields.map((name) => [name, { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$" }]))
};
function validateTaskSnapshotQuery(raw) {
  const query = object(raw);
  keys(query, taskSnapshotFields);
  return Object.fromEntries(taskSnapshotFields.map((name) => [name, identifier(query[name])]));
}
function taskSnapshotSequence(seq, blockers) {
  return {
    mode: blockers.length ? "unavailable" : seq === null ? "initialize_sequence" : "advance_sequence",
    next_seq: blockers.length ? null : seq === null ? 0 : seq + 1,
    blockers, advisory_only: true, reserved: false, compare_and_swap_supported: false,
    instruction: "Only the source that owns event ordering may use this advice. It describes the observed branch, does not reserve a sequence or authorize an update. Concurrent writers can change the branch immediately. Keep the same task/run/branch; re-read and reconcile after a conflict, never blindly increment or auto-retry."
  };
}
function readTaskSnapshot(storage, bindings, source, raw, now = Date.now()) {
  const current = bindings.sources.find((s) => s.source_id === source?.source_id);
  if (!current?.enabled || canonical(current) !== canonical(source)) throw new Rejected("source_not_authorized", 403);
  const query = validateTaskSnapshotQuery(raw);
  if (!validateAllowedProjectIds(bindings.allowedProjectIds).includes(query.project_id)) throw new Rejected("project_not_authorized", 403);
  const rows = (sql, ...args) => storage.sql.exec(sql, ...args).toArray();
  const tables = new Set(rows("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('meta','branches','requests')").map((r) => r.name));
  if (tables.has("meta")) {
    const identity = rows("SELECT value FROM meta WHERE key='identity'")[0];
    if (identity && identity.value !== canonical([bindings.ownerId, bindings.appId, bindings.userId, bindings.dmId])) throw new Rejected("persisted_destination_mismatch", 503);
  }
  const response = { schema_version: "1.0", source_id: source.source_id, ...query, observed_at: new Date(now).toISOString(), found: false, snapshot: null, sequence: taskSnapshotSequence(null, ["task_not_found"]) };
  if (!tables.has("branches")) return response;
  const key = branchKey({ source_id: source.source_id, ...query });
  const row = rows("SELECT source_id,project_id,payload,seq,state_version,revision,last_confirmed,archived FROM branches WHERE branch_key=? AND source_id=? AND project_id=?", key, source.source_id, query.project_id)[0];
  if (!row) return response;
  const safePayload = (rawPayload) => {
    let payload;
    try { payload = JSON.parse(rawPayload); } catch { throw new Rejected("task_snapshot_unavailable", 503); }
    if (!payload || payload.source_id !== source.source_id || taskSnapshotFields.some((name) => payload[name] !== query[name]) || !["normal", "restricted"].includes(payload.sensitivity) || !statuses.has(payload.source_status)) throw new Rejected("task_snapshot_unavailable", 503);
    return projection(payload);
  };
  const payload = safePayload(row.payload), seq = row.seq;
  if (seq !== null && (!Number.isSafeInteger(seq) || seq < 0) || payload.source_seq !== seq || !Number.isSafeInteger(row.revision) || !Number.isSafeInteger(row.state_version) || !Number.isFinite(row.last_confirmed) || ![0, 1].includes(row.archived)) throw new Rejected("task_snapshot_unavailable", 503);
  if (!tables.has("requests")) throw new Rejected("task_snapshot_unavailable", 503);
  const pendingCount = rows("SELECT COUNT(*) AS count FROM requests WHERE branch_key=? AND state='pending'", key)[0].count;
  const pending = rows("SELECT request_id,payload,state,version FROM requests WHERE branch_key=? AND state='pending' ORDER BY request_key LIMIT 20", key).map((request) => {
    const p = safePayload(request.payload), action = p.action;
    if (!action || action.request_id !== request.request_id || typeof action.question !== "string" || action.mode !== "return_to_source") throw new Rejected("task_snapshot_unavailable", 503);
    return { request_id: request.request_id, state: request.state, version: request.version, question: action.question, impact: action.impact, expires_at: action.expires_at, expiry_elapsed: action.expires_at !== null && Date.parse(action.expires_at) <= now, mode: "return_to_source" };
  });
  const isTerminal = terminal.has(payload.source_status), archived = row.archived === 1;
  const blockers = [archived && "archived_branch", isTerminal && "terminal_requires_explicit_correction", pendingCount > 0 && "pending_action", payload.source_status === "needs_input" && "needs_input_state", seq === Number.MAX_SAFE_INTEGER && "sequence_exhausted"].filter(Boolean);
  return {
    ...response, found: true,
    snapshot: {
      source_seq: seq, state_version: row.state_version, revision: row.revision,
      event_id: payload.event_id, kind: payload.kind, source_status: payload.source_status,
      project_name: payload.project_name, task_name: payload.task_name, branch_name: payload.branch_name,
      summary: payload.summary, phase_id: payload.phase_id, phase_label: payload.phase_label,
      progress: payload.progress, blocker: payload.blocker, sensitivity: payload.sensitivity,
      occurred_at: payload.occurred_at, last_confirmed_at: new Date(row.last_confirmed).toISOString(),
      stale: now - row.last_confirmed > 18e5, terminal: isTerminal, archived,
      pending_actions: { stored_pending_count: pendingCount, items: pending, truncated: pendingCount > pending.length, expiry_is_observation_only: true }
    },
    sequence: taskSnapshotSequence(seq, blockers)
  };
}
async function taskSnapshotOwnerRequest(request, env, storage) {
  try {
    const bindings = loadBindings(env), url = new URL(request.url);
    if (url.origin !== "https://owner.internal" || url.pathname !== "/v1/task/snapshot" || url.search || url.hash || request.method !== "POST") throw new Rejected("internal_route_required", 403);
    const bytes = await boundedBody(request);
    const source = await authenticate(request, bytes, bindings, env, Date.now());
    let data;
    try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); } catch { throw new Rejected("invalid_json", 400); }
    return jsonResponse(readTaskSnapshot(storage, bindings, source, data));
  } catch (error) { return safeError(error); }
}
async function suppressTaskSnapshotTrace(request, trace) {
  const path = new URL(request.url).pathname;
  if (path === "/v1/task/snapshot") { trace.skip(); return; }
  if (!(path === "/mcp" || path.startsWith("/mcp/")) || request.method !== "POST") return;
  // Inspect a bounded clone so even denied snapshot calls cannot cold-start the
  // owner through the existing diagnostic sink. Original body/auth are unchanged.
  try {
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json") return;
    const reader = request.clone().body?.getReader();
    if (!reader) return;
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) {
        // A cloned stream is teed. Awaiting its cancellation can wait forever
        // for the original body that gatewayCore has not consumed yet.
        void reader.cancel().catch(() => {});
        return;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const rpc = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (rpc && !Array.isArray(rpc) && rpc.method === "tools/call" && rpc.params?.name === "get_task_snapshot") trace.skip();
  } catch {}
}
