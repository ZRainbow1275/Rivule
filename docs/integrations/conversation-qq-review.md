# Owner review of a conversation QQ unknown outcome

This is a metadata-only acknowledgement. It never asserts that the old message arrived or failed, never resends it, never enables or resumes QQ, and never changes budget or standing consent. The original outbox status/result remains uncertain forever. The existing owner QQ enable flow is a separate step, with all original gates still applied.

## Integration contract

Construct `ConversationQQReview({storage,queue,currentOwnerState,gateway?,now?,random?})` only in the authenticated owner controller. The default gateway function uses the existing signed internal broker. No source/producer operation exposes preview or confirm.

- Expired never-confirmed preview drafts are ephemeral and are reclaimed only inside a later preview mutation. Every once-confirmed intent and confirmed/readback/blocked/reviewed tombstone remains durable; read-only access never performs cleanup.
- `preview(receipt)` reads the exact terminal gateway unknown snapshot and persists a short-lived prepared review. It returns review_id, receipt_id, scope (opaque hash), expires_at, safe original/current revision summary and confirmation wording. A source caller cannot mint this confirmation.
- `confirm(reviewId,scope,admissionGuard)` requires the owner controller's short-lived authenticated management-cap guard; each review intent can be confirmed only once. It rechecks original receipt, exact unknown set, maximum admitted sequence, current identity/config/consent and current gateway snapshot inside the final local transaction. The committed explicit intent is synced before gateway mutation.
- `reviewAuthority(reviewId,scope,reviewPayload)` is read-only for the independent fixed owner verifier. It authorizes only the exact committed payload for an immutable window no longer than 30 seconds. Producer-signed fields cannot create or extend this window.
- `readback(reviewId)` only calls conversation_review_status, never repeats conversation_review. Lost remote responses and process restart after confirmation stay readback-only. Verified settlement may occur after the authorization window expires without authorizing a new mutation.

The separate owner authority endpoint should call `review.reviewAuthority(payload.reviewId,scope,payload)` twice around its own asynchronous response signing, according to its service verification contract.

`currentOwnerState(sourceId,originalQueueRow,gatewayScope)` must return trusted local/configured metadata, not producer fields:

sourceId, providerId, accountBinding, generation, grantRevision, sourceBinding, sourceEnabled, consentRevision, consentEnabled, commandsEnabled, recipient, verifiedAt.

The source/provider/account, source generation and actual owner/app/openID/binding fingerprint destination must match the original queue scope for this slice. Operation revisions or category consent can differ from the original send, but must remain unchanged throughout review. Disabled operations/category do not prevent no-send review. Persisted same-account proof may be older than 24 hours solely for this metadata operation; it is never labeled current provider verification and never relaxes freshness for future sends. The helper must reject newer contradictory identity evidence.

## Queue behavior

A separate conversation_qq_reviewed marker excludes only the exact acknowledged unknown from the blocking set. Other unknowns still block. The original uncertain row is never converted to sent/not_sent and never queued again.

While any unreviewed unknown exists, newly admitted conversation responses receive terminal suppressed channel receipts. On successful settlement every existing queued receipt through the final sequence watermark is suppressed, so review cannot release historical backlog. Only later new responses may become eligible, and they still require source/owner consent and the independently enabled runtime. The gateway separately persists its reviewed-intent sequence floor across later runtime enrollment.

## Explicit limits

This gateway slice reviews terminal provider_outcome_unknown outcomes with unchanged runtime/grant/destination and minimum terminal age. In-flight, missing, changed-runtime and other unavailable evidence stays blocked; the module does not improvise recovery. If gateway review is confirmed but current owner scope changed before local settlement, local state becomes blocked with next_step=manual_reconciliation_required. This slice has no automatic or UI readback recovery for that changed-scope state; a separate explicit reconciliation flow is still needed. It must not be presented as an actionable readback retry. A reviewed marker is not a delivery receipt.

Tests use the actual ConversationBridge and queue with SQLite, plus a narrowly modeled gateway review contract. Real paired gateway/fixed-owner-service tests are a separate integration layer. No live messages, configuration changes or permission grants are performed by these tests.

## Explicit unavailable historical-source cases

This no-send review supports an identifiable source/account/generation even when its conversation operation grant or category consent is now revoked, and can use stale persisted lineage solely to acknowledge metadata after message-body expiry. It never presents stale lineage as a fresh send proof. Ordinary sending still requires current source freshness and all existing gates.

A removed source, changed provider/account or generation, source configuration disable that invalidates the stored binding, unsupported orphan-inflight gateway attempt, or unverifiable historical lineage is not automatically reconciled by this batch. An orphan unknown may continue blocking the shared QQ grant's re-enrollment and the local conversation queue, including other sources. The UI must say reconciliation is unavailable, not suggest repeatedly pressing readback as a fix. Do not delete its uncertainty tombstone, restore old source authorization, or claim a message was sent/not sent to work around the block. A separately designed explicit historical-owner reconciliation flow remains required for those cases.

If remote review succeeds but owner scope changes before local settlement, the local result is `blocked` with `manual_reconciliation_required`. The original receipt remains unknown; this edge has no automatic continuation or resend path.
