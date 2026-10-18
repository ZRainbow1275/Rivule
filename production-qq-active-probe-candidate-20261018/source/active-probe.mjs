// qq-cloudflare/active-probe.mjs
// Isolated, fixed, one-shot diagnostic. Never supplies ordinary-delivery evidence.
var ACTIVE_PROBE_ID = "qq-active-fixed-v1";
var ACTIVE_PROBE_TEXT = "Rivule 主动通知测试：主动消息通道验证。";
var ACTIVE_PROBE_FRESH_MS = 300000;
var ACTIVE_PROBE_BUDGET_MS = 7200000;
var authenticatedGatewayDispatches = new WeakSet();
async function dispatchAuthenticatedGatewayEvent(client, event, phase = "live") {
  const auth = { session: client.session, generation: client.generation, phase };
  authenticatedGatewayDispatches.add(auth);
  try {
    return await client.onDispatch(event, auth);
  } finally {
    authenticatedGatewayDispatches.delete(auth);
  }
}
async function activeBindingFingerprint(binding) {
  if (!binding || !/^\d{1,32}$/.test(binding.appId) || !valid(binding.ownerId) || !valid(binding.userOpenId) || !Number.isSafeInteger(binding.confirmedAt) || binding.confirmedAt < 0) return null;
  return qqHash(JSON.stringify([binding.appId, binding.ownerId, binding.userOpenId, binding.confirmedAt]));
}
function permissionHistory(state, now) {
  state.qqActivePermission ??= { revision: 0, history: [], seen: {} };
  const p = state.qqActivePermission;
  if (state.qqRevoked === true && p.revision === 0) {
    p.revision = 1;
    p.history.push({ type: "legacy_revocation_latch", revision: 1, recordedAt: now });
  }
  return p;
}
async function observeActivePermission({ state, store, event, auth, client, appId, ownerId, now }) {
  const b = state.binding, d = event.d;
  if (b?.appId !== appId || b?.ownerId !== ownerId || ![d?.openid, d?.user_openid].includes(b.userOpenId)) return;
  const revoked = ["FRIEND_DEL", "C2C_MSG_REJECT"].includes(event.t);
  // Negative events fail closed, including older/malformed timestamp shapes.
  // Positive consent must come from an authenticated current gateway dispatch.
  const trusted = authenticatedGatewayDispatches.has(auth) && auth.phase === "live" && auth.session === client.session && auth.generation === client.generation && !client.stopped && typeof auth.session === "string" && !!auth.session && event.op === 0 && Number.isSafeInteger(event.s) && event.s >= 0;
  if (!revoked && !trusted) return;
  if (event.t === "FRIEND_ADD") return;
  const at = Number.isSafeInteger(d?.timestamp) && d.timestamp >= 0 && d.timestamp <= 8640000000000 ? d.timestamp * 1000 : null;
  const fingerprint = await activeBindingFingerprint(b);
  const p = permissionHistory(state, now);
  // Provider event ID is preferred. The timestamp tuple is a conservative
  // cross-session duplicate key when QQ does not provide an event ID.
  const eventKey = await qqHash(JSON.stringify(text(event.id, 1024) ? [fingerprint, event.t, "provider_id", event.id] : [fingerprint, event.t, "timestamp", at, at === null ? [auth?.session ?? null, event.s ?? null] : null]));
  if (p.seen[eventKey]) return;
  if (Object.keys(p.seen).length >= 1024 || revoked && p.history.length >= 128) {
    if (revoked) state.qqRevoked = true;
    delete p.renewal;
    delete state.qqActiveObservedCapability;
    store.qqIngestionFault = true;
    state.qqIngestionHealth = { healthy: false, reason: "permission_history_capacity", failedAt: now };
    return;
  }
  p.seen[eventKey] = true;
  if (revoked) {
    state.qqRevoked = true;
    p.revision++;
    p.history.push({ type: event.t, revision: p.revision, recordedAt: now, eventAt: at, eventKey, bindingFingerprint: fingerprint });
    delete p.renewal;
    delete state.qqActiveObservedCapability;
    return;
  }
  if (event.t !== "C2C_MSG_RECEIVE" || d.openid !== b.userOpenId || !fingerprint || at === null || at > now || now - at >= ACTIVE_PROBE_FRESH_MS || at < b.confirmedAt || store.qqIngestionFault || state.qqIngestionHealth?.healthy !== true || state.control?.running !== true) return;
  const last = p.history.at(-1);
  // Require time strictly after the newest negative record. Same-second
  // ambiguous ordering cannot grant renewal; ask for a fresh QQ toggle.
  if (last && (at <= last.recordedAt || last.eventAt !== null && Number.isFinite(last.eventAt) && at <= last.eventAt)) return;
  p.renewal = { kind: "authenticated_C2C_MSG_RECEIVE", eventKey, eventAt: at, receivedAt: now, bindingFingerprint: fingerprint, confirmedAt: b.confirmedAt, revision: p.revision, sessionFingerprint: await qqHash(auth.session), sequence: event.s };
}
async function activeProbeEligibility(actor, state, expected) {
  const c = actor.config(), now = actor.now(), binding = state.binding;
  if (c.budget !== ACTIVE_PROBE_BUDGET_MS) return { reason: "active_probe_budget_configuration_changed" };
  const budget = state.activeBudget;
  if (!budget || !Number.isSafeInteger(budget.day) || !Number.isFinite(budget.usedMs) || budget.usedMs < 0 || !Number.isFinite(budget.lastAt) || budget.lastAt > now || (budget.day === Math.floor(now / 86400000) ? budget.usedMs + Math.max(0, now - budget.lastAt) : Math.max(0, now % 86400000)) >= c.budget) return { reason: "budget_exhausted" };
  // The diagnostic cannot serve as a path for enabling ordinary delivery.
  if (actor.env.QQ_DELIVERY_ENABLED !== "false") return { reason: "active_probe_delivery_must_remain_disabled" };
  if (state.control?.running !== true || actor.runtime?.client.ready !== true || actor.store.qqIngestionFault || state.qqIngestionHealth?.healthy !== true) return { reason: "active_probe_connection_not_healthy" };
  const fingerprint = await activeBindingFingerprint(binding);
  if (!fingerprint || binding.appId !== c.appId || binding.ownerId !== c.ownerId || binding.confirmedAt > now) return { reason: "active_probe_binding_unverified" };
  if (expected && (expected.probeId !== ACTIVE_PROBE_ID || expected.bindingFingerprint !== fingerprint || expected.confirmedAt !== binding.confirmedAt)) return { reason: "active_probe_binding_changed" };
  const revision = state.qqActivePermission?.revision ?? 0;
  let renewalEventKey = null;
  if (state.qqRevoked === true) {
    const renewal = state.qqActivePermission?.renewal;
    if (!renewal || renewal.kind !== "authenticated_C2C_MSG_RECEIVE" || renewal.bindingFingerprint !== fingerprint || renewal.confirmedAt !== binding.confirmedAt || renewal.revision !== revision || renewal.eventAt > now || now - renewal.eventAt >= ACTIVE_PROBE_FRESH_MS || renewal.receivedAt > now || renewal.eventAt < binding.confirmedAt) return { reason: "active_probe_fresh_qq_permission_required" };
    renewalEventKey = renewal.eventKey;
  }
  if (expected && (expected.permissionRevision !== revision || expected.renewalEventKey !== renewalEventKey)) return { reason: "active_probe_permission_changed" };
  return { bindingFingerprint: fingerprint, confirmedAt: binding.confirmedAt, probeId: ACTIVE_PROBE_ID, permissionRevision: revision, renewalEventKey };
}
async function activeProbePanel(actor, state) {
  permissionHistory(state, actor.now());
  const eligible = await activeProbeEligibility(actor, state);
  const fingerprint = await activeBindingFingerprint(state.binding);
  const observation = state.qqActiveObservedCapability;
  if (observation && (observation.bindingFingerprint !== fingerprint || observation.validUntil <= actor.now())) delete state.qqActiveObservedCapability;
  const record = fingerprint && state.qqActiveProbes?.[fingerprint]?.[ACTIVE_PROBE_ID];
  return { eligible: !eligible.reason && !record, control: eligible, receipt: record?.receipt, reason: eligible.reason };
}
async function fixedActiveProbe(actor, approved, interactionId) {
  let reserved;
  try {
    reserved = await actor.command(async () => {
      const budget = await actor.accountBudget();
      if (budget.exhausted) {
        await actor.stopInternal("active_budget_exhausted");
        return { receipt: blocked("budget_exhausted") };
      }
      return actor.store.transaction(async (s) => {
        const permission = await activeProbeEligibility(actor, s, approved);
        if (permission.reason) return { receipt: blocked(permission.reason) };
        const old = s.qqActiveProbes?.[permission.bindingFingerprint]?.[ACTIVE_PROBE_ID];
        if (old) return { receipt: old.receipt };
        s.qqActiveProbes ??= {};
        if (Object.keys(s.qqActiveProbes).length >= 64) return { receipt: blocked("active_probe_history_capacity") };
        const probe = { ...permission, kind: "one_shot_active_test", interactionId, reservedAt: actor.now(), userOpenId: s.binding.userOpenId, receipt: { state: "uncertain", reason: "reserved_before_send" } };
        s.qqActiveProbes[permission.bindingFingerprint] = { [ACTIVE_PROBE_ID]: probe };
        return { probe: structuredClone(probe) };
      });
    });
  } catch {
    return blocked("active_probe_reservation_unavailable");
  }
  if (reserved.receipt) return reserved.receipt;
  const probe = reserved.probe;
  let result = { state: "not_sent", reason: "preflight_failed" }, attempted = false;
  try {
    const token = await actor.runtime.client.tokenValue();
    // Commands serialize this final gate and immediate POST invocation with
    // stop, rebind, and authenticated gateway ingestion. The durable one-shot
    // reservation above is already committed before any message request.
    const dispatch = await actor.command(async () => {
      const budget = await actor.accountBudget();
      if (budget.exhausted) {
        await actor.stopInternal("active_budget_exhausted");
        return { reason: "budget_exhausted" };
      }
      const gate = await actor.store.transaction(async (s) => {
        const permission = await activeProbeEligibility(actor, s, probe);
        const record = s.qqActiveProbes?.[probe.bindingFingerprint]?.[ACTIVE_PROBE_ID];
        return permission.reason ? permission : !record || record.interactionId !== probe.interactionId || record.receipt.reason !== "reserved_before_send" ? { reason: "active_probe_reservation_changed" } : {};
      });
      if (gate.reason) return gate;
      attempted = true;
      // Deliberately does not call QQC2CTransport.post (which retries a 401).
      const network = actor.network;
      const response = network(QQ_API_ORIGIN + "/v2/users/" + encodeURIComponent(probe.userOpenId) + "/messages", { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000), headers: { Authorization: "QQBot " + token, "content-type": "application/json", "X-Union-Appid": actor.config().appId }, body: JSON.stringify({ msg_type: 0, content: ACTIVE_PROBE_TEXT }) });
      // Attach a rejection handler synchronously; awaiting happens outside the
      // command queue so a revoke/stop can still persist while HTTP is pending.
      return { response: Promise.resolve(response).then(value => ({ value }), () => ({ networkError: true })) };
    });
    if (dispatch.reason) result = { state: "not_sent", reason: dispatch.reason };
    else {
      const outcome = await dispatch.response;
      if (outcome.networkError) result = { state: "uncertain", reason: "network_outcome_unknown" };
      else {
        const response = outcome.value;
        let data;
        try {
          data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await qqReadBytes(response.body, 65536)));
        } catch {
        }
        const providerCode = Number.isSafeInteger(data?.code) && data.code !== 0 ? data.code : Number.isSafeInteger(data?.err_code) && data.err_code !== 0 ? data.err_code : void 0;
        if (response.ok && (data?.code === void 0 || data.code === 0) && (data?.err_code === void 0 || data.err_code === 0) && text(data?.id, 1024)) result = { state: "sent", reason: "provider_accepted", messageId: data.id };
        else if ([401, 403, 429].includes(response.status) || knownRejections.has(providerCode)) result = { state: "not_sent", reason: qqRejectionReason(response.status, providerCode), ...providerCode === void 0 ? {} : { providerCode } };
        else result = { state: "uncertain", reason: "provider_outcome_unknown" };
      }
    }
  } catch {
    result = { state: attempted ? "uncertain" : "not_sent", reason: attempted ? "network_outcome_unknown" : "preflight_failed" };
  }
  try {
    await actor.command(() => actor.store.transaction(async (s) => {
      const record = s.qqActiveProbes?.[probe.bindingFingerprint]?.[ACTIVE_PROBE_ID];
      if (!record || record.interactionId !== probe.interactionId) throw Error("active_probe_receipt_conflict");
      record.receipt = result;
      record.completedAt = actor.now();
      const current = await activeProbeEligibility(actor, s, probe);
      if (result.reason === "provider_accepted" && !current.reason) {
        s.qqActiveObservedCapability = { schemaVersion: 1, kind: "isolated_active_probe_observation", bindingFingerprint: probe.bindingFingerprint, confirmedAt: probe.confirmedAt, appId: s.binding.appId, ownerId: s.binding.ownerId, recipientFingerprint: await qqHash(s.binding.userOpenId), checkedAt: actor.now(), validUntil: actor.now() + ACTIVE_PROBE_FRESH_MS, probeId: ACTIVE_PROBE_ID, permissionRevision: probe.permissionRevision, renewalEventKey: probe.renewalEventKey, receipt: structuredClone(result) };
      }
    }));
  } catch {
    return { state: "uncertain", reason: "receipt_persistence_failed" };
  }
  return result;
}


function activeProbeHumanReason(reason) {
  return ({
    proactive_permission_denied: "主动消息权限未开启",
    rate_limited: "QQ 发送频率受限",
    friendship_missing: "请先添加机器人好友",
    recipient_refused: "QQ 已关闭消息接收",
    bot_offline: "机器人暂时离线",
    provider_rejected: "QQ 暂未接受消息",
    budget_exhausted: "今日连接时间已用完",
    active_probe_connection_not_healthy: "请先连接 QQ",
    active_probe_binding_unverified: "请先确认 QQ 绑定",
    active_probe_binding_changed: "绑定已变化，请重新打开设置",
    active_probe_permission_changed: "权限已变化，请重新打开设置",
    active_probe_fresh_qq_permission_required: "请在 QQ 机器人资料卡重新开启主动消息",
    active_probe_budget_configuration_changed: "连接预算需要检查",
    active_probe_delivery_must_remain_disabled: "当前通知设置不适用此测试"
  })[reason] || "请重新打开设置查看状态";
}
function activeProbeHumanReceipt(receipt) {
  if (receipt.state === "sent" && receipt.reason === "provider_accepted") return "已提交 QQ";
  if (receipt.state === "uncertain") return "待确认";
  return "发送失败 · " + activeProbeHumanReason(receipt.reason);
}
