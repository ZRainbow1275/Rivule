// Rivule — AGPL-3.0. Third-party notices: ../../third-party-licenses/
var CODES = {
    token: ["request_started", "credential_unavailable", "http_rejected", "invalid_response", "json_invalid", "response_shape_invalid", "token_missing", "ttl_type_invalid", "ttl_range_invalid", "business_rejected", "network_failed", "accepted"],
    gateway: ["request_started", "http_rejected", "invalid_response", "network_failed", "accepted"],
    socket: ["upgrade_started", "upgrade_http_rejected", "upgrade_invalid_response", "upgrade_failed", "opened", "closed", "transport_error", "protocol_error", "frame_backpressure", "heartbeat_timeout"],
    auth: ["identify_sent", "resume_sent", "invalid_session", "hello_timeout", "ready_timeout", "ready", "resumed"],
    alarm: ["started", "completed", "failed"]
};
var FAILURE = new Set(["credential_unavailable", "http_rejected", "invalid_response", "json_invalid", "response_shape_invalid", "token_missing", "ttl_type_invalid", "ttl_range_invalid", "business_rejected", "network_failed", "upgrade_http_rejected", "upgrade_invalid_response", "upgrade_failed", "closed", "transport_error", "protocol_error", "frame_backpressure", "heartbeat_timeout", "invalid_session", "hello_timeout", "ready_timeout", "failed"]);
function diagnosticRecord(stage, code, at, httpStatus, businessCode) {
    if (typeof stage !== "string" || typeof code !== "string" || !Object.hasOwn(CODES, stage) || !CODES[stage].includes(code) || !Number.isSafeInteger(at) || at < 0 || at > 864e13)
        return null;
    const record = { stage, code, at };
    if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599)
        record.httpStatus = httpStatus;
    if (stage === "token" && code === "business_rejected" && Number.isSafeInteger(businessCode) && businessCode !== 0 && Math.abs(businessCode) <= 99999999)
        record.businessCode = businessCode;
    return record;
}
function diagnosticSnapshot(value) {
    const result = { schemaVersion: 1, last: {} };
    for (const stage of Object.keys(CODES)) {
        const r = value?.last?.[stage], clean = r && diagnosticRecord(stage, r.code, r.at, r.httpStatus, r.businessCode);
        if (clean)
            result.last[stage] = clean;
    }
    for (const key2 of ["firstFailure", "lastFailure"]) {
        const r = value?.[key2], clean = r && diagnosticRecord(r.stage, r.code, r.at, r.httpStatus, r.businessCode);
        if (clean && FAILURE.has(clean.code))
            result[key2] = clean;
    }
    return result;
}
function appendDiagnostic(value, record) {
    const clean = record && diagnosticRecord(record.stage, record.code, record.at, record.httpStatus, record.businessCode);
    const result = diagnosticSnapshot(value);
    if (!clean)
        return result;
    result.last[clean.stage] = clean;
    if (FAILURE.has(clean.code)) {
        result.firstFailure ??= clean;
        result.lastFailure = clean;
    }
    return result;
}
function diagnosticTime(value) {
    return Number.isSafeInteger(value) && value >= 0 && value <= 864e13 ? value : null;
}
function connectionDiagnosticLines(status) {
    const startedAt = diagnosticTime(status?.connectionStartedAt), snapshot = diagnosticSnapshot(status?.connectionDiagnostics);
    const scope = (at) => startedAt === null ? "\u5F52\u5C5E\u672A\u786E\u8BA4" : at >= startedAt ? "\u672C\u8F6E" : "\u5386\u53F2";
    const when = (at) => new Date(at).toISOString();
    const lines = [startedAt === null ? "\u672C\u8F6E\u542F\u52A8\u65F6\u95F4\uFF1A\u672A\u8BB0\u5F55\uFF08\u65E7\u72B6\u6001\uFF09" : `\u672C\u8F6E\u542F\u52A8\u65F6\u95F4\uFF1A${when(startedAt)}`];
    for (const stage of Object.keys(CODES)) {
        const record = snapshot.last[stage];
        lines.push(record ? `${stage}\uFF1A${record.code}\uFF0C${when(record.at)}\uFF08${scope(record.at)}\uFF09` : `${stage}\uFF1A\u5C1A\u65E0\u8BB0\u5F55`);
    }
    const permission = status?.permissionEvidence;
    if (permission) {
        const labels = { missing: "尚未收到允许事件", invalid: "权限事件格式待核对", binding_changed: "权限记录属于旧绑定", permission_changed: "权限记录代次已变化", expired_local_evidence: "权限记录已超过本地验证窗口", session_changed: "权限记录属于旧会话", current: "已收到当前允许事件" };
        lines.push("权限记录：" + (labels[permission.status] ?? "待核对") + (permission.observedRevocation ? "；曾收到关闭或移除事件" : "") + (Number.isSafeInteger(permission.ageMs) ? "；距今 " + Math.floor(permission.ageMs / 1000) + " 秒" : ""));
    }
    const failure = snapshot.lastFailure;
    if (failure)
        lines.push(`${scope(failure.at)}\u6700\u8FD1\u5931\u8D25\uFF1A${failure.stage}/${failure.code}${failure.httpStatus === void 0 ? "" : `\uFF08HTTP ${failure.httpStatus}\uFF09`}\uFF0C${when(failure.at)}${failure.businessCode === void 0 ? "" : `\uFF1B\u4E1A\u52A1\u7801 ${failure.businessCode}`}\u3002\u5931\u8D25\u8BB0\u5F55\u4E0D\u4EE3\u8868\u5F53\u524D\u9636\u6BB5\u3002`);
    return lines;
}
var QQ_API_ORIGIN = "https://api.bot.qq.com";
var QQDurableLedger = class {
    storage;
    constructor(storage) {
        this.storage = storage;
    }
    reserve(key2, fingerprint, replySlot, gateKey) {
        return this.storage.transaction(async (tx) => {
            if (gateKey && await tx.get(gateKey))
                return { state: "blocked", reason: "permission_revoked" };
            const old = await tx.get(key2);
            if (old)
                return old.fingerprint === fingerprint ? old.receipt : { state: "blocked", reason: "idempotency_conflict" };
            if (replySlot && await tx.get(replySlot))
                return { state: "blocked", reason: "reply_sequence_used" };
            await tx.put(key2, { fingerprint, receipt: { state: "uncertain", reason: "reserved_before_send" } });
            if (replySlot)
                await tx.put(replySlot, true);
            return "new";
        });
    }
    async isRevoked(gateKey) {
        return this.storage.transaction(async (tx) => Boolean(await tx.get(gateKey)));
    }
    async finish(key2, fingerprint, receipt) {
        await this.storage.transaction(async (tx) => {
            const old = await tx.get(key2);
            if (!old || old.fingerprint !== fingerprint)
                throw Error("qq_ledger_conflict");
            await tx.put(key2, { fingerprint, receipt });
        });
    }
};
var text = (v, max = 256) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\r\n\0]/.test(v);
var blocked = (reason) => ({ state: "blocked", reason });
async function qqReadBytes(body, limit) {
    if (!body)
        throw Error("empty_body");
    const reader = body.getReader(), parts = [];
    let size = 0;
    try {
        while (true) {
            const r = await reader.read();
            if (r.done)
                break;
            size += r.value.length;
            if (size > limit)
                throw Error("body_too_large");
            parts.push(r.value);
        }
    }
    catch (e) {
        await reader.cancel().catch(() => {
        });
        throw e;
    }
    finally {
        reader.releaseLock();
    }
    const out = new Uint8Array(size);
    let p = 0;
    for (const part of parts) {
        out.set(part, p);
        p += part.length;
    }
    return out;
}
async function json(r) {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await qqReadBytes(r.body, 262144)));
}
async function qqHash(s) {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");
}
var QQC2CTransport = class {
    config;
    token;
    refreshing;
    ledger;
    transport;
    now;
    constructor(config, ledger, transport = fetch, now = Date.now) {
        this.ledger = ledger;
        this.transport = (input, init) => transport(input, init);
        this.now = now;
        this.config = { ...config, allowedSources: [...config.allowedSources], allowedProjects: [...config.allowedProjects], allowedImageOrigins: [...config.allowedImageOrigins] };
        if (!/^\d{1,32}$/.test(config.appId) || !/^[A-Za-z0-9_-]{1,256}$/.test(config.userOpenId) || !text(config.ownerId))
            throw Error("qq_invalid_config");
    }
    async accessToken() {
        if (this.token && this.token.expiresAt - this.now() > 6e4)
            return this.token.value;
        if (this.refreshing)
            return this.refreshing;
        this.refreshing = (async () => {
            const secret = this.config.appSecret();
            if (!text(secret, 1024))
                throw Error("qq_credentials_missing");
            const r = await this.transport(QQ_API_ORIGIN + "/app/getAppAccessToken", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: this.config.appId, clientSecret: secret }), redirect: "manual", signal: AbortSignal.timeout(1e4) });
            if (!r.ok)
                throw Error("qq_token_failed");
            const d = await json(r), seconds = Number(d?.expires_in);
            if (d?.code !== void 0 && d.code !== 0 || !text(d?.access_token, 8192) || !Number.isFinite(seconds) || seconds <= 0 || seconds > 7200)
                throw Error("qq_token_failed");
            this.token = { value: d.access_token, expiresAt: this.now() + seconds * 1e3 };
            return d.access_token;
        })();
        try {
            return await this.refreshing;
        }
        finally {
            this.refreshing = void 0;
        }
    }
    async post(path, payload) {
        const send = async (token2) => this.transport(QQ_API_ORIGIN + path, { method: "POST", headers: { Authorization: "QQBot " + token2, "content-type": "application/json", "X-Union-Appid": this.config.appId }, body: JSON.stringify(payload), redirect: "manual", signal: AbortSignal.timeout(15e3) });
        const token = await this.accessToken();
        let r = await send(token);
        if (r.status === 401) {
            await r.body?.cancel();
            if (this.token?.value === token)
                this.token = void 0;
            r = await send(await this.accessToken());
        }
        return r;
    }
    async send(intent) {
        try {
            intent = structuredClone(intent);
        }
        catch {
            return blocked("invalid_intent");
        }
        const c = this.config, now = this.now();
        if (c.enabled !== true)
            return blocked("disabled");
        if (!intent || intent.ownerId !== c.ownerId || !c.allowedSources.includes(intent.sourceId) || !c.allowedProjects.includes(intent.projectId))
            return blocked("binding_not_authorized");
        if (!text(intent.eventId) || !text(intent.sourceId) || !text(intent.projectId) || typeof intent.content !== "string" || intent.content.length > 4e3 || !intent.content.trim() && !intent.image)
            return blocked("invalid_intent");
        let e;
        try {
            e = c.evidence();
        }
        catch {
            return blocked("evidence_unavailable");
        }
        if (!e || !Number.isFinite(e.checkedAt) || !Number.isFinite(e.validUntil) || e.checkedAt > now || e.validUntil <= now || e.checkedAt >= e.validUntil)
            return blocked("evidence_expired");
        if (e.identity !== true)
            return blocked("identity_unverified");
        if (intent.reply) {
            const r = intent.reply;
            if (e.reply !== true || !text(r.messageId) || !Number.isFinite(r.validUntil) || r.validUntil <= now || !Number.isSafeInteger(r.sequence) || r.sequence < 1 || r.sequence > 4)
                return blocked("reply_unverified");
        }
        else if (e.proactive !== true)
            return blocked("proactive_unverified");
        let imageUrl;
        if (intent.image) {
            if (e.image !== true)
                return blocked("image_unverified");
            try {
                const u = new URL(intent.image.url);
                if (u.protocol !== "https:" || u.username || u.password || u.hash || !c.allowedImageOrigins.includes(u.origin))
                    return blocked("image_origin_not_authorized");
                imageUrl = u.href;
            }
            catch {
                return blocked("invalid_image");
            }
        }
        const gateKey = await qqGateKey(c.appId, c.userOpenId);
        const key2 = "qq:out:" + await qqHash(JSON.stringify([c.ownerId, c.appId, c.userOpenId, intent.sourceId, intent.projectId, intent.eventId]));
        const fingerprint = await qqHash(JSON.stringify([intent.content, imageUrl ?? null, intent.reply ?? null]));
        const replySlot = intent.reply ? "qq:reply:" + await qqHash(JSON.stringify([c.appId, c.userOpenId, intent.reply.messageId, intent.reply.sequence])) : void 0;
        let reserved;
        try {
            reserved = await this.ledger.reserve(key2, fingerprint, replySlot, gateKey);
        }
        catch {
            return blocked("ledger_unavailable");
        }
        if (reserved !== "new")
            return reserved;
        let receipt = { state: "not_sent", reason: "preflight_failed" };
        let sending = false;
        try {
            await this.accessToken();
            const payload = { msg_type: 0, content: intent.content };
            if (intent.reply) {
                payload.msg_id = intent.reply.messageId;
                payload.msg_seq = intent.reply.sequence;
            }
            const path = "/v2/users/" + encodeURIComponent(c.userOpenId);
            if (imageUrl) {
                const upload = await this.post(path + "/files", { file_type: 1, url: imageUrl, srv_send_msg: false });
                const d2 = await json(upload);
                if (!upload.ok || d2?.code !== void 0 && d2.code !== 0 || !text(d2?.file_info, 65536) || !Number.isFinite(d2.ttl) || d2.ttl < 0)
                    throw Error("qq_upload_failed");
                payload.msg_type = 7;
                payload.media = { file_info: d2.file_info };
            }
            const latest = c.evidence();
            if (!latest || !Number.isFinite(latest.checkedAt) || !Number.isFinite(latest.validUntil) || latest.checkedAt > this.now() || latest.checkedAt >= latest.validUntil || latest.validUntil <= this.now() || latest.identity !== true || !intent.reply && latest.proactive !== true || intent.reply && (latest.reply !== true || intent.reply.validUntil <= this.now()) || imageUrl && latest.image !== true)
                throw Error("qq_evidence_changed");
            if (await this.ledger.isRevoked(gateKey))
                throw Error("qq_permission_revoked");
            const token = await this.accessToken();
            const sendMessage = () => {
                sending = true;
                return this.transport(QQ_API_ORIGIN + path + "/messages", { method: "POST", headers: { Authorization: "QQBot " + token, "content-type": "application/json", "X-Union-Appid": c.appId }, body: JSON.stringify(payload), redirect: "manual", signal: AbortSignal.timeout(15e3) });
            };
            const dispatched = typeof c.dispatchMessage === "function"
                ? await c.dispatchMessage(sendMessage)
                : { response: Promise.resolve(sendMessage()).then(value => ({ value }), () => ({ networkError: true })) };
            const outcome = await dispatched.response;
            if (outcome.networkError)
                throw Error("qq_message_network_unknown");
            const r = outcome.value;
            let d;
            try {
                d = await json(r);
            }
            catch {
                d = null;
            }
            const code = Number.isSafeInteger(d?.code) ? d.code : void 0;
            if (r.ok && (d?.code === void 0 || d.code === 0) && text(d?.id, 1024))
                receipt = { state: "sent", reason: "provider_accepted", messageId: d.id };
            else if (r.status === 401 || r.status === 403 || r.status === 429 || knownRejections.has(code ?? -1))
                receipt = { state: "not_sent", reason: qqRejectionReason(r.status, code), ...code !== void 0 ? { providerCode: code } : {}, ...r.status === 429 && /^\d+$/.test(r.headers.get("retry-after") ?? "") ? { retryAfterSeconds: Number(r.headers.get("retry-after")) } : {} };
            else
                receipt = { state: "uncertain", reason: "provider_outcome_unknown", ...code !== void 0 ? { providerCode: code } : {} };
        }
        catch {
            receipt = { state: sending ? "uncertain" : "not_sent", reason: sending ? "network_outcome_unknown" : "preflight_failed" };
        }
        try {
            await this.ledger.finish(key2, fingerprint, receipt);
        }
        catch {
            return { state: "uncertain", reason: "receipt_persistence_failed" };
        }
        return receipt;
    }
};
var knownRejections = new Set([22006, 50059, 304004, 304061, 304062, 304064, 304080, 304103, 40034005, 40034006, 40034008, 40034009, 40034010, 40034011, 40034024, 40034025, 40034026, 40034027, 40034029, 40034100, 40034105, 40034106, 40034108, 40034109, 40034122, 40034123, 40034124, 40034127, 40034128, 40054004, 40054007, 40054013, 40054016, 40054018]);
function qqRejectionReason(status, code) {
    if (status === 429 || code === 40034100)
        return "rate_limited";
    if (!Number.isSafeInteger(code))
        return "provider_rejected";
    return { 40034105: "proactive_permission_denied", 40054004: "friendship_missing", 40054013: "recipient_refused", 40054016: "bot_offline" }[code] ?? "provider_rejected";
}
function qqBridgeRejectedReceipt(result) {
    const reason = Number.isSafeInteger(result?.providerCode) ? qqRejectionReason(0, result.providerCode) : "provider_rejected";
    if (result.state === "not_sent" && reason !== "provider_rejected" && result.reason === reason) {
        return { state: "not_sent", reason, providerCode: result.providerCode };
    }
    return { state: result.state, reason: "provider_rejected" };
}
async function qqGateKey(appId, userOpenId) {
    return "qq:gate:" + await qqHash(JSON.stringify([appId, userOpenId]));
}
var PROOF_TEXT = "Rivule QQ \u8FDE\u63A5\u6D4B\u8BD5\uFF0C\u4E0D\u4EE3\u8868\u771F\u5B9E\u9879\u76EE\u8FDB\u5EA6";
var FRESH = 3e5;
function proofReply(state, now) {
    const candidates = [state.binding?.replyMessage, ...state.inbox ?? []].filter((x) => x && typeof x.messageId === "string" && x.messageId.length > 0 && x.messageId.length <= 1024 && Number.isFinite(x.eventAt) && x.eventAt <= now && now - x.eventAt < FRESH);
    return candidates.sort((a, b) => b.eventAt - a.eventAt)[0] ?? null;
}
function eligible(actor, state) {
    const c = actor.config();
    return actor.env.QQ_PROOF_ENABLED === "true" && state.control?.running === true && actor.runtime?.client.ready === true && !actor.store.qqIngestionFault && state.qqIngestionHealth?.healthy === true && state.qqRevoked !== true && state.binding?.appId === c.appId && state.binding?.ownerId === c.ownerId && typeof state.binding?.userOpenId === "string" && !!state.binding.userOpenId;
}
async function fixedReplyProof(actor) {
    const reserved = await actor.command(async () => {
        const budget = await actor.accountBudget();
        if (budget.exhausted) {
            await actor.stopInternal("active_budget_exhausted");
            return { receipt: { state: "blocked", reason: "budget_exhausted" } };
        }
        return actor.store.transaction((s) => {
            if (s.qqProof)
                return { receipt: s.qqProof.receipt };
            if (!eligible(actor, s))
                return { receipt: { state: "blocked", reason: "proof_not_eligible" } };
            const reply2 = proofReply(s, actor.now());
            if (!reply2)
                return { receipt: { state: "blocked", reason: "fresh_owner_message_required" } };
            s.qqProof = { kind: "one_shot_reply_test", reservedAt: actor.now(), messageId: reply2.messageId, eventAt: reply2.eventAt, userOpenId: s.binding.userOpenId, receipt: { state: "uncertain", reason: "reserved_before_send" } };
            return { proof: structuredClone(s.qqProof) };
        });
    });
    if (reserved.receipt)
        return reserved.receipt;
    let result = { state: "not_sent", reason: "preflight_failed" }, attempted = false;
    try {
        const token = await actor.runtime.client.tokenValue();
        const permitted = await actor.command(async () => {
            const budget = await actor.accountBudget();
            if (budget.exhausted) {
                await actor.stopInternal("active_budget_exhausted");
                return false;
            }
            return actor.store.transaction((s) => eligible(actor, s) && s.binding.userOpenId === reserved.proof.userOpenId && actor.now() - reserved.proof.eventAt < FRESH && reserved.proof.eventAt <= actor.now());
        });
        if (!permitted)
            result = { state: "not_sent", reason: "permission_changed" };
        else {
            attempted = true;
            const network = actor.network;
            const response = await network("https://api.bot.qq.com/v2/users/" + encodeURIComponent(reserved.proof.userOpenId) + "/messages", { method: "POST", redirect: "manual", signal: AbortSignal.timeout(1e4), headers: { Authorization: "QQBot " + token, "content-type": "application/json" }, body: JSON.stringify({ msg_type: 0, content: PROOF_TEXT, msg_id: reserved.proof.messageId, msg_seq: 1 }) });
            let data;
            try {
                data = JSON.parse(new TextDecoder().decode(await qqReadBytes(response.body, 65536)));
            }
            catch {
            }
            if (response.ok && (data?.err_code === void 0 || data.err_code === 0) && (data?.code === void 0 || data.code === 0) && typeof data?.id === "string" && data.id.length > 0 && data.id.length <= 1024)
                result = { state: "sent", reason: "reply_provider_accepted", messageId: data.id };
            else if ([401, 403, 429].includes(response.status))
                result = { state: "not_sent", reason: "provider_rejected" };
            else
                result = { state: "uncertain", reason: "provider_outcome_unknown" };
        }
    }
    catch {
        result = { state: attempted ? "uncertain" : "not_sent", reason: attempted ? "network_outcome_unknown" : "preflight_failed" };
    }
    try {
        await actor.store.transaction((s) => {
            s.qqProof.receipt = result;
        });
    }
    catch {
        return { state: "uncertain", reason: "receipt_persistence_failed" };
    }
    return result;
}
var ACTIVE_PROBE_ID = "qq-active-fixed-v1";
var ACTIVE_PROBE_TEXT = "Rivule 主动通知测试：主动消息通道验证。";
var ACTIVE_PROBE_FRESH_MS = 300000;
var RUNTIME_SESSION_EXPIRY = Number.MAX_SAFE_INTEGER;
function runtimeBudgetPolicy(state, fallback) {
    const p = state.qqRuntimeBudgetPolicy;
    if (p === undefined) {
        if (!Number.isSafeInteger(fallback) || fallback < 60000 || fallback > 86400000)
            throw Error("runtime_budget_policy_invalid");
        return { version: 1, mode: "warn", limitMs: fallback, revision: 0 };
    }
    if (!p || p.version !== 1 || !["warn", "stop"].includes(p.mode) || !Number.isSafeInteger(p.limitMs) || p.limitMs < 60000 || p.limitMs > 86400000 || !Number.isSafeInteger(p.revision) || p.revision < 1)
        throw Error("runtime_budget_policy_invalid");
    return p;
}
function runtimeBudgetView(state, fallback, now) {
    const p = runtimeBudgetPolicy(state, fallback);
    const b = setupBudgetView({ budget: state.activeBudget, running: state.control?.running }, p.limitMs, now);
    if (!b)
        throw Error("runtime_budget_ledger_invalid");
    return { ...b, mode: p.mode, revision: p.revision, warningReached: b.exhausted, exhausted: p.mode === "stop" && b.exhausted,
        availableMs: p.mode === "stop" ? b.remainingMs : RUNTIME_SESSION_EXPIRY - now };
}
var authenticatedGatewayDispatches = new WeakSet();
async function dispatchAuthenticatedGatewayEvent(client, event, phase = "live") {
    const auth = { session: client.session, generation: client.generation, phase };
    authenticatedGatewayDispatches.add(auth);
    try {
        return await client.onDispatch(event, auth);
    }
    finally {
        authenticatedGatewayDispatches.delete(auth);
    }
}
async function activeBindingFingerprint(binding) {
    if (!binding || !/^\d{1,32}$/.test(binding.appId) || !valid(binding.ownerId) || !valid(binding.userOpenId) || !Number.isSafeInteger(binding.confirmedAt) || binding.confirmedAt < 0)
        return null;
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
    if (b?.appId !== appId || b?.ownerId !== ownerId || ![d?.openid, d?.user_openid].includes(b.userOpenId))
        return;
    const revoked = ["FRIEND_DEL", "C2C_MSG_REJECT"].includes(event.t);
    const trusted = authenticatedGatewayDispatches.has(auth) && auth.phase === "live" && auth.session === client.session && auth.generation === client.generation && !client.stopped && typeof auth.session === "string" && !!auth.session && event.op === 0 && Number.isSafeInteger(event.s) && event.s >= 0;
    if (!revoked && !trusted)
        return;
    if (event.t === "FRIEND_ADD")
        return;
    const at = Number.isSafeInteger(d?.timestamp) && d.timestamp >= 0 && d.timestamp <= 8640000000000 ? d.timestamp * 1000 : null;
    const fingerprint = await activeBindingFingerprint(b);
    const p = permissionHistory(state, now);
    const eventKey = await qqHash(JSON.stringify(text(event.id, 1024) ? [fingerprint, event.t, "provider_id", event.id] : [fingerprint, event.t, "timestamp", at, at === null ? [auth?.session ?? null, event.s ?? null] : null]));
    if (p.seen[eventKey])
        return;
    if (Object.keys(p.seen).length >= 1024 || revoked && p.history.length >= 128) {
        if (revoked)
            state.qqRevoked = true;
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
    if (event.t !== "C2C_MSG_RECEIVE" || d.openid !== b.userOpenId || !fingerprint || at === null || at > now || now - at >= ACTIVE_PROBE_FRESH_MS || at < b.confirmedAt || store.qqIngestionFault || state.qqIngestionHealth?.healthy !== true || state.control?.running !== true)
        return;
    const last = p.history.at(-1);
    if (last && (at <= last.recordedAt || last.eventAt !== null && Number.isFinite(last.eventAt) && at <= last.eventAt))
        return;
    p.renewal = { kind: "authenticated_C2C_MSG_RECEIVE", eventKey, eventAt: at, receivedAt: now, bindingFingerprint: fingerprint, confirmedAt: b.confirmedAt, revision: p.revision, sessionFingerprint: await qqHash(auth.session), sequence: event.s };
}
async function activeProbeEligibility(actor, state, expected) {
    const c = actor.config(), now = actor.now(), binding = state.binding;
    let budget;
    try {
        budget = runtimeBudgetView(state, c.budget, now);
    }
    catch {
        return { reason: "active_probe_budget_configuration_changed" };
    }
    if (budget.exhausted)
        return { reason: "budget_exhausted" };
    if (actor.env.QQ_DELIVERY_ENABLED !== "false")
        return { reason: "active_probe_delivery_must_remain_disabled" };
    if (state.control?.running !== true || actor.runtime?.client.ready !== true || actor.store.qqIngestionFault || state.qqIngestionHealth?.healthy !== true)
        return { reason: "active_probe_connection_not_healthy" };
    const fingerprint = await activeBindingFingerprint(binding);
    if (!fingerprint || binding.appId !== c.appId || binding.ownerId !== c.ownerId || binding.confirmedAt > now)
        return { reason: "active_probe_binding_unverified" };
    if (expected && (expected.probeId !== ACTIVE_PROBE_ID || expected.bindingFingerprint !== fingerprint || expected.confirmedAt !== binding.confirmedAt))
        return { reason: "active_probe_binding_changed" };
    const revision = state.qqActivePermission?.revision ?? 0;
    let renewalEventKey = null;
    if (state.qqRevoked === true) {
        const renewal = state.qqActivePermission?.renewal;
        if (!renewal || renewal.kind !== "authenticated_C2C_MSG_RECEIVE" || renewal.bindingFingerprint !== fingerprint || renewal.confirmedAt !== binding.confirmedAt || renewal.revision !== revision || renewal.eventAt > now || now - renewal.eventAt >= ACTIVE_PROBE_FRESH_MS || renewal.receivedAt > now || renewal.eventAt < binding.confirmedAt)
            return { reason: "active_probe_fresh_qq_permission_required" };
        renewalEventKey = renewal.eventKey;
    }
    if (expected && (expected.permissionRevision !== revision || expected.renewalEventKey !== renewalEventKey))
        return { reason: "active_probe_permission_changed" };
    return { bindingFingerprint: fingerprint, confirmedAt: binding.confirmedAt, probeId: ACTIVE_PROBE_ID, permissionRevision: revision, renewalEventKey };
}
async function activeProbePanel(actor, state) {
    permissionHistory(state, actor.now());
    const eligible = await activeProbeEligibility(actor, state);
    const fingerprint = await activeBindingFingerprint(state.binding);
    const observation = state.qqActiveObservedCapability;
    if (observation && (observation.bindingFingerprint !== fingerprint || observation.validUntil <= actor.now()))
        delete state.qqActiveObservedCapability;
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
                if (permission.reason)
                    return { receipt: blocked(permission.reason) };
                const old = s.qqActiveProbes?.[permission.bindingFingerprint]?.[ACTIVE_PROBE_ID];
                if (old)
                    return { receipt: old.receipt };
                s.qqActiveProbes ??= {};
                if (Object.keys(s.qqActiveProbes).length >= 64)
                    return { receipt: blocked("active_probe_history_capacity") };
                const probe = { ...permission, kind: "one_shot_active_test", interactionId, reservedAt: actor.now(), userOpenId: s.binding.userOpenId, receipt: { state: "uncertain", reason: "reserved_before_send" } };
                s.qqActiveProbes[permission.bindingFingerprint] = { [ACTIVE_PROBE_ID]: probe };
                return { probe: structuredClone(probe) };
            });
        });
    }
    catch {
        return blocked("active_probe_reservation_unavailable");
    }
    if (reserved.receipt)
        return reserved.receipt;
    const probe = reserved.probe;
    let result = { state: "not_sent", reason: "preflight_failed" }, attempted = false;
    try {
        const token = await actor.runtime.client.tokenValue();
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
            if (gate.reason)
                return gate;
            attempted = true;
            const network = actor.network;
            const response = network(QQ_API_ORIGIN + "/v2/users/" + encodeURIComponent(probe.userOpenId) + "/messages", { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000), headers: { Authorization: "QQBot " + token, "content-type": "application/json", "X-Union-Appid": actor.config().appId }, body: JSON.stringify({ msg_type: 0, content: ACTIVE_PROBE_TEXT }) });
            return { response: Promise.resolve(response).then(value => ({ value }), () => ({ networkError: true })) };
        });
        if (dispatch.reason)
            result = { state: "not_sent", reason: dispatch.reason };
        else {
            const outcome = await dispatch.response;
            if (outcome.networkError)
                result = { state: "uncertain", reason: "network_outcome_unknown" };
            else {
                const response = outcome.value;
                let data;
                try {
                    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await qqReadBytes(response.body, 65536)));
                }
                catch {
                }
                const providerCode = Number.isSafeInteger(data?.code) && data.code !== 0 ? data.code : Number.isSafeInteger(data?.err_code) && data.err_code !== 0 ? data.err_code : void 0;
                if (response.ok && (data?.code === void 0 || data.code === 0) && (data?.err_code === void 0 || data.err_code === 0) && text(data?.id, 1024))
                    result = { state: "sent", reason: "provider_accepted", messageId: data.id };
                else if ([401, 403, 429].includes(response.status) || knownRejections.has(providerCode))
                    result = { state: "not_sent", reason: qqRejectionReason(response.status, providerCode), ...providerCode === void 0 ? {} : { providerCode } };
                else
                    result = { state: "uncertain", reason: "provider_outcome_unknown" };
            }
        }
    }
    catch {
        result = { state: attempted ? "uncertain" : "not_sent", reason: attempted ? "network_outcome_unknown" : "preflight_failed" };
    }
    try {
        await actor.command(() => actor.store.transaction(async (s) => {
            const record = s.qqActiveProbes?.[probe.bindingFingerprint]?.[ACTIVE_PROBE_ID];
            if (!record || record.interactionId !== probe.interactionId)
                throw Error("active_probe_receipt_conflict");
            record.receipt = result;
            record.completedAt = actor.now();
            const current = await activeProbeEligibility(actor, s, probe);
            if (result.reason === "provider_accepted" && !current.reason) {
                s.qqActiveObservedCapability = { schemaVersion: 1, kind: "isolated_active_probe_observation", bindingFingerprint: probe.bindingFingerprint, confirmedAt: probe.confirmedAt, appId: s.binding.appId, ownerId: s.binding.ownerId, recipientFingerprint: await qqHash(s.binding.userOpenId), checkedAt: actor.now(), validUntil: actor.now() + ACTIVE_PROBE_FRESH_MS, probeId: ACTIVE_PROBE_ID, permissionRevision: probe.permissionRevision, renewalEventKey: probe.renewalEventKey, receipt: structuredClone(result) };
            }
        }));
    }
    catch {
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
    if (receipt.state === "sent" && receipt.reason === "provider_accepted")
        return "已提交 QQ";
    if (receipt.state === "uncertain")
        return "待确认";
    return "发送失败 · " + activeProbeHumanReason(receipt.reason);
}
function setupBudgetView(status, limit, now) {
    const b = status?.budget, day = Math.floor(now / 86400000);
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 1000 || limit > 86400000 || !b || !Number.isSafeInteger(b.day) || b.day < 0 || b.day > day || !Number.isFinite(b.usedMs) || b.usedMs < 0 || !Number.isFinite(b.lastAt) || b.lastAt < 0 || b.lastAt > now)
        return null;
    const usedMs = b.day === day ? b.usedMs + (status.running === true ? Math.max(0, now - b.lastAt) : 0) : status.running === true ? Math.max(0, now % 86400000) : 0;
    if (!Number.isFinite(usedMs))
        return null;
    return { usedMs, remainingMs: Math.max(0, limit - usedMs), limitMs: limit, exhausted: usedMs >= limit };
}
function setupMinutes(ms) {
    return ms > 0 && ms < 60000 ? "不足 1 分钟" : `${Math.floor(ms / 60000)} 分钟`;
}
function setupBudgetBar(budget) {
    const filled = Math.max(0, Math.min(10, Math.floor(budget.usedMs / budget.limitMs * 10)));
    return "■".repeat(filled) + "□".repeat(10 - filled);
}
function setupSafeText(value, max = 100) {
    return Array.from(String(value ?? "").replace(/[\r\n\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ")).slice(0, max).join("").replace(/([\\`*_{}\[\]()<>~|])/g, "\\$1");
}
function setupProofReceipt(receipt) {
    if (receipt?.state === "sent" && receipt.reason === "reply_provider_accepted")
        return "已提交 QQ";
    if (receipt?.state === "uncertain")
        return "待确认，请到 QQ 查看";
    return "未完成，请查看诊断";
}
function setupStageView(status, active, budget) {
    const healthy = status.running && status.connected && status.ingestionHealthy && !status.ingestionFault;
    const connection = healthy ? "✓ 连接" : status.running && !status.connected ? "◌ 连接中" : status.running ? "⚠ 连接异常" : "○ 连接已停止";
    const binding = status.pendingPairing ? "◌ 待确认绑定" : status.bound ? "✓ 已绑定" : "○ 待绑定";
    const receipt = active.receipt;
    const probe = receipt?.state === "sent" && receipt.reason === "provider_accepted" ? "✓ 已提交 QQ" : receipt?.state === "uncertain" ? "◌ 测试待确认" : receipt ? "⚠ 测试未完成" : active.eligible ? "○ 待主动测试" : "○ 待主动测试";
    let heading, next;
    if (budget?.exhausted) {
        heading = "已达到你设置的暂停时长";
        next = "在「运行预算」调整时长或改为仅提醒，再点「启动连接」。";
    }
    else if (!status.running) {
        heading = "连接已停止";
        next = "点「启动连接」，继续设置。";
    }
    else if (!status.connected) {
        heading = "正在连接 QQ";
        next = "稍等片刻，点「刷新状态」查看连接结果。";
    }
    else if (!healthy) {
        heading = "连接需要检查";
        next = "点「查看诊断」查看当前问题。";
    }
    else if (status.pendingPairing) {
        heading = "确认你的 QQ 账户";
        next = "点「核对绑定账户」，核对后确认。";
    }
    else if (!status.bound) {
        heading = "QQ 已连接，等待绑定";
        next = "点「生成绑定口令」，在 QQ 私聊机器人完成绑定。";
    }
    else if (active.eligible) {
        heading = "可以发送一次主动测试";
        next = "点「发送一次主动测试」，然后到 QQ 查看。";
    }
    else if (receipt?.state === "sent" && receipt.reason === "provider_accepted") {
        heading = "主动测试已提交 QQ";
        next = "持续推送正在完善，可先到 QQ 查看测试消息。";
    }
    else if (receipt?.state === "uncertain") {
        heading = "主动测试结果待确认";
        next = "先到 QQ 查看；需要排查时点「查看诊断」。不会自动重发。";
    }
    else if (receipt) {
        heading = "主动测试未完成";
        next = activeProbeHumanReason(receipt.reason) + "；需要排查时点「查看诊断」。不会自动重发。";
    }
    else if (active.reason === "active_probe_fresh_qq_permission_required") {
        heading = "等待 QQ 主动消息权限";
        next = "请在 QQ 机器人资料卡重新开启主动消息，然后点「刷新状态」。";
    }
    else {
        heading = "主动测试暂不可用";
        next = activeProbeHumanReason(active.reason) + "。";
    }
    return { healthy, stages: `${connection} → ${binding} → ${probe}`, heading, next };
}
function setupPanelText({ status, proof, active, budget, notice = "", diagnostics = false, reviewBinding = false, deliveryEnabled }) {
    if (reviewBinding) {
        return ["**Rivule · QQ 确认绑定**", "", status.pendingPairing ? `候选 QQ OpenID：${setupSafeText(status.pendingPairing.userOpenId, 128)}` : "当前没有待确认的候选账户。", "", status.pendingPairing ? "核对这是你刚发送绑定口令的 QQ 账户，再点「确认此候选」。" : "点「返回设置」继续。"].join("\n");
    }
    if (diagnostics) {
        const lines = ["**Rivule · QQ 诊断**", "连接记录 · 时间均为 UTC", "", ...connectionDiagnosticLines(status)];
        if (proof.receipt)
            lines.push(`回复测试：${setupSafeText(proof.receipt.state)} · ${setupSafeText(proof.receipt.reason)}`);
        if (active.receipt)
            lines.push(`主动测试：${setupSafeText(active.receipt.state)} · ${setupSafeText(active.receipt.reason)}`);
        else if (active.reason)
            lines.push(`主动测试检查：${setupSafeText(active.reason)}`);
        lines.push("", "历史失败不代表当前连接状态。点「返回设置」查看现在的阶段。");
        return lines.join("\n");
    }
    const view = setupStageView(status, active, budget);
    if (view.healthy && status.bound && !status.pendingPairing && active.receipt?.state === "sent" && active.receipt.reason === "provider_accepted") {
        view.next = deliveryEnabled === "true" ? "点「持续通知」，查看本轮状态；尚未开启时点「验证并开启本轮通知」。" : "主动测试已提交 QQ。持续通知配置尚未开启。";
    }
    const lines = ["**Rivule · QQ 设置**", `-# ${view.stages}`, "", `**${view.heading}**`, `下一步：${view.next}`];
    if (notice)
        lines.push("", notice);
    if (active.receipt && view.heading !== "主动测试已提交 QQ" && notice !== `主动测试：${activeProbeHumanReceipt(active.receipt)}`)
        lines.push(`主动测试：${activeProbeHumanReceipt(active.receipt)}`);
    if (active.eligible)
        lines.push("", `测试内容：${ACTIVE_PROBE_TEXT}`, "仅测试一次，失败不自动重发。");
    if (budget)
        lines.push("", `-# 今日连接已用 ${setupMinutes(budget.usedMs)} · ${budget.mode === "stop" ? "到点暂停" : "仅提醒，不暂停"} · 阈值 ${setupMinutes(budget.limitMs)}`, budget.warningReached ? (budget.exhausted ? "⚠ 已达到你设置的暂停时长。" : "⚠ 已达到你设置的提醒时长，连接可以继续。") : "-# 可在「运行预算」自行调整；每日 00:00 UTC 重新计时", "-# 连接时长不等于 Cloudflare 账单额度；实际额度尚未接入。");
    lines.push("", `-# 通知自动推送：${deliveryEnabled === "true" ? "配置已开启" : deliveryEnabled === "false" ? "未开启" : "配置待检查"}`);
    return lines.join("\n");
}
function setupControlSpecs({ status, proof, active, budget, diagnostics = false, reviewBinding = false }) {
    if (reviewBinding)
        return status.pendingPairing ? [["confirm", "确认此候选"], ["status", "返回设置"]] : [["status", "返回设置"]];
    if (diagnostics)
        return [["status", "返回设置"]];
    const specs = [];
    if (!status.running && !budget?.exhausted)
        specs.push(["start", "启动连接"]);
    if (status.connected && !status.bound && !status.pendingPairing)
        specs.push(["pair", "生成绑定口令"]);
    if (status.pendingPairing)
        specs.push(["review_binding", "核对绑定账户"]);
    if (active.eligible)
        specs.push(["active_probe", "发送一次主动测试"]);
    specs.push(["status", status.pendingPairing ? "刷新候选" : "刷新状态"], ["diagnostics", "查看诊断"], ["budget_settings", "运行预算"]);
    if (status.bound && status.connected && status.ingestionHealthy && !status.revoked && proof.eligible)
        specs.push(["proof", "发送一次固定回复测试"]);
    if (status.running)
        specs.push(["stop", "停止连接"]);
    return specs;
}
function runtimeBudgetPanel(b) {
    return ["**Rivule · 运行预算**", "", `当前：${b.mode === "stop" ? "到点暂停" : "仅提醒，不暂停"}`,
        `每日阈值：${setupMinutes(b.limitMs)} · 今天已用 ${setupMinutes(b.usedMs)}`,
        b.warningReached ? (b.exhausted ? "⚠ 已达到暂停时长。" : "⚠ 已达到提醒时长，连接仍可继续。") : "尚未达到你设置的时长。",
        "", "默认只提醒。你可以调整时长，或选择到点暂停。修改不会清零已用时长，也不会自动启动连接或发送消息。",
        "这是 Rivule 的连接时长，不是 Cloudflare 的实际账单额度。实际额度尚未接入，请在 Cloudflare 控制台查看。",
        "不会修改套餐、消费上限或平台配额。每日 00:00 UTC 重新计时。"].join("\n");
}
var PREFIX = "qqsetup:";
var reply = (content, components = []) => ({ type: 4, data: { content, components, flags: 64, allowed_mentions: { parse: [] } } });
async function ownerSetup(actor, p) {
    const env = actor.env;
    if (env.QQ_SETUP_ENABLED !== "true")
        return reply("QQ \u8BBE\u7F6E\u5C1A\u672A\u542F\u7528");
    const user = p.user ?? p.member?.user;
    if (p.type !== 3 || p.application_id !== env.APPLICATION_ID || user?.id !== env.OWNER_DISCORD_ID || user?.bot === true || p.context !== 1 || p.channel_id !== env.DM_CHANNEL_ID || p.guild_id || p.message?.author?.id !== env.APPLICATION_ID || p.data?.component_type !== 2)
        throw Error("owner_setup_identity_required");
    const install = p.authorizing_integration_owners;
    if (!/^\d{1,25}$/.test(p.id ?? "") || !install || !(install["0"] === "0" || install["1"] === env.OWNER_DISCORD_ID) || Object.keys(install).some((k) => !["0", "1"].includes(k)))
        throw Error("owner_setup_install_required");
    const ref = p.data?.custom_id;
    if (typeof ref !== "string" || !ref.startsWith(PREFIX))
        throw Error("invalid_setup_control");
    const action = await actor.store.transaction((s) => {
        s.adminSeen ??= {};
        s.adminControls ??= {};
        const now = actor.now();
        for (const [id2, until] of Object.entries(s.adminSeen))
            if (until < now)
                delete s.adminSeen[id2];
        for (const [id2, c2] of Object.entries(s.adminControls))
            if (c2.expires < now)
                delete s.adminControls[id2];
        if (s.adminSeen[p.id])
            return null;
        if (Object.keys(s.adminSeen).length >= 1e3)
            throw Error("setup_replay_capacity");
        s.adminSeen[p.id] = now + 6e5;
        if (ref === PREFIX + "open")
            return { action: "status" };
        const c = s.adminControls[ref];
        if (!c || c.expires <= now)
            throw Error("setup_control_expired");
        s.adminControls = {};
        return c;
    });
    if (!action)
        return reply("\u6B64\u64CD\u4F5C\u5DF2\u7ECF\u5904\u7406\uFF1B\u8BF7\u91CD\u65B0\u6253\u5F00 QQ \u8BBE\u7F6E\u67E5\u770B\u72B6\u6001");
    let text2 = "";
    if (action.action === "start") {
        const r = await actor.requestStart();
        text2 = "连接请求已提交，正在等待 QQ 就绪。";
    }
    else if (action.action === "pair") {
        const r = await actor.beginBinding();
        text2 = `请在 5 分钟内私聊 QQ 机器人发送：/bind ${r.code}
随后刷新本面板，核对候选账户后确认。请勿转发此口令。`;
    }
    else if (action.action === "confirm") {
        await actor.confirmBinding(action.confirmationId);
        text2 = "\u5DF2\u786E\u8BA4\u7ED1\u5B9A\uFF1B\u901A\u77E5\u5F00\u5173\u4FDD\u6301\u539F\u914D\u7F6E\u3002";
    }
    else if (action.action === "proof") {
        const r = await fixedReplyProof(actor);
        text2 = `回复测试：${setupProofReceipt(r)}。不会自动重试。`;
    }
    else if (action.action === "active_probe") {
        const pending = fixedActiveProbe(actor, action, p.id);
        actor.ctx.waitUntil(pending.catch(() => { }));
        const r = await pending;
        text2 = `主动测试：${activeProbeHumanReceipt(r)}`;
    }
    else if (action.action === "stop") {
        await actor.stop();
        text2 = "\u5DF2\u505C\u6B62 QQ \u8FDE\u63A5\u3002";
    }
    else if (action.action === 'continuous_enable') {
        const pending = enableContinuousFromControl(actor, action, p.id);
        actor.ctx.waitUntil(pending.catch(() => { }));
        text2 = await pending;
    }
    else if (action.action === 'continuous_review') {
        text2 = await reviewContinuousOutcome(actor, action, p.id);
    }
    else if (action.action === 'continuous_pause') {
        await (await continuousController(actor)).pause('owner_paused');
        text2 = '持续通知已暂停。';
    }
    else if (["budget_warn", "budget_stop", "budget_less", "budget_more", "budget_reset"].includes(action.action)) {
        await actor.updateRuntimeBudget(action);
        text2 = "运行预算已保存。不会修改 Cloudflare 套餐或扣费设置；通知需按当前会话重新开启。";
    }
    else if (!["status", "diagnostics", "review_binding", "continuous_settings", "budget_settings"].includes(action.action))
        throw Error("unknown_setup_action");
    const status = await actor.status();
    status.ingestionFault = actor.store.qqIngestionFault === true;
    const proof = await actor.store.transaction((s) => ({ receipt: s.qqProof?.receipt, eligible: actor.env.QQ_PROOF_ENABLED === "true" && !s.qqProof && !!proofReply(s, actor.now()) }));
    const active = await actor.store.transaction((s) => activeProbePanel(actor, s));
    const budget = status.runtimeBudget;
    const panel = { status, proof, active, budget, notice: text2, diagnostics: action.action === "diagnostics", reviewBinding: action.action === "review_binding", deliveryEnabled: actor.env.QQ_DELIVERY_ENABLED };
    const continuous = ['continuous_settings', 'continuous_enable', 'continuous_pause', 'continuous_review'].includes(action.action) ? await continuousPanel(actor) : null;
    const budgetPanel = action.action.startsWith("budget_");
    text2 = budgetPanel ? [runtimeBudgetPanel(budget), text2].filter(Boolean).join("\n\n") : continuous ? [continuous.text, text2].filter(Boolean).join('\n\n') : setupPanelText(panel);
    const specs = budgetPanel ? [["budget_warn", "仅提醒（不暂停）"], ["budget_stop", "到点暂停"], ["budget_less", "减少 30 分钟"], ["budget_more", "增加 30 分钟"], ["budget_reset", "重置为 120 分钟"], ["status", "返回设置"]] : continuous ? continuous.specs : [...setupControlSpecs(panel), ...panel.diagnostics || panel.reviewBinding ? [] : [['continuous_settings', '持续通知']]];
    const components = await actor.store.transaction((s) => {
        s.adminControls = {};
        const buttons = specs.map(([action2, label]) => {
            const ref2 = PREFIX + crypto.randomUUID();
            s.adminControls[ref2] = { action: action2, expires: actor.now() + 3e5, ...action2.startsWith("budget_") ? { budgetRevision: budget?.revision } : {}, ...action2 === "confirm" ? { confirmationId: status.pendingPairing.confirmationId } : {}, ...action2 === "active_probe" ? active.control : {}, ...action2 === "continuous_enable" ? continuous.control : {}, ...action2 === "continuous_review" ? continuous.reviewControl : {} };
            return { type: 2, style: action2 === "confirm" ? 3 : ["start", "pair", "review_binding", "active_probe", "continuous_enable"].includes(action2) ? 1 : 2, label, custom_id: ref2 };
        });
        return Array.from({ length: Math.ceil(buttons.length / 5) }, (_, row) => ({ type: 1, components: buttons.slice(row * 5, row * 5 + 5) }));
    });
    const response = reply(text2, components);
    if (action.action === 'continuous_enable') {
        const approved = await (await continuousController(actor)).status();
        if (approved.gatewayReady === true && approved.approvalInteractionId === p.id)
            response._rivuleActivation = { interactionId: p.id, grantId: approved.grantId };
    }
    return response;
}
import { DurableObject } from "cloudflare:workers";
function cloudflareSocket(network = globalThis.fetch) {
    return class OutboundSocket extends EventTarget {
        static supportsConnectionDiagnostics = true;
        constructor(url, { onDiagnostic = () => {
        } } = {}) {
            super();
            this.readyState = 0;
            this.closed = false;
            this.onDiagnostic = onDiagnostic;
            this.opening = this.open(url);
        }
        diagnostic(code, status) {
            if (this.closed)
                return;
            this.diagnosticFailure = true;
            try {
                this.onDiagnostic(code, status);
            }
            catch {
            }
        }
        async open(url) {
            let failure = "upgrade_failed", httpStatus;
            const controller = new AbortController();
            this.handshakeController = controller;
            let timer = setTimeout(() => controller.abort(new DOMException("WebSocket upgrade timed out", "TimeoutError")), 1e4);
            const finishHandshake = () => {
                if (timer !== null) {
                    clearTimeout(timer);
                    timer = null;
                }
                if (this.handshakeController === controller)
                    this.handshakeController = null;
            };
            try {
                const target = new URL(url);
                if (target.protocol !== "wss:")
                    throw Error("wss_required");
                target.protocol = "https:";
                const response = await network(target.href, { headers: { Upgrade: "websocket" }, redirect: "manual", signal: controller.signal });
                httpStatus = response.status;
                failure = response.status === 101 ? "upgrade_invalid_response" : "upgrade_http_rejected";
                const socket = response.webSocket;
                if (response.status !== 101 || !socket)
                    throw Error("upgrade_failed");
                if (this.closed) {
                    socket.accept();
                    socket.close(1e3, "stopped");
                    return;
                }
                this.socket = socket;
                socket.addEventListener("message", (event) => this.dispatchEvent(new MessageEvent("message", { data: event.data })));
                socket.addEventListener("close", () => {
                    this.readyState = 3;
                    this.dispatchEvent(new Event("close"));
                });
                socket.addEventListener("error", () => this.dispatchEvent(new Event("error")));
                this.readyState = 1;
                socket.accept();
                finishHandshake();
                this.dispatchEvent(new Event("open"));
            }
            catch {
                if (!this.closed) {
                    this.diagnostic(failure, httpStatus);
                    this.readyState = 3;
                    this.dispatchEvent(new Event("error"));
                }
            }
            finally {
                finishHandshake();
            }
        }
        send(value) {
            if (this.readyState !== 1 || !this.socket)
                throw Error("socket_not_open");
            this.socket.send(value);
        }
        close() {
            this.closed = true;
            this.readyState = 3;
            this.handshakeController?.abort();
            try {
                this.socket?.close(1e3, "stopped");
            }
            catch {
            }
        }
    };
}
function flatten(state) {
    const rows = new Map();
    for (const [key2, value] of Object.entries(state)) {
        if (key2 === "bridge") {
            for (const [group, items] of Object.entries(value))
                for (const [id2, item] of Object.entries(items))
                    rows.set(JSON.stringify([key2, group, id2]), JSON.stringify(item));
        }
        else if (key2 === "qqContinuous") {
            const groups = ['attempts', 'events', 'approvals', 'quotas', 'enrollments'];
            rows.set(JSON.stringify([key2, 'meta']), JSON.stringify(Object.fromEntries(Object.entries(value).filter(([k]) => !groups.includes(k)))));
            for (const group of groups)
                for (const [id, item] of Object.entries(value[group] ?? {}))
                    rows.set(JSON.stringify([key2, group, id]), JSON.stringify(item));
        }
        else if (key2 === "qqTransport") {
            for (const [id2, item] of Object.entries(value))
                rows.set(JSON.stringify([key2, id2]), JSON.stringify(item));
        }
        else if (key2 === "inbox") {
            value.forEach((item, i) => rows.set(JSON.stringify([key2, String(i)]), JSON.stringify(item)));
        }
        else
            rows.set(JSON.stringify([key2]), JSON.stringify(value));
    }
    return rows;
}
function inflate(rows) {
    const state = {};
    for (const { k, v } of rows) {
        const path = JSON.parse(k), value = JSON.parse(v);
        if (path[0] === "bridge") {
            state.bridge ??= { receipts: {}, events: {}, nonces: {} };
            state.bridge[path[1]][path[2]] = value;
        }
        else if (path[0] === "qqContinuous") {
            if (path.length === 1)
                state.qqContinuous = value;
            else {
                state.qqContinuous ??= {};
                if (path[1] === 'meta')
                    Object.assign(state.qqContinuous, value);
                else {
                    state.qqContinuous[path[1]] ??= {};
                    state.qqContinuous[path[1]][path[2]] = value;
                }
            }
        }
        else if (path[0] === "inbox") {
            state.inbox ??= [];
            state.inbox[Number(path[1])] = value;
        }
        else if (path[0] === "qqTransport") {
            state.qqTransport ??= {};
            state.qqTransport[path[1]] = value;
        }
        else
            state[path[0]] = value;
    }
    return state;
}
var DurableStateStore = class {
    constructor(storage) {
        this.storage = storage;
        this.tail = Promise.resolve();
        this.cache = null;
        storage.sql.exec("CREATE TABLE IF NOT EXISTS qq_gateway_state(k TEXT PRIMARY KEY,v TEXT NOT NULL)");
    }
    transaction(fn) {
        const run = this.tail.then(async () => {
            let committed;
            const result = await this.storage.transaction(async () => {
                const before = this.cache === null ? new Map(this.storage.sql.exec("SELECT k,v FROM qq_gateway_state").toArray().map((r) => [r.k, r.v])) : flatten(this.cache);
                const draft = this.cache === null ? inflate([...before].map(([k, v]) => ({ k, v }))) : structuredClone(this.cache);
                const value = await fn(draft), after = flatten(draft);
                if (after.size > 45e3)
                    throw Error("durable_state_capacity");
                for (const [k, v] of after)
                    if (before.get(k) !== v)
                        this.storage.sql.exec("INSERT INTO qq_gateway_state(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, v);
                for (const k of before.keys())
                    if (!after.has(k))
                        this.storage.sql.exec("DELETE FROM qq_gateway_state WHERE k=?", k);
                committed = structuredClone(draft);
                return value;
            });
            this.cache = committed;
            return result;
        });
        this.tail = run.catch(() => {
        });
        return run;
    }
};
var ORIGIN = "https://api.bot.qq.com";
var QQGateway = class {
    constructor({ appId, secret, fetch: transport = globalThis.fetch, WebSocket: Socket = globalThis.WebSocket, onDispatch = async () => {
    }, onStatus = () => {
    }, onDiagnostic = () => {
    }, now = Date.now }) {
        if (!/^\d{1,32}$/.test(appId) || typeof secret !== "function")
            throw Error("invalid_gateway_config");
        Object.assign(this, { appId, secret, transport: (input, init) => transport(input, init), Socket, onDispatch, onStatus, onDiagnostic, now });
        this.generation = 0;
        this.pendingFrames = 0;
        this.stopped = true;
        this.sequence = null;
        this.session = null;
        this.backoff = 1e3;
        this.serial = Promise.resolve();
    }
    diagnostic(stage, code, httpStatus, businessCode) {
        const record = diagnosticRecord(stage, code, this.now(), httpStatus, businessCode);
        if (!record)
            return;
        try {
            const pending = this.onDiagnostic(record);
            pending?.catch?.(() => {
            });
        }
        catch {
        }
    }
    async tokenValue() {
        if (this.token && this.token.until - this.now() > 6e4)
            return this.token.value;
        const generation = this.generation;
        if (this.refresh?.generation === generation)
            return this.refresh.promise;
        const refresh = { generation, promise: (async () => {
                let failure = "credential_unavailable", httpStatus, businessCode;
                const report = (code) => {
                    if (this.generation === generation)
                        this.diagnostic("token", code, httpStatus, businessCode);
                };
                report("request_started");
                try {
                    const value = await this.secret();
                    if (typeof value !== "string" || !value || value.length > 1024 || /[\r\n\0]/.test(value))
                        throw Error("credential_unavailable");
                    failure = "network_failed";
                    const r = await this.transport(ORIGIN + "/app/getAppAccessToken", { method: "POST", redirect: "manual", signal: AbortSignal.timeout(1e4), headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: this.appId, clientSecret: value }) });
                    httpStatus = r.status;
                    failure = r.ok ? "invalid_response" : "http_rejected";
                    if (!r.ok)
                        throw Error("token_rejected");
                    failure = "json_invalid";
                    const d = await r.json();
                    failure = "response_shape_invalid";
                    if (!d || typeof d !== "object" || Array.isArray(d))
                        throw Error("token_rejected");
                    failure = "ttl_type_invalid";
                    const ttl = Number(d.expires_in);
                    if (typeof d.access_token !== "string" || !d.access_token || !Number.isFinite(ttl) || ttl <= 0 || ttl > 7200) {
                        if (Number.isSafeInteger(d.code) && d.code !== 0) {
                            failure = "business_rejected";
                            businessCode = d.code;
                        }
                        else if (typeof d.access_token !== "string" || !d.access_token)
                            failure = "token_missing";
                        else if (!["number", "string"].includes(typeof d.expires_in) || !Number.isFinite(ttl))
                            failure = "ttl_type_invalid";
                        else
                            failure = "ttl_range_invalid";
                        throw Error("token_rejected");
                    }
                    report("accepted");
                    if (this.generation === generation)
                        this.token = { value: d.access_token, until: this.now() + ttl * 1e3 };
                    return d.access_token;
                }
                catch (error) {
                    report(failure);
                    throw error;
                }
            })() };
        this.refresh = refresh;
        try {
            return await refresh.promise;
        }
        finally {
            if (this.refresh === refresh)
                this.refresh = null;
        }
    }
    async start() {
        if (!this.stopped)
            return this.connecting?.promise;
        this.stopped = false;
        this.generation++;
        await this.connect();
    }
    async connect() {
        if (this.stopped)
            return;
        const generation = this.generation;
        if (this.connecting?.generation === generation)
            return this.connecting.promise;
        const flight = { generation, promise: this.open(generation) };
        this.connecting = flight;
        try {
            return await flight.promise;
        }
        finally {
            if (this.connecting === flight)
                this.connecting = null;
        }
    }
    async open(generation) {
        const current = () => !this.stopped && this.generation === generation;
        let stage = "token", failure = "network_failed", httpStatus;
        try {
            const token = await this.tokenValue();
            if (!current())
                return;
            stage = "gateway";
            this.diagnostic("gateway", "request_started");
            const r = await this.transport(ORIGIN + "/gateway", { headers: { Authorization: "QQBot " + token }, redirect: "manual", signal: AbortSignal.timeout(1e4) });
            if (!current())
                return;
            httpStatus = r.status;
            failure = r.ok ? "invalid_response" : "http_rejected";
            if (r.status === 401) {
                this.token = null;
                throw Error("gateway_auth_expired");
            }
            if (!r.ok)
                throw Error("invalid_gateway");
            const d = await r.json();
            const u = new URL(d.url);
            if (!r.ok || u.protocol !== "wss:" || u.username || u.password || u.port && u.port !== "443" || !(u.hostname === "qq.com" || u.hostname.endsWith(".qq.com")))
                throw Error("invalid_gateway");
            if (!current())
                return;
            this.diagnostic("gateway", "accepted", httpStatus);
            stage = "socket";
            failure = "upgrade_failed";
            httpStatus = void 0;
            const attempt = {};
            this.diagnosticAttempt = attempt;
            const socketOptions = { onDiagnostic: (code, status) => {
                    if (current() && this.diagnosticAttempt === attempt)
                        this.diagnostic("socket", code, status);
                } };
            this.diagnostic("socket", "upgrade_started");
            const ws = this.Socket.supportsConnectionDiagnostics === true ? new this.Socket(u.href, socketOptions) : new this.Socket(u.href);
            this.ws = ws;
            this.resumePending = null;
            this.ready = false;
            this.hello = false;
            this.deadline = this.now() + 15e3;
            ws.addEventListener("message", (event) => {
                if (this.pendingFrames >= 1e3) {
                    if (current() && this.ws === ws)
                        this.diagnostic("socket", "frame_backpressure");
                    this.status("frame_backpressure");
                    this.reconnect(ws);
                    return;
                }
                this.pendingFrames++;
                this.serial = this.serial.then(() => this.receive(ws, event.data)).catch(() => {
                    if (current() && this.ws === ws)
                        this.diagnostic("socket", "protocol_error");
                    this.status("protocol_error");
                    this.reconnect(ws);
                }).finally(() => {
                    this.pendingFrames--;
                });
            });
            ws.addEventListener("open", () => {
                if (current() && this.ws === ws)
                    this.diagnostic("socket", "opened");
            });
            ws.addEventListener("close", () => {
                if (current() && this.ws === ws)
                    this.diagnostic("socket", "closed");
                this.reconnect(ws);
            });
            ws.addEventListener("error", () => {
                if (current() && this.ws === ws && !ws.diagnosticFailure)
                    this.diagnostic("socket", "transport_error");
                this.reconnect(ws);
            });
            this.status("connecting");
        }
        catch {
            if (current()) {
                if (stage !== "token")
                    this.diagnostic(stage, failure, httpStatus);
                this.status("connection_failed");
                this.schedule();
            }
        }
    }
    status(state) {
        this.onStatus({ state });
    }
    schedule() {
        if (!this.stopped) {
            this.retryAt = this.now() + this.backoff;
            this.backoff = Math.min(this.backoff * 2, 6e4);
        }
    }
    reconnect(ws) {
        if (this.ws !== ws)
            return;
        this.resumePending = null;
        this.ws = null;
        this.ready = false;
        try {
            ws.close();
        }
        catch {
        }
        this.status("connection_unavailable");
        this.schedule();
    }
    send(payload) {
        if (!this.ws || this.ws.readyState !== 1)
            throw Error("socket_not_open");
        this.ws.send(JSON.stringify(payload));
    }
    async receive(ws, raw) {
        if (this.stopped || ws !== this.ws)
            return;
        if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > 262144)
            throw Error("invalid_frame");
        const p = JSON.parse(raw);
        if (!Number.isInteger(p.op))
            throw Error("invalid_opcode");
        if (p.op === 10) {
            if (this.hello || !Number.isFinite(p.d?.heartbeat_interval) || p.d.heartbeat_interval < 1e3 || p.d.heartbeat_interval > 3e5)
                throw Error("invalid_hello");
            this.hello = true;
            this.interval = p.d.heartbeat_interval;
            this.nextBeat = this.now() + this.interval;
            this.awaitAck = false;
            const token = await this.tokenValue();
            if (ws !== this.ws || this.stopped)
                return;
            const resume = typeof this.session === "string" && this.session.length > 0 && this.session.length <= 256 && Number.isSafeInteger(this.sequence) && this.sequence >= 0;
            if (this.session && !resume)
                throw Error("invalid_resume_context");
            this.send(resume ? { op: 6, d: { token: "QQBot " + token, session_id: this.session, seq: this.sequence } } : { op: 2, d: { token: "QQBot " + token, intents: 1 << 25, shard: [0, 1] } });
            this.resumePending = resume ? { ws, generation: this.generation, session: this.session, last: this.sequence, bytes: 0, events: [] } : null;
            this.diagnostic("auth", resume ? "resume_sent" : "identify_sent");
            return;
        }
        if (!this.hello)
            throw Error("hello_required");
        if (p.op === 11) {
            this.awaitAck = false;
            return;
        }
        if (p.op === 7) {
            this.reconnect(ws);
            return;
        }
        if (p.op === 9) {
            this.diagnostic("auth", "invalid_session");
            const rejected = { session: this.session, sequence: this.sequence, generation: this.generation };
            this.ready = false;
            this.session = null;
            this.sequence = null;
            this.resumePending = null;
            let invalidated = true;
            try {
                if (typeof this.onSessionInvalidated === "function")
                    invalidated = await this.onSessionInvalidated(rejected);
            }
            catch {
                this.stop();
                throw Error("session_invalidation_failed");
            }
            if (this.stopped || ws !== this.ws || this.generation !== rejected.generation)
                return;
            if (invalidated !== true) {
                this.stop();
                return;
            }
            this.reconnect(ws);
            return;
        }
        if (p.op !== 0)
            return;
        if (!Number.isSafeInteger(p.s) || p.s < 0)
            throw Error("invalid_sequence");
        if (p.t === "READY") {
            if (this.resumePending)
                throw Error("unexpected_ready");
            if (typeof p.d?.session_id !== "string" || !p.d.session_id || p.d.session_id.length > 256)
                throw Error("invalid_session");
            this.session = p.d.session_id;
            this.ready = true;
            this.sequence = p.s;
            this.backoff = 1e3;
            this.diagnostic("auth", "ready");
            this.status("ready");
            return;
        }
        if (p.t === "RESUMED") {
            const replay = this.resumePending;
            if (!replay || replay.ws !== ws || replay.generation !== this.generation || replay.session !== this.session || this.now() > this.deadline || p.s < replay.last)
                throw Error("invalid_resume_confirmation");
            for (const event of replay.events) {
                if (this.stopped || this.ws !== ws || this.resumePending !== replay)
                    return;
                await dispatchAuthenticatedGatewayEvent(this, event, "replay");
                if (this.stopped || this.ws !== ws || this.resumePending !== replay)
                    return;
                this.sequence = event.s;
            }
            this.resumePending = null;
            this.ready = true;
            this.sequence = p.s;
            this.backoff = 1e3;
            this.diagnostic("auth", "resumed");
            this.status("ready");
            return;
        }
        if (!this.ready) {
            const replay = this.resumePending;
            if (!replay || replay.ws !== ws || replay.generation !== this.generation || replay.session !== this.session || this.now() > this.deadline)
                throw Error("ready_required");
            if (typeof p.t !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(p.t) || !p.d || typeof p.d !== "object" || Array.isArray(p.d))
                throw Error("invalid_replay_dispatch");
            if (p.s <= replay.last)
                return;
            const bytes = new TextEncoder().encode(raw).byteLength;
            if (replay.events.length >= 64 || replay.bytes + bytes > 262144)
                throw Error("replay_capacity");
            replay.events.push(p);
            replay.bytes += bytes;
            replay.last = p.s;
            return;
        }
        if (this.sequence !== null && p.s <= this.sequence)
            return;
        await dispatchAuthenticatedGatewayEvent(this, p);
        if (ws === this.ws && !this.stopped)
            this.sequence = p.s;
    }
    async tick() {
        if (this.stopped)
            return;
        if (!this.ws) {
            if (this.retryAt !== void 0 && this.now() >= this.retryAt) {
                this.retryAt = void 0;
                await this.connect();
            }
            return;
        }
        if (!this.ready && this.now() > this.deadline) {
            this.diagnostic("auth", this.hello ? "ready_timeout" : "hello_timeout");
            this.reconnect(this.ws);
            return;
        }
        if (this.hello && this.now() >= this.nextBeat) {
            if (this.awaitAck) {
                this.diagnostic("socket", "heartbeat_timeout");
                this.status("heartbeat_timeout");
                this.reconnect(this.ws);
                return;
            }
            try {
                this.send({ op: 1, d: this.sequence });
                this.awaitAck = true;
                this.nextBeat = this.now() + this.interval;
            }
            catch {
                this.reconnect(this.ws);
            }
        }
    }
    stop() {
        this.resumePending = null;
        this.stopped = true;
        this.generation++;
        this.connecting = null;
        this.refresh = null;
        this.retryAt = void 0;
        this.session = null;
        this.sequence = null;
        const ws = this.ws;
        this.ws = null;
        this.ready = false;
        this.token = null;
        try {
            ws?.close();
        }
        catch {
        }
    }
};
var enc = new TextEncoder();
var hex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
var randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
var hash = async (text2) => hex(await crypto.subtle.digest("SHA-256", enc.encode(text2)));
function equalHex(a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length)
        return false;
    let d = 0;
    for (let i = 0; i < a.length; i++)
        d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
}
async function key(raw) {
    if (typeof raw !== "string" || raw.length < 32)
        throw Error("bridge_key_unavailable");
    return crypto.subtle.importKey("raw", enc.encode(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
var hmac = async (raw, domain, body) => hex(await crypto.subtle.sign("HMAC", await key(raw), enc.encode(domain + "\n" + body)));
var verifyHmac = async (raw, domain, body, signature) => crypto.subtle.verify("HMAC", await key(raw), Uint8Array.from(signature.match(/../g), (v) => parseInt(v, 16)), enc.encode(domain + "\n" + body));
var valid = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(s);
var OwnerBinding = class {
    constructor({ store, appId, ownerId, now = Date.now }) {
        if (!/^\d{1,32}$/.test(appId) || !valid(ownerId))
            throw Error("invalid_binding_config");
        Object.assign(this, { store, appId, ownerId, now });
    }
    async begin() {
        const code = randomHex(24);
        const codeHash = await hash(code);
        await this.store.transaction((state) => {
            if (state.binding || state.pairing && state.pairing.expiresAt > this.now())
                throw Error("binding_or_pairing_exists");
            state.pairing = { appId: this.appId, ownerId: this.ownerId, digest: codeHash, expiresAt: this.now() + 3e5, attempts: 0 };
        });
        return { code, expiresAt: this.now() + 3e5 };
    }
    async observe(event) {
        if (event?.t !== "C2C_MESSAGE_CREATE" || !valid(event?.d?.author?.user_openid) || typeof event.d.content !== "string")
            return { state: "ignored" };
        const content = event.d.content.trim();
        if (!content.startsWith("/bind "))
            return { state: "ignored" };
        const supplied = await hash(content.slice(6));
        return this.store.transaction((state) => {
            const p = state.pairing;
            if (state.binding || !p || p.appId !== this.appId || p.ownerId !== this.ownerId || p.expiresAt <= this.now() || p.attempts >= 5 || p.candidate)
                return { state: "closed" };
            p.attempts++;
            if (!equalHex(supplied, p.digest))
                return { state: "rejected" };
            p.candidate = { userOpenId: event.d.author.user_openid, confirmationId: randomHex(16) };
            const eventAt = Date.parse(event.d.timestamp);
            if (typeof event.d.id === "string" && event.d.id.length > 0 && event.d.id.length <= 1024 && Number.isFinite(eventAt) && eventAt <= this.now() && this.now() - eventAt < 3e5)
                p.candidate.replyMessage = { messageId: event.d.id, eventAt };
            delete p.digest;
            return { state: "confirmation_required", ...p.candidate };
        });
    }
    async confirm(confirmationId) {
        return this.store.transaction((state) => {
            const p = state.pairing;
            if (state.binding || !p?.candidate || p.appId !== this.appId || p.ownerId !== this.ownerId || p.expiresAt <= this.now() || p.candidate.confirmationId !== confirmationId)
                throw Error("confirmation_invalid");
            state.binding = { appId: this.appId, ownerId: this.ownerId, userOpenId: p.candidate.userOpenId, confirmedAt: this.now(), ...p.candidate.replyMessage ? { replyMessage: p.candidate.replyMessage } : {} };
            delete state.pairing;
            return { ...state.binding };
        });
    }
    async cancel() {
        await this.store.transaction((state) => {
            delete state.pairing;
        });
    }
};
function createQQRuntime({ store, appId, ownerId, secret, fetch: fetch2, WebSocket, now = Date.now, onStatus = () => {
}, onDiagnostic = () => {
}, setInterval: installTimer = globalThis.setInterval, clearInterval: removeTimer = globalThis.clearInterval }) {
    const binding = new OwnerBinding({ store, appId, ownerId, now });
    const client = new QQGateway({ appId, secret, fetch: fetch2, WebSocket, now, onStatus, onDiagnostic, onDispatch: async (event, auth) => {
            try {
                if (["FRIEND_DEL", "C2C_MSG_REJECT", "FRIEND_ADD", "C2C_MSG_RECEIVE"].includes(event.t)) {
                    await store.transaction((state) => observeActivePermission({ state, store, event, auth, client, appId, ownerId, now: now() }));
                    return;
                }
                const result = await binding.observe(event);
                if (result.state !== "ignored")
                    return;
                if (event.t !== "C2C_MESSAGE_CREATE")
                    return;
                const d = event.d;
                if (typeof d?.id !== "string" || !d.id || d.id.length > 1024 || typeof d.content !== "string" || d.content.length > 16e3)
                    return;
                await store.transaction((state) => {
                    const b = state.binding;
                    if (!b || b.appId !== appId || b.ownerId !== ownerId || b.userOpenId !== d.author?.user_openid)
                        return;
                    state.inbox ??= [];
                    if (state.inbox.some((item) => item.messageId === d.id))
                        return;
                    if (state.inbox.length >= 1e3) {
                        state.qqIngestionHealth = { healthy: false, reason: "inbox_full", failedAt: now() };
                        store.qqIngestionFault = true;
                        return;
                    }
                    const eventAt = Date.parse(d.timestamp);
                    state.inbox.push({ messageId: d.id, receivedAt: now(), ...Number.isFinite(eventAt) && eventAt <= now() ? { eventAt } : {} });
                });
            }
            catch (error) {
                store.qqIngestionFault = true;
                try {
                    await store.transaction((state) => {
                        state.qqIngestionHealth = { healthy: false, reason: "ingestion_failed", failedAt: now() };
                    });
                }
                catch {
                }
                throw error;
            }
        } });
    let timer, generation = 0, starting;
    const drain = async ({ messageIds, confirmReview } = {}) => {
        if (!client.stopped)
            throw Error("stop_before_review");
        await client.serial;
        if (confirmReview !== true || !Array.isArray(messageIds) || messageIds.some((id2) => typeof id2 !== "string") || new Set(messageIds).size !== messageIds.length)
            throw Error("review_required");
        await store.transaction((state) => {
            if (!state.binding || state.binding.appId !== appId || state.binding.ownerId !== ownerId)
                throw Error("stored_binding_mismatch");
            const inbox = state.inbox ?? [];
            if (messageIds.some((id2) => !inbox.some((item) => item.messageId === id2)))
                throw Error("unknown_inbox_record");
            const remaining = inbox.filter((item) => !messageIds.includes(item.messageId));
            if (remaining.length >= 1e3)
                throw Error("inbox_still_full");
            state.inbox = remaining;
            state.qqIngestionHealth = { healthy: true, reviewedAt: now() };
        });
        store.qqIngestionFault = false;
    };
    return {
        binding,
        client,
        reviewAndDrainInbox: drain,
        async start() {
            if (timer !== void 0)
                return;
            if (starting)
                return starting.promise;
            const mine = ++generation;
            const flight = { promise: (async () => {
                    await store.transaction((state) => {
                        if (state.binding && (state.binding.appId !== appId || state.binding.ownerId !== ownerId))
                            throw Error("stored_binding_mismatch");
                    });
                    if (mine !== generation)
                        return;
                    await client.start();
                    if (mine !== generation)
                        return;
                    timer = installTimer(() => {
                        client.tick().catch(() => onStatus({ state: "tick_failed" }));
                    }, 250);
                })() };
            starting = flight;
            try {
                await flight.promise;
            }
            finally {
                if (starting === flight)
                    starting = void 0;
            }
        },
        stop() {
            generation++;
            starting = void 0;
            if (timer !== void 0)
                removeTimer(timer);
            timer = void 0;
            client.stop();
        }
    };
}
var terminal = new Set(["completed", "failed", "cancelled"]);
var kindStatus = { registered: "proposed", started: "running", needs_input: "needs_input", completed: "completed", failed: "failed", cancelled: "cancelled" };
var kinds = new Set([...Object.keys(kindStatus), "progress", "heartbeat", "correction"]);
var statuses = new Set(["proposed", "running", "needs_input", ...terminal]);
var storeFault = (store, state) => store.qqIngestionFault === true || state.qqIngestionHealth?.healthy === false;
var id = (s) => typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(s);
async function check(key2, domain, packet) {
    if (typeof packet?.body !== "string" || new TextEncoder().encode(packet.body).byteLength > 65536 || typeof packet.signature !== "string" || !/^[a-f0-9]{64}$/.test(packet.signature))
        throw Error("bridge_auth_invalid");
    if (!await verifyHmac(key2, domain, packet.body, packet.signature))
        throw Error("bridge_auth_invalid");
    return JSON.parse(packet.body);
}
function exact(obj, keys) {
    return obj && typeof obj === "object" && !Array.isArray(obj) && Object.keys(obj).every((k) => keys.includes(k));
}
var NotificationBridge = class {
    constructor({ store, key: key2, ownerId, appId, allowedSourceIds, allowedProjectIds, deliver, enabled = false, evidence = () => null, now = Date.now }) {
        if (!id(ownerId) || !/^\d{1,32}$/.test(appId) || typeof key2 !== "function" || typeof deliver !== "function")
            throw Error("invalid_bridge_config");
        for (const list2 of [allowedSourceIds, allowedProjectIds])
            if (!Array.isArray(list2) || list2.some((x) => !id(x)) || new Set(list2).size !== list2.length)
                throw Error("invalid_bridge_scope");
        Object.assign(this, { store, key: key2, ownerId, appId, allowedSourceIds: [...allowedSourceIds], allowedProjectIds: [...allowedProjectIds], deliver, enabled, evidence, now });
    }
    async receive(packet) {
        const key2 = await this.key();
        const envelope = await check(key2, "rivule-qq-request-v1", packet);
        if (!exact(envelope, ["version", "timestamp", "nonce", "job"]) || envelope.version !== 1 || !Number.isSafeInteger(envelope.timestamp) || Math.abs(this.now() - envelope.timestamp) > 6e4 || typeof envelope.nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(envelope.nonce))
            throw Error("bridge_envelope_invalid");
        const job = envelope.job;
        if (!exact(job, ["ownerId", "appId", "sourceId", "projectId", "eventId", "receiptId", "content"]) || job.ownerId !== this.ownerId || job.appId !== this.appId || !this.allowedSourceIds.includes(job.sourceId) || !this.allowedProjectIds.includes(job.projectId) || !id(job.eventId) || !/^rcpt_[a-f0-9]{32}$/.test(job.receiptId) || typeof job.content !== "string" || !job.content.trim() || job.content.length > 4e3 || job.content.includes("\0"))
            throw Error("bridge_scope_invalid");
        const intent = { ownerId: job.ownerId, appId: job.appId, sourceId: job.sourceId, projectId: job.projectId, eventId: job.eventId, receiptId: job.receiptId, content: job.content };
        const fingerprint = await hash(JSON.stringify(intent));
        const ledgerKey = await hash(JSON.stringify([job.sourceId, job.receiptId]));
        const eventKey = await hash(JSON.stringify([job.sourceId, job.eventId]));
        const requestHash = await hash(packet.body);
        const response = async (receipt2) => {
            const body = JSON.stringify({ requestHash, receipt: receipt2 });
            return { body, signature: await hmac(key2, "rivule-qq-response-v1", body) };
        };
        const blocked2 = (reason) => ({ state: "blocked", reason });
        const reservation = await this.store.transaction((state) => {
            state.bridge ??= { receipts: {}, events: {}, nonces: {} };
            const b = state.bridge;
            for (const [nonce, value] of Object.entries(b.nonces))
                if (value.until < this.now())
                    delete b.nonces[nonce];
            const seen = b.nonces[envelope.nonce];
            if (seen && seen.hash !== requestHash)
                throw Error("nonce_reuse");
            if (!seen && Object.keys(b.nonces).length >= 1e4)
                throw Error("nonce_capacity");
            b.nonces[envelope.nonce] = { hash: requestHash, until: envelope.timestamp + 6e4 };
            const old = b.receipts[ledgerKey];
            if (old) {
                if (old.fingerprint !== fingerprint)
                    throw Error("receipt_conflict");
                return { receipt: old.receipt };
            }
            if (b.events[eventKey])
                throw Error("event_already_reserved");
            if (!this.enabled)
                return { receipt: blocked2("disabled") };
            const binding = state.binding;
            if (!binding || binding.ownerId !== this.ownerId || binding.appId !== this.appId || typeof binding.userOpenId !== "string" || !binding.userOpenId)
                return { receipt: blocked2("binding_unverified") };
            if (storeFault(this.store, state))
                return { receipt: blocked2("ingestion_unhealthy") };
            if (state.qqRevoked === true)
                return { receipt: blocked2("permission_revoked") };
            const e = this.evidence();
            if (!e || e.identity !== true || e.proactive !== true || !Number.isFinite(e.checkedAt) || !Number.isFinite(e.validUntil) || e.checkedAt > this.now() || e.checkedAt >= e.validUntil || e.validUntil <= this.now())
                return { receipt: blocked2("capability_unverified") };
            if (Object.values(b.receipts).some((x) => ["uncertain", "not_sent", "blocked"].includes(x.receipt.state)))
                return { receipt: blocked2("queue_requires_review") };
            if (Object.keys(b.receipts).length >= 1e4)
                return { receipt: blocked2("receipt_capacity") };
            if ((state.qqNextSendAt ?? 0) > this.now())
                return { receipt: blocked2("paced") };
            b.events[eventKey] = ledgerKey;
            b.receipts[ledgerKey] = { fingerprint, receipt: { state: "uncertain", reason: "reserved_before_send" } };
            state.qqNextSendAt = this.now() + 3100;
            return { send: true, userOpenId: binding.userOpenId };
        });
        if (!reservation.send)
            return response(reservation.receipt);
        let receipt;
        try {
            const allowed = await this.store.transaction((state) => !storeFault(this.store, state) && state.qqRevoked !== true && state.binding?.userOpenId === reservation.userOpenId && state.binding?.appId === this.appId && state.binding?.ownerId === this.ownerId);
            const evidence = this.evidence();
            if (!allowed || !evidence || evidence.identity !== true || evidence.proactive !== true || !Number.isFinite(evidence.validUntil) || !Number.isFinite(evidence.checkedAt) || evidence.checkedAt >= evidence.validUntil || evidence.validUntil <= this.now() || evidence.checkedAt > this.now())
                receipt = blocked2("permission_changed");
            else {
                const result = await this.deliver({ ...intent, userOpenId: reservation.userOpenId });
                if (result?.state === "sent" && typeof result.messageId === "string" && result.messageId.length > 0 && result.messageId.length <= 1024)
                    receipt = { state: "sent", reason: "provider_accepted", messageId: result.messageId };
                else if (["not_sent", "blocked"].includes(result?.state))
                    receipt = qqBridgeRejectedReceipt(result);
                else
                    receipt = { state: "uncertain", reason: "provider_outcome_unknown" };
            }
        }
        catch {
            receipt = { state: "uncertain", reason: "network_outcome_unknown" };
        }
        try {
            await this.store.transaction((state) => {
                const old = state.bridge?.receipts[ledgerKey];
                if (!old || old.fingerprint !== fingerprint)
                    throw Error("receipt_missing");
                old.receipt = receipt;
            });
        }
        catch {
            receipt = { state: "uncertain", reason: "receipt_persistence_failed" };
        }
        return response(receipt);
    }
};
function createQQDelivery({ store, config, fetch: fetch2, now = Date.now }) {
    if (typeof config.dispatchMessage !== "function")
        throw Error("qq_dispatch_gate_required");
    const storage = { transaction: (fn) => store.transaction(async (state) => {
            state.qqTransport ??= {};
            return fn({ get: async (key2) => key2.startsWith("qq:gate:") && (state.qqRevoked === true || state.qqIngestionHealth?.healthy === false || store.qqIngestionFault === true) ? true : state.qqTransport[key2], put: async (key2, value) => {
                    state.qqTransport[key2] = structuredClone(value);
                } });
        }) };
    const network = fetch2 ?? globalThis.fetch;
    const compatibleFetch = async (url, init) => {
        const response = await network(url, init);
        if (response.status === 204 || !response.body)
            return response;
        const raw = await qqReadBytes(response.body, 262144);
        let body = raw;
        try {
            const data = JSON.parse(new TextDecoder().decode(raw));
            if (Number.isSafeInteger(data?.err_code) && data.code === void 0) {
                data.code = data.err_code;
                body = JSON.stringify(data);
            }
        }
        catch {
        }
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    const client = new QQC2CTransport(config, new QQDurableLedger(storage), compatibleFetch, now);
    return async (job) => {
        if (job.appId !== config.appId || job.ownerId !== config.ownerId || job.userOpenId !== config.userOpenId)
            return { state: "blocked", reason: "binding_not_authorized" };
        return client.send({ ownerId: job.ownerId, sourceId: job.sourceId, projectId: job.projectId, eventId: job.eventId, content: job.content });
    };
}
var DAY = 864e5;
function list(value) {
    if (typeof value !== "string")
        return [];
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "string") || new Set(parsed).size !== parsed.length)
        throw Error("invalid_scope");
    return parsed;
}
var RivuleContinuous = (() => {
    const DELIVERY_VERSION = 2;
    const POLICY = Object.freeze({ revision: 2, sourceMode: 'all_currently_verified', dailyLimit: 100, minimumIntervalMs: 3000, sourceProofMaxAgeMs: 86400000, permitTtlMs: 30000, maxSessionMs: 300000, expiryMode: 'current_runtime', maxAttempts: 1000 });
    const fail = reason => { throw Error(reason); };
    const integer = n => Number.isSafeInteger(n) && n >= 0;
    const text = (s, n = 256) => typeof s === 'string' && s.length > 0 && s.length <= n;
    const fresh = (at, now, max) => integer(at) && at <= now && now - at < max;
    const safeKey = s => text(s) && !['__proto__', 'constructor', 'prototype'].includes(s);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    function bindingKey(b) { if (!b || !text(b.ownerId) || !text(b.appId) || !text(b.userOpenId) || !integer(b.confirmedAt))
        fail('binding_unverified'); return JSON.stringify([b.ownerId, b.appId, b.userOpenId, b.confirmedAt]); }
    function permissionKey(p) { if (!p || !['authenticated_C2C_MSG_RECEIVE', 'authenticated_active_enrollment'].includes(p.kind) || !text(p.eventKey) || !integer(p.revision) || !integer(p.confirmedAt))
        fail('permission_unverified'); return JSON.stringify([p.eventKey, p.revision, p.confirmedAt, p.bindingFingerprint, p.sessionFingerprint]); }
    function currentGate(state, context, now, requireProducer = true) {
        if (!integer(now) || context.enabled !== true)
            fail('delivery_disabled');
        if (context.credentialsCurrent !== true || !integer(context.runtimeLimitMs) || context.runtimeLimitMs < 60000 || context.runtimeLimitMs > 86400000 || context.ownerId !== context.binding?.ownerId || context.appId !== context.binding?.appId || !Array.isArray(context.projectIds) || context.projectIds.some(x => !text(x)))
            fail('configuration_changed');
        if (context.running !== true || context.ready !== true || context.healthy !== true || context.storageFault === true)
            fail('connection_unavailable');
        if (!integer(context.remainingMs) || context.remainingMs <= 0)
            fail('runtime_budget_unavailable');
        const d = state.qqContinuous, g = d?.grant;
        if (!g || g.state !== 'active')
            fail('grant_inactive');
        if (requireProducer && g.producerReady !== true)
            fail('producer_not_ready');
        if (g.policyFingerprint !== JSON.stringify(POLICY) || g.policyRevision !== POLICY.revision || g.sourceMode !== POLICY.sourceMode || g.projectScope !== JSON.stringify([...context.projectIds].sort()))
            fail('policy_changed');
        if (g.bindingKey !== bindingKey(context.binding) || g.bindingFingerprint !== context.bindingFingerprint)
            fail('binding_changed');
        if (g.budgetRevision !== context.budgetRevision || g.runtimeLimitMs !== context.runtimeLimitMs)
            fail('configuration_changed');
        if (g.runtimeEpoch !== context.runtimeEpoch || !text(context.runtimeEpoch))
            fail('connection_continuity_changed');
        if (g.permissionKey !== permissionKey(context.permission) || context.permission.revision !== context.permissionRevision || context.permission.sessionFingerprint !== context.permissionSessionFingerprint)
            fail('permission_changed');
        if (!integer(g.issuedAt) || !integer(g.hardUntil) || g.issuedAt > now || g.hardUntil <= now)
            fail('grant_expired');
        return g;
    }
    function unresolvedAttempts(state, fingerprint, now) {
        const pending = [];
        for (const [id, a] of Object.entries(state.qqContinuous?.attempts ?? {}))
            if (a.job.bindingFingerprint === fingerprint && a.state === 'uncertain' && !integer(a.reviewedAt))
                pending.push({ key: 'normal:' + id, record: a, at: a.requestStartedAt ?? a.createdAt });
        for (const [kind, records] of [['enrollment', state.qqEnrollmentProbes?.[fingerprint]], ['diagnostic', state.qqActiveProbes?.[fingerprint]]])
            for (const [id, a] of Object.entries(records ?? {}))
                if (a.receipt?.state === 'uncertain' && !integer(a.reviewedAt))
                    pending.push({ key: kind + ':' + id, record: a, at: a.reservedAt });
        return { keys: pending.map(x => x.key).sort(), reviewable: pending.length > 0 && pending.every(x => integer(x.at) && now >= x.at && now - x.at >= 30000), records: pending.map(x => x.record) };
    }
    function acknowledgeUnknown(state, fingerprint, keys, interactionId, now) {
        const pending = unresolvedAttempts(state, fingerprint, now);
        if (!safeKey(interactionId) || !pending.reviewable || !Array.isArray(keys) || !same(keys, pending.keys))
            fail('review_changed');
        for (const record of pending.records) {
            record.reviewedAt = now;
            record.reviewInteractionId = interactionId;
        }
        return { reviewed: pending.keys.length };
    }
    function maintainHistory(state, now) {
        if (!integer(now))
            fail('history_clock_invalid');
        const d = state.qqContinuous;
        if (!d)
            return;
        const cutoff = now - 72 * 3600000;
        for (const [id, a] of Object.entries(d.attempts ?? {})) {
            if (a.grantRevision === d.grant?.revision || a.state === 'uncertain' && !integer(a.reviewedAt))
                continue;
            const at = a.finishedAt ?? a.createdAt;
            if (integer(at) && at < cutoff) {
                delete d.attempts[id];
                for (const [key, value] of Object.entries(d.events ?? {}))
                    if (value === id)
                        delete d.events[key];
            }
        }
        for (const [id, a] of Object.entries(d.approvals ?? {}))
            if (integer(a.at) && a.at < cutoff && (a.expiresAt ?? a.at + POLICY.maxSessionMs) <= now)
                delete d.approvals[id];
        for (const [id, a] of Object.entries(d.enrollments ?? {}))
            if (integer(a.at) && a.at < cutoff)
                delete d.enrollments[id];
        for (const [day] of Object.entries(d.quotas ?? {}))
            if (Number(day) < Math.floor(cutoff / 86400000))
                delete d.quotas[day];
        for (const [binding, records] of Object.entries(state.qqEnrollmentProbes ?? {})) {
            for (const [id, a] of Object.entries(records))
                if (integer(a.reservedAt) && a.reservedAt < cutoff && (a.receipt?.state !== 'uncertain' || integer(a.reviewedAt)) && !(d.grant?.state === 'active' && d.grant.bindingFingerprint === binding && d.grant.approvalId === a.interactionId))
                    delete records[id];
            if (!Object.keys(records).length)
                delete state.qqEnrollmentProbes[binding];
        }
    }
    function enroll(state, context, approval, now) {
        if (!approval || approval.ownerAuthenticated !== true || !safeKey(approval.interactionId) || approval.policyFingerprint !== JSON.stringify(POLICY) || approval.policyRevision !== POLICY.revision || approval.backlog !== 'new_only')
            fail('approval_required');
        if (approval.budgetRevision !== context.budgetRevision)
            fail('configuration_changed');
        if (!integer(approval.startAfterRevision) || !integer(approval.expiresAt) || approval.expiresAt <= now || approval.expiresAt - now > POLICY.maxSessionMs)
            fail('approval_scope_invalid');
        if (context.enabled !== true || context.running !== true || context.ready !== true || context.healthy !== true || context.storageFault === true || !text(context.runtimeEpoch))
            fail('connection_unavailable');
        if (context.credentialsCurrent !== true || !integer(context.runtimeLimitMs) || context.runtimeLimitMs < 60000 || context.runtimeLimitMs > 86400000 || context.ownerId !== context.binding?.ownerId || context.appId !== context.binding?.appId || !Array.isArray(context.projectIds) || context.projectIds.some(x => !text(x)))
            fail('configuration_changed');
        const b = bindingKey(context.binding), p = context.permission, pk = permissionKey(p), probe = context.probe;
        if (probe?.kind === 'continuous_enrollment_observation') {
            const record = state.qqEnrollmentProbes?.[probe.bindingFingerprint]?.[probe.probeId];
            if (!record || record.interactionId !== approval.interactionId || record.bindingFingerprint !== context.bindingFingerprint || record.confirmedAt !== context.binding.confirmedAt || record.userOpenId !== context.binding.userOpenId || record.permissionRevision !== context.permissionRevision || record.sessionFingerprint !== context.permissionSessionFingerprint || record.runtimeEpoch !== context.runtimeEpoch || record.receipt?.state !== 'sent' || record.receipt?.reason !== 'provider_accepted' || probe.receipt?.reason !== 'provider_accepted' || record.receipt.messageId !== probe.receipt.messageId)
                fail('enrollment_observation_mismatch');
        }
        if (probe?.kind === 'continuous_enrollment_observation' && (probe.interactionId !== approval.interactionId || probe.runtimeEpoch !== context.runtimeEpoch || probe.sessionFingerprint !== context.permissionSessionFingerprint))
            fail('enrollment_observation_mismatch');
        if (p.kind === 'authenticated_active_enrollment' && (p.interactionId !== approval.interactionId || probe?.interactionId !== approval.interactionId || p.eventKey !== probe?.probeId || p.messageId !== probe?.receipt?.messageId))
            fail('enrollment_observation_mismatch');
        if (!fresh(p.eventAt, now, 300000) || !fresh(p.receivedAt, now, 300000) || p.confirmedAt !== context.binding.confirmedAt || p.bindingFingerprint !== context.bindingFingerprint || p.revision !== context.permissionRevision || p.sessionFingerprint !== context.permissionSessionFingerprint)
            fail('fresh_permission_required');
        if (!probe || !['isolated_active_probe_observation', 'continuous_enrollment_observation'].includes(probe.kind) || probe.bindingFingerprint !== context.bindingFingerprint || probe.confirmedAt !== context.binding.confirmedAt || probe.permissionRevision !== context.permissionRevision || probe.receipt?.state !== 'sent' || !text(probe.receipt.messageId, 1024) || !fresh(probe.checkedAt, now, 300000) || !integer(probe.validUntil) || probe.validUntil <= now)
            fail('fresh_probe_required');
        if (!integer(context.remainingMs) || context.remainingMs <= 0)
            fail('runtime_budget_unavailable');
        if (unresolvedAttempts(state, context.bindingFingerprint, now).keys.length)
            fail('unknown_outcome_requires_review');
        const d = state.qqContinuous ??= { version: DELIVERY_VERSION, revision: 0, approvals: {}, attempts: {}, events: {}, quotas: {} };
        if (d.version !== DELIVERY_VERSION)
            fail('delivery_schema_changed');
        maintainHistory(state, now);
        if (d.approvals[approval.interactionId])
            fail('approval_consumed');
        if (Object.keys(d.approvals).length >= 1000)
            fail('approval_capacity');
        d.revision++;
        d.approvals[approval.interactionId] = { at: now, expiresAt: approval.expiresAt, revision: d.revision };
        d.grant = { id: 'grant-' + d.revision, revision: d.revision, policyRevision: POLICY.revision, policyFingerprint: JSON.stringify(POLICY), sourceMode: POLICY.sourceMode, state: 'active', producerReady: false, projectScope: JSON.stringify([...context.projectIds].sort()), bindingKey: b, bindingFingerprint: context.bindingFingerprint, permissionKey: pk, runtimeEpoch: context.runtimeEpoch, budgetRevision: context.budgetRevision, runtimeLimitMs: context.runtimeLimitMs, expiryMode: 'current_runtime', issuedAt: now, hardUntil: Number.MAX_SAFE_INTEGER, startAfterRevision: approval.startAfterRevision, approvalId: approval.interactionId, probeCheckedAt: probe.checkedAt, probeMessageId: probe.receipt.messageId };
        return structuredClone(d.grant);
    }
    function acknowledgeProducer(state, context, ack, now) {
        const g = currentGate(state, context, now, false);
        if (!ack || Object.keys(ack).sort().join(',') !== 'approvalInteractionId,grantId,startAfterRevision' || ack.grantId !== g.id || ack.approvalInteractionId !== g.approvalId || !integer(ack.startAfterRevision) || ack.startAfterRevision < g.startAfterRevision)
            fail('producer_ack_invalid');
        if (g.producerReady) {
            if (g.startAfterRevision !== ack.startAfterRevision)
                fail('producer_cursor_conflict');
            return { state: 'ready', grantId: g.id };
        }
        g.startAfterRevision = ack.startAfterRevision;
        g.producerReady = true;
        g.producerAcknowledgedAt = now;
        return { state: 'ready', grantId: g.id };
    }
    function pause(state, reason, now) { const d = state.qqContinuous; if (!d?.grant)
        return; d.grant.state = 'paused'; d.grant.pauseReason = reason; d.grant.pausedAt = now; for (const a of Object.values(d.attempts))
        if (a.state === 'prepared') {
            a.state = 'suppressed';
            a.reason = reason;
        } }
    function sourceGate(job, source, grant, now) {
        if (!source || source.selectable !== true || source.enabled !== true || source.revoked === true || source.sourceId !== job.sourceId || source.generation !== job.sourceGeneration || source.bindingDigest !== job.sourceBindingDigest || !fresh(source.verifiedAt, now, POLICY.sourceProofMaxAgeMs))
            fail('source_unverified');
        if (!integer(job.acceptedRevision) || job.acceptedRevision <= grant.startAfterRevision || source.applied !== true || source.receiptId !== job.receiptId || source.eventId !== job.eventId || source.acceptedRevision !== job.acceptedRevision)
            fail('event_not_current');
        if (source.projectAllowed !== true || source.projectId !== job.projectId || source.sensitivity !== 'normal' || source.kind === 'heartbeat' || source.payloadHash !== job.payloadHash)
            fail('projection_not_authorized');
    }
    function validateJob(job) {
        const keys = ['intentId', 'sourceId', 'sourceGeneration', 'sourceBindingDigest', 'projectId', 'receiptId', 'eventId', 'acceptedRevision', 'payloadHash', 'content', 'grantId', 'bindingFingerprint'];
        if (!job || Object.keys(job).length !== keys.length || Object.keys(job).some(k => !keys.includes(k)))
            fail('job_schema_invalid');
        for (const k of keys.filter(k => !['sourceGeneration', 'acceptedRevision', 'content'].includes(k)))
            if (!text(job[k]))
                fail('job_schema_invalid');
        if (!safeKey(job.intentId) || !integer(job.sourceGeneration) || !integer(job.acceptedRevision) || !text(job.content, 4000) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(job.content))
            fail('job_schema_invalid');
    }
    function legacyActiveCount(state, day) { let count = 0; for (const group of Object.values(state.qqActiveProbes ?? {}))
        for (const p of Object.values(group))
            if (integer(p.reservedAt) && Math.floor(p.reservedAt / 86400000) === day)
                count++; return count; }
    function reserveQuota(state, now) {
        const d = state.qqContinuous, day = Math.floor(now / 86400000), q = d.quotas[day] ??= { count: 0, lastAt: null };
        if (!integer(q.count) || q.lastAt !== null && !integer(q.lastAt))
            fail('quota_corrupt');
        if (q.count + legacyActiveCount(state, day) >= POLICY.dailyLimit)
            fail('daily_quota_exhausted');
        if (d.lastAttemptAt !== undefined && (!integer(d.lastAttemptAt) || now < d.lastAttemptAt || now - d.lastAttemptAt < POLICY.minimumIntervalMs))
            fail('paced');
        q.count++;
        q.lastAt = now;
        d.lastAttemptAt = now;
        return day;
    }
    function reserveEnrollmentAttempt(state, attemptId, now) {
        if (!safeKey(attemptId) || !integer(now))
            fail('enrollment_invalid');
        const d = state.qqContinuous ??= { version: DELIVERY_VERSION, revision: 0, approvals: {}, attempts: {}, events: {}, quotas: {} };
        if (d.version !== DELIVERY_VERSION)
            fail('delivery_schema_changed');
        maintainHistory(state, now);
        d.enrollments ??= {};
        if (d.enrollments[attemptId])
            fail('enrollment_consumed');
        if (Object.keys(d.enrollments).length >= 1000)
            fail('enrollment_capacity');
        const day = reserveQuota(state, now);
        d.enrollments[attemptId] = { at: now, quotaDay: day };
    }
    function prepare(state, context, job, source, challenge, now) {
        validateJob(job);
        if (!text(challenge, 128) || challenge.length < 32)
            fail('challenge_invalid');
        const g = currentGate(state, context, now);
        if (job.grantId !== g.id || job.bindingFingerprint !== g.bindingFingerprint)
            fail('grant_changed');
        sourceGate(job, source, g, now);
        if (!context.projectIds.includes(job.projectId))
            fail('project_not_authorized');
        maintainHistory(state, now);
        const d = state.qqContinuous, old = d.attempts[job.intentId];
        if (old) {
            if (!same(old.job, job))
                fail('intent_conflict');
            return { state: 'reserved', attemptState: old.state, reason: 'already_reserved' };
        }
        const eventKey = JSON.stringify([job.sourceId, job.eventId]);
        if (d.events[eventKey])
            fail('event_already_reserved');
        if (Object.keys(d.attempts).length >= POLICY.maxAttempts)
            fail('attempt_capacity');
        d.events[eventKey] = job.intentId;
        d.attempts[job.intentId] = { job: structuredClone(job), state: 'prepared', challenge, createdAt: now, expiresAt: Math.min(now + POLICY.permitTtlMs, g.hardUntil), grantRevision: g.revision, runtimeEpoch: g.runtimeEpoch };
        return { state: 'prepared', challenge, expiresAt: d.attempts[job.intentId].expiresAt, grantId: g.id, grantRevision: g.revision };
    }
    function commit(state, context, intentId, permit, source, now) {
        const g = currentGate(state, context, now), d = state.qqContinuous, a = d.attempts[intentId];
        if (!a || a.state !== 'prepared')
            fail('attempt_consumed');
        if (!permit || Object.keys(permit).sort().join(',') !== 'challenge,expiresAt,grantRevision,intentId,payloadHash' || permit.intentId !== intentId || permit.challenge !== a.challenge || permit.payloadHash !== a.job.payloadHash || permit.grantRevision !== a.grantRevision || permit.expiresAt !== a.expiresAt)
            fail('permit_mismatch');
        if (a.expiresAt <= now || a.createdAt > now || a.grantRevision !== g.revision || a.runtimeEpoch !== context.runtimeEpoch)
            fail('permit_expired');
        sourceGate(a.job, source, g, now);
        if (!context.projectIds.includes(a.job.projectId))
            fail('project_not_authorized');
        const day = reserveQuota(state, now);
        a.state = 'uncertain';
        a.reason = 'reserved_before_post';
        a.requestStartedAt = now;
        a.quotaDay = day;
        return { content: a.job.content, userOpenId: context.binding.userOpenId };
    }
    function recordResult(state, intentId, result, now) {
        const a = state.qqContinuous?.attempts[intentId];
        if (!a || a.state !== 'uncertain' || a.reason !== 'reserved_before_post')
            fail('result_without_reservation');
        if (result?.state === 'sent' && text(result.messageId, 1024)) {
            a.state = 'sent';
            a.reason = 'provider_accepted';
            a.messageId = result.messageId;
        }
        else if (result?.state === 'not_sent') {
            a.state = 'not_sent';
            a.reason = ['proactive_permission_denied', 'rate_limited', 'friendship_missing', 'recipient_refused', 'bot_offline'].includes(result.reason) ? result.reason : 'provider_rejected';
        }
        else {
            a.reason = 'provider_outcome_unknown';
        }
        if (integer(result?.providerCode) && result.providerCode <= 999999999)
            a.providerCode = result.providerCode;
        if (integer(result?.httpStatus) && result.httpStatus >= 100 && result.httpStatus <= 599)
            a.httpStatus = result.httpStatus;
        if (state.qqContinuous.grant?.revision === a.grantRevision && a.state !== 'sent')
            pause(state, a.reason, now);
        a.finishedAt = now;
        return { state: a.state, reason: a.reason, ...a.messageId ? { messageId: a.messageId } : {}, ...a.providerCode === undefined ? {} : { providerCode: a.providerCode }, ...a.httpStatus === undefined ? {} : { httpStatus: a.httpStatus } };
    }
    function status(state, context, now) {
        let gatewayReady = true;
        try {
            currentGate(state, context, now, false);
        }
        catch {
            gatewayReady = false;
        }
        let reason = null;
        try {
            currentGate(state, context, now);
        }
        catch (e) {
            reason = e.message;
        }
        const d = state.qqContinuous, g = d?.grant, q = d?.quotas[Math.floor(now / 86400000)];
        const bound = context.binding?.ownerId === context.ownerId && context.binding?.appId === context.appId && text(context.binding?.userOpenId) && integer(context.binding?.confirmedAt) && context.binding.confirmedAt <= now;
        return { policyFingerprint: JSON.stringify(POLICY), enabled: reason === null, bound, gatewayReady, producerReady: g?.producerReady === true, grantState: g?.state ?? null, expiryMode: g?.expiryMode ?? null, remainingGrantMs: g?.expiryMode === 'current_runtime' ? null : g ? Math.max(0, g.hardUntil - now) : 0, reason, grantId: g?.id ?? null, bindingFingerprint: g?.bindingFingerprint ?? null, approvalInteractionId: g?.approvalId ?? null, expiresAt: g?.hardUntil ?? null, remainingDaily: Math.max(0, POLICY.dailyLimit - (q?.count ?? 0) - legacyActiveCount(state, Math.floor(now / 86400000))), remainingRuntimeMs: integer(context.remainingMs) ? context.remainingMs : 0 };
    }
    const state = { enroll, pause, status, prepare, commit, currentGate, sourceGate, recordResult, acknowledgeProducer };
    const reasons = new Set(['delivery_disabled', 'connection_unavailable', 'configuration_changed', 'runtime_budget_unavailable', 'grant_inactive', 'producer_not_ready', 'policy_changed', 'binding_changed', 'connection_continuity_changed', 'permission_changed', 'grant_expired', 'source_unverified', 'event_not_current', 'projection_not_authorized', 'project_not_authorized', 'grant_changed', 'intent_conflict', 'event_already_reserved', 'attempt_capacity', 'attempt_consumed', 'permit_mismatch', 'permit_expired', 'quota_corrupt', 'daily_quota_exhausted', 'paced', 'preparation_expired']);
    const safeReason = e => reasons.has(e?.message) ? e.message : 'preflight_unavailable';
    class ContinuousDeliveryController {
        constructor({ store, command, context, acquireToken, post, random, now = Date.now }) { Object.assign(this, { store, command, context, acquireToken, post, random, now }); this.tokens = new Map(); }
        async enroll(approval) { return this.command(() => this.store.transaction(s => state.enroll(s, this.context(s), approval, this.now()))); }
        async acknowledgeProducer(ack) { return this.command(() => this.store.transaction(s => state.acknowledgeProducer(s, this.context(s), ack, this.now()))); }
        async pause(reason = 'owner_paused') { return this.command(() => this.store.transaction(s => state.pause(s, reason, this.now()))); }
        async status() { return this.store.transaction(s => state.status(s, this.context(s), this.now())); }
        async prepare(job, source) {
            const result = await this.command(() => this.store.transaction(s => state.prepare(s, this.context(s), job, source, this.random(), this.now())));
            if (result.state !== 'prepared')
                return result;
            let token;
            try {
                token = await this.acquireToken();
            }
            catch {
                await this.command(() => this.store.transaction(s => { const a = s.qqContinuous?.attempts[job.intentId]; if (a?.state === 'prepared') {
                    a.state = 'suppressed';
                    a.reason = 'token_unavailable';
                } }));
                return { state: 'suppressed', reason: 'token_unavailable' };
            }
            try {
                await this.command(() => this.store.transaction(s => { state.currentGate(s, this.context(s), this.now()); const a = s.qqContinuous?.attempts[job.intentId]; if (a?.state !== 'prepared' || a.expiresAt <= this.now())
                    throw Error('preparation_expired'); }));
            }
            catch (e) {
                return { state: 'suppressed', reason: safeReason(e) };
            }
            this.tokens.set(job.intentId, { token, expiresAt: result.expiresAt });
            for (const [id, t] of this.tokens)
                if (t.expiresAt <= this.now())
                    this.tokens.delete(id);
            return result;
        }
        async commit(intentId, permit, source) {
            const token = this.tokens.get(intentId);
            if (!token || token.expiresAt <= this.now())
                return { state: 'suppressed', reason: 'preparation_not_live' };
            this.tokens.delete(intentId);
            let flight;
            try {
                flight = await this.command(async () => {
                    const committed = await this.store.transaction(s => ({ payload: state.commit(s, this.context(s), intentId, permit, source, this.now()), snapshot: structuredClone(s) }));
                    const checkedAt = this.now(), current = this.context(committed.snapshot), grant = state.currentGate(committed.snapshot, current, checkedAt);
                    state.sourceGate(committed.snapshot.qqContinuous.attempts[intentId].job, source, grant, checkedAt);
                    if (permit.expiresAt <= checkedAt || token.expiresAt <= checkedAt)
                        throw Error('permit_expired');
                    const payload = committed.payload;
                    this.tokens.delete(intentId);
                    let response;
                    try {
                        response = Promise.resolve(this.post(payload, token.token)).then(result => ({ result }), () => ({ result: { state: 'uncertain' } }));
                    }
                    catch {
                        response = Promise.resolve({ result: { state: 'uncertain' } });
                    }
                    return { response };
                });
            }
            catch (e) {
                return { state: 'suppressed', reason: safeReason(e) };
            }
            const { result } = await flight.response;
            try {
                return await this.command(() => this.store.transaction(s => state.recordResult(s, intentId, result, this.now())));
            }
            catch {
                return { state: 'uncertain', reason: 'receipt_persistence_failed' };
            }
        }
    }
    return { ContinuousDeliveryController, POLICY, pause, maintainHistory, reserveEnrollmentAttempt, unresolvedAttempts, acknowledgeUnknown, safeReason };
})();
function continuousPermissionProof(state) {
    if (state.qqRevoked === true)
        return state.qqActivePermission?.renewal;
    const observation = state.qqEnrollmentObservedCapability, binding = state.binding;
    const record = state.qqEnrollmentProbes?.[observation?.bindingFingerprint]?.[observation?.probeId];
    if (!observation || observation.kind !== "continuous_enrollment_observation" || !record || !binding
        || observation.permissionRevision !== (state.qqActivePermission?.revision ?? 0)
        || observation.confirmedAt !== binding.confirmedAt || record.confirmedAt !== binding.confirmedAt
        || observation.appId !== binding.appId || observation.ownerId !== binding.ownerId || record.userOpenId !== binding.userOpenId
        || record.bindingFingerprint !== observation.bindingFingerprint || record.interactionId !== observation.interactionId
        || record.permissionRevision !== observation.permissionRevision || record.sessionFingerprint !== observation.sessionFingerprint || record.runtimeEpoch !== observation.runtimeEpoch
        || record.receipt?.reason !== "provider_accepted" || observation.receipt?.reason !== "provider_accepted"
        || record.receipt?.state !== "sent" || observation.receipt?.state !== "sent" || record.receipt.messageId !== observation.receipt.messageId
        || typeof observation.sessionFingerprint !== "string" || !observation.sessionFingerprint
        || !Number.isSafeInteger(observation.checkedAt) || observation.checkedAt < 0)
        return state.qqActivePermission?.renewal;
    return { kind: "authenticated_active_enrollment", eventKey: observation.probeId, revision: observation.permissionRevision,
        confirmedAt: observation.confirmedAt, bindingFingerprint: observation.bindingFingerprint, sessionFingerprint: observation.sessionFingerprint,
        eventAt: observation.checkedAt, receivedAt: observation.checkedAt, interactionId: observation.interactionId, messageId: observation.receipt.messageId };
}
async function continuousPermissionDiagnostic(actor, state) {
    const renewal = state.qqActivePermission?.renewal, now = actor.now(), fingerprint = await activeBindingFingerprint(state.binding);
    let status = "missing", observedAt = null, ageMs = null;
    if (renewal) {
        const validTime = Number.isSafeInteger(renewal.eventAt) && renewal.eventAt >= 0 && renewal.eventAt <= now;
        if (validTime) {
            observedAt = renewal.eventAt;
            ageMs = now - renewal.eventAt;
        }
        status = renewal.kind !== "authenticated_C2C_MSG_RECEIVE" || !validTime ? "invalid"
            : renewal.bindingFingerprint !== fingerprint || renewal.confirmedAt !== state.binding?.confirmedAt ? "binding_changed"
                : renewal.revision !== (state.qqActivePermission?.revision ?? 0) ? "permission_changed"
                    : ageMs >= ACTIVE_PROBE_FRESH_MS ? "expired_local_evidence"
                        : renewal.sessionFingerprint !== actor.continuousSessionFingerprint ? "session_changed" : "current";
    }
    return { status, observedRevocation: state.qqRevoked === true, observedAt, ageMs,
        enrollmentAcceptedAt: Number.isSafeInteger(state.qqEnrollmentObservedCapability?.checkedAt) ? state.qqEnrollmentObservedCapability.checkedAt : null };
}
function continuousRuntimeEpoch(actor) {
    actor.continuousEpoch ??= randomHex(24);
    actor.continuousClientIds ??= new WeakMap();
    const client = actor.runtime?.client;
    if (client && !actor.continuousClientIds.has(client))
        actor.continuousClientIds.set(client, randomHex(24));
    return actor.continuousEpoch + ':' + (client ? actor.continuousClientIds.get(client) : 'no-client') + ':' + String(client?.generation);
}
async function continuousController(actor) {
    if (actor.continuous)
        return actor.continuous;
    actor.continuousEpoch ??= randomHex(24);
    const credentials = { appSecret: actor.env.QQ_APP_SECRET, bridgeSecret: actor.env.QQ_BRIDGE_SECRET };
    const context = (s) => {
        const c = actor.config(), client = actor.runtime?.client;
        continuousRuntimeEpoch(actor);
        let budget;
        try {
            budget = runtimeBudgetView(s, c.budget, actor.now());
        }
        catch {
            budget = null;
        }
        const b = s.binding, p = continuousPermissionProof(s);
        return { credentialsCurrent: credentials.appSecret === actor.env.QQ_APP_SECRET && credentials.bridgeSecret === actor.env.QQ_BRIDGE_SECRET, runtimeLimitMs: budget?.limitMs ?? 0, budgetRevision: budget?.revision ?? null, ownerId: c.ownerId, appId: c.appId, projectIds: c.allowedProjects, enabled: actor.env.QQ_DELIVERY_ENABLED === 'true', running: s.control?.running === true, ready: client?.ready === true && !client.stopped, healthy: s.qqIngestionHealth?.healthy === true, storageFault: actor.store.qqIngestionFault === true, remainingMs: budget?.availableMs ?? 0, binding: b, bindingFingerprint: p?.bindingFingerprint ?? null, runtimeEpoch: continuousRuntimeEpoch(actor), permissionSessionFingerprint: actor.continuousSessionFingerprint, permissionRevision: s.qqActivePermission?.revision ?? 0, permission: p, probe: (s.qqEnrollmentObservedCapability?.validUntil ?? 0) > (s.qqActiveObservedCapability?.validUntil ?? 0) ? s.qqEnrollmentObservedCapability : s.qqActiveObservedCapability };
    };
    actor.continuous = new RivuleContinuous.ContinuousDeliveryController({ store: actor.store, command: fn => actor.command(fn), context, now: () => actor.now(), random: () => randomHex(24),
        acquireToken: async () => {
            const c = actor.config(), b = await actor.store.transaction(s => s.binding);
            const transport = new QQC2CTransport({ appId: c.appId, ownerId: c.ownerId, userOpenId: b?.userOpenId, appSecret: () => actor.env.QQ_APP_SECRET, allowedSources: [], allowedProjects: [], allowedImageOrigins: [] }, null, actor.network, actor.now);
            return transport.accessToken();
        },
        post: async (payload, token) => {
            const c = actor.config();
            let r;
            try {
                r = await actor.network(QQ_API_ORIGIN + '/v2/users/' + encodeURIComponent(payload.userOpenId) + '/messages', { method: 'POST', headers: { Authorization: 'QQBot ' + token, 'content-type': 'application/json', 'X-Union-Appid': c.appId }, body: JSON.stringify({ msg_type: 0, content: payload.content }), redirect: 'manual', signal: AbortSignal.timeout(15000) });
            }
            catch {
                return { state: 'uncertain' };
            }
            const body = await json(r).catch(() => null), code = Number.isSafeInteger(body?.code) && body.code !== 0 ? body.code : Number.isSafeInteger(body?.err_code) && body.err_code !== 0 ? body.err_code : null;
            if (r.ok && (body?.code === undefined || body.code === 0) && (body?.err_code === undefined || body.err_code === 0) && text(body?.id, 1024))
                return { state: 'sent', messageId: body.id };
            if ([401, 403, 429].includes(r.status) || knownRejections.has(code))
                return { state: 'not_sent', reason: qqRejectionReason(r.status, code), httpStatus: r.status, ...code === null ? {} : { providerCode: code } };
            return { state: 'uncertain' };
        }
    });
    return actor.continuous;
}
async function continuousRequest(actor, packet) {
    const secret = actor.env.QQ_BRIDGE_SECRET, envelope = await check(secret, 'rivule-qq-request-v2', packet), c = actor.config();
    if (!envelope || Object.keys(envelope).sort().join(',') !== 'appId,operation,ownerId,payload,timestamp,version' || envelope.version !== 2 || envelope.ownerId !== c.ownerId || envelope.appId !== c.appId || !Number.isSafeInteger(envelope.timestamp) || Math.abs(actor.now() - envelope.timestamp) > 30000)
        throw Error('continuous_envelope_invalid');
    const ctl = await continuousController(actor);
    let result;
    if (envelope.operation === 'status') {
        if (envelope.payload !== null)
            throw Error('continuous_schema_invalid');
        result = await ctl.status();
    }
    else if (envelope.operation === 'acknowledge_producer') {
        result = await ctl.acknowledgeProducer(envelope.payload);
    }
    else if (envelope.operation === 'prepare') {
        if (!envelope.payload || Object.keys(envelope.payload).sort().join(',') !== 'job,source')
            throw Error('continuous_schema_invalid');
        const job = envelope.payload.job;
        if (typeof job?.content !== 'string' || job.payloadHash !== await hash(job.content))
            throw Error('continuous_payload_digest_mismatch');
        try {
            result = await ctl.prepare(job, envelope.payload.source);
        }
        catch (error) {
            result = { state: 'suppressed', reason: 'preflight_not_sent', diagnostic: { stage: 'gateway_prepare', code: RivuleContinuous.safeReason(error) } };
        }
    }
    else if (envelope.operation === 'commit') {
        if (!envelope.payload || Object.keys(envelope.payload).sort().join(',') !== 'intentId,permit,source')
            throw Error('continuous_schema_invalid');
        result = await ctl.commit(envelope.payload.intentId, envelope.payload.permit, envelope.payload.source);
    }
    else
        throw Error('continuous_operation_invalid');
    const body = JSON.stringify({ version: 2, requestHash: await hash(packet.body), result });
    return { body, signature: await hmac(secret, 'rivule-qq-response-v2', body) };
}
async function continuousEnrollmentEligibility(actor, state, expected) {
    const c = actor.config(), now = actor.now(), binding = state.binding;
    let budget;
    try {
        budget = runtimeBudgetView(state, c.budget, now);
    }
    catch {
        return { reason: "active_probe_budget_configuration_changed" };
    }
    if (budget.exhausted)
        return { reason: "budget_exhausted" };
    if (actor.env.QQ_DELIVERY_ENABLED !== "true")
        return { reason: "continuous_delivery_disabled" };
    if (state.control?.running !== true || actor.runtime?.client.ready !== true || actor.store.qqIngestionFault || state.qqIngestionHealth?.healthy !== true)
        return { reason: "active_probe_connection_not_healthy" };
    const fingerprint = await activeBindingFingerprint(binding);
    if (!fingerprint || binding.appId !== c.appId || binding.ownerId !== c.ownerId || binding.confirmedAt > now)
        return { reason: "active_probe_binding_unverified" };
    if (expected && (expected.probeId !== "continuous-enrollment-v1" || expected.bindingFingerprint !== fingerprint || expected.confirmedAt !== binding.confirmedAt))
        return { reason: "active_probe_binding_changed" };
    const revision = state.qqActivePermission?.revision ?? 0;
    if (typeof actor.continuousSessionFingerprint !== "string" || !actor.continuousSessionFingerprint)
        return { reason: "active_probe_connection_not_healthy" };
    if (expected && (expected.budgetRevision !== budget.revision || expected.sessionFingerprint !== actor.continuousSessionFingerprint || expected.runtimeEpoch !== continuousRuntimeEpoch(actor) || expected.runtimeGeneration !== actor.runtime?.client.generation))
        return { reason: "active_probe_connection_changed" };
    let renewalEventKey = null;
    if (state.qqRevoked === true) {
        const renewal = state.qqActivePermission?.renewal;
        if (!renewal || renewal.kind !== "authenticated_C2C_MSG_RECEIVE" || renewal.sessionFingerprint !== actor.continuousSessionFingerprint || renewal.bindingFingerprint !== fingerprint || renewal.confirmedAt !== binding.confirmedAt || renewal.revision !== revision || renewal.eventAt > now || now - renewal.eventAt >= ACTIVE_PROBE_FRESH_MS || renewal.receivedAt > now || renewal.eventAt < binding.confirmedAt)
            return { reason: "active_probe_fresh_qq_permission_required" };
        renewalEventKey = renewal.eventKey;
    }
    if (expected && (expected.permissionRevision !== revision || expected.renewalEventKey !== renewalEventKey))
        return { reason: "active_probe_permission_changed" };
    return { bindingFingerprint: fingerprint, confirmedAt: binding.confirmedAt, probeId: "continuous-enrollment-v1", budgetRevision: budget.revision, permissionRevision: revision, renewalEventKey, sessionFingerprint: actor.continuousSessionFingerprint, runtimeEpoch: continuousRuntimeEpoch(actor), runtimeGeneration: actor.runtime?.client.generation };
}
async function continuousEnrollmentProbe(actor, approved, interactionId) {
    let reserved;
    try {
        reserved = await actor.command(async () => {
            const budget = await actor.accountBudget();
            if (budget.exhausted) {
                await actor.stopInternal("active_budget_exhausted");
                return { receipt: blocked("budget_exhausted") };
            }
            return actor.store.transaction(async (s) => {
                const permission = await continuousEnrollmentEligibility(actor, s, approved);
                if (permission.reason)
                    return { receipt: blocked(permission.reason) };
                const old = s.qqEnrollmentProbes?.[permission.bindingFingerprint]?.[approved.enrollmentId];
                if (old)
                    return { receipt: old.receipt };
                RivuleContinuous.maintainHistory(s, actor.now());
                s.qqEnrollmentProbes ??= {};
                if (Object.values(s.qqEnrollmentProbes).reduce((n, records) => n + Object.keys(records).length, 0) >= 1000)
                    return { receipt: blocked("active_probe_history_capacity") };
                RivuleContinuous.reserveEnrollmentAttempt(s, approved.enrollmentId, actor.now());
                const probe = { ...permission, kind: "one_shot_active_test", interactionId, reservedAt: actor.now(), userOpenId: s.binding.userOpenId, receipt: { state: "uncertain", reason: "reserved_before_send" } };
                s.qqEnrollmentProbes[permission.bindingFingerprint] ??= {};
                s.qqEnrollmentProbes[permission.bindingFingerprint][approved.enrollmentId] = probe;
                return { probe: structuredClone(probe) };
            });
        });
    }
    catch {
        return blocked("active_probe_reservation_unavailable");
    }
    if (reserved.receipt)
        return reserved.receipt;
    const probe = reserved.probe;
    let result = { state: "not_sent", reason: "preflight_failed" }, attempted = false;
    try {
        const token = await actor.runtime.client.tokenValue();
        const dispatch = await actor.command(async () => {
            const budget = await actor.accountBudget();
            if (budget.exhausted) {
                await actor.stopInternal("active_budget_exhausted");
                return { reason: "budget_exhausted" };
            }
            const gate = await actor.store.transaction(async (s) => {
                const permission = await continuousEnrollmentEligibility(actor, s, probe);
                const record = s.qqEnrollmentProbes?.[probe.bindingFingerprint]?.[approved.enrollmentId];
                return permission.reason ? permission : !record || record.interactionId !== probe.interactionId || record.receipt.reason !== "reserved_before_send" ? { reason: "active_probe_reservation_changed" } : {};
            });
            if (gate.reason)
                return gate;
            attempted = true;
            const network = actor.network;
            const response = network(QQ_API_ORIGIN + "/v2/users/" + encodeURIComponent(probe.userOpenId) + "/messages", { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000), headers: { Authorization: "QQBot " + token, "content-type": "application/json", "X-Union-Appid": actor.config().appId }, body: JSON.stringify({ msg_type: 0, content: "Rivule 持续通知验证：通道已就绪。" }) });
            return { response: Promise.resolve(response).then(value => ({ value }), () => ({ networkError: true })) };
        });
        if (dispatch.reason)
            result = { state: "not_sent", reason: dispatch.reason };
        else {
            const outcome = await dispatch.response;
            if (outcome.networkError)
                result = { state: "uncertain", reason: "network_outcome_unknown" };
            else {
                const response = outcome.value;
                let data;
                try {
                    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await qqReadBytes(response.body, 65536)));
                }
                catch {
                }
                const providerCode = Number.isSafeInteger(data?.code) && data.code !== 0 ? data.code : Number.isSafeInteger(data?.err_code) && data.err_code !== 0 ? data.err_code : void 0;
                if (response.ok && (data?.code === void 0 || data.code === 0) && (data?.err_code === void 0 || data.err_code === 0) && text(data?.id, 1024))
                    result = { state: "sent", reason: "provider_accepted", messageId: data.id };
                else if ([401, 403, 429].includes(response.status) || knownRejections.has(providerCode))
                    result = { state: "not_sent", reason: qqRejectionReason(response.status, providerCode), ...providerCode === void 0 ? {} : { providerCode } };
                else
                    result = { state: "uncertain", reason: "provider_outcome_unknown" };
            }
        }
    }
    catch {
        result = { state: attempted ? "uncertain" : "not_sent", reason: attempted ? "network_outcome_unknown" : "preflight_failed" };
    }
    try {
        await actor.command(() => actor.store.transaction(async (s) => {
            const record = s.qqEnrollmentProbes?.[probe.bindingFingerprint]?.[approved.enrollmentId];
            if (!record || record.interactionId !== probe.interactionId)
                throw Error("active_probe_receipt_conflict");
            record.receipt = result;
            record.completedAt = actor.now();
            const current = await continuousEnrollmentEligibility(actor, s, probe);
            if (result.reason === "provider_accepted" && !current.reason) {
                s.qqEnrollmentObservedCapability = { schemaVersion: 1, kind: "continuous_enrollment_observation", bindingFingerprint: probe.bindingFingerprint, confirmedAt: probe.confirmedAt, appId: s.binding.appId, ownerId: s.binding.ownerId, recipientFingerprint: await qqHash(s.binding.userOpenId), checkedAt: actor.now(), validUntil: actor.now() + ACTIVE_PROBE_FRESH_MS, probeId: approved.enrollmentId, interactionId: probe.interactionId, sessionFingerprint: probe.sessionFingerprint, runtimeEpoch: probe.runtimeEpoch, permissionRevision: probe.permissionRevision, renewalEventKey: probe.renewalEventKey, receipt: structuredClone(result) };
            }
        }));
    }
    catch {
        return { state: "uncertain", reason: "receipt_persistence_failed" };
    }
    return result;
}
function continuousReasonGuidance(reason) {
    const known = {
        continuous_delivery_disabled: '请由部署者开启持续通知配置，再点「刷新状态」。',
        budget_exhausted: '已达到你设置的暂停时长。返回设置，在「运行预算」调整时长或改为仅提醒。',
        active_probe_budget_configuration_changed: '连接预算配置需要核对。请由部署者检查预算设置。',
        active_probe_connection_not_healthy: 'QQ 连接尚未就绪。返回设置，查看连接阶段和下一步。',
        active_probe_binding_unverified: '请先确认接收账户。返回设置，完成本人 QQ 绑定。',
        active_probe_binding_changed: '接收账户已更新。返回设置核对绑定，再重新打开持续通知。',
        active_probe_permission_changed: 'QQ 权限已变化。刷新状态，按当前提示重新验证。',
        fresh_permission_required: '曾收到关闭或移除记录，尚缺当前允许事件。请核对 QQ 资料卡的接收设置后刷新。',
        active_probe_fresh_qq_permission_required: '曾收到关闭或移除记录，尚缺当前允许事件。请核对 QQ 资料卡的接收设置后刷新。',
        enrollment_outcome_requires_review: '上次验证结果待确认，请先核对 QQ 中的消息。'
    };
    return Object.hasOwn(known, reason) ? known[reason] : '当前还不能开启。返回设置查看具体阶段；仍有问题时打开诊断。';
}
function continuousDisplayView({ status, eligibility, review, deliveryEnabled }) {
    const active = status.enabled === true, awaitingProducer = status.gatewayReady === true && status.producerReady !== true;
    const quotaKnown = Number.isSafeInteger(status.remainingDaily) && status.remainingDaily >= 0 && status.remainingDaily <= 100, quotaEmpty = quotaKnown && status.remainingDaily === 0;
    let heading, reason = null;
    if (review.count) {
        heading = review.reviewable ? '上次发送结果待确认' : '最近发送正在确认';
        reason = review.reviewable ? '先查看 QQ 中的消息，再点「我已查看 QQ」。' : '请稍后点「刷新状态」，查看这次发送的结果。';
    }
    else if (eligibility.reason === 'budget_exhausted') {
        heading = '已达到你设置的暂停时长';
        reason = continuousReasonGuidance(eligibility.reason);
    }
    else if (!quotaKnown) {
        heading = '通知额度需要检查';
        reason = '返回设置打开诊断，核对当前额度记录。';
    }
    else if (quotaEmpty) {
        heading = '今日通知额度已用完';
        reason = '今天的 100 次尝试额度已用完，每日 00:00 UTC 重置。';
    }
    else if (active) {
        heading = '本轮通知已开启';
    }
    else if (awaitingProducer) {
        heading = '验证已通过，等待队列就绪';
        reason = '点「刷新状态」查看结果，也可以取消本轮开启。';
    }
    else if (deliveryEnabled !== 'true') {
        heading = '持续通知待开启';
        reason = continuousReasonGuidance('continuous_delivery_disabled');
    }
    else if (status.grantState === 'paused') {
        heading = '持续通知已暂停';
        reason = eligibility.reason ? continuousReasonGuidance(eligibility.reason) : '可以重新验证并开启下一轮通知。';
    }
    else if (eligibility.reason) {
        const titles = { active_probe_binding_unverified: '确认接收 QQ 账户', active_probe_connection_not_healthy: '等待 QQ 连接就绪', fresh_permission_required: '权限更新待确认', active_probe_fresh_qq_permission_required: '权限更新待确认', active_probe_budget_configuration_changed: '连接预算需要检查' };
        heading = Object.hasOwn(titles, eligibility.reason) ? titles[eligibility.reason] : 'QQ 设置需要检查';
        reason = continuousReasonGuidance(eligibility.reason);
    }
    else {
        heading = '准备开启本轮通知';
    }
    return { active, awaitingProducer, quotaKnown, quotaEmpty, heading, reason, canOfferEnable: !active && !awaitingProducer && !review.count && deliveryEnabled === 'true' && !eligibility.reason && quotaKnown && !quotaEmpty };
}
async function continuousPanel(actor) {
    const ctl = await continuousController(actor), status = await ctl.status();
    const review = await actor.store.transaction(async (s) => { const fingerprint = await activeBindingFingerprint(s.binding), pending = RivuleContinuous.unresolvedAttempts(s, fingerprint, actor.now()); return { count: pending.keys.length, reviewable: pending.reviewable, control: { bindingFingerprint: fingerprint, confirmedAt: s.binding?.confirmedAt, reviewDigest: await qqHash(JSON.stringify(pending.keys)) } }; });
    const eligibility = await actor.store.transaction(async (s) => {
        const p = await continuousEnrollmentEligibility(actor, s), renewal = s.qqActivePermission?.renewal;
        if (p.reason)
            return { reason: p.reason };
        if (s.qqRevoked === true && (!renewal || renewal.kind !== 'authenticated_C2C_MSG_RECEIVE' || renewal.bindingFingerprint !== p.bindingFingerprint || renewal.revision !== p.permissionRevision || renewal.eventAt > actor.now() || actor.now() - renewal.eventAt >= 300000))
            return { reason: 'fresh_permission_required' };
        if (review.count)
            return { reason: 'enrollment_outcome_requires_review' };
        return { control: { ...p, enrollmentId: crypto.randomUUID(), policyFingerprint: JSON.stringify(RivuleContinuous.POLICY) }, reason: null };
    });
    const view = continuousDisplayView({ status, eligibility, review, deliveryEnabled: actor.env.QQ_DELIVERY_ENABLED });
    const { active, awaitingProducer, heading, reason, canOfferEnable } = view;
    const stage = active ? '✓ 本轮通知' : awaitingProducer ? '◌ 通知队列' : '○ 本轮通知';
    const daily = (await actor.status()).runtimeBudget;
    const text = ['**Rivule · 持续通知**', `-# ${status.bound ? '✓ 已绑定' : '○ 待绑定'} · ${active || awaitingProducer ? '✓' : '○'} 主动验证 · ${stage}`, '', `**${heading}**`, reason,
        status.bound ? '\n发送到：已确认的本人 QQ' : '\n接收账户：尚未确认', '来源：已授权项目的全部已验证 PA', '通知：普通内容的进展 / 受阻 / 待办 / 完成',
        '\n每天最多 100 次尝试 · 每次至少间隔 3 秒', `-# 今日（UTC）还可尝试 ${view.quotaKnown ? status.remainingDaily + ' 次' : '待核对'}`,
        `-# 今日连接已用 ${setupMinutes(daily.usedMs)} · ${daily.mode === 'stop' ? '到点暂停' : '仅提醒，不暂停'} · 阈值 ${setupMinutes(daily.limitMs)}`,
        active ? '本轮通知仅在当前连接会话有效，连接变化后需重新开启；可以随时暂停。' : awaitingProducer ? null : '只发送开启后的新动态。',
        canOfferEnable ? '先发一条「Rivule 持续通知验证：通道已就绪。」；提交成功后开启本轮通知。' : null].filter(Boolean).join('\n');
    const reviewSpecs = review.reviewable ? [['continuous_review', '我已查看 QQ'], ['continuous_settings', '刷新状态'], ['status', '返回设置']] : [['continuous_settings', '刷新状态'], ['status', '返回设置']];
    if (review.count && active)
        reviewSpecs.splice(reviewSpecs.length - 1, 0, ['continuous_pause', '暂停持续通知']);
    const specs = review.count ? reviewSpecs : awaitingProducer ? [['continuous_settings', '刷新状态'], ['continuous_pause', '取消本轮开启'], ['status', '返回设置']] : active ? [['continuous_pause', '暂停持续通知'], ['status', '返回设置']] : canOfferEnable ? [['continuous_enable', '验证并开启本轮通知'], ['continuous_settings', '刷新状态'], ['status', '返回设置']] : [['continuous_settings', '刷新状态'], ['status', '返回设置']];
    return { text, specs, control: eligibility.control, reviewControl: review.control };
}
async function enableContinuousFromControl(actor, action, interactionId) {
    if (actor.env.QQ_DELIVERY_ENABLED !== 'true' || typeof action.enrollmentId !== 'string' || !/^[a-f0-9-]{36}$/.test(action.enrollmentId))
        throw Error('enrollment_control_invalid');
    const eligible = await continuousPanel(actor);
    if (!eligible.control || action.policyFingerprint !== JSON.stringify(RivuleContinuous.POLICY) || eligible.control.bindingFingerprint !== action.bindingFingerprint || eligible.control.confirmedAt !== action.confirmedAt || eligible.control.permissionRevision !== action.permissionRevision || eligible.control.renewalEventKey !== action.renewalEventKey || eligible.control.budgetRevision !== action.budgetRevision)
        throw Error('enrollment_permission_changed');
    const result = await continuousEnrollmentProbe(actor, action, interactionId);
    if (result.state !== 'sent')
        return '验证' + (result.state === 'uncertain' ? '结果待确认，请先到 QQ 核对。' : '未完成，可在诊断中查看原因。');
    const accepted = await actor.store.transaction(s => s.qqEnrollmentObservedCapability?.interactionId === interactionId && s.qqEnrollmentObservedCapability?.probeId === action.enrollmentId && s.qqEnrollmentObservedCapability?.receipt?.messageId === result.messageId);
    if (!accepted)
        throw Error('enrollment_observation_changed');
    const ctl = await continuousController(actor), remaining = (await ctl.status()).remainingRuntimeMs;
    await ctl.enroll({ ownerAuthenticated: true, interactionId, policyFingerprint: action.policyFingerprint, policyRevision: RivuleContinuous.POLICY.revision, budgetRevision: action.budgetRevision, backlog: 'new_only', startAfterRevision: 0, expiresAt: actor.now() + 300000 });
    return '验证已提交 QQ，正在开启本轮通知。';
}
async function reviewContinuousOutcome(actor, action, interactionId) {
    const result = await actor.command(() => actor.store.transaction(async (s) => {
        const fingerprint = await activeBindingFingerprint(s.binding), pending = RivuleContinuous.unresolvedAttempts(s, fingerprint, actor.now());
        if (action.bindingFingerprint !== fingerprint || action.confirmedAt !== s.binding?.confirmedAt || action.reviewDigest !== await qqHash(JSON.stringify(pending.keys)))
            throw Error('review_changed');
        return RivuleContinuous.acknowledgeUnknown(s, fingerprint, pending.keys, interactionId, actor.now());
    }));
    return `已保留 ${result.reviewed} 条核对记录。`;
}
var GatewayActor = class {
    constructor(ctx, env, { fetch: network = globalThis.fetch, WebSocket: Socket = cloudflareSocket(network), now = Date.now } = {}) {
        Object.assign(this, { ctx, env, network, Socket, now });
        this.store = new DurableStateStore(ctx.storage);
        this.commands = Promise.resolve();
        this.runtime = null;
    }
    command(fn) {
        const run = this.commands.then(fn);
        this.commands = run.catch(() => {
        });
        return run;
    }
    recordDiagnostic(record) {
        const clean = record && diagnosticRecord(record.stage, record.code, record.at, record.httpStatus, record.businessCode);
        if (!clean)
            return;
        try {
            this.ctx.waitUntil(this.store.transaction((s) => {
                s.qqConnectionDiagnostics = appendDiagnostic(s.qqConnectionDiagnostics, clean);
            }).catch(() => {
            }));
        }
        catch {
        }
    }
    config() {
        const e = this.env;
        if (e.QQ_ENABLED !== "true")
            throw Error("qq_disabled");
        if (typeof e.QQ_OWNER_ID !== "string" || e.QQ_OWNER_ID !== e.OWNER_ID || !/^\d{1,32}$/.test(e.QQ_APP_ID ?? ""))
            throw Error("identity_config_invalid");
        const budget = Number(e.QQ_DAILY_ACTIVE_BUDGET_MS);
        if (!Number.isSafeInteger(budget) || budget < 60000 || budget > DAY)
            throw Error("active_budget_required");
        return { ownerId: e.QQ_OWNER_ID, appId: e.QQ_APP_ID, allowedSources: list(e.QQ_ALLOWED_SOURCE_IDS), allowedProjects: list(e.QQ_ALLOWED_PROJECT_IDS), budget };
    }
    evidence() {
        try {
            return JSON.parse(this.env.QQ_CAPABILITIES_JSON ?? "null");
        }
        catch {
            return null;
        }
    }
    async configuredRuntime() {
        const c = this.config();
        if (!this.runtime) {
            const runtime = createQQRuntime({
                store: this.store,
                appId: c.appId,
                ownerId: c.ownerId,
                secret: () => this.env.QQ_APP_SECRET,
                fetch: this.network,
                WebSocket: this.Socket,
                now: this.now,
                setInterval: () => 1,
                clearInterval: () => {
                },
                onStatus: (status) => this.ctx.waitUntil(this.handleStatus(status)),
                onDiagnostic: (record) => this.recordDiagnostic(record)
            });
            runtime.client.onSessionInvalidated = (rejected) => this.command(async () => {
                if (this.runtime !== runtime)
                    return false;
                try {
                    return await this.store.transaction((state) => {
                        const saved = state.gatewaySession;
                        if (saved && (saved.session !== rejected.session || !Number.isSafeInteger(saved.sequence)
                            || !Number.isSafeInteger(rejected.sequence) || saved.sequence > rejected.sequence))
                            return false;
                        if (runtime.client.generation !== rejected.generation && !runtime.client.stopped)
                            return false;
                        delete state.gatewaySession;
                        this.unhealthy(state, "connection_unavailable");
                        return true;
                    });
                }
                catch (error) {
                    this.store.qqIngestionFault = true;
                    runtime.stop();
                    try {
                        await this.store.transaction((state) => {
                            state.control = { running: false, reason: "session_invalidation_failed" };
                            state.qqIngestionHealth = { healthy: false, reason: "session_invalidation_failed", failedAt: this.now() };
                        });
                    }
                    catch { }
                    throw error;
                }
            });
            const dispatch = runtime.client.onDispatch;
            runtime.client.onDispatch = (event, auth) => this.command(async () => {
                try {
                    await dispatch(event, auth);
                    await this.store.transaction((state) => {
                        state.gatewaySession = { session: runtime.client.session, sequence: event.s };
                        if (state.qqContinuous?.grant && state.qqContinuous.grant.permissionKey !== ((p) => JSON.stringify([p?.eventKey, p?.revision, p?.confirmedAt, p?.bindingFingerprint, p?.sessionFingerprint]))(continuousPermissionProof(state)))
                            RivuleContinuous.pause(state, 'permission_changed', this.now());
                    });
                }
                catch (error) {
                    this.store.qqIngestionFault = true;
                    try {
                        await this.store.transaction((state) => {
                            state.qqIngestionHealth = { healthy: false, reason: "session_persistence_failed", failedAt: this.now() };
                        });
                    }
                    catch {
                    }
                    throw error;
                }
            });
            await this.store.transaction((state) => {
                const session = state.gatewaySession;
                if (typeof session?.session === "string" && Number.isSafeInteger(session.sequence)) {
                    runtime.client.session = session.session;
                    runtime.client.sequence = session.sequence;
                }
            });
            this.runtime = runtime;
        }
        return this.runtime;
    }
    async ensureRuntime() {
        await this.configuredRuntime();
        await this.runtime.start();
    }
    unhealthy(state, reason) {
        if (state.qqIngestionHealth?.healthy === false && !["connection_not_ready", "connection_unavailable"].includes(state.qqIngestionHealth.reason))
            return;
        state.qqIngestionHealth = { healthy: false, reason, failedAt: this.now() };
    }
    async handleStatus(status) {
        return this.command(async () => {
            const live = this.runtime?.client;
            this.continuousSessionFingerprint = typeof live?.session === "string" ? await qqHash(live.session) : null;
            await this.store.transaction((state) => {
                if (!state.control?.running)
                    return;
                if (status.state === "ready" && live?.ready) {
                    if (!state.qqIngestionHealth || ["connection_not_ready", "connection_unavailable"].includes(state.qqIngestionHealth.reason))
                        state.qqIngestionHealth = { healthy: true, connectedAt: this.now() };
                    state.gatewaySession = { session: live.session, sequence: live.sequence };
                }
                else if (["connecting", "connection_unavailable", "connection_failed", "protocol_error", "frame_backpressure", "heartbeat_timeout"].includes(status.state))
                    this.unhealthy(state, "connection_unavailable");
            });
            await this.arm();
        });
    }
    async accountBudget() {
        const c = this.config(), now = this.now(), day = Math.floor(now / DAY);
        return this.store.transaction((state) => {
            const running = state.control?.running;
            if (state.activeBudget === null || (state.activeBudget === undefined && running === true))
                throw Error("runtime_budget_ledger_invalid");
            let b = state.activeBudget ?? { day, usedMs: 0, lastAt: now };
            if (!Number.isSafeInteger(b.day) || b.day < 0 || b.day > day || !Number.isFinite(b.usedMs) || b.usedMs < 0 || !Number.isSafeInteger(b.lastAt) || b.lastAt < 0 || b.lastAt > now)
                throw Error("runtime_budget_ledger_invalid");
            runtimeBudgetPolicy(state, c.budget);
            if (b.day !== day)
                b = { day, usedMs: running ? Math.max(0, now - day * DAY) : 0, lastAt: now };
            else if (running)
                b.usedMs += Math.max(0, now - b.lastAt);
            b.lastAt = now;
            state.activeBudget = b;
            const view = runtimeBudgetView(state, c.budget, now);
            return { exhausted: view.exhausted, remaining: view.availableMs, warningReached: view.warningReached, mode: view.mode };
        });
    }
    async arm() {
        try {
            return await this.planAlarm();
        }
        catch (error) {
            this.runtime?.stop();
            this.store.qqIngestionFault = true;
            throw error;
        }
    }
    async planAlarm() {
        const control = await this.store.transaction((state2) => state2.control);
        if (!control?.running) {
            await this.ctx.storage.deleteAlarm();
            return;
        }
        const c = this.config(), view = await this.store.transaction(s => runtimeBudgetView(s, c.budget, this.now()));
        const client = this.runtime?.client, now = this.now();
        const times = [now + 3e4, ...view.mode === "stop" ? [now + view.remainingMs] : []];
        if (client?.ws) {
            if (!client.ready)
                times.push(client.deadline);
            if (client.hello)
                times.push(client.nextBeat);
        }
        else if (Number.isFinite(client?.retryAt))
            times.push(client.retryAt);
        await this.ctx.storage.setAlarm(Math.max(now + 1e3, Math.min(...times.filter(Number.isFinite))));
    }
    async requestStart() {
        return this.command(async () => {
            this.config();
            const budget = await this.accountBudget();
            if (budget.exhausted)
                throw Error("active_budget_exhausted");
            await this.store.transaction((state) => {
                if (!state.control?.running)
                    state.qqConnectionStartedAt = this.now();
                state.control = { running: true };
                this.unhealthy(state, "connection_not_ready");
            });
            try {
                await this.ctx.storage.setAlarm(this.now() + 1e3);
            }
            catch (error) {
                await this.stopInternal("alarm_failed");
                throw error;
            }
            return { state: "scheduled", budgetRemainingMs: budget.remaining };
        });
    }
    async start() {
        return this.command(async () => {
            this.config();
            const budget = await this.accountBudget();
            if (budget.exhausted)
                throw Error("active_budget_exhausted");
            await this.store.transaction((state) => {
                if (!state.control?.running)
                    state.qqConnectionStartedAt = this.now();
                state.control = { running: true };
                this.unhealthy(state, "connection_not_ready");
            });
            await this.arm();
            await this.ensureRuntime();
            await this.arm();
            return { state: "starting", budgetRemainingMs: budget.remaining };
        });
    }
    async stopInternal(reason) {
        this.runtime?.stop();
        await this.store.transaction((state) => {
            state.control = { running: false, reason };
            this.unhealthy(state, "connection_unavailable");
        });
        await this.ctx.storage.deleteAlarm();
    }
    async stop() {
        return this.command(async () => {
            await this.accountBudget();
            await this.stopInternal("owner_stopped");
            return { state: "stopped" };
        });
    }
    async alarm() {
        return this.command(async () => {
            this.recordDiagnostic(diagnosticRecord("alarm", "started", this.now()));
            const running = await this.store.transaction((state) => state.control?.running);
            if (!running) {
                await this.ctx.storage.deleteAlarm();
                this.recordDiagnostic(diagnosticRecord("alarm", "completed", this.now()));
                return;
            }
            if (this.env.QQ_ENABLED !== "true") {
                await this.stopInternal("configuration_disabled");
                this.recordDiagnostic(diagnosticRecord("alarm", "completed", this.now()));
                return;
            }
            const budget = await this.accountBudget();
            if (budget.exhausted) {
                await this.stopInternal("active_budget_exhausted");
                this.recordDiagnostic(diagnosticRecord("alarm", "completed", this.now()));
                return;
            }
            let alarmFailed = false;
            try {
                if (!this.runtime)
                    await this.store.transaction((state) => this.unhealthy(state, "connection_not_ready"));
                await this.ensureRuntime();
                await this.runtime.client.tick();
            }
            catch {
                alarmFailed = true;
                this.recordDiagnostic(diagnosticRecord("alarm", "failed", this.now()));
                this.runtime?.stop();
                this.store.qqIngestionFault = true;
                await this.store.transaction((state) => {
                    state.qqIngestionHealth = { healthy: false, reason: "alarm_failed", failedAt: this.now() };
                });
            }
            finally {
                await this.arm();
                if (!alarmFailed)
                    this.recordDiagnostic(diagnosticRecord("alarm", "completed", this.now()));
            }
        }).catch((error) => {
            this.recordDiagnostic(diagnosticRecord("alarm", "failed", this.now()));
            throw error;
        });
    }
    async beginBinding() {
        return this.command(async () => {
            const running = await this.store.transaction((state) => state.control?.running);
            if (!running || !this.runtime)
                throw Error("gateway_not_started");
            return this.runtime.binding.begin();
        });
    }
    async confirmBinding(id2) {
        return this.command(async () => {
            if (!this.runtime)
                throw Error("gateway_not_started");
            return this.runtime.binding.confirm(id2);
        });
    }
    async reviewAndDrainInbox(options) {
        const runtime = await this.command(async () => {
            const running = await this.store.transaction((state) => state.control?.running);
            if (running)
                throw Error("stop_before_review");
            await this.configuredRuntime();
            return this.runtime;
        });
        await runtime.client.serial;
        return this.command(async () => {
            const running = await this.store.transaction((state) => state.control?.running);
            if (running || runtime !== this.runtime || !runtime.client.stopped)
                throw Error("stop_before_review");
            return runtime.reviewAndDrainInbox(options);
        });
    }
    async updateRuntimeBudget(action) {
        return this.command(async () => {
            await this.accountBudget();
            const result = await this.store.transaction(state => {
                const old = runtimeBudgetPolicy(state, this.config().budget);
                if (action.budgetRevision !== old.revision)
                    throw Error("runtime_budget_policy_changed");
                const mode = action.action === "budget_warn" ? "warn" : action.action === "budget_stop" ? "stop" : old.mode;
                const limitMs = action.action === "budget_less" ? Math.max(60000, old.limitMs - 1800000) : action.action === "budget_more" ? Math.min(86400000, old.limitMs + 1800000) : action.action === "budget_reset" ? 7200000 : old.limitMs;
                if (old.revision >= Number.MAX_SAFE_INTEGER)
                    throw Error("runtime_budget_policy_invalid");
                state.qqRuntimeBudgetPolicy = { version: 1, mode, limitMs, revision: old.revision + 1 };
                RivuleContinuous.pause(state, "runtime_budget_policy_changed", this.now());
                return runtimeBudgetView(state, this.config().budget, this.now());
            });
            if (result.exhausted)
                await this.stopInternal("active_budget_exhausted");
            else
                await this.arm();
            return result;
        });
    }
    async status() {
        return this.store.transaction(async (state) => ({ runtimeBudget: state.activeBudget !== undefined || state.control?.running === true ? runtimeBudgetView(state, this.config().budget, this.now()) : { usedMs: 0, remainingMs: runtimeBudgetPolicy(state, this.config().budget).limitMs, limitMs: runtimeBudgetPolicy(state, this.config().budget).limitMs, ...runtimeBudgetPolicy(state, this.config().budget), warningReached: false, exhausted: false }, permissionEvidence: await continuousPermissionDiagnostic(this, state), running: state.control?.running === true, stopReason: state.control?.reason ?? null, connected: this.runtime?.client.ready === true, bound: !!state.binding, ingestionHealthy: state.qqIngestionHealth?.healthy === true, revoked: state.qqRevoked === true, inboxCount: state.inbox?.length ?? 0, budget: state.activeBudget ?? null, connectionStartedAt: diagnosticTime(state.qqConnectionStartedAt), connectionDiagnostics: diagnosticSnapshot(state.qqConnectionDiagnostics), pendingPairing: state.pairing?.candidate ? { confirmationId: state.pairing.candidate.confirmationId, userOpenId: state.pairing.candidate.userOpenId } : null }));
    }
    async receiveBridge(packet) {
        if (this.env.QQ_DELIVERY_ENABLED === 'true') {
            await check(this.env.QQ_BRIDGE_SECRET, 'rivule-qq-request-v1', packet);
            const body = JSON.stringify({ requestHash: await hash(packet.body), receipt: { state: 'blocked', reason: 'continuous_protocol_required' } });
            return { body, signature: await hmac(this.env.QQ_BRIDGE_SECRET, 'rivule-qq-response-v1', body) };
        }
        const c = this.config();
        const snapshot = await this.command(async () => {
            const budget = await this.accountBudget();
            if (budget.exhausted)
                await this.stopInternal("active_budget_exhausted");
            return this.store.transaction((state) => ({ binding: state.binding, running: state.control?.running, health: state.qqIngestionHealth }));
        });
        const config = { enabled: this.env.QQ_DELIVERY_ENABLED === "true", appId: c.appId, ownerId: c.ownerId, userOpenId: snapshot.binding?.userOpenId ?? "unbound", appSecret: () => this.env.QQ_APP_SECRET, allowedSources: c.allowedSources, allowedProjects: c.allowedProjects, allowedImageOrigins: [], evidence: () => this.evidence() };
        const expectedRuntime = this.runtime, expectedClient = this.runtime?.client, expectedGeneration = expectedClient?.generation;
        config.dispatchMessage = (sendMessage) => this.command(async () => {
            const current = this.config();
            if (this.env.QQ_DELIVERY_ENABLED !== "true" || current.ownerId !== c.ownerId || current.appId !== c.appId || current.budget !== c.budget
                || JSON.stringify(current.allowedSources) !== JSON.stringify(c.allowedSources) || JSON.stringify(current.allowedProjects) !== JSON.stringify(c.allowedProjects))
                throw Error("qq_dispatch_configuration_changed");
            const budgetCheckedAt = this.now();
            const budget = await this.accountBudget();
            if (budget.exhausted || !Number.isFinite(budget.remaining) || budget.remaining <= 0) {
                await this.stopInternal("active_budget_exhausted");
                throw Error("qq_dispatch_budget_exhausted");
            }
            const allowed = await this.store.transaction((state) => {
                const b = state.binding, expected = snapshot.binding;
                return state.control?.running === true && !storeFault(this.store, state) && state.qqIngestionHealth?.healthy === true && state.qqRevoked !== true
                    && b?.ownerId === c.ownerId && b?.appId === c.appId && b?.userOpenId === expected?.userOpenId
                    && Number.isSafeInteger(b?.confirmedAt) && b.confirmedAt >= 0 && b.confirmedAt <= this.now() && b.confirmedAt === expected?.confirmedAt;
            });
            const now = this.now(), e = this.evidence();
            if (now < budgetCheckedAt || now - budgetCheckedAt >= budget.remaining) {
                await this.stopInternal("active_budget_exhausted");
                throw Error("qq_dispatch_budget_exhausted");
            }
            if (!allowed || this.runtime !== expectedRuntime || this.runtime?.client !== expectedClient || this.runtime?.client.generation !== expectedGeneration || this.runtime?.client.ready !== true
                || !e || e.identity !== true || e.proactive !== true || !Number.isFinite(e.checkedAt) || !Number.isFinite(e.validUntil)
                || e.checkedAt > now || e.checkedAt >= e.validUntil || e.validUntil <= now)
                throw Error("qq_dispatch_permission_changed");
            return { response: Promise.resolve(sendMessage()).then(value => ({ value }), () => ({ networkError: true })) };
        });
        const deliver = createQQDelivery({ store: this.store, config, fetch: this.network, now: this.now });
        const bridge = new NotificationBridge({
            store: this.store,
            key: () => this.env.QQ_BRIDGE_SECRET,
            appId: c.appId,
            ownerId: c.ownerId,
            allowedSourceIds: c.allowedSources,
            allowedProjectIds: c.allowedProjects,
            enabled: config.enabled && snapshot.running === true && this.runtime?.client.ready === true,
            evidence: () => this.evidence(),
            now: this.now,
            deliver
        });
        return bridge.receive(packet);
    }
};
var QQGatewayObject = class extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.actor = new GatewayActor(ctx, env);
    }
    start() {
        return this.actor.start();
    }
    stop() {
        return this.actor.stop();
    }
    beginBinding() {
        return this.actor.beginBinding();
    }
    confirmBinding(id2) {
        return this.actor.confirmBinding(id2);
    }
    reviewAndDrainInbox(options) {
        return this.actor.reviewAndDrainInbox(options);
    }
    status() {
        return this.actor.status();
    }
    receiveBridge(packet) {
        return this.actor.receiveBridge(packet);
    }
    continuousRequest(packet) {
        return continuousRequest(this.actor, packet);
    }
    ownerSetup(p) {
        return ownerSetup(this.actor, p);
    }
    alarm() {
        return this.actor.alarm();
    }
    async fetch() {
        return new Response("Not found", { status: 404 });
    }
};
var worker_default = { async fetch() {
        return new Response("Not found", { status: 404 });
    } };
export { QQGatewayObject, worker_default as default };
