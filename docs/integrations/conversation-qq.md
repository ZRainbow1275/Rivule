# Ordinary conversation QQ adapter (v2)

These modules add no live configuration, producer activation, webhook subscription, permission grant, or messages. They do not reuse a task/project identifier. Default-off independent owner consent for `general_conversation_response`, source operation grants, current provider enrollment and gateway owner verification remain mandatory.

## Queue

`ConversationQQQueue({storage,bridge,env,ownerId,config,sourceAuthority,activation,now})`:

- `config()` returns `{enabled,ownerId,appId,userOpenId,allowedSources}` from server configuration and the confirmed recipient. It is not itself category authorization.
- `sourceAuthority(sourceId)` returns current `{selectable,verifiedAt}`. Generation, operation revision and binding digest independently come from `ConversationBridge.grant()` and `bindingToken()`.
- `activation()` reads the existing producer runtime `{active,grantId,bindingFingerprint,expiresAt}`. It cannot authorize conversation content on its own.
- `enqueue(authority)` is synchronous durable work within the publish transaction. Expected paused/unavailable state records a terminal suppressed receipt, allowing another authorized channel to succeed. It never backfills such a receipt after activation.
- `currentJob(receipt)` produces a strict conversation envelope, usable by the independent owner verifier. Real conversation sequence and accepted timestamp replace task event/cursor fields.
- `drain()` uses signed `conversation_prepare` / `conversation_commit` operations. Rechecks owner/source/recipient/context consent after asynchronous work and immediately before commit. An unknown commit, malformed outcome or restart-in-flight becomes uncertain, is never retried, and blocks further queue dispatch pending explicit reconciliation. No automatic resume path is added.
- `delivery(receipt)` returns provider_accepted only with a valid actual provider message ID; that is not recipient confirmation.
- `erase(receipt)` cancels queued work. The queue stores no response body or signed plan; the core owns and clears the sole persisted body at expiry. Hashing/dispatch plans are not retained between calls.
- `nextAlarmAt()` participates in the owner scheduler, without starting or reactivating a runtime.

The gateway independently validates the exact response with the configured owner service binding at prepare and commit, under a separate conversation authorization category. Legacy task or task-response grants cannot substitute. Normal task protocol modules are unchanged.

## Inbound

`ConversationQQCommandAdapter({bridge,inbox,rawInbox,config,authority,revoked,now})` wraps only the inbox passed to the existing production `handleQQWebhook` after its real Ed25519 and configured owner C2C identity checks.

- `inbox` is the existing task/lifecycle wrapper for non-conversation events.
- `rawInbox` is the underlying `QQDurableInbox` for exact `/rivule-chat` events, avoiding the legacy task prefix handler. The adapter passes trusted `{retainContent:false}` so the inbox retains the original dedupe fingerprint but not instruction plaintext; bounded plaintext exists only in the core command record. Both use the same durable storage. Do not expose `acceptVerified` as an HTTP or source RPC.
- `authority()` reads signed current gateway `command_authority`; exact owner/app/openID and `conversationVerifierConfigured` must match. `revoked()` reads the local authenticated QQ lifecycle gate.
- Only `/rivule-chat <actual response receipt UUID> <instruction>` selects a conversation. Neither prose, task references nor body-provided trust flags do so.
- ConversationBridge requires current consent and a provider-accepted receipt with actual message ID. Replay keys use app/owner/provider-message ID, not user-provided source identifiers.
- A local revocation guard runs inside the same durable transaction as command insertion, closing the post-signature/post-hash revocation race.
- Commands remain pending until the real source claims them in its exact registered conversation/thread. Claim is not permission to execute; execution policy remains at the source.

Tests exercise the actual production Ed25519/normalization/QQDurableInbox path, real ConversationBridge and SQLite queue. The local transport fixture signs its responses but is not a live QQ provider; independent real gateway/owner-verifier integration is a separate test layer.
