import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(fileURLToPath(import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const base = readFileSync(path.join(root, 'reference/gateway-base.mjs'), 'utf8');
if (sha(base) !== 'cc94f479fab39dac1351638e6fb51bb8f695789c34e93473a45ef3122084c0c8') throw Error('base_digest_mismatch');
let candidate = base;
const edits = [];
const edit = (label, before, after) => {
  if (candidate.split(before).length !== 2) throw Error('exact_patch_count:' + label);
  candidate = candidate.replace(before, () => after);
  edits.push({ label, before, after });
};
edit('insert isolated one-shot probe', '// qq-cloudflare/admin.mjs\n', readFileSync(path.join(root, 'source/active-probe.mjs'), 'utf8') + '// qq-cloudflare/admin.mjs\n');
edit('active owner-only control execution', '  } else if (action.action === "stop") {', `  } else if (action.action === "active_probe") {
    const pending = fixedActiveProbe(actor, action, p.id);
    actor.ctx.waitUntil(pending.catch(() => {}));
    const r = await pending;
    text2 = \`主动测试：\${activeProbeHumanReceipt(r)}\`;
  } else if (action.action === "stop") {`);
edit('active panel eligibility and receipt', '  const specs = [["status",', `  const active = await actor.store.transaction((s) => activeProbePanel(actor, s));
  if (active.receipt && action.action !== "active_probe") text2 += \`\n主动测试：\${activeProbeHumanReceipt(active.receipt)}\`;
  else if (active.eligible) text2 += "\\n测试内容：" + ACTIVE_PROBE_TEXT + " 仅测试一次，失败不自动重发。";
  else if (status.bound && !active.receipt && action.action !== "active_probe") text2 += \`\n主动测试：\${activeProbeHumanReason(active.reason)}\`;
  const specs = [["status",`);
edit('active button exposure', '  if (!status.running) specs.push(["start",', '  if (active.eligible) specs.push(["active_probe", "发送一次主动测试"]);\n  if (!status.running) specs.push(["start",');
edit('control binds current generation', '...action2 === "confirm" ? { confirmationId: status.pendingPairing.confirmationId } : {} };', '...action2 === "confirm" ? { confirmationId: status.pendingPairing.confirmationId } : {}, ...action2 === "active_probe" ? active.control : {} };');
edit('Discord maximum five controls per row', '    return [{ type: 1, components: specs.map(([action2, label]) => {', '    const buttons = specs.map(([action2, label]) => {');
edit('chunk Discord rows', '    }) }];\n  });\n  return reply(text2, components);', '    });\n    return Array.from({ length: Math.ceil(buttons.length / 5) }, (_, row) => ({ type: 1, components: buttons.slice(row * 5, row * 5 + 5) }));\n  });\n  return reply(text2, components);');
edit('authenticated resumed dispatch provenance', '        await this.onDispatch(event);', '        await dispatchAuthenticatedGatewayEvent(this, event, "replay");');
edit('authenticated live dispatch provenance', '    await this.onDispatch(p);', '    await dispatchAuthenticatedGatewayEvent(this, p);');
edit('runtime authentic dispatch context', 'onDiagnostic, onDispatch: async (event) => {', 'onDiagnostic, onDispatch: async (event, auth) => {');
edit('permission event ingestion', `        await store.transaction((state) => {
          const b = state.binding, d2 = event.d;
          if (b?.appId === appId && b?.ownerId === ownerId && [d2?.openid, d2?.user_openid].includes(b.userOpenId)) {
            if (["FRIEND_DEL", "C2C_MSG_REJECT"].includes(event.t)) state.qqRevoked = true;
          }
        });`, `        await store.transaction((state) => observeActivePermission({ state, store, event, auth, client, appId, ownerId, now: now() }));`);
edit('serialize ingestion with final send gate', `      runtime.client.onDispatch = async (event) => {
        try {
          await dispatch(event);`, `      runtime.client.onDispatch = (event, auth) => this.command(async () => {
        try {
          await dispatch(event, auth);`);
edit('close ingestion command', `          throw error;
        }
      };
      await this.store.transaction((state) => {
        const session = state.gatewaySession;`, `          throw error;
        }
      });
      await this.store.transaction((state) => {
        const session = state.gatewaySession;`);
edit('drain serial outside command queue to avoid ingestion deadlock', `  async reviewAndDrainInbox(options) {
    return this.command(async () => {
      const running = await this.store.transaction((state) => state.control?.running);
      if (running) throw Error("stop_before_review");
      await this.configuredRuntime();
      return this.runtime.reviewAndDrainInbox(options);
    });
  }`, `  async reviewAndDrainInbox(options) {
    const runtime = await this.command(async () => {
      const running = await this.store.transaction((state) => state.control?.running);
      if (running) throw Error("stop_before_review");
      await this.configuredRuntime();
      return this.runtime;
    });
    // Ingestion itself uses command(); never hold that queue while waiting
    // for already-enqueued gateway frames to finish.
    await runtime.client.serial;
    return this.command(async () => {
      const running = await this.store.transaction((state) => state.control?.running);
      if (running || runtime !== this.runtime || !runtime.client.stopped) throw Error("stop_before_review");
      return runtime.reviewAndDrainInbox(options);
    });
  }`);
writeFileSync(path.join(root, 'modules/gateway-candidate.mjs'), candidate);
const reverse = JSON.stringify(edits, null, 2) + '\n';
writeFileSync(path.join(root, 'reverse-patch.json'), reverse);
let restored = candidate;
for (const change of [...edits].reverse()) {
  if (restored.split(change.after).length !== 2) throw Error('inverse_count:' + change.label);
  restored = restored.replace(change.after, () => change.before);
}
if (restored !== base) throw Error('inverse_mismatch');
writeFileSync(path.join(root, 'PATCH_MANIFEST.json'), JSON.stringify({ schemaVersion: 1, kind: 'local-only-one-shot-active-probe', deployed: false, baseGatewaySha256: sha(base), candidateGatewaySha256: sha(candidate), reversePatchSha256: sha(reverse), ownerIntegrationSha256: sha(readFileSync(path.join(root, 'reference/qq-integration.mjs'))), exactInverseVerified: true, editCount: edits.length, preservedProvenanceModuleSha256: sha(readFileSync(path.join(root, 'modules/SHA256SUMS.txt'))), configurationFilesCreated: false, runtimeFlagsChanged: false, externalNetworkUsedByTests: false, rpcMethodsAdded: [], ordinaryDeliveryEvidenceSourceUnchanged: true }, null, 2) + '\n');
console.log(JSON.stringify({ candidateSha256: sha(candidate), inverseVerified: restored === base, edits: edits.length }));
