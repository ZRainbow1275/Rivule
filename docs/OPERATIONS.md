# Deployment and rollback

This review package does not perform deployment. The provided templates disable outbound delivery and contain unusable identity/KV placeholders. Set your own Cloudflare account, Worker names, Discord app/user/DM context, public origin and KV namespace in a private configuration. Preserve secrets server-side.

After rebuilding, use the owner four-module layout in production-readable-ui-candidate-20261018/modules and gateway two-module layout in production-qq-active-probe-candidate-20261018/modules. The public owner is a neutral-artwork variant, not the exact private-production module. Do not bundle the owner module again or replace its external QQ module: the existing eleven-argument integration ABI is deliberate. The SHA256SUMS.txt gateway resource is retained historical provenance, not the manifest of the rebuilt candidate. PROVENANCE.json is authoritative for package integrity.

For a new install, create the gateway Durable Object class QQGatewayObject with migration tag qq-gateway-v1 and the owner class OwnerTerminal with migration tag v1; bind owner QQ_GATEWAY to the gateway Worker and OAUTH_KV to your KV namespace. Existing installations must preserve namespace identity and migration history rather than replaying destructive migrations. New-install acceptance remains required.

Set the Discord application's interaction endpoint to your configured public origin plus /discord/interactions; verify its signed handshake and exact DM/user installation scope. Never use an example host or someone else's application ID. OAuth redirect configuration must match your deployment and approved client. Use official Wrangler authentication; script/version access requires the actual scripts permission, not an assumed equivalence from a similarly named general Workers scope.

For an existing installation: first read current deployed version/module hashes and metadata; stop on drift. Upload an immutable candidate version with the same intended bindings/runtime/migrations; compare metadata and downloaded module hashes before switching traffic. After 100% rollout, read back the version and module hashes. Keep the pre-change version ID privately for rollback. Rollback code does not rewind Durable Object data.

QQ has separate enable/setup/proof/delivery controls. A successful passive reply does not authorize active delivery. Keep the daily connection budget explicit and bounded; do not inherit a newer draft setting silently. Real test sends and new persistent access require the appropriate user approval.

## QQ product roadmap

The intended QQ experience is a full daily terminal: proactively send progress, blockers and requests from every connected and verified PA to the owner’s currently bound personal QQ, then add task details, progress graphics and safe interactions as the official platform permits. The current implementation adds an owner-click one-shot active probe; a successful probe is only the first acceptance gate. Continuing delivery requires current binding/permission evidence, quota-aware pacing, deduplication, clear uncertainty handling and scoped activation. Never silently add a recipient or claim Discord parity before those surfaces are implemented and accepted.
