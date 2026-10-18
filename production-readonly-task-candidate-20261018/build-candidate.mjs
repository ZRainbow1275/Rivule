import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = dirname(fileURLToPath(import.meta.url));
const base = resolve(root, '../production-ui-candidate-20261018/modules');
const hash = x => createHash('sha256').update(x).digest('hex');
const expected = '9becfb77fdf3edb1bc999ac598917643319562e8103c1a73f288437d43150b21';
let code = readFileSync(resolve(base, 'worker.js'), 'utf8');
if (hash(code) !== expected) throw Error('Sanitized public display baseline hash mismatch');
const changes = [];
function replace(before, after, label) {
  if (code.split(before).length !== 2) throw Error('Patch anchor not unique: ' + label);
  code = code.replace(before, after); changes.push({ label, before, after });
}
replace('// src/ingress.ts', '// BEGIN RIVULE READONLY TASK SNAPSHOT 20261018\n' + readFileSync(resolve(root, 'src/task-snapshot.js'), 'utf8') + '// END RIVULE READONLY TASK SNAPSHOT 20261018\n\n// src/ingress.ts', 'isolated SELECT-only snapshot implementation');
replace('!["/v1/events", "/v1/receipt"].includes(path)', '!["/v1/events", "/v1/receipt", "/v1/task/snapshot"].includes(path)', 'HMAC ingress exact route');
const listAnchor = '      ...isDiagnosticReader(source, config2) ? [{ name: "get_connection_diagnostics"';
replace(listAnchor, '      { name: "get_task_snapshot", description: "Read one exact project/task/run/branch from this authenticated source only. Returns the actual nullable source_seq, projected status and pending actions. Sequence advice is nonreserved, not approval, not compare-and-swap and must not be blindly auto-assigned or retried. No discovery, notification, source-proof refresh, expiry or alarm writes, even on cold start.", inputSchema: taskSnapshotInputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, securitySchemes: [{ type: "oauth2", scopes: ["pa:receipt"] }], _meta: { securitySchemes: [{ type: "oauth2", scopes: ["pa:receipt"] }] } },\n' + listAnchor, 'MCP tool definition');
replace('        } else if (call.params.name === "get_connection_diagnostics") {', '        } else if (call.params.name === "get_task_snapshot") {\n          trace?.skip();\n          authorizeOAuthContext(request, ctx, config2, ["pa:receipt"]);\n          const query = validateTaskSnapshotQuery(args);\n          result2 = await owner.taskSnapshot(principal, query);\n        } else if (call.params.name === "get_connection_diagnostics") {', 'MCP scope/query/RPC dispatch without handshake');
replace('      return response2;\n    } finally {\n      await transport.close();', '      if (parsed.method === "tools/call" && parsed.params?.name === "get_task_snapshot") {\n        const headers = new Headers(response2.headers);\n        headers.set("cache-control", "no-store");\n        return new Response(response2.body, { status: response2.status, statusText: response2.statusText, headers });\n      }\n      return response2;\n    } finally {\n      await transport.close();', 'snapshot-only MCP responses explicitly no-store');
replace('  let response2;\n  try {\n    response2 = await gatewayCore(request, env, ctx, trace);', '  await suppressTaskSnapshotTrace(request, trace);\n  let response2;\n  try {\n    response2 = await gatewayCore(request, env, ctx, trace);', 'no diagnostic sink for identified snapshot calls');
replace('          diagnostics: /* @__PURE__ */ __name(async (principal, query) => appendMuseConfiguration', '          taskSnapshot: async (principal, query) => unwrap(await owner.taskSnapshot(principal, query)),\n          diagnostics: /* @__PURE__ */ __name(async (principal, query) => appendMuseConfiguration', 'gateway private RPC adapter');
const start = code.indexOf('  constructor(ctx, env) {', code.indexOf('var OwnerTerminal = class'));
const end = code.indexOf('  async fetch(request) {', start);
const oldConstructor = code.slice(start, end);
const innerStart = oldConstructor.indexOf('    const sourceBindingContext = {};');
const innerEnd = oldConstructor.indexOf('    ctx.blockConcurrencyWhile(async () => {');
let setup = oldConstructor.slice(innerStart, innerEnd);
setup = setup.replace('    if (ctx.id.toString() !== env.OWNERS.idFromName("owner:" + b.ownerId).toString()) throw new Rejected("owner_object_mismatch", 503);\n', '').replace('    if (!["true", "false"].includes(env.DELIVERY_ENABLED)) throw new Rejected("delivery_config_invalid", 503);\n', '');
const newConstructor = `  initialized;\n  constructor(ctx, env) {\n    super(ctx, env);\n    const b = loadBindings(env);\n    if (ctx.id.toString() !== env.OWNERS.idFromName("owner:" + b.ownerId).toString()) throw new Rejected("owner_object_mismatch", 503);\n    if (!["true", "false"].includes(env.DELIVERY_ENABLED)) throw new Rejected("delivery_config_invalid", 503);\n  }\n  async initializeLegacy() {\n    if (!this.initialized) this.initialized = this.ctx.blockConcurrencyWhile(async () => {\n      const ctx = this.ctx, env = this.env, b = loadBindings(env);\n${setup}      Object.assign(sourceBindingContext, await __ownerUiOverlay.sourceBindingContexts(b, env));\n      await this.qq.initialize();\n      await this.core.initialize();\n    });\n    return this.initialized;\n  }\n`;
replace(oldConstructor, newConstructor, 'defer existing constructor writes until legacy access, preserve exact core and QQ setup');
replace('  async fetch(request) {\n    if (new URL(request.url).pathname === "/qq/webhook")', '  async fetch(request) {\n    if (new URL(request.url).pathname === "/v1/task/snapshot") return taskSnapshotOwnerRequest(request, this.env, this.ctx.storage);\n    await this.initializeLegacy();\n    if (new URL(request.url).pathname === "/qq/webhook")', 'cold HTTP read bypasses schema/queue/alarm recovery');
replace('  async alarm() {\n    await this.qq.drain();', '  async alarm() {\n    await this.initializeLegacy();\n    await this.qq.drain();', 'existing alarm recovery retained');
replace('  async result(operation) {\n    try {\n      return { ok: true, result: await operation() };', '  async result(operation, initialize = true) {\n    try {\n      if (initialize) await this.initializeLegacy();\n      return { ok: true, result: await operation() };', 'existing RPC recovery retained');
replace('  // RPC is private to this Worker\'s namespace binding; no public owner-selected URL.\n', '  async taskSnapshot(principal, query) {\n    return this.result(() => readTaskSnapshot(this.ctx.storage, loadBindings(this.env), this.source(principal), query), false);\n  }\n  // RPC is private to this Worker\'s namespace binding; no public owner-selected URL.\n', 'read-only RPC authenticates without legacy initialization');
const oldReceiptConsent = String.raw`\u67E5\u8BE2\u6B64\u6765\u6E90\u81EA\u5DF1\u63D0\u4EA4\u7684\u56DE\u6267`;
replace(oldReceiptConsent, oldReceiptConsent + '及单个任务状态快照', 'consent wording describes exact own-source task snapshot under unchanged pa:receipt scope');
mkdirSync(resolve(root, 'modules'), { recursive: true });
const assets = [];
for (const file of readdirSync(base)) if (file !== 'worker.js' && !file.endsWith('.map')) { copyFileSync(resolve(base, file), resolve(root, 'modules', file)); assets.push({ file, sha256: hash(readFileSync(resolve(base, file))) }); }
writeFileSync(resolve(root, 'modules/worker.js'), code);
writeFileSync(resolve(root, 'PATCH_MANIFEST.json'), JSON.stringify({ base_main_sha256: expected, baseline_kind: 'sanitized-public-display', candidate_main_sha256: hash(code), deployed: false, unchanged_assets: assets, changes: changes.map(({label})=>label) }, null, 2) + '\n');
let reverse = code; for (const {before,after} of [...changes].reverse()) { if (reverse.split(after).length !== 2) throw Error('Reverse patch not unique'); reverse = reverse.replace(after,before); }
if (hash(reverse) !== expected) throw Error('Reverse patch did not restore baseline');
writeFileSync(resolve(root, 'validation/patch-operations.json'), JSON.stringify(changes, null, 2) + '\n');
console.log(JSON.stringify({sha256:hash(code), exact_baseline_preserved: true, changes:changes.length}));
