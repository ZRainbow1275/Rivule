import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(root, '../production-readonly-20261018');
const gatewayPath = path.join(base, 'bbbot-qq-gateway/modules/gateway-candidate.mjs');
const ownerPath = path.join(base, 'bbbot-pa-terminal/modules/qq-integration.mjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const raw = readFileSync(gatewayPath, 'utf8');
const owner = readFileSync(ownerPath);
if (hash(raw) !== 'ed0495e49716d16cfa06eee82d1d4b26c6862850f51930ac41ed04a3b3fd7044') throw Error('production_gateway_hash_changed');
if (hash(owner) !== '3c19b4634a0d2a100afbe1e12e5687ca9851901ae0f3d67e6e0da56ebf17730c') throw Error('production_owner_integration_hash_changed');

const helpers = `// Exact, fixed-vocabulary rejection diagnostics only. No capability or retry changes.
function qqRejectionReason(status, code) {
  if (status === 429 || code === 40034100) return "rate_limited";
  if (!Number.isSafeInteger(code)) return "provider_rejected";
  return { 40034105: "proactive_permission_denied", 40054004: "friendship_missing", 40054013: "recipient_refused", 40054016: "bot_offline" }[code] ?? "provider_rejected";
}
function qqBridgeRejectedReceipt(result) {
  const reason = Number.isSafeInteger(result?.providerCode) ? qqRejectionReason(0, result.providerCode) : "provider_rejected";
  if (result.state === "not_sent" && reason !== "provider_rejected" && result.reason === reason) {
    return { state: "not_sent", reason, providerCode: result.providerCode };
  }
  return { state: result.state, reason: "provider_rejected" };
}
`;
const edits = [
  {
    name: 'classify_five_known_transport_rejections',
    before: 'reason: r.status === 429 || code === 40034100 ? "rate_limited" : "provider_rejected",',
    after: 'reason: qqRejectionReason(r.status, code),',
  },
  {
    name: 'preserve_exact_allowlisted_bridge_pairs',
    before: 'else if (["not_sent", "blocked"].includes(result?.state)) receipt = { state: result.state, reason: "provider_rejected" };',
    after: 'else if (["not_sent", "blocked"].includes(result?.state)) receipt = qqBridgeRejectedReceipt(result);',
  },
  {
    name: 'add_private_diagnostic_helpers',
    before: 'async function qqGateKey(appId, userOpenId) {',
    after: helpers + 'async function qqGateKey(appId, userOpenId) {',
  },
];
let candidate = raw;
for (const edit of edits) {
  if (candidate.split(edit.before).length !== 2) throw Error('ambiguous_patch:' + edit.name);
  candidate = candidate.replace(edit.before, () => edit.after);
}
let reversed = candidate;
for (const edit of [...edits].reverse()) {
  if (reversed.split(edit.after).length !== 2) throw Error('ambiguous_reverse_patch:' + edit.name);
  reversed = reversed.replace(edit.after, () => edit.before);
}
if (reversed !== raw) throw Error('reverse_patch_failed');
for (const marker of ['// qq-cloudflare/proof.mjs', '// qq-cloudflare/admin.mjs', '// qq-cloudflare/actor.mjs', '// qq-cloudflare/worker.mjs']) {
  if (!candidate.includes(marker)) throw Error('missing_production_section');
}
mkdirSync(path.join(root, 'modules'), { recursive: true });
mkdirSync(path.join(root, 'preserved-owner-reference'), { recursive: true });
writeFileSync(path.join(root, 'modules/gateway-candidate.mjs'), candidate);
copyFileSync(ownerPath, path.join(root, 'preserved-owner-reference/qq-integration.mjs'));
writeFileSync(path.join(root, 'reverse-patch.json'), JSON.stringify(edits, null, 2) + '\n');
writeFileSync(path.join(root, 'PATCH_MANIFEST.json'), JSON.stringify({
  schema_version: 1,
  base_gateway_sha256: hash(raw),
  candidate_gateway_sha256: hash(candidate),
  preserved_owner_integration_sha256: hash(owner),
  reverse_patch_sha256: hash(JSON.stringify(edits, null, 2) + '\n'),
  reverse_patch_recovers_exact_production: true,
  modifications: edits.map(edit => edit.name),
  preserved: ['Fixed-reply eligibility, text, payload and one-shot ledger', 'Gateway actor, permission checks, flags and RPC exports', 'Transport rejection states, idempotency, reservations, pacing and retry behavior', 'Owner integration byte-for-byte, including its 11-argument interaction ABI'],
  configuration_files_created: false,
  runtime_flags_changed: false,
  production_flags_queried: false,
  deployed: false,
}, null, 2) + '\n');
console.log('Built local QQ diagnostic candidate: ' + hash(candidate));
