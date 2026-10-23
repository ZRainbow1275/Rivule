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
