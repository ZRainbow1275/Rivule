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
