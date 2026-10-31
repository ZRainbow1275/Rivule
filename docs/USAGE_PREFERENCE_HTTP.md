# Optional Cloudflare reminder preferences

The owner settings panel can save an optional percentage preference before a
supported account-wide metric and quota have been connected. It displays:

**仅保存偏好，尚未接入实际用量，提醒未启用**

Actual usage is unknown and the applicable quota is unconfirmed. There is no default
percentage, progress bar, enable checkbox, collector or notification operation.
These preferences do not alter QQ notification counts or runtime budgets.

## Unbound intent, not an operational rule

`usage-preferences:unbound:v1` stores exactly:

`{version:1, revision, owner_binding, threshold_percent}`.

The percentage must be an integer from 1 to 100. An absent record has revision zero
and a null draft. This value means “I would like a reminder at this percentage of
an applicable quota”; it is not a measured percentage or a verified provider quota.
No account, metric, time window, grant, destination or enabled flag is stored.
The key belongs to an owner-isolated store, not a shared cross-owner database.

Future account/metric selection, quota entitlement/window verification and
notification authority require separate review. Never automatically convert this
intent into an absolute-count rule, arm a collector or send when credentials appear.
Existing bound policies use a different key and are neither armed nor disarmed by
this feature.

## Authenticated routes

`GET /dashboard/usage-preference` reads without granting editing rights or writing
preferences. `POST /dashboard/usage-preference/access` accepts exactly
`{csrf, confirm:true}` and grants a short-lived preference-edit capability.
`POST /dashboard/usage-preference` accepts exactly
`{csrf, capability_id, expected_revision, threshold_percent}`.

Successful views contain `revision`, nullable `draft`, `state:unbound_draft`,
`monitoring:not_connected`, `notifications_enabled:false`, `usage:null`,
`quota:null`, the session CSRF token and nullable `access` containing
`capability_id` and `expires_at`. These status fields describe this feature, not
all external account notification systems. Internal owner/session bindings are
never returned.

The Worker validates its configured origin and routes to its fixed owner Durable
Object. Dashboard authentication hashes the opaque session cookie to its server
record and validates expiry and configuration binding. The route retains exact
Origin checks for POST, same-origin Fetch Metadata, strict JSON/body fields, a
2 KiB body bound, rejected query strings and no-store responses.

The dedicated capability lasts at most five minutes and never beyond the session.
It is not a QQ capability, Analytics permission, OAuth grant or sending consent.
Its generation is pinned by the save request; a replacement cannot silently
re-authorize an in-flight save. Session, CSRF, configuration, capability and
compare-and-swap checks occur in the same owner storage transaction as the write.
Late revocation or expiry rejects the transaction. The storage contract requires
rollback of staged writes on callback rejection.

`usage-preference-draft.mjs` snapshots validated request scalars before awaiting
authorization/storage, so caller mutation cannot change the validated percentage
or original CAS revision. `usage-preference-http.mjs` is a separately testable
abstract HTTP boundary; the connected dashboard uses
`dashboard-usage-preference.mjs` for transaction-scoped authentication.

## Panel lifecycle and uncertain outcomes

Opening or refreshing performs GET only. A deliberate Save may first acquire the
narrow edit capability, then save the captured value and revision. Repeated clicks
are fenced. Conflicting revisions require re-reading and review, not overwrite.
No mutation is retried automatically.

Close, Cancel, parent settings closure, navigation, visibility and session expiry
invalidate pending UI work. Both parent and child synchronous open states are
checked at the access-to-save boundary; queued close events cannot start a late
save. If POST has already started, closing does not prove cancellation or rollback.
The next action is a read-only lookup of the stored revision/value.

A transport failure may occur after commit. Show “保存结果未知；请重新读取核对” and
keep saving disabled until a successful readback. Reauthentication is required
when the owner session fails; no speculative new preference write is performed.

## Verification boundaries

Tests cover optional defaults, exact field validation, mutable caller input,
opaque-cookie authentication, CSRF/origin rejection, separate capability generation,
CAS races, transactional rollback, unknown-save readback and interrupted UI flows.
Synthetic identity fixtures are not real provider/owner login acceptance.
Local tests do not imply a hosted deployment or verified provider metrics.

Before operational monitoring, establish authorized Analytics access, supported
account coverage, metric schema, quota/window mapping, normalized fresh reads,
crossing/delivery deduplication and explicit notification authorization. Missing or
incomplete data must remain unknown, never a fabricated zero.
