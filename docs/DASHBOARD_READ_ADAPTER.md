# Owner-only read dashboard

Status: implemented on the existing owner Worker, disabled by default. Deployment and first owner login must be verified separately. The public showcase remains fictional and disconnected.

## Existing backend and login boundary

The owner Worker serves `/dashboard`, `/dashboard/login`, `/dashboard/data` and `/dashboard/logout`. It reuses the existing Discord application and `identify`-only identity verifier. The configured application and exact `OWNER_DISCORD_ID` must match. No assistant OAuth token is copied into the browser and no additional source grant is issued.

The registered redirect remains `PUBLIC_ORIGIN + /callback`. Dashboard transactions use a separate `rd_` state namespace; all other callback states retain the existing MCP OAuth flow. Namespaced failures never fall back into the MCP grant handler. No extra Discord callback registration is needed when the existing callback is correctly registered.

Login is initiated by a same-origin POST, with a five-minute random state and separate HttpOnly/Secure browser-binding cookie. The hashed state record is atomically consumed before exchanging the code. Successful owner verification creates a 15-minute non-refreshing HttpOnly/Secure/SameSite=Strict session cookie. Only token hashes are stored in the existing owner Durable Object. Login requests, pending transactions and active sessions are bounded. Logout revokes the session; owner/source/watchlist configuration changes invalidate it. No new signing secret or external credential is required.

The page uses a nonce CSP, no external assets, textContent rendering and no-store responses. `/dashboard/data` additionally requires same-origin Fetch Metadata. No CORS access is granted. Dashboard routes bypass legacy task/delivery initialization and connection-diagnostic writes.

## Private configuration

Keep public templates disabled:

```json
{"DASHBOARD_ENABLED":"false","DASHBOARD_WATCHLIST_JSON":"[]"}
```

After authorizing the owner-browser access path, configure the existing private owner deployment:

- `DASHBOARD_ENABLED`: `true` to enable; `false` disables all dashboard routes and dashboard callback handling.
- `DASHBOARD_WATCHLIST_JSON`: a JSON array of at most 20 exact `{ project_id, task_id, run_id, branch_id }` tuples. Keep actual identifiers private. Projects must already be allowed. Only configured, enabled `zot-main` is supported.

An empty watchlist is valid and shows an explicit unconfigured-task state, not demo rows. Do not guess identifiers or discover other sources. The UI does not accept arbitrary task IDs from URL parameters.

Build with the existing owner build workflow. `scripts/build.mjs` copies the dashboard and read-model modules into `dist/owner`, inside the existing Wrangler `base_dir`. Deploy only to the existing authorized owner service with its retained bindings/secrets; do not deploy the example configuration over production. The QQ gateway does not need a dashboard change.

## Read contract and display

`src/owner/dashboard-read-model.mjs` consumes the existing snapshot contract and exact source/project allowlist. The owner-authenticated route calls the existing storage reader directly with the configured source; it does not fabricate a source OAuth principal. Normal task content only is shown. Restricted/secret content, action questions, raw errors and sequence advice are withheld.

Connected means the selected snapshots were read, not a live subscription. Individual rows distinguish unavailable, not found and withheld; stale/archive flags and source observation times are preserved. Read failures never become empty-success views. There are no notification, approval, scheduling or write controls.

## Validation and rollback

Run `npm run check` and `npm test`. Offline tests cover state replay/concurrency, wrong-owner and expired login, cookie binding, session expiry, same-origin restrictions, configuration revocation, storage bounds, private reads, callback isolation and markup safety. These use fixtures; they do not prove the first live Discord login or browser redirect behavior.

After deployment, verify the configured origin's `/dashboard`, unauthenticated `/dashboard/data` rejection, then owner login, selected-task reads and logout in the browser. Do not send a task notification as a dashboard test. Disable `DASHBOARD_ENABLED` to close the new access path; existing source MCP OAuth behavior remains unchanged.

### Existing verified test receipt

An optional private `DASHBOARD_TEST_RECEIPT_JSON` selects one already-known test receipt without enumerating tasks. Its exact object contains `receipt_id`, `event_id`, `run_id` and positive integer `revision`; unset or `null` disables it. Keep real values out of the repository. Selection plus explicit tuples must fit the 20-item limit.

After owner session and same-origin checks, the resolver reads only that unique receipt under enabled `zot-main`, verifies persisted owner identity, expected event/run/revision, payload source, canonical branch key and existing project allowlist, and returns only four branch identifiers to the existing snapshot reader. A missing or inconsistent receipt is an explicit read error. The selector is part of session configuration binding. No new public resolver API, source permission, event or notification is created. Receipt-selected entries are labeled “测试任务”; their snapshots are not evidence of current project activity.

## PA work activity (owner-only)

The original zot selector remains compatible. Optional private `DASHBOARD_SOURCE_WATCHLISTS_JSON` maps other **existing enabled source IDs** to arrays of exact `{ project_id, task_id, run_id, branch_id }` tuples. Disabled/unknown sources, duplicate tuples, unauthorized projects, additional fields and more than 20 total selections fail closed. All existing enabled sources get a card; an unselected source says that no tasks have been configured, not that it is idle. This does not authorize or create upstream connections, discover tasks, or collect runtime data that the PA has not reported. A configuration/binding change invalidates existing owner sessions. The source's registered provider selects a pinned official icon where one exists; unknown providers use a clearly generic symbol.

Snapshots now preserve actual reported phase, blocker and valid done/total/unit progress. Missing numerical progress stays unknown, never an inferred percentage. Exact project/task/run/branch scope, stale/archive indicators, task status, source-confirmation time and read time remain separate from source connection proof.

For each readable normal-sensitivity selected branch, the backend reads at most 31 matching stored events and returns the newest 30, with an explicit truncation indicator. It checks persisted owner identity, enabled exact source binding, allowed project, canonical branch and every returned event's scope before projection. Restricted events are withheld with a count. Read failure is unavailable, never empty success. Only business summaries, phases, validated progress, event times, projection-applied status and allowlisted delivery states are returned. Action questions, raw payloads/errors, URLs, receipt/event IDs, message IDs and recipient identifiers are not included. Credential-shaped/recipient-assignment content is withheld and other recognizable identifiers are redacted. Producers must still classify sensitive information correctly; free-form text is not a general-purpose secret detector.

Delivery is explicitly the Discord outbox status for the event's exact receipt, not QQ delivery or recipient-read confirmation. `sending` is shown as uncertain because an in-flight or cold-start job cannot prove the external outcome. Coalesced, suppressed, blocked and dead-letter states remain distinct. No delivery or notification is triggered by a read.

The visible authenticated page refreshes every 30 seconds, with single-flight abortable requests and generation guards. Errors back off to at most five minutes and retain the last successful view with a prominent possibly-stale warning. Hidden pages pause and clear private views; visibility resumes one read. Open details/settings defer automatic refresh so it does not interrupt reading. A 401 clears private data and stops polling. Manual refresh remains available. Logs and full scope live in the existing detail dialog; the accepted card/add-PA layout stays within one desktop viewport.

Run `npm run check`, `npm test`, `npm run resources` and `npm run build`. Test coverage includes per-source selector/session isolation, bounded event reads, withheld/error states, redaction, real progress validation, delivery semantics, polling/backoff/expiry, interrupted first reads and clearing additional PA cards. Live work remains limited to the selected tuples actually configured and events actually reported in production; fixture tests cannot prove current activity or delivery.

## Session-scoped local task picker

Each enabled PA card now offers **选择已上报任务**. Opening the dialog reads only the current session scope. The owner must explicitly confirm before a source-specific `POST /dashboard/task-picker/access` reads its minimal catalog. This is not global task discovery: it uses only branches already persisted in this owner Durable Object under enabled source bindings and allowed project IDs. No upstream calls, grants, producer activation, enrollment or notification are performed.

Catalog rows disclose only redacted names, status, last-confirmed time, stale/archive flags and opaque session-specific references. Task text and business logs remain behind exact selection. Existing configured selections remain fixed and retain their previous behavior. Applying replaces only the chosen PA's session selections; all sources plus configured/test selectors share a conservative 20-entry limit. Cancel leaves previously applied selections intact. Nothing changes account-level configuration.

Authorization binds owner, application, user, DM, public origin, project allowlist, enabled sources, selectors and feature version. Session selection expires with the existing 15-minute login and never carries into a different session. Every dynamic read and apply revalidates the current row and its normal sensitivity. Previously selected entries that are deleted or become restricted can be explicitly removed through opaque unavailable-selection controls without disclosing their old metadata. Corrupt catalog rows fail closed instead of being presented as an empty catalog; logging out clears session-only selections.

The read adapter uses SELECT-only SQL with strict persisted identity checks, 25 rows plus one sentinel, stable branch-key pagination and at most 250 scanned branches per traversal. References are never silently evicted: catalog state is capped at 64 KiB and the session at 96 KiB; exceeding capacity returns an explicit error. Opaque request IDs protect cancellation/reopen races, cancellation tombstones are bounded, and logout serializes against session mutations. The UI clears private task data on expiry, revoked selection, logout or visibility loss; polling does not replace an open chooser.

Endpoints: GET `/dashboard/task-picker` (scope only), same-origin JSON POST `/access`, `/page`, `/apply`, `/cancel` under that prefix. Mutations require session CSRF, exact source and opaque request ID; access additionally requires `confirm: true`. Catalog and selection state is stored only inside bounded owner-session records, never in task or outbox tables.

## QQ producer state versus selected-source configuration

The existing authenticated `readConnection` projection now includes `qq_source_configuration`, using the same pure allowlist observer as connection diagnostics. It reads only `QQ_ALLOWED_SOURCE_IDS`, with no added SQL, proof refresh, gateway call, activation, permission or scheduling action. The normal owner identity/source gates run first.

The source-proof badge and color remain about proof freshness only. QQ capability/settings text and secondary source cards separately show producer activation and the exact source's allowlist membership. Exclusion says “此来源不在允许名单”; inclusion says only “来源在允许名单”, not permission to send. Missing, malformed or differently scoped/source-bound data says “来源许可待确认”. Capability detail directs users to receipts for actual delivery; the existing Discord event-log/QQ/read-confirmation distinctions are unchanged. Session loss clears these observations with the existing private workbench data.

Offline tests cover active producer with excluded source and fresh proof, paused producer with included source, unknown/malformed/cross-source projections, existing owner auth gates, zero added SQL and expiry cleanup.
