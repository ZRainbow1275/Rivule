# Private dashboard read adapter

Status: server-side integration code, not a deployed dashboard. The public showcase remains fictional and disconnected.

`src/dashboard/read-model.mjs` consumes the existing `get_task_snapshot` response contract. It accepts only the existing `zot-main` source and an explicit watchlist of at most 20 exact `{ project_id, task_id, run_id, branch_id }` records. No task discovery, other-source access, notifications, approval actions, sequence assignment, retries or subscriptions are added.

## Existing backend boundary

- MCP `get_task_snapshot` uses `pa:receipt` and an already authenticated source principal.
- HMAC `POST /v1/task/snapshot` also authenticates the source before reading the exact branch.
- The owner implementation `taskSnapshot(principal, query)` revalidates the principal/source and project allowlist. The adapter does not replace these checks.
- Neither route establishes a browser-owner session. No authenticated browser dashboard route currently exists.

## Host injection

An owner-authenticated server host can call:

```js
const model = await readDashboardWatchlist({
  sourceId: 'zot-main',
  watchlist: privateServerConfiguration.watchlist,
  readSnapshot: query => existingAuthenticatedSnapshotReader(query),
});
const view = dashboardViewState(model);
```

`existingAuthenticatedSnapshotReader` must return the decoded snapshot object from the existing authorized backend. Inside the owner integration, use the existing principal-bound `taskSnapshot` flow and existing result/error unwrapping. Do not synthesize a principal, broaden scopes, or pass a browser-supplied source identity. Store the selected task identifiers on the private server, not in this repository or the showcase bundle.

Before returning any model, the host must independently authenticate the visitor as the owner, enforce owner-only access, and return `Cache-Control: no-store`. Render returned text using textContent, not HTML. Never expose OAuth/HMAC credentials to the browser. Hosting a private static Site alone does not establish the backend authorization or grant it access to the assistant's connector.

## Display semantics

`dashboardViewState(null)` means unconfigured and returns no rows. Connected means the selected snapshots were read, not a live subscription. A read failure is explicit and must not become an empty-success view or demo data. Individual rows distinguish unavailable, not found and withheld; stale/archive flags are preserved. Restricted/secret payloads are withheld. Action questions, raw errors and sequence advice are never forwarded.

## Required decision before wiring a live page

Choose an owner-authenticated backend host/bridge that can invoke the existing source-bound reader without transferring assistant credentials, and supply the exact private watchlist. If a new browser login, service binding, credential or access grant is needed, obtain the required approval first. No new endpoint or grant is created by this adapter.

A Rivule Sites publication is a separate operation: inspect/persist its own Site identity, prepare/push its source, save the exact version and deploy privately. Any source-write credential approval must name Rivule; approval for other projects does not cover it. A published static showcase still does not make this adapter live.

Run `npm test` for offline contract and presentation-state tests. These use fixtures, not production task data, and do not prove browser authentication or live integration.
