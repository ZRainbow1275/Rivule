# Conversation-v2 Discord controls

The isolated `ConversationDiscordAdapter` accepts signed owner DM interactions for `rvconv:<receipt UUID>` buttons and `rvconvsubmit:<ticket UUID>` modals. It uses the existing raw-byte Ed25519 verifier, including application, configured owner, DM, installation, signature freshness, body size, and original bot-message author checks. Other valid controls return null for the legacy dispatcher. No slash command registration or Gateway deployment is required.

## Internal integration

- Import `ConversationDiscordAdapter` from `conversation-discord-adapter.mjs` and include the module in the build copy list.
- Construct inside the owner Durable Object with `{storage,bindings,bridge:conversationBridge,publicKey}`.
- The displayed immutable response button uses `rvconv:` plus the raw receipt UUID, not the reusable context reference. Do not add controls to unknown or unauthorized contexts.
- Route original request bytes/headers unchanged to `adapter.handle(request,{admissionGuard})`. The optional outer admission guard enforces the edge deadline; adapter default local deadline is 1,800 ms. Preserve a total response budget below Discord's three-second deadline. Null responses should fall through using untouched request bytes.
- `bridge.resolveDiscordReceipt(receiptId,messageId)` is synchronous and must validate the exact immutable response receipt, accepted Discord message ID, current source/owner binding, conversation registration, current command consent epoch, and source grant. Return exactly `{kind:'conversation',version:2,context_ref,receipt_id,conversation_id,thread_id,source_id}`. No task project/run/branch identifiers are supported.
- `bridge.enqueueCommand(trusted,{receipt_id,text,ttl_seconds},admissionGuard)` must invoke/await the supplied admission guard inside its final storage transaction, after any earlier async work, then revalidate the exact receipt and authority before committing. The adapter-supplied guard also resolves the signed original message again and rejects a changed message correlation or conversation target. `trusted` comes only from verified owner/channel/interaction metadata. The queue must use event-ID idempotency and never execute a command itself.
- Include `adapter.nextExpiry()` in alarm scheduling after modal handling, and call `adapter.expire()` on alarms. Tickets retain only a SHA-256 instruction digest, not plaintext. They expire after five minutes and are bounded to 2,000 live records.

Opening and submitting both resolve the immutable receipt against the signed original message. Each ticket binds one opening event, receipt, original message, first submission event and instruction digest. Replays with changed content, another message or another event fail. Exact duplicate submissions reach the core queue using the same event ID. Text is bounded to 1–1,200 characters and command TTL is one hour. Notices disable mentions and distinguish queued, previously recorded, and uncertain outcomes; none claims a PA was awakened or that instructions executed.

Timeout before verification cannot later open a modal. Timeout during authenticated handling produces an uncertain-outcome notice; subsequent guard checks reject late admission. A transaction already committed before timeout remains durable and must not be automatically resent under a new event ID.

## Verification and live boundary

`node --test tests/conversation-discord-adapter.test.mjs` runs real Ed25519 signature and SQLite tests against the actual adapter, with both an isolated fake bridge and the real ConversationBridge module. It covers receipt mismatch, rejection of task-shaped targets, signed-original-message binding, owner/install/channel validation, malformed input, replay, expiry, digest retention, legacy namespace separation and late transaction admission.

Six integrated core tests additionally verify real registration/consent/publication, immutable receipt correlation, consent/source rotation, queue deduplication, claim/acknowledgment, expired-lease uncertainty and final-admission message fencing, without creating any task tables. Provider delivery is still a simulated callback. These tests do not prove the production outbox, worker route, deployed behavior or live delivery; those require separate integration checks including the edge deadline. No real Discord send, credential change, registration, deployment or PA execution was performed by this adapter implementation.
