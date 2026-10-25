# Bounded MCP failure observation

For an enabled existing diagnostic configuration, failed MCP requests can emit an operational console record with exactly `component`, `stage`, `code`, and `http_status`. Both stage and code come from literal allowlists; unknown values become `unknown`. Exception messages, source identities, URLs, headers, bodies, tokens and recipient identifiers are never included. No new storage, credential, external logger or service binding is configured.

This does not change HTTP responses, OAuth rules or tool outcomes. A tool-level error can have HTTP 200; the record preserves that transport status. A successful diagnostic read can still fail during source-proof refresh, which is separately labeled. Final response failures may also emit a fixed `response/unknown` category; it is not a second request. Ordinary successful reads produce no failure record. Existing `trace.skip` still suppresses database diagnostic records, including diagnostics reads.

The production transport regressions cover unchanged success/rejection status and bodies, diagnostic read suppression, safe proof-refresh classification, poisoning with private strings, and an unavailable log sink. These categories are evidence for the next controlled observation, not a claim that the current connector error is already fixed. Existing platform log retention applies; no persistent logging settings are changed by this code.

Proof-refresh failures additionally identify only fixed subphases: context digest,
schema checks, transaction start, row read, generation/revocation guard, write,
and transaction completion. The actual OAuth facade distinguishes an RPC throw
from an unsuccessful RPC envelope. These are failure-only observations; they do
not log source identity, database values, SQL, exception names/messages or raw
RPC results. An unavailable HTTP status remains null. The original rejection,
rollback and response behavior remain unchanged; no failed proof becomes success.

The offline persistence regression loads the production modules into real
workerd/Miniflare and calls OwnerTerminal over Durable Object RPC against SQLite.
Cold initialization and a warm existing proof both succeed with generation 1 and
no task/outbox tables. Thus unsupported transaction/pragma behavior is not an
established explanation for the live failure. Fixed subphase observation is still
needed to distinguish live state or storage failure, not a claimed root-cause fix.
