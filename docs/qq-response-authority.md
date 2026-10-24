# QQ response authority (default off)

Task-update delivery remains unchanged. Arbitrary assistant responses require independent owner consent verification in addition to the existing QQ grant, source verification, registered task context, runtime budget, and delivery quota.

## Deployment wiring

The gateway example sets `QQ_RESPONSE_AUTHORITY_ENABLED` to `false` and supplies no reverse service binding. Response delivery therefore fails closed by default. Enabling this feature requires an explicitly authorized deployment change:

1. Bind gateway `QQ_RESPONSE_AUTHORITY` to the intended Rivule owner Worker using a fixed Cloudflare service binding.
2. Enable the corresponding read-only owner verifier and gateway `QQ_RESPONSE_AUTHORITY_ENABLED` flag only after the owner consent UI and integration tests are available.
3. Obtain explicit source-specific QQ response opt-in through the authenticated owner flow. Existing task grants or Discord forwarding preferences do not authorize QQ responses.

No producer can specify an authority URL or submit its own authority response. No extra signing key is needed. The existing bridge secret authenticates a read request only; it cannot create consent.

## Protocol

Gateway sends a signed `{body, signature}` packet to the fixed service-bound endpoint `https://rivule-owner.internal/internal/qq-response-authority`. The JSON body contains `version: 1`, fresh `nonce`, `timestamp`, current `ownerId`, `appId`, `userOpenId`, `bindingFingerprint`, `runtimeEpoch`, `grantId`, and the complete typed `job`. The HMAC domain is `rivule-qq-response-authority-request-v1`.

Owner independently reads durable source/channel/category consent and the exact stored response job. Its signed reply contains exactly `version`, `requestHash`, `nonce`, `authorized`, and `validUntil`, using `rivule-qq-response-authority-response-v1`. The request hash binds every request field. Proof lifetime is at most 30 seconds, with a new independent check at both prepare and commit. Durable owner consent does not expire with a proof or management session; it lasts until revoked or paused.

Missing configuration, redirection, timeout, malformed/oversized replies, invalid signatures, mismatched request hashes/nonces, expired proofs, and denied consent all suppress delivery. Proofs cannot bypass current destination/runtime/grant/source checks, pacing, quota, deduplication, or unknown-outcome no-resend behavior. Provider acceptance is not recipient confirmation.

## Verification boundary

`tests/qq-response-contract.test.mjs` exercises the shipped gateway with offline service-bound authority fixtures and paired production owner verifier, real SQL consent, registered MessageBridge contexts, and QQ queue projections. Paired cases cover exact approved delivery, revocation between prepare and commit, forged content, destination mismatch, and revoke/re-enable replay rejection. These offline tests do not prove an installed service binding or live provider delivery.
