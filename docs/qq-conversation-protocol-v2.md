# QQ conversation protocol v2 (offline implementation, default off)

Conversation forwarding is a separate category from task updates and task-context responses. An existing QQ runtime grant is necessary but does not authorize this category. Owner opt-in must name the source, QQ destination, `general_conversation_response` category and context selection. Source-reported conversation identities are authenticated source assertions, not independent provider ownership proofs.

## Strict message contract

`conversation_prepare` and `conversation_commit` use the existing signed gateway RPC transport, but accept only conversation jobs. Task `prepare`/`commit` and task-context `response_prepare`/`response_commit` reject conversation jobs, and vice versa.

The job has exactly these fields:

- `kind: "conversation"`, `version: 2`
- `intentId`, `sourceId`, `sourceGeneration`, `sourceGrantRevision`, `sourceBindingDigest`
- `receiptId` and `contextRef` (UUIDs), `contextDigest` (SHA-256 of recursive key-sorted canonical context JSON)
- `sequence`, `consentRevision`, `acceptedAt`, `expiresAt`
- `payloadHash` (SHA-256 of exact rendered content), `content`
- `grantId`, `bindingFingerprint`

No nullable or fabricated task, project, event, acceptedRevision or task response cursor is accepted. Conversation sequence is its own real owner-ledger sequence. `acceptedAt` must be at or after the current QQ runtime grant issuance; expired, future or prior-runtime backlog is rejected. Receipt lifetime is at most 24 hours.

The source assertion has exactly `selectable`, `enabled`, `revoked`, `sourceId`, `generation`, `bindingDigest`, `verifiedAt`, `kind`, `version`, `sourceGrantRevision`, `receiptId`, `contextRef`, `contextDigest`, `sequence`, `consentRevision`, `payloadHash`, and `sensitivity`. Enabled, selectable, normal-sensitivity and fresh provenance must match the job. Source grant generation/revision is independent of the task event revision.

## Independent consent verification

The gateway uses only its deployment-controlled `QQ_RESPONSE_AUTHORITY` service binding. Conversation verification additionally requires `QQ_CONVERSATION_AUTHORITY_ENABLED === "true"`; omission or false keeps the feature disabled. This work does not configure a live binding or flag.

The fixed route is `https://rivule-owner.internal/internal/qq-conversation-authority`. Each prepare and commit independently requests a fresh owner verification, outside gateway command locks. Request packet `{body, signature}` uses HMAC domain `rivule-qq-conversation-authority-request-v2`. The body contains exactly `version: 2`, `nonce`, `timestamp`, `ownerId`, `appId`, `userOpenId`, `bindingFingerprint`, `runtimeEpoch`, `grantId`, and the full job.

The owner independently reads current durable per-source/channel/category consent, registered context, current source operation grant and exact stored response/job. It returns the signed five-field proof `{version:2, requestHash, nonce, authorized, validUntil}` in domain `rivule-qq-conversation-authority-response-v2`. The gateway limits proofs to 30 seconds, fetch/read work to 5 seconds and replies to 8 KiB. Redirects, unknown results, wrong domains/nonces/digests and disabled configuration fail closed. The producer cannot submit the authority URL, proof, owner consent or enablement.

Standing owner consent lasts until revoked or paused. A short verification proof does not require the user to approve again. Existing runtime, grant continuity, daily quota, pacing, durable idempotency and unknown-outcome no-resend rules still apply to conversations. Nothing auto-enables or auto-resumes delivery. Provider acceptance does not confirm recipient receipt or reading.

## Retention

Gateway conversation attempts schedule their receipt expiry even when delivery is paused or the QQ connection is stopped. The expiry alarm erases content, context references/digests and the prepare challenge without requiring another user action. A cryptographic job fingerprint, receipt, destination fingerprint and delivery/uncertain tombstone remain for deduplication and review; this is content redaction, not total metadata erasure. Expiration never resumes transport or retries a send.

## Tests

`tests/qq-conversation-gateway.test.mjs` runs the production gateway offline, including strict schema validation, protocol/domain separation, independent cursor handling, consent/runtime/destination revocation, quota and uncertain-outcome safeguards. Paired tests additionally exercise real ConversationBridge SQL consent and response rows, the owner verifier, signed queue drain, actual Ed25519 QQ webhook validation, and command claim/ack in the exact original conversation. Revocation, forged jobs, re-enabled consent replay and unknown outcomes are covered. Provider network posts remain offline fixtures; these results are not a live integration or deployment claim.

## Explicit unknown-outcome review

`conversation_review_status` reads one exact `{intentId, receiptId}` without creating consent, a grant, or a send. It exposes metadata-only scope and a snapshot digest. This narrow path handles terminal `provider_outcome_unknown` attempts at least 30 seconds old, while their original grant/runtime/recipient binding is still current. In-flight, orphaned, changed-runtime or older unsupported tombstones remain unavailable through this path and need the existing broader QQ owner review flow.

`conversation_review` accepts only `{intentId,receiptId,reviewId,snapshotDigest,sequenceFloor}`. It independently reads an already committed owner review from the fixed service-bound `/internal/qq-conversation-review-authority`, using distinct HMAC domains `rivule-qq-conversation-review-authority-request-v1` and `rivule-qq-conversation-review-authority-response-v1`. The producer's own signed request is not an owner approval. The request includes the exact source generation, operation-grant revision, binding digest, consent revision, recipient, original attempt/grant/runtime, receipt and full-job fingerprint. Owner verification uses metadata and current durable scope, not retained response text.

Applying a verified review only marks that one uncertainty as reviewed and persists a source-scope conversation sequence floor. It never changes the original uncertain receipt to sent, retries the receipt, clears other unknowns, starts transport or resumes a grant. The result explicitly says `delivery_resumed:false` and `next_step:'existing_owner_qq_enable'`. A separate existing owner QQ enable action must perform its normal probe, grant and runtime checks before new delivery. Durable source/category consent does not need to be granted again. Old queued conversation sequences at or below the review floor remain fenced even after re-enrollment.

Exact repeat/readback is idempotent. A changed snapshot, pause, runtime, binding, review identifier or watermark fails closed. Reviewed uncertainty and deduplication metadata survive later grants and history cleanup; content is still erased on expiry. The existing bounded attempt capacity applies rather than silently dropping uncertainty records.

Paired offline recovery tests use the real owner review manager and SQL-confirmed review record, the fixed signed review authority endpoint and gateway mutation/readback. They demonstrate that an unconfirmed producer request cannot clear an unknown; a lost apply response is resolved with a read-only status check and no second mutation; another unknown still blocks re-enrollment; and only a separate existing owner enable action permits subsequent fresh delivery. They do not constitute live enablement or a delivery confirmation for the original message.
