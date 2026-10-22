import { isRoutineProgress, sameNotificationBranch, routineDueAt, formatQQNotification } from "./notification-policy.mjs";
// Rivule — AGPL-3.0. Third-party notices: ../../third-party-licenses/
var Rejected = class extends Error {
    code;
    status;
    constructor(code, status = 422) {
        super(code);
        this.code = code;
        this.status = status;
    }
};
var idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
var terminal = new Set(["completed", "failed", "cancelled"]);
var kindStatus = { registered: "proposed", started: "running", needs_input: "needs_input", completed: "completed", failed: "failed", cancelled: "cancelled" };
var kinds = new Set([...Object.keys(kindStatus), "progress", "heartbeat", "correction"]);
var statuses = new Set(["proposed", "running", "needs_input", ...terminal]);
function object(v) {
    if (v === null || typeof v !== "object" || Array.isArray(v))
        throw new Rejected("invalid_contract");
    return v;
}
function keys(v, allowed) {
    if (Object.keys(v).some((k) => !allowed.includes(k)))
        throw new Rejected("unknown_field");
}
function identifier(v) {
    if (typeof v !== "string" || !idPattern.test(v))
        throw new Rejected("invalid_id");
    return v;
}
function text(v, max, min = 0) {
    if (typeof v !== "string" || [...v].length < min || [...v].length > max)
        throw new Rejected("invalid_text");
    for (const c of v) {
        const n = c.codePointAt(0);
        if (n < 32 && n !== 9 && n !== 10 || n >= 55296 && n <= 57343 || /[\u202a-\u202e\u2066-\u2069]/.test(c))
            throw new Rejected("invalid_text");
    }
    return v;
}
function timestamp(v) {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(v) || !Number.isFinite(Date.parse(v)))
        throw new Rejected("invalid_time");
    const year = +v.slice(0, 4), month = +v.slice(5, 7), day = +v.slice(8, 10);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const max = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    if (month < 1 || month > 12 || day < 1 || day > max || +v.slice(11, 13) > 23 || +v.slice(14, 16) > 59 || +v.slice(17, 19) > 59)
        throw new Rejected("invalid_time");
    return new Date(v).toISOString();
}
function safeUrl(v) {
    if (v === null || v === void 0)
        return null;
    if (typeof v !== "string" || v.length > 1600 || /[\s\\]/.test(v))
        throw new Rejected("invalid_link");
    let u;
    try {
        u = new URL(v);
    }
    catch {
        throw new Rejected("invalid_link");
    }
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.port && u.port !== "443" || !u.hostname.includes(".") || u.hostname.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || /\.(local|localhost|internal)$/.test(u.hostname))
        throw new Rejected("invalid_link");
    return v;
}
function validateEvent(raw, source, now) {
    const v = object(raw);
    keys(v, ["schema_version", "event_id", "source_id", "project_id", "task_id", "run_id", "branch_id", "project_name", "task_name", "branch_name", "kind", "source_status", "source_seq", "occurred_at", "summary", "phase_id", "phase_label", "progress", "blocker", "action", "source_url", "sensitivity", "correction_of"]);
    if (v.schema_version !== void 0 && v.schema_version !== "1.0")
        throw new Rejected("invalid_version");
    const e = {
        schema_version: "1.0",
        event_id: identifier(v.event_id),
        source_id: identifier(v.source_id),
        project_id: identifier(v.project_id),
        task_id: identifier(v.task_id),
        run_id: identifier(v.run_id),
        branch_id: identifier(v.branch_id ?? "main"),
        project_name: text(v.project_name, 120, 1),
        task_name: text(v.task_name, 120, 1),
        branch_name: text(v.branch_name ?? "\u4E3B\u8DEF\u7EBF", 80, 1),
        kind: v.kind,
        source_status: v.source_status,
        source_seq: v.source_seq ?? null,
        occurred_at: timestamp(v.occurred_at),
        summary: text(v.summary ?? "", 1200),
        phase_id: v.phase_id ?? null,
        phase_label: v.phase_label ?? null,
        progress: null,
        blocker: v.blocker ?? null,
        action: null,
        source_url: safeUrl(v.source_url),
        sensitivity: v.sensitivity ?? "normal",
        correction_of: v.correction_of ?? null
    };
    if (e.source_id !== source.source_id || !source.enabled)
        throw new Rejected("source_not_authorized", 403);
    if (!kinds.has(e.kind) || !statuses.has(e.source_status) || kindStatus[e.kind] && kindStatus[e.kind] !== e.source_status)
        throw new Rejected("invalid_state");
    if (e.source_seq !== null && (!Number.isSafeInteger(e.source_seq) || e.source_seq < 0))
        throw new Rejected("invalid_sequence");
    if (Date.parse(e.occurred_at) > now + 3e5)
        throw new Rejected("future_timestamp", 409);
    if (e.phase_id === null !== (e.phase_label === null))
        throw new Rejected("invalid_phase");
    if (e.phase_id !== null) {
        identifier(e.phase_id);
        text(e.phase_label, 100, 1);
    }
    if (e.blocker !== null)
        text(e.blocker, 400);
    if (!["normal", "restricted", "secret"].includes(e.sensitivity))
        throw new Rejected("invalid_sensitivity");
    if (e.sensitivity === "secret")
        throw new Rejected("secret_content_not_authorized", 403);
    if (e.source_url && !source.allowed_hosts.includes(new URL(e.source_url).hostname))
        throw new Rejected("source_link_not_authorized", 403);
    if (e.kind === "progress" && terminal.has(e.source_status))
        throw new Rejected("invalid_terminal_kind");
    if (e.kind === "correction") {
        identifier(e.correction_of);
    }
    else if (e.correction_of !== null)
        throw new Rejected("invalid_correction");
    if (v.progress !== null && v.progress !== void 0) {
        const p = object(v.progress);
        keys(p, ["done", "total", "unit"]);
        const total = p.total ?? null;
        if (typeof p.done !== "number" || !Number.isFinite(p.done) || p.done < 0 || total !== null && (typeof total !== "number" || !Number.isFinite(total) || total <= 0 || p.done > total))
            throw new Rejected("invalid_progress");
        e.progress = { done: p.done, total, unit: text(p.unit, 40, 1) };
    }
    if (v.action !== null && v.action !== void 0) {
        const a = object(v.action);
        keys(a, ["request_id", "question", "impact", "expires_at", "mode"]);
        if ((a.mode ?? "return_to_source") !== "return_to_source")
            throw new Rejected("upstream_approval_not_supported");
        e.action = { request_id: identifier(a.request_id), question: text(a.question, 400, 1), impact: text(a.impact ?? "\u672A\u63D0\u4F9B", 300), expires_at: a.expires_at == null ? null : timestamp(a.expires_at), mode: "return_to_source" };
    }
    if (e.source_status === "needs_input" !== (e.action !== null))
        throw new Rejected("invalid_action_state");
    return e;
}
function projection(e) {
    const p = structuredClone(e);
    if (p.sensitivity === "restricted") {
        Object.assign(p, { project_name: "\u53D7\u9650\u9879\u76EE", task_name: "\u53D7\u9650\u4EFB\u52A1", branch_name: "\u53D7\u9650\u8DEF\u7EBF", summary: "\u6709\u66F4\u65B0\uFF0C\u8BF7\u56DE\u539F\u5E73\u53F0\u67E5\u770B", blocker: null, progress: null });
        if (p.phase_label)
            p.phase_label = "\u8BF7\u56DE\u539F\u5E73\u53F0\u67E5\u770B";
        if (p.action)
            Object.assign(p.action, { question: "\u6709\u4E8B\u9879\u9700\u8981\u4F60\u51B3\u5B9A\uFF0C\u8BF7\u56DE\u539F\u5E73\u53F0\u67E5\u770B", impact: "\u8BF7\u5728\u539F\u5E73\u53F0\u67E5\u770B\u5F71\u54CD" });
    }
    return p;
}
var enc = new TextEncoder();
var hex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
var hash = async (text2) => hex(await crypto.subtle.digest("SHA-256", enc.encode(text2)));
async function key(raw) {
    if (typeof raw !== "string" || raw.length < 32)
        throw Error("bridge_key_unavailable");
    return crypto.subtle.importKey("raw", enc.encode(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
var hmac = async (raw, domain, body) => hex(await crypto.subtle.sign("HMAC", await key(raw), enc.encode(domain + "\n" + body)));
var verifyHmac = async (raw, domain, body, signature) => crypto.subtle.verify("HMAC", await key(raw), Uint8Array.from(signature.match(/../g), (v) => parseInt(v, 16)), enc.encode(domain + "\n" + body));
async function check(key2, domain, packet) {
    if (typeof packet?.body !== "string" || new TextEncoder().encode(packet.body).byteLength > 65536 || typeof packet.signature !== "string" || !/^[a-f0-9]{64}$/.test(packet.signature))
        throw Error("bridge_auth_invalid");
    if (!await verifyHmac(key2, domain, packet.body, packet.signature))
        throw Error("bridge_auth_invalid");
    return JSON.parse(packet.body);
}
async function signBridgeRequest({ job, nonce, now = Date.now() }, key2) {
    const body = JSON.stringify({ version: 1, timestamp: now, nonce, job });
    return { body, signature: await hmac(key2, "rivule-qq-request-v1", body) };
}
async function verifyBridgeResponse(packet, request, key2) {
    const value = await check(key2, "rivule-qq-response-v1", packet);
    if (value.requestHash !== await hash(request.body) || !value.receipt)
        throw Error("bridge_response_mismatch");
    return value.receipt;
}
async function jobFromAccepted({ receiptId, loadAccepted, ownerId, appId, sources, allowedSourceIds, allowedProjectIds, now = Date.now() }) {
    if (!/^rcpt_[a-f0-9]{32}$/.test(receiptId))
        throw Error("invalid_receipt");
    const record = await loadAccepted(receiptId);
    if (!record || record.receiptId !== receiptId || record.decision !== "applied")
        throw Error("accepted_event_required");
    const source = sources.find((s) => s.enabled && s.source_id === record.source?.source_id);
    if (!source || JSON.stringify(source) !== JSON.stringify(record.source) || !allowedSourceIds.includes(source.source_id))
        throw Error("source_not_authorized");
    const event = projection(validateEvent(record.event, source, now));
    if (event.kind === "heartbeat" || !allowedProjectIds.includes(event.project_id))
        throw Error("project_or_event_not_authorized");
    const content = formatQQNotification(event, source, now, { includeSourceUrl: true });
    return { ownerId, appId, sourceId: event.source_id, projectId: event.project_id, eventId: event.event_id, receiptId, content };
}
async function dispatchAcceptedQQ({ receiptId, loadAccepted, ownerId, appId, sources, allowedSourceIds, allowedProjectIds, bridgeKey, stub, now = Date.now() }) {
    const job = await jobFromAccepted({ receiptId, loadAccepted, ownerId, appId, sources, allowedSourceIds, allowedProjectIds, now });
    const key2 = await bridgeKey();
    const request = await signBridgeRequest({ job, nonce: crypto.randomUUID(), now }, key2);
    try {
        return await verifyBridgeResponse(await stub.receiveBridge(request), request, key2);
    }
    catch {
        return { state: "uncertain", reason: "bridge_outcome_unknown" };
    }
}
function bridgeConfig(env, ownerId) {
    if (env.QQ_ENABLED !== "true")
        return null;
    if (env.QQ_OWNER_ID !== ownerId || !/^\d{1,32}$/.test(env.QQ_APP_ID ?? ""))
        throw Error("qq_identity_invalid");
    const list = (name) => {
        const v = JSON.parse(env[name] ?? "[]");
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string") || new Set(v).size !== v.length)
            throw Error("qq_scope_invalid");
        return v;
    };
    return { enabled: env.QQ_DELIVERY_ENABLED === "true", ownerId, appId: env.QQ_APP_ID, allowedSources: list("QQ_ALLOWED_SOURCE_IDS"), allowedProjects: list("QQ_ALLOWED_PROJECT_IDS"), evidence: () => {
            try {
                return JSON.parse(env.QQ_CAPABILITIES_JSON ?? "{}");
            }
            catch {
                return {};
            }
        } };
}
var QQBridgeQueue = class {
    storage;
    env;
    ownerId;
    sources;
    transport;
    now;
    busy = false;
    constructor(storage, env, ownerId, sources, transport = fetch, now = Date.now) {
        this.storage = storage;
        this.env = env;
        this.ownerId = ownerId;
        this.sources = structuredClone(sources);
        this.transport = transport;
        this.now = now;
        this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS qq_outbox(source_id TEXT NOT NULL,receipt_id TEXT NOT NULL,event_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,created_at REAL NOT NULL,result TEXT,PRIMARY KEY(source_id,receipt_id));CREATE TABLE IF NOT EXISTS qq_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    }
    rows(query, ...args) {
        return this.storage.sql.exec(query, ...args).toArray();
    }
    config() {
        return bridgeConfig(this.env, this.ownerId);
    }
    async initialize() {
        const c = this.config();
        await this.storage.transaction(async () => {
            if (c) {
                const binding = JSON.stringify([c.ownerId, c.appId, "durable-owner-binding-v1"]), old = this.rows("SELECT value FROM qq_meta WHERE key='binding'")[0];
                if (old && old.value !== binding)
                    throw Error("qq_persisted_binding_mismatch");
                this.rows("INSERT OR IGNORE INTO qq_meta(key,value) VALUES('binding',?)", binding);
            }
            this.rows("UPDATE qq_outbox SET status='uncertain',result=? WHERE status='sending'", JSON.stringify({ state: "uncertain", reason: "restart_during_dispatch" }));
        });
    }
    enqueue(event, receiptId) {
        const c = this.config();
        if (!c?.enabled || !c.allowedSources.includes(event.source_id) || !c.allowedProjects.includes(event.project_id))
            return false;
        const source = this.sources.find((s) => s.source_id === event.source_id && s.enabled);
        if (!source)
            return false;
        const e = projection(validateEvent(event, source, this.now()));
        if (e.kind === "heartbeat")
            return false;
        if (typeof receiptId !== "string" || !/^rcpt_[a-f0-9]{32}$/.test(receiptId))
            throw Error("qq_accepted_receipt_invalid");
        const payload = JSON.stringify(e), prior = this.rows("SELECT payload FROM qq_outbox WHERE source_id=? AND receipt_id=?", e.source_id, receiptId)[0];
        if (prior) {
            if (prior.payload !== payload)
                throw Error("qq_outbox_conflict");
            return false;
        }
        if (this.rows("SELECT COUNT(*) AS n FROM qq_outbox")[0].n >= 1e4)
            throw Error("qq_outbox_budget_reached");
        this.rows("INSERT INTO qq_outbox(source_id,receipt_id,event_id,payload,status,created_at) VALUES(?,?,?,?,'queued',?)", e.source_id, receiptId, e.event_id, payload, this.now());
        return true;
    }
    nextAlarmAt() {
        const c = this.config();
        if (!c?.enabled)
            return null;
        const evidence = c.evidence();
        if (!evidence.identity || !evidence.proactive || !Number.isFinite(evidence.checkedAt) || !Number.isFinite(evidence.validUntil) || evidence.checkedAt > this.now() || evidence.validUntil <= this.now())
            return null;
        if (this.rows("SELECT 1 FROM qq_outbox WHERE status IN ('sending','uncertain','blocked','not_sent') LIMIT 1").length)
            return null;
        const first = this.rows("SELECT MIN(created_at) AS at FROM qq_outbox WHERE status='queued'")[0]?.at;
        if (first == null)
            return null;
        const pace = Number(this.rows("SELECT value FROM qq_meta WHERE key='next_send_at'")[0]?.value ?? 0);
        return Math.max(first, pace);
    }
    receipt(source, receiptId) {
        const configured = this.sources.find((s) => s.source_id === source.source_id && s.enabled);
        if (!configured || JSON.stringify(configured) !== JSON.stringify(source))
            throw Error("qq_source_not_authorized");
        const row = this.rows("SELECT status,result FROM qq_outbox WHERE source_id=? AND receipt_id=?", source.source_id, receiptId)[0];
        if (!row)
            return null;
        return row.result ? JSON.parse(row.result) : { state: row.status, reason: row.status === "sending" ? "reserved_before_send" : "awaiting_dispatch" };
    }
    async drain() {
        if (this.busy)
            return { state: "busy", reason: "already_running" };
        this.busy = true;
        let job;
        try {
            const due = this.nextAlarmAt();
            if (due === null || due > this.now())
                return { state: "idle", reason: "nothing_due" };
            await this.storage.transaction(async () => {
                if (this.rows("SELECT 1 FROM qq_outbox WHERE status IN ('sending','uncertain','blocked','not_sent') LIMIT 1").length)
                    return;
                job = this.rows("SELECT * FROM qq_outbox WHERE status='queued' ORDER BY created_at,receipt_id LIMIT 1")[0];
                if (job)
                    this.rows("UPDATE qq_outbox SET status='sending' WHERE source_id=? AND receipt_id=? AND status='queued'", job.source_id, job.receipt_id);
            });
            if (!job)
                return { state: "idle", reason: "nothing_due" };
            await this.storage.sync();
            const c = this.config();
            const source = this.sources.find((s) => s.source_id === job.source_id && s.enabled);
            let result;
            if (!c?.enabled || !source)
                result = { state: "blocked", reason: "binding_not_authorized" };
            else {
                const e = projection(validateEvent(JSON.parse(job.payload), source, this.now()));
                const row = this.rows("SELECT receipt,source_id,payload,decision FROM events WHERE receipt=?", job.receipt_id)[0];
                const accepted = row ? { receiptId: row.receipt, decision: row.decision, source: this.sources.find((s) => s.source_id === row.source_id), event: JSON.parse(row.payload) } : null;
                if (!accepted || JSON.stringify(projection(validateEvent(accepted.event, source, this.now()))) !== job.payload)
                    result = { state: "blocked", reason: "accepted_event_mismatch" };
                else
                    result = await dispatchAcceptedQQ({ receiptId: job.receipt_id, loadAccepted: async () => accepted, ownerId: this.ownerId, appId: c.appId, sources: this.sources, allowedSourceIds: c.allowedSources, allowedProjectIds: c.allowedProjects, bridgeKey: () => this.env.QQ_BRIDGE_SECRET, stub: this.env.QQ_GATEWAY.get(this.env.QQ_GATEWAY.idFromName("qq:" + this.ownerId)), now: this.now() });
            }
            await this.storage.transaction(async () => {
                this.rows("UPDATE qq_outbox SET status=?,result=? WHERE source_id=? AND receipt_id=?", result.state, JSON.stringify(result), job.source_id, job.receipt_id);
                this.rows("INSERT INTO qq_meta(key,value) VALUES('next_send_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(this.now() + 3100));
            });
            await this.storage.sync();
            return result;
        }
        catch {
            if (job) {
                try {
                    this.rows("UPDATE qq_outbox SET status='uncertain',result=? WHERE source_id=? AND receipt_id=?", JSON.stringify({ state: "uncertain", reason: "queue_outcome_unknown" }), job.source_id, job.receipt_id);
                    await this.storage.sync();
                }
                catch {
                }
            }
            return { state: "uncertain", reason: "queue_outcome_unknown" };
        }
        finally {
            this.busy = false;
        }
    }
};
var PREFIX = "qqsetup:";
var reply = (content, components = []) => ({ type: 4, data: { content, components, flags: 64, allowed_mentions: { parse: [] } } });
function isQQSetup(p) {
    return p?.type === 3 && typeof p.data?.custom_id === "string" && p.data.custom_id.startsWith(PREFIX);
}
function setupFailureCode(error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "setup_control_expired")
        return "setup_control_expired";
    if (code === "active_budget_exhausted")
        return "setup_budget_exhausted";
    if (["qq_disabled", "identity_config_invalid", "active_budget_required", "invalid_scope"].includes(code))
        return "setup_config_unavailable";
    if (code === "gateway_not_started")
        return "setup_gateway_not_ready";
    if (["owner_setup_identity_required", "owner_setup_install_required", "invalid_setup_control"].includes(code))
        return "setup_identity_rejected";
    return "setup_rejected";
}
function setupFailureMessage(error) {
    const code = setupFailureCode(error);
    if (code === "setup_control_expired")
        return "\u8FD9\u4E2A\u8BBE\u7F6E\u6309\u94AE\u5DF2\u8FC7\u671F\u3001\u5DF2\u4F7F\u7528\u6216\u88AB\u65B0\u9762\u677F\u66FF\u6362\uFF0C\u672A\u6267\u884C\u64CD\u4F5C\u3002\u8BF7\u91CD\u65B0\u6253\u5F00 QQ \u8BBE\u7F6E\uFF0C\u5E76\u53EA\u4F7F\u7528\u6700\u65B0\u9762\u677F\u3002";
    if (code === "setup_budget_exhausted")
        return "\u4ECA\u65E5 QQ \u8FDE\u63A5\u8FD0\u884C\u9884\u7B97\u5DF2\u7528\u5B8C\uFF0C\u672C\u6B21\u672A\u542F\u52A8\u3002\u8BF7\u7A0D\u540E\u67E5\u770B\u9884\u7B97\uFF0C\u4E0D\u8981\u53CD\u590D\u70B9\u51FB\u542F\u52A8\u3002";
    if (code === "setup_config_unavailable")
        return "QQ \u8FDE\u63A5\u914D\u7F6E\u6682\u4E0D\u53EF\u7528\uFF0C\u672C\u6B21\u64CD\u4F5C\u672A\u5B8C\u6210\u3002\u8BF7\u4FDD\u7559\u6B64\u63D0\u793A\u4F9B\u6392\u67E5\u3002";
    if (code === "setup_gateway_not_ready")
        return "QQ \u8FDE\u63A5\u5C1A\u672A\u5C31\u7EEA\uFF0C\u6682\u4E0D\u80FD\u7ED1\u5B9A\u3002\u8BF7\u91CD\u65B0\u6253\u5F00 QQ \u8BBE\u7F6E\u67E5\u770B\u8FDE\u63A5\u72B6\u6001\u3002";
    if (code === "setup_identity_rejected")
        return "\u65E0\u6CD5\u6838\u9A8C\u6B64\u8BBE\u7F6E\u64CD\u4F5C\u7684\u6765\u6E90\uFF0C\u672A\u6267\u884C\u64CD\u4F5C\u3002\u8BF7\u4ECE\u73B0\u6709\u603B\u89C8\u91CD\u65B0\u6253\u5F00 QQ \u8BBE\u7F6E\u3002";
    return "\u6B64\u8BBE\u7F6E\u64CD\u4F5C\u7ED3\u679C\u672A\u786E\u8BA4\u3002\u8BF7\u91CD\u65B0\u6253\u5F00 QQ \u8BBE\u7F6E\u67E5\u770B\u72B6\u6001\uFF1B\u4E0D\u8981\u91CD\u590D\u786E\u8BA4\u7ED1\u5B9A\u6216\u53D1\u9001\u6D4B\u8BD5\u3002\u82E5\u4ECD\u5931\u8D25\uFF0C\u8BF7\u4FDD\u7559\u6B64\u63D0\u793A\u4F9B\u6392\u67E5\u3002";
}
async function setupResponse(operation, observe) {
    const mark = (code) => {
        try {
            observe?.(code);
        }
        catch {
        }
    };
    let timer;
    try {
        const outcome = await Promise.race([Promise.resolve(operation()).then((response) => ({ response, code: "setup_response_returned" })), new Promise((resolve) => {
                timer = setTimeout(() => resolve({ response: reply("\u8BBE\u7F6E\u7ED3\u679C\u5C1A\u672A\u786E\u8BA4\u3002\u8BF7\u91CD\u65B0\u6253\u5F00 QQ \u8BBE\u7F6E\u67E5\u770B\u72B6\u6001\uFF0C\u4E0D\u8981\u91CD\u590D\u786E\u8BA4\u7ED1\u5B9A\u3002"), code: "setup_status_unknown" }), 1500);
            })]);
        mark(outcome.code);
        return outcome.response;
    }
    catch (error) {
        mark(setupFailureCode(error));
        return reply(setupFailureMessage(error));
    }
    finally {
        clearTimeout(timer);
    }
}
async function qqInteractionResponse(request, b, key, guild, select, env, interactionResponse, verifyDiscordInteraction, jsonResponse, safeError, trace) {
    const mark = (stage, code, status = 200) => {
        try {
            trace?.mark(stage, code, status);
        }
        catch {
        }
    };
    try {
        const p = await verifyDiscordInteraction(request.clone(), b, key, guild);
        if (!isQQSetup(p))
            return interactionResponse(request, b, key, guild, select, trace);
        mark("discord_verify", "ok");
        if (env.QQ_SETUP_ENABLED !== "true") {
            mark("qq_setup", "setup_disabled");
            return jsonResponse({ type: 4, data: { content: "QQ \u8BBE\u7F6E\u5C1A\u672A\u542F\u7528", flags: 64, allowed_mentions: { parse: [] } } });
        }
        const minimal = { id: p.id, application_id: p.application_id, type: p.type, context: p.context, channel_id: p.channel_id, user: p.user, member: p.member, authorizing_integration_owners: p.authorizing_integration_owners, message: { id: p.message.id, flags: p.message.flags, author: { id: p.message.author.id } }, guild_id: p.guild_id, data: p.data };
        let panelResponse;
        const pending = (async () => {
            const response = await env.QQ_GATEWAY.get(env.QQ_GATEWAY.idFromName("qq:" + b.ownerId)).ownerSetup(minimal);
            const activation = response?._rivuleActivation;
            if (response && Object.hasOwn(response, '_rivuleActivation'))
                delete response._rivuleActivation;
            if (env.QQ_DELIVERY_ENABLED === 'true' && activation?.interactionId === p.id && typeof activation.grantId === 'string' && /^grant-[1-9][0-9]*$/.test(activation.grantId) && Object.keys(activation).sort().join(',') === 'grantId,interactionId') {
                try {
                    const result = await env.OWNERS.get(env.OWNERS.idFromName('owner:' + b.ownerId)).activateQQForInteraction(p.id);
                    if (['active', 'already_active'].includes(result?.state) && typeof response?.data?.content === 'string') {
                        response.data.content = response.data.content.replace('正在开启本轮通知。', '本轮持续通知已开启。').replace('**验证已通过，等待队列就绪**', '**本轮通知已开启**').replace('◌ 通知队列', '✓ 本轮通知').replace('验证已提交 QQ，正在连接通知队列。', '本轮只推送新的进展，可以随时暂停。');
                        for (const row of response.data.components ?? [])
                            for (const button of row.components ?? [])
                                if (button.label === '取消本轮开启')
                                    button.label = '暂停持续通知';
                    }
                }
                catch {
                    if (typeof response?.data?.content === 'string')
                        response.data.content = response.data.content.replace('正在开启本轮通知。', '通知队列开启结果待确认，请刷新设置查看。');
                }
            }
            if (typeof response?.data?.content === 'string') {
                try {
                    const queue = await env.OWNERS.get(env.OWNERS.idFromName('owner:' + b.ownerId)).qqQueueStatus();
                    qqProducerPanel(response, queue);
                    if (Number.isSafeInteger(queue?.skipped) && queue.skipped > 0) {
                        const notice = '累计 ' + queue.skipped + ' 条新动态因队列容量未加入推送，项目记录已保存。';
                        const suffix = '\n\n**QQ 推送记录**\n' + notice;
                        if (response.data.content.length + suffix.length <= 2000)
                            response.data.content += suffix;
                        else {
                            const embeds = response.data.embeds ?? [];
                            const used = embeds.reduce((n, e) => n + (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text?.length ?? 0) + (e.author?.name?.length ?? 0) + (e.fields ?? []).reduce((m, f) => m + (f.name?.length ?? 0) + (f.value?.length ?? 0), 0), 0);
                            if (embeds.length < 10 && used + notice.length + 7 <= 6000)
                                response.data.embeds = [...embeds, { title: 'QQ 推送记录', description: notice, color: 0xB1772F }];
                        }
                    }
                }
                catch {
                    qqProducerPanel(response, null);
                }
            }
            panelResponse = response;
            let navigationTimer;
            try {
                const nav = await Promise.race([env.OWNERS.get(env.OWNERS.idFromName('owner:' + b.ownerId)).overviewNavigation(minimal), new Promise(resolve => { navigationTimer = setTimeout(() => resolve(null), 150); })]);
                if (typeof nav?.url === 'string' && /^https:\/\/discord\.com\/channels\/@me\/[0-9]{1,25}\/[0-9]{1,25}$/.test(nav.url) && nav.url.startsWith('https://discord.com/channels/@me/' + b.dmId + '/') && response?.data) {
                    const rows = response.data.components ??= [];
                    const button = { type: 2, style: 5, label: '返回总览', url: nav.url };
                    const row = rows.find(x => x.type === 1 && Array.isArray(x.components) && x.components.every(c => c.type === 2) && x.components.length < 5);
                    if (row)
                        row.components.push(button);
                    else if (rows.length < 5)
                        rows.push({ type: 1, components: [button] });
                }
            }
            catch { }
            finally {
                clearTimeout(navigationTimer);
            }
            return response;
        })();
        env.__qqWaitUntil?.(pending.catch(() => { }));
        const timedResponse = await setupResponse(() => pending, (code) => mark("qq_setup", code));
        const response = panelResponse ?? timedResponse;
        if (response?.type === 4 && response.data) {
            if (!response.data.components?.length)
                response.data.components = [{ type: 1, components: [{ type: 2, style: 2, label: '重新打开 QQ 设置', custom_id: 'qqsetup:open' }] }];
            const caller = p.user ?? p.member?.user;
            const privateOwnerPanel = p.type === 3 && p.context === 1 && p.application_id === b.appId && p.channel_id === b.dmId && !p.guild_id && caller?.id === b.userId && caller?.bot !== true && p.message?.author?.id === b.appId && Number.isSafeInteger(p.message?.flags) && (p.message.flags & 64) === 64;
            if (privateOwnerPanel) {
                response.type = 7;
                delete response.data.flags;
            }
        }
        return jsonResponse(response);
    }
    catch (error) {
        const response = safeError(error);
        mark("discord_interaction", "interaction_rejected", response.status);
        return response;
    }
}
async function qqV2Request(queue, operation, payload) {
    const c = queue.config(), secret = queue.env.QQ_BRIDGE_SECRET;
    const body = JSON.stringify({ version: 2, timestamp: queue.now(), ownerId: queue.ownerId, appId: c.appId, operation, payload });
    const request = { body, signature: await hmac(secret, 'rivule-qq-request-v2', body) };
    const stub = queue.env.QQ_GATEWAY.get(queue.env.QQ_GATEWAY.idFromName('qq:' + queue.ownerId));
    const response = await check(secret, 'rivule-qq-response-v2', await stub.continuousRequest(request));
    if (response.version !== 2 || response.requestHash !== await hash(body) || !response.result)
        throw Error('continuous_response_mismatch');
    return response.result;
}
const qqDiagnosticCodes = new Set(['delivery_disabled', 'connection_unavailable', 'configuration_changed', 'runtime_budget_unavailable', 'grant_inactive', 'producer_not_ready', 'policy_changed', 'binding_changed', 'connection_continuity_changed', 'permission_changed', 'grant_expired', 'source_unverified', 'event_not_current', 'projection_not_authorized', 'project_not_authorized', 'grant_changed', 'intent_conflict', 'event_already_reserved', 'attempt_capacity', 'attempt_consumed', 'permit_mismatch', 'permit_expired', 'quota_corrupt', 'daily_quota_exhausted', 'paced', 'preparation_expired', 'source_or_event_changed', 'projection_changed', 'source_changed_during_projection', 'job_changed', 'activation_changed']);
const qqDiagnosticStages = new Set(['owner_activation', 'owner_select', 'owner_sync', 'owner_projection', 'gateway_prepare', 'owner_recheck']);
function qqSafeDiagnostic(stage, code) { return { stage: qqDiagnosticStages.has(stage) ? stage : 'owner_activation', code: qqDiagnosticCodes.has(code) ? code : 'preflight_unavailable' }; }
function qqStoredDiagnostic(value) { if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'code,stage' || !qqDiagnosticStages.has(value.stage) || !qqDiagnosticCodes.has(value.code) && value.code !== 'preflight_unavailable')
    return null; return { stage: value.stage, code: value.code }; }
function qqProducerView(rows, now = Date.now()) {
    const row = rows("SELECT v FROM qq_continuous_meta WHERE k='activation'")[0];
    if (!row)
        return { active: false, reason: 'not_activated', diagnostic: null };
    let a;
    try {
        a = JSON.parse(row.v);
    }
    catch {
        return { active: null, reason: 'state_unavailable', diagnostic: null };
    }
    const reasons = new Set(['provider_outcome_unknown', 'grant_expired', 'preflight_not_sent', 'bridge_outcome_unknown', 'source_unverified', 'token_unavailable', 'grant_inactive', 'connection_unavailable', 'policy_changed', 'permission_changed', 'runtime_budget_unavailable']);
    if (a?.active === true && !Number.isSafeInteger(a.expiresAt))
        return { active: null, reason: 'state_unavailable', diagnostic: null };
    if (a?.active === true && Number.isSafeInteger(a.expiresAt) && a.expiresAt <= now)
        return { active: false, reason: 'grant_expired', diagnostic: null };
    return { active: typeof a?.active === 'boolean' ? a.active : null, reason: a?.active === true ? null : reasons.has(a?.pauseReason) ? a.pauseReason : 'state_unavailable', diagnostic: qqStoredDiagnostic(a?.pauseDiagnostic) };
}
function qqProducerPanel(response, queue) {
    if (typeof response?.data?.content !== 'string' || !['Rivule · 持续通知', 'Rivule · QQ 设置'].some(t => response.data.content.includes(t)))
        return;
    const d = queue?.delivery;
    const known = { connection_continuity_changed: 'QQ 连接会话已变化，原会话授权不再适用。', connection_unavailable: 'QQ 连接当前未就绪。', permission_changed: '当前 QQ 权限证据已变化。', policy_changed: '项目或通知策略与本轮授权不一致。', configuration_changed: '运行配置与本轮授权不一致。', runtime_budget_unavailable: '当前运行预算不允许继续发送。', grant_inactive: '本轮通知授权已暂停。', grant_expired: '本轮通知授权已失效。', producer_not_ready: '任务通知队列尚未完成开启。', source_unverified: '当前 PA 来源的验证证据不可用。', daily_quota_exhausted: '今日通知尝试额度已用完。', paced: '尚未达到最小发送间隔。' };
    const code = qqStoredDiagnostic(d?.diagnostic)?.code;
    const detail = d?.active === true ? '已开启' : d?.active === false ? (Object.hasOwn(known, code) ? known[code] : d.reason === 'not_activated' ? '任务通知队列尚未开启。' : ['bridge_outcome_unknown', 'provider_outcome_unknown'].includes(d.reason) ? '上一条任务通知的发送结果尚未确认，本轮任务队列已暂停。不会自动重发。' : d.reason === 'preflight_not_sent' ? '任务通知在发送前检查阶段暂停；尚无可确认的具体原因。' : '任务通知队列已暂停；具体原因尚未确认。') : '等待确认';
    let content = response.data.content.replace('通知自动推送：配置已开启', '自动推送配置：已开启').replaceAll('**本轮通知已开启**', d?.active === false ? '**任务通知已暂停**' : '**通知队列状态待确认**').replaceAll('本轮持续通知已开启。', '').replaceAll('✓ 本轮通知', '○ 任务队列').replaceAll('本轮只推送新的进展，可以随时暂停。', '');
    if (d?.active === true)
        content = response.data.content.replace('通知自动推送：配置已开启', '自动推送配置：已开启');
    const panel = response.data.embeds?.find(embed => embed.fields?.some(field => field.name === '本轮状态'));
    if (panel) {
        const state = panel.fields.find(field => field.name === '本轮状态');
        state.value = d?.active === true ? '✓ 本轮队列已开启' : d?.active === false ? '○ 本轮队列未开启' : '◌ 等待确认';
        if (panel.title === '本轮通知已开启' || panel.title === '验证已通过，等待队列就绪') {
            panel.title = d?.active === true ? '本轮通知已开启' : d?.active === false ? '任务通知已暂停' : '通知队列状态待确认';
            panel.color = d?.active === true ? 0x16866B : 0xB1772F;
        }
    }
    const quota = response.data.embeds?.find(embed => embed.fields?.some(field => field.name === '▶ 通知节奏'));
    if (quota && d?.active !== true && /^\d+ 次可用$/.test(quota.title ?? '')) {
        quota.title = '剩余 ' + quota.title.replace(' 次可用', ' 次额度');
        quota.color = 0xB1772F;
    }
    const admission = queue?.latestAdmission;
    const admissionText = !admission ? '暂无新事件' : admission.reason === 'admission_not_recorded' ? '最近一条事件没有 QQ 入队记录，历史原因未知。' : admission.state === 'coalesced' ? '已合并到最新进展' : admission.state === 'queued' ? '等待发送' : admission.state === 'sent' && admission.reason === 'provider_accepted' ? '已提交 QQ' : admission.reason === 'activation_inactive' ? '最近一条事件被跳过：本轮任务队列未开启或已暂停。' : admission.reason === 'activation_expired' ? '最近一条事件被跳过：本轮任务队列授权已过期。' : admission.state === 'suppressed' ? '最近一条事件被跳过，原因可在诊断回执中核对。' : '最近一条事件的发送结果尚未确认。';
    const embeds = response.data.embeds ?? [];
    if (embeds.length < 10) response.data.embeds = [...embeds, { title: '发送动态', color: d?.active === true ? 0x16866B : 0xB1772F, fields: [{ name: '本轮队列', value: detail, inline: true }, { name: '最近事件', value: admissionText, inline: true }] }];
    response.data.content = content;
}
const qqAdmissionCodes = new Set(['queue_capacity', 'delivery_disabled', 'activation_inactive', 'activation_expired', 'project_not_authorized', 'source_unverified', 'sensitivity_excluded', 'heartbeat_excluded', 'event_not_current', 'admission_history_excluded', 'projection_not_authorized', 'admission_unavailable']);
function qqAdmissionReason(value) { return qqAdmissionCodes.has(value) ? value : 'admission_unavailable'; }
function qqSkipReceipt(storage, sourceId, receiptId) {
    const rows = (q, ...a) => storage.sql.exec(q, ...a).toArray();
    if (!rows("SELECT name FROM sqlite_master WHERE type='table' AND name='qq_continuous_skips'").length)
        return null;
    const hasReason = rows('PRAGMA table_info(qq_continuous_skips)').some(c => c.name === 'reason');
    const row = rows('SELECT ' + (hasReason ? 'reason' : 'receipt') + ' FROM qq_continuous_skips WHERE receipt=? AND source_id=?', receiptId, sourceId)[0];
    return row ? { state: 'suppressed', reason: hasReason ? qqAdmissionReason(row.reason) : 'queue_capacity' } : null;
}
function qqAdmissionSnapshot(storage) {
    const rows = (q, ...a) => storage.sql.exec(q, ...a).toArray(), tables = new Set(rows("SELECT name FROM sqlite_master WHERE type='table'").map(x => x.name));
    if (!tables.has('events'))
        return null;
    const accepted = rows("SELECT revision,receipt,source_id FROM events WHERE decision='applied' ORDER BY revision DESC LIMIT 1")[0];
    if (!accepted)
        return null;
    let result;
    for (const [table, key] of [['qq_continuous_outbox', 'receipt'], ['qq_outbox', 'receipt_id']])
        if (!result && tables.has(table)) {
            const row = rows('SELECT status,result FROM ' + table + ' WHERE ' + key + '=? AND source_id=?', accepted.receipt, accepted.source_id)[0];
            if (row)
                result = row.status === 'sending' ? { state: 'uncertain', reason: 'dispatch_outcome_unknown' } : row.result ? JSON.parse(row.result) : { state: row.status };
        }
    result ??= qqSkipReceipt(storage, accepted.source_id, accepted.receipt);
    const states = new Set(['queued', 'sent', 'coalesced', 'suppressed', 'not_sent', 'uncertain', 'blocked']);
    const reasons = new Set([...qqAdmissionCodes, ...qqDiagnosticCodes, 'provider_accepted', 'provider_outcome_unknown', 'bridge_outcome_unknown', 'preflight_not_sent', 'dispatch_outcome_unknown', 'restart_during_dispatch', 'new_activation_skips_backlog', 'newer_branch_update', 'receipt_history_unavailable']);
    return { revision: accepted.revision, state: result ? (states.has(result.state) ? result.state : 'uncertain') : 'uncertain', reason: result ? (result.reason === undefined ? (result.state === 'queued' ? 'awaiting_dispatch' : 'state_unavailable') : reasons.has(result.reason) ? result.reason : 'state_unavailable') : 'admission_not_recorded' };
}
const qqLocalSuppression = new Set(['source_or_event_changed', 'projection_changed', 'source_changed_during_projection', 'job_changed', 'source_unverified', 'event_not_current', 'projection_not_authorized', 'project_not_authorized']);
const QQBridgeQueueV1 = QQBridgeQueue;
QQBridgeQueue = class extends QQBridgeQueueV1 {
    attachAuthority(read) { this.readAuthority = read; }
    async initialize() { await super.initialize(); if (this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='qq_continuous_skips'").length)
        this.migrateAdmissionReason(); }
    migrateAdmissionReason() { if (!this.rows('PRAGMA table_info(qq_continuous_skips)').some(c => c.name === 'reason'))
        this.rows("ALTER TABLE qq_continuous_skips ADD COLUMN reason TEXT NOT NULL DEFAULT 'queue_capacity'"); }
    static skipReceipt(storage, sourceId, receiptId) { return qqSkipReceipt(storage, sourceId, receiptId); }
    static producerSnapshot(storage, now = Date.now()) {
        const rows = (q, ...a) => storage.sql.exec(q, ...a).toArray();
        return rows("SELECT name FROM sqlite_master WHERE type='table' AND name='qq_continuous_meta'").length ? qqProducerView(rows, now) : { active: false, reason: 'not_activated', diagnostic: null };
    }
    static statusSnapshot(storage, sources, now = Date.now()) {
        const rows = (q, ...a) => storage.sql.exec(q, ...a).toArray();
        const capacity = QQBridgeQueue.capacityStatus(storage, sources);
        const delivery = rows("SELECT name FROM sqlite_master WHERE type='table' AND name='qq_continuous_meta'").length ? qqProducerView(rows, now) : { active: false, reason: 'not_activated', diagnostic: null };
        return { ...capacity, delivery, latestAdmission: qqAdmissionSnapshot(storage) };
    }
    recordAdmissionSkip(event, receiptId, reason) {
        if (!/^rcpt_[a-f0-9]{32}$/.test(receiptId ?? '') || !this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='qq_continuous_skips'").length)
            return;
        const row = this.rows('SELECT revision,source_id,decision FROM events WHERE receipt=?', receiptId)[0];
        if (!row || row.source_id !== event.source_id || row.decision !== 'applied')
            return;
        this.storage.transactionSync(() => {
            this.rows('INSERT OR IGNORE INTO qq_continuous_skips(receipt,source_id,revision,recorded_at,reason) VALUES(?,?,?,?,?)', receiptId, row.source_id, row.revision, this.now(), qqAdmissionReason(reason));
            this.rows('DELETE FROM qq_continuous_skips WHERE recorded_at<? OR receipt IN (SELECT receipt FROM qq_continuous_skips ORDER BY revision DESC LIMIT -1 OFFSET 1000)', this.now() - 72 * 3600000);
        });
    }
    async initializeContinuous() {
        if (this.continuousInitialized)
            return;
        await this.storage.transaction(async () => {
            this.storage.sql.exec("CREATE TABLE IF NOT EXISTS qq_continuous_outbox(receipt TEXT PRIMARY KEY,source_id TEXT NOT NULL,source_generation INTEGER NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,result TEXT,recorded_at INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS qq_continuous_meta(k TEXT PRIMARY KEY,v TEXT NOT NULL);CREATE TABLE IF NOT EXISTS qq_continuous_skips(receipt TEXT PRIMARY KEY,source_id TEXT NOT NULL,revision INTEGER NOT NULL,recorded_at INTEGER NOT NULL);");
            this.migrateAdmissionReason();
            if (!this.rows('PRAGMA table_info(qq_continuous_outbox)').some(c => c.name === 'recorded_at'))
                this.rows('ALTER TABLE qq_continuous_outbox ADD COLUMN recorded_at INTEGER NOT NULL DEFAULT 0');
            this.rows('UPDATE qq_continuous_outbox SET recorded_at=? WHERE recorded_at=0', this.now());
            this.compactHistory();
            this.rows("UPDATE qq_continuous_outbox SET status='uncertain',result=? WHERE status='sending'", JSON.stringify({ state: 'uncertain', reason: 'restart_during_dispatch' }));
        });
        this.continuousInitialized = true;
    }
    static capacityStatus(storage, sources, sourceId = null) {
        const rows = (query, ...args) => storage.sql.exec(query, ...args).toArray();
        if (!rows("SELECT name FROM sqlite_master WHERE type='table' AND name='qq_continuous_meta'").length)
            return { skipped: 0, lastAt: null, sources: [] };
        const row = rows("SELECT v FROM qq_continuous_meta WHERE k='capacity'")[0], data = Object.assign(Object.create(null), row ? JSON.parse(row.v) : {});
        const configured = new Set(sources.filter(s => s.enabled).map(s => s.source_id));
        if (sourceId && !configured.has(sourceId))
            throw Error('qq_source_not_authorized');
        const entries = Object.entries(data).filter(([id]) => !sourceId || id === sourceId);
        if (entries.some(([, v]) => !Number.isSafeInteger(v.count) || v.count < 0 || !Number.isSafeInteger(v.lastAt)))
            throw Error('capacity_status_corrupt');
        return { skipped: entries.reduce((n, [, v]) => n + v.count, 0), lastAt: entries.length ? Math.max(...entries.map(([, v]) => v.lastAt)) : null, sources: entries.map(([source_id, v]) => ({ source_id, count: v.count, lastAt: v.lastAt })), ...sourceId === null ? { delivery: qqProducerView(rows) } : {} };
    }
    capacityStatus(sourceId = null) { return QQBridgeQueue.capacityStatus(this.storage, this.sources, sourceId); }
    capacityFloor() { const row = this.rows("SELECT v FROM qq_continuous_meta WHERE k='capacity_floor'")[0]; const n = row ? Number(row.v) : 0; if (!Number.isSafeInteger(n) || n < 0)
        throw Error('capacity_floor_corrupt'); return n; }
    recordCapacitySkip(sourceId, receiptId, revision) {
        this.storage.transactionSync(() => {
            if (revision <= this.capacityFloor() || this.rows('SELECT receipt FROM qq_continuous_skips WHERE receipt=?', receiptId).length)
                return;
            const row = this.rows("SELECT v FROM qq_continuous_meta WHERE k='capacity'")[0], data = Object.assign(Object.create(null), row ? JSON.parse(row.v) : {});
            const old = data[sourceId] ?? { count: 0 };
            if (!Number.isSafeInteger(old.count) || old.count < 0 || old.count >= Number.MAX_SAFE_INTEGER)
                throw Error('capacity_counter_exhausted');
            data[sourceId] = { count: old.count + 1, lastAt: this.now() };
            this.rows("INSERT INTO qq_continuous_meta(k,v) VALUES('capacity',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", JSON.stringify(data));
            this.rows("INSERT INTO qq_continuous_meta(k,v) VALUES('capacity_floor',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", String(revision));
            this.rows('INSERT INTO qq_continuous_skips(receipt,source_id,revision,recorded_at) VALUES(?,?,?,?)', receiptId, sourceId, revision, this.now());
            this.rows('DELETE FROM qq_continuous_skips WHERE recorded_at<? OR receipt IN (SELECT receipt FROM qq_continuous_skips ORDER BY revision DESC LIMIT -1 OFFSET 1000)', this.now() - 72 * 3600000);
        });
    }
    retentionFloor() { const row = this.rows("SELECT v FROM qq_continuous_meta WHERE k='retention_floor'")[0]; const value = row ? Number(row.v) : 0; if (!Number.isSafeInteger(value) || value < 0)
        throw Error('retention_floor_corrupt'); return value; }
    compactHistory() {
        const cutoff = this.now() - 72 * 3600000;
        if (this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='qq_continuous_skips'").length)
            this.rows('DELETE FROM qq_continuous_skips WHERE recorded_at<?', cutoff);
        const revision = this.rows("SELECT MAX(revision) AS revision FROM qq_continuous_outbox WHERE status IN ('sent','not_sent','suppressed','coalesced') AND recorded_at<?", cutoff)[0]?.revision;
        if (revision === null || revision === undefined)
            return;
        const floor = Math.max(this.retentionFloor(), revision);
        this.rows("INSERT INTO qq_continuous_meta(k,v) VALUES('retention_floor',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", String(floor));
        this.rows("DELETE FROM qq_continuous_outbox WHERE status IN ('sent','not_sent','suppressed','coalesced') AND recorded_at<?", cutoff);
    }
    hasContinuousSchema() { return this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='qq_continuous_meta'").length === 1; }
    activation() { if (!this.hasContinuousSchema())
        return null; const row = this.rows("SELECT v FROM qq_continuous_meta WHERE k='activation'")[0]; return row ? JSON.parse(row.v) : null; }
    saveActivation(a) { this.rows("INSERT INTO qq_continuous_meta(k,v) VALUES('activation',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", JSON.stringify(a)); }
    async activateForInteraction(interactionId) {
        const remote = await qqV2Request(this, 'status', null);
        if (remote.gatewayReady !== true || remote.approvalInteractionId !== interactionId || typeof remote.bindingFingerprint !== 'string')
            throw Error('activation_not_approved');
        await this.initializeContinuous();
        const prepared = await this.storage.transaction(async () => {
            this.compactHistory();
            const old = this.activation();
            if (old?.grantId === remote.grantId)
                return { state: old.active ? 'already_active' : 'prepared', startAfterRevision: old.startAfterRevision };
            const cursor = this.rows('SELECT COALESCE(MAX(revision),0) AS revision FROM events')[0].revision;
            this.rows("UPDATE qq_continuous_outbox SET status='suppressed',result=?,recorded_at=? WHERE status='queued'", JSON.stringify({ state: 'suppressed', reason: 'new_activation_skips_backlog' }), this.now());
            this.saveActivation({ active: false, grantId: remote.grantId, bindingFingerprint: remote.bindingFingerprint, startAfterRevision: cursor, expiresAt: remote.expiresAt });
            return { state: 'prepared', startAfterRevision: cursor };
        });
        if (prepared.state === 'already_active')
            return prepared;
        const ack = await qqV2Request(this, 'acknowledge_producer', { grantId: remote.grantId, approvalInteractionId: interactionId, startAfterRevision: prepared.startAfterRevision });
        if (ack.state !== 'ready' || ack.grantId !== remote.grantId)
            throw Error('producer_ack_failed');
        return this.storage.transaction(async () => { const a = this.activation(); if (a?.grantId !== remote.grantId || a.startAfterRevision !== prepared.startAfterRevision)
            throw Error('activation_changed'); this.saveActivation({ ...a, active: true }); return { state: 'active', startAfterRevision: a.startAfterRevision }; });
    }
    enqueue(event, receiptId) {
        const skip = reason => { try {
            this.recordAdmissionSkip(event, receiptId, reason);
        }
        catch { } return false; };
        try {
            const c = this.config(), a = this.activation();
            if (!c?.enabled)
                return skip('delivery_disabled');
            if (!a?.active)
                return skip('activation_inactive');
            if (a.expiresAt <= this.now())
                return skip('activation_expired');
            if (!c.allowedProjects.includes(event.project_id))
                return skip('project_not_authorized');
            const source = this.sources.find(s => s.source_id === event.source_id && s.enabled), proof = this.readAuthority?.(event.source_id);
            if (!source || proof?.selectable !== true || !Number.isSafeInteger(proof.connection_generation))
                return skip('source_unverified');
            if (event.sensitivity !== 'normal')
                return skip('sensitivity_excluded');
            if (event.kind === 'heartbeat')
                return skip('heartbeat_excluded');
            const row = this.rows('SELECT revision,source_id,payload,decision FROM events WHERE receipt=?', receiptId)[0];
            if (!row || row.decision !== 'applied' || row.source_id !== source.source_id || row.revision <= a.startAfterRevision)
                return skip('event_not_current');
            if (row.revision <= this.retentionFloor() || row.revision <= this.capacityFloor())
                return skip('admission_history_excluded');
            const projected = projection(validateEvent(JSON.parse(row.payload), source, this.now()));
            if (JSON.stringify(projected) !== JSON.stringify(projection(validateEvent(event, source, this.now()))))
                return skip('projection_not_authorized');
            if (this.rows('SELECT receipt FROM qq_continuous_outbox WHERE receipt=?', receiptId).length)
                return true;
            if (this.rows('SELECT COUNT(*) AS n FROM qq_continuous_outbox')[0].n >= 10000) {
                this.recordCapacitySkip(source.source_id, receiptId, row.revision);
                return false;
            }
            let receivedAt = this.now();
            // Merge only unsent ordinary progress from this exact source generation and branch.
            // Keep the oldest window start; updates cannot postpone the notification indefinitely.
            for (const prior of this.rows("SELECT * FROM qq_continuous_outbox WHERE status='queued' AND source_id=?", source.source_id)) {
                const previous = JSON.parse(prior.payload);
                if (prior.revision < row.revision && prior.receipt !== receiptId && prior.source_generation === proof.connection_generation && isRoutineProgress(previous) && sameNotificationBranch(previous, projected)) {
                    if (isRoutineProgress(projected)) receivedAt = Math.min(receivedAt, prior.recorded_at);
                    this.rows("UPDATE qq_continuous_outbox SET status='coalesced',result=? WHERE receipt=? AND status='queued'", JSON.stringify({ state: 'coalesced', reason: 'newer_branch_update' }), prior.receipt);
                }
            }
            this.rows("INSERT OR IGNORE INTO qq_continuous_outbox(receipt,source_id,source_generation,revision,payload,status,recorded_at) VALUES(?,?,?,?,?,'queued',?)", receiptId, source.source_id, proof.connection_generation, row.revision, JSON.stringify(projected), receivedAt);
            return true;
        }
        catch {
            return skip('admission_unavailable');
        }
    }
    nextAlarmAt() { const a = this.activation(); if (!this.config()?.enabled || !a?.active || a.expiresAt <= this.now())
        return null; const due = this.rows("SELECT payload,recorded_at FROM qq_continuous_outbox WHERE status='queued'").map(row => routineDueAt(JSON.parse(row.payload), row.recorded_at)); return due.length ? Math.max(this.now() + 3100, Math.min(...due)) : null; }
    receipt(source, receiptId) {
        const configured = this.sources.find(s => s.source_id === source.source_id && s.enabled);
        if (!configured || JSON.stringify(configured) !== JSON.stringify(source))
            throw Error('qq_source_not_authorized');
        if (this.hasContinuousSchema()) {
            const row = this.rows('SELECT status,result FROM qq_continuous_outbox WHERE receipt=? AND source_id=?', receiptId, source.source_id)[0];
            if (row)
                return row.status === 'sending' ? { state: 'uncertain', reason: 'dispatch_outcome_unknown' } : row.result ? JSON.parse(row.result) : { state: row.status };
        }
        const legacy = super.receipt(source, receiptId);
        if (legacy)
            return legacy;
        const skipped = qqSkipReceipt(this.storage, source.source_id, receiptId);
        if (skipped)
            return skipped;
        if (!this.hasContinuousSchema())
            return null;
        const accepted = this.rows('SELECT revision FROM events WHERE receipt=? AND source_id=?', receiptId, source.source_id)[0];
        return accepted ? { state: 'uncertain', reason: accepted.revision <= Math.max(this.capacityFloor(), this.retentionFloor()) ? 'receipt_history_unavailable' : 'admission_not_recorded' } : null;
    }
    async currentJob(row, a) {
        const source = this.sources.find(s => s.source_id === row.source_id && s.enabled), proof = this.readAuthority?.(row.source_id);
        const accepted = this.rows('SELECT revision,source_id,payload,decision FROM events WHERE receipt=?', row.receipt)[0];
        if (!source || proof?.selectable !== true || typeof proof.binding !== 'string' || proof.connection_generation !== row.source_generation || !accepted || accepted.decision !== 'applied' || accepted.revision !== row.revision || accepted.source_id !== row.source_id || row.revision <= a.startAfterRevision)
            throw Error('source_or_event_changed');
        const event = projection(validateEvent(JSON.parse(accepted.payload), source, this.now()));
        if (JSON.stringify(event) !== row.payload || event.sensitivity !== 'normal' || event.kind === 'heartbeat' || !this.config().allowedProjects.includes(event.project_id))
            throw Error('projection_changed');
        const content = formatQQNotification(event, source, this.now());
        const sourceBindingDigest = await hash(proof.binding), payloadHash = await hash(content);
        const current = this.readAuthority?.(row.source_id);
        if (current?.selectable !== true || current.connection_generation !== proof.connection_generation || current.binding !== proof.binding)
            throw Error('source_changed_during_projection');
        const job = { intentId: await hash(JSON.stringify([row.source_id, row.receipt])), sourceId: row.source_id, sourceGeneration: row.source_generation, sourceBindingDigest, projectId: event.project_id, receiptId: row.receipt, eventId: event.event_id, acceptedRevision: row.revision, payloadHash, content, grantId: a.grantId, bindingFingerprint: a.bindingFingerprint };
        const verification = { selectable: true, enabled: true, revoked: false, sourceId: row.source_id, generation: row.source_generation, bindingDigest: sourceBindingDigest, verifiedAt: current.last_verified_at, applied: true, receiptId: row.receipt, eventId: event.event_id, acceptedRevision: row.revision, projectAllowed: true, projectId: event.project_id, sensitivity: event.sensitivity, kind: event.kind, payloadHash };
        return { job, source: verification };
    }
    async drain() {
        await this.initializeContinuous();
        if (this.v2Busy)
            return { state: 'idle', reason: 'already_draining' };
        this.v2Busy = true;
        let row, commitStarted = false, diagnosticStage = 'owner_activation';
        try {
            const a = this.activation();
            if (!this.config()?.enabled || !a?.active || a.expiresAt <= this.now())
                return { state: 'idle', reason: 'inactive' };
            diagnosticStage = 'owner_select';
            await this.storage.transaction(async () => { this.compactHistory(); row = this.rows("SELECT * FROM qq_continuous_outbox WHERE status='queued' ORDER BY revision").find(candidate => routineDueAt(JSON.parse(candidate.payload), candidate.recorded_at) <= this.now()); if (row)
                this.rows("UPDATE qq_continuous_outbox SET status='sending' WHERE receipt=?", row.receipt); });
            if (!row)
                return { state: 'idle', reason: 'nothing_due' };
            diagnosticStage = 'owner_sync';
            await this.storage.sync();
            diagnosticStage = 'owner_projection';
            const first = await this.currentJob(row, a);
            diagnosticStage = 'gateway_prepare';
            const prepared = await qqV2Request(this, 'prepare', first);
            let result;
            if (prepared.state !== 'prepared') {
                const diagnostic = qqStoredDiagnostic(prepared.diagnostic);
                result = { state: 'suppressed', reason: prepared.reason === 'preflight_not_sent' && diagnostic && qqLocalSuppression.has(diagnostic.code) ? diagnostic.code : prepared.reason ?? 'not_prepared', ...diagnostic ? { diagnostic } : {} };
            }
            else {
                diagnosticStage = 'owner_recheck';
                const latest = this.activation();
                if (!latest?.active || latest.grantId !== a.grantId)
                    throw Error('activation_changed');
                const fresh = await this.currentJob(row, a);
                if (JSON.stringify(fresh.job) !== JSON.stringify(first.job))
                    throw Error('job_changed');
                commitStarted = true;
                result = await qqV2Request(this, 'commit', { intentId: first.job.intentId, permit: { intentId: first.job.intentId, challenge: prepared.challenge, expiresAt: prepared.expiresAt, grantRevision: prepared.grantRevision, payloadHash: first.job.payloadHash }, source: fresh.source });
            }
            await this.storage.transaction(async () => { this.rows('UPDATE qq_continuous_outbox SET status=?,result=?,recorded_at=? WHERE receipt=?', result.state, JSON.stringify(result), this.now(), row.receipt); if (result.state !== 'sent' && !qqLocalSuppression.has(result.reason)) {
                const current = this.activation();
                if (current?.grantId === a.grantId)
                    this.saveActivation({ ...current, active: false, pauseReason: result.reason, pauseDiagnostic: qqStoredDiagnostic(result.diagnostic) });
            } });
            return result;
        }
        catch (error) {
            const local = !commitStarted && qqLocalSuppression.has(error?.message);
            const result = { state: commitStarted ? 'uncertain' : 'suppressed', reason: commitStarted ? 'bridge_outcome_unknown' : local ? error.message : 'preflight_not_sent', ...commitStarted ? {} : { diagnostic: qqSafeDiagnostic(diagnosticStage, error?.message) } };
            if (row)
                await this.storage.transaction(async () => { this.rows('UPDATE qq_continuous_outbox SET status=?,result=?,recorded_at=? WHERE receipt=?', result.state, JSON.stringify(result), this.now(), row.receipt); const a = this.activation(); if (a && !local)
                    this.saveActivation({ ...a, active: false, pauseReason: result.reason, pauseDiagnostic: qqStoredDiagnostic(result.diagnostic) }); });
            return result;
        }
        finally {
            this.v2Busy = false;
        }
    }
};
export { QQBridgeQueue, qqInteractionResponse };
