# QQ task-context commands and response queue

This patch does not register webhooks, enable a producer, change permissions, send live QQ messages, or deploy anything.

## Owner wiring

Import `QQCommandAdapter` from `qq-command-adapter.mjs`. Construct it around the existing `QQDurableInbox` only within the existing owner webhook handler. `handleQQWebhook` must remain responsible for Ed25519 verification, configured app ID and C2C owner openID checks. Do not expose `acceptVerified` as a public route or trust a request-body `verified` field.

Constructor dependencies:

- `bridge`: actual owner-scoped MessageBridge.
- `inbox`: existing QQDurableInbox(storage), retaining duplicate/conflict/capacity behavior.
- `config`: current configured ownerId/appId/userOpenId, allowedSources/allowedProjects and feature enabled flag. The feature flag is not evidence of enrollment.
- `authority`: `() => queue.commandAuthority()`, signed v2 internal broker read; requires active real gateway enrollment/lifecycle, matching configured owner/app/openID, current generation and unexpired validity.
- `revoked`: `async c => await storage.get(await qqGateKey(c.appId,c.userOpenId)) === true`. Mandatory: local authenticated lifecycle rejection must block even if gateway state has not caught up.

`enqueueOnce` persists the existing inbox item, then processes `/rivule UUID instruction`. Duplicate events retry command admission after a crash; MessageBridge deduplicates by a hash of app/openID/provider message ID. Conflicting inbox bodies never reroute. Ordinary prose never selects a PA. The callback acknowledges durable admission, not PA execution or user-visible delivery; commands remain source-initiated pull and source policy still applies.

MessageBridge must invoke the adapter's third `enqueueCommand` argument (an internal admissionGuard closure, never a public payload field) inside its durable insert transaction. This closes the local lifecycle revocation race after asynchronous hashing.

The adapter calls `bridge.resolveQQContext(ref, trusted)` and expects exactly source_id/project_id/task_id/run_id/branch_id/thread_id. That resolver must require an actually provider-accepted QQ forward for the current registered source binding/context/consent, bounded freshness, and reject unknown, stale, revoked and ambiguous contexts. Source claims and acknowledgments remain MessageBridge's responsibility.

## Queue wiring

Call `queue.attachMessageBridge(bridge)` before dispatch. For ordinary accepted task events call `bridge.recordTask(event,receipt)` before `queue.enqueue(event,receipt)`. `bridge.taskAuthority(source,receipt)` may decorate a genuine task notification only when its exact registered context and command consent remain valid.

For a user-visible response, persist the typed `events` row with decision `bridge_response` plus matching authoritative `bridge_responses` row in the same transaction, then call `queue.enqueueResponse(source,receipt)`. No synthetic task state/sequence transition is made. `bridge.responseAuthority(source,receipt)` returns `{event,revision,context,context_ref,consent_revision,receiptId,decision:'bridge_response'}` or null. The queue revalidates this before both prepare and commit. The response uses separate response_prepare/response_commit operations, responseRevision (actual global receipt revision), and typed source proof. Existing producer cursor, quotas, pacing, unknown-outcome pause, no-replay behavior and signing domains remain in force. The gateway also requires explicit owner response-channel policy; local every-response preference alone does not activate QQ.

Provider acceptance is not recipient confirmation. Missing gateway policy is not successful delivery. No instruction can wake a paused PA or authorize execution contrary to its own policy.

## Native quote correlation limitation

The existing production normalizer does not preserve a quoted-message reference. Current official C2C event/API URLs were attempted but unavailable to the research tool on 2026-10-24:

- https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html
- https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html

The official Tencent SDK's outbound quote example (https://github.com/tencent-connect/qqbot-agent-sdk/blob/main/examples/e2e_test.py) does not establish a verified inbound correlation contract. Therefore this slice uses the explicit server-stored context code and does not infer a quote target or assert that QQ lacks quote support. A future native quote path must preserve authenticated callback fields and map only known stored outbound provider identifiers, with the same scope/lifecycle gates.
