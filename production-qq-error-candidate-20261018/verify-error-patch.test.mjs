import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(root, '../production-readonly-20261018');
const gatewaySource = readFileSync(path.join(root, 'modules/gateway-candidate.mjs'), 'utf8');
const productionGateway = readFileSync(path.join(base, 'bbbot-qq-gateway/modules/gateway-candidate.mjs'), 'utf8');
const ownerSource = readFileSync(path.join(root, 'preserved-owner-reference/qq-integration.mjs'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(root, 'PATCH_MANIFEST.json'), 'utf8'));
const clean = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex');
let forbiddenFetchCalls = 0;
const forbiddenFetch = () => { forbiddenFetchCalls++; throw Error('external_network_forbidden'); };

function loadExactModule(source, gateway) {
  const exportBlock = gateway
    ? 'export {\n  QQGatewayObject,\n  worker_default as default\n};'
    : 'export {\n  QQBridgeQueue,\n  qqInteractionResponse\n};';
  assert.equal(source.split(exportBlock).length, 2, 'one exact production export block');
  let evaluated = source.replace(exportBlock, '');
  if (gateway) {
    const importLine = 'import { DurableObject } from "cloudflare:workers";';
    assert.equal(evaluated.split(importLine).length, 2);
    evaluated = evaluated.replace(importLine, '');
  }
  // Test-only loader substitution. The candidate file itself is never transformed.
  const names = gateway
    ? 'GatewayActor,NotificationBridge,createQQDelivery,QQC2CTransport,QQDurableLedger,fixedReplyProof,qqRejectionReason,qqBridgeRejectedReceipt'
    : 'QQBridgeQueue,qqInteractionResponse,dispatchAcceptedQQ,signBridgeRequest,verifyBridgeResponse';
  const context = createContext({
    crypto: webcrypto, TextEncoder, TextDecoder, Response, Request, Headers, URL, Event, EventTarget,
    AbortSignal, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: forbiddenFetch,
    DurableObject: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } },
  });
  runInContext(evaluated + '\n;globalThis.audit = {' + names + '};', context, { timeout: 1000 });
  return context.audit;
}
const gateway = loadExactModule(gatewaySource, true);
const owner = loadExactModule(ownerSource, false);

class SqlStorage {
  db = new DatabaseSync(':memory:');
  tail = Promise.resolve();
  alarm = null;
  sql = { exec: (query, ...args) => {
    if (/^\s*CREATE\b/.test(query) && args.length === 0) {
      this.db.exec(query);
      return { toArray: () => [] };
    }
    const statement = this.db.prepare(query);
    const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
    return { toArray: () => rows };
  } };
  transaction(fn) {
    const result = this.tail.then(async () => {
      this.db.exec('BEGIN');
      try { const value = await fn(); this.db.exec('COMMIT'); return value; }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
    });
    this.tail = result.catch(() => {});
    return result;
  }
  async sync() {}
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
  close() { this.db.close(); }
}

const NOW = Date.parse('2026-10-18T12:00:00Z');
const KEY = 'SYNTHETIC-LOCAL-BRIDGE-KEY-NOT-REAL-0000';
const SOURCE = { source_id: 'source', provider: 'dot', display_name: 'Synthetic source', enabled: true, allowed_hosts: ['source.example'], secret_name: 'SYNTHETIC_SOURCE' };
const event = (suffix = '1') => ({ event_id: 'event-' + suffix, source_id: 'source', project_id: 'project', project_name: 'Synthetic project', task_id: 'task', task_name: 'Synthetic task', run_id: 'run', branch_id: 'main', branch_name: 'Main', kind: 'started', source_status: 'running', source_seq: Number(suffix), occurred_at: new Date(NOW).toISOString(), summary: 'Synthetic local-only notification' });
const receiptId = suffix => 'rcpt_' + String(suffix).padStart(32, '0');
const evidence = () => ({ identity: true, proactive: true, reply: false, image: false, checkedAt: NOW - 1000, validUntil: NOW + 100000 });
const job = (suffix = '1') => ({ ownerId: 'owner', appId: '123', sourceId: 'source', projectId: 'project', eventId: 'event-' + suffix, receiptId: receiptId(suffix), content: 'Synthetic local-only notification' });
const syntheticEnvironment = extra => Object.freeze({
  OWNER_ID: 'owner', QQ_OWNER_ID: 'owner', QQ_APP_ID: '123',
  QQ_ENABLED: 'true', QQ_DELIVERY_ENABLED: 'true', QQ_PROOF_ENABLED: 'false', QQ_SETUP_ENABLED: 'false',
  QQ_DAILY_ACTIVE_BUDGET_MS: '3600000', QQ_ALLOWED_SOURCE_IDS: '["source"]', QQ_ALLOWED_PROJECT_IDS: '["project"]',
  QQ_CAPABILITIES_JSON: JSON.stringify(evidence()), QQ_APP_SECRET: 'SYNTHETIC-LOCAL-SECRET-NOT-REAL', QQ_BRIDGE_SECRET: KEY,
  ...extra,
});

async function harness(t, { body = { code: 40034105 }, status = 400, environment = {}, state = {}, ready = true, onMessage } = {}) {
  const gatewayStorage = new SqlStorage(), ownerStorage = new SqlStorage();
  t.after(() => { gatewayStorage.close(); ownerStorage.close(); });
  const calls = [], pending = [];
  const env = syntheticEnvironment(environment);
  const network = async (url, init) => {
    const address = new URL(url);
    assert.equal(address.origin, 'https://api.bot.qq.com', 'only mocked official endpoints');
    assert.equal(init.method, 'POST');
    calls.push({ path: address.pathname, body: JSON.parse(init.body), headers: init.headers });
    if (address.pathname === '/app/getAppAccessToken') return Response.json({ access_token: 'SYNTHETIC-LOCAL-TOKEN', expires_in: 7200 });
    assert.equal(address.pathname, '/v2/users/fixed-user/messages');
    if (onMessage) return onMessage();
    return Response.json(body, { status });
  };
  const actor = new gateway.GatewayActor({ storage: gatewayStorage, waitUntil: promise => pending.push(promise) }, env, { fetch: network, now: () => NOW });
  actor.runtime = { client: { ready }, stop() { this.client.ready = false; } };
  await actor.store.transaction(s => Object.assign(s, {
    binding: { ownerId: 'owner', appId: '123', userOpenId: 'fixed-user', replyMessage: { messageId: 'fresh-message', eventAt: NOW - 1 } },
    control: { running: true }, qqIngestionHealth: { healthy: true },
    activeBudget: { day: Math.floor(NOW / 86400000), usedMs: 0, lastAt: NOW }, ...state,
  }));
  const ownerEnv = Object.freeze({ ...env, QQ_GATEWAY: {
    idFromName(name) { assert.equal(name, 'qq:owner'); return name; },
    get() { return { receiveBridge: packet => actor.receiveBridge(packet) }; },
  } });
  ownerStorage.sql.exec('CREATE TABLE events(receipt TEXT PRIMARY KEY,source_id TEXT,payload TEXT,decision TEXT)');
  const queue = new owner.QQBridgeQueue(ownerStorage, ownerEnv, 'owner', [SOURCE], forbiddenFetch, () => NOW);
  await queue.initialize();
  const accept = (suffix = '1') => {
    const e = event(suffix), receipt = receiptId(suffix);
    ownerStorage.sql.exec('INSERT INTO events VALUES(?,?,?,?)', receipt, SOURCE.source_id, JSON.stringify(e), 'applied');
    return queue.enqueue(e, receipt);
  };
  const dispatchAgain = (targetActor = actor) => owner.dispatchAcceptedQQ({
    receiptId: receiptId('1'), loadAccepted: async () => ({ receiptId: receiptId('1'), decision: 'applied', source: SOURCE, event: event() }),
    ownerId: 'owner', appId: '123', sources: [SOURCE], allowedSourceIds: ['source'], allowedProjectIds: ['project'],
    bridgeKey: () => KEY, stub: { receiveBridge: packet => targetActor.receiveBridge(packet) }, now: NOW,
  });
  const direct = async (suffix = '1') => {
    const request = await owner.signBridgeRequest({ job: job(suffix), nonce: 'synthetic_nonce_' + suffix.padStart(8, '0'), now: NOW }, KEY);
    return clean(await owner.verifyBridgeResponse(await actor.receiveBridge(request), request, KEY));
  };
  return { actor, env, ownerEnv, gatewayStorage, ownerStorage, queue, calls, pending, accept, dispatchAgain, direct };
}

test('exact reverse patch, fixed reply, flags, RPC ABI and owner integration are preserved', () => {
  assert.equal(hash(productionGateway), manifest.base_gateway_sha256);
  assert.equal(hash(gatewaySource), manifest.candidate_gateway_sha256);
  let restored = gatewaySource;
  const reversePatch = readFileSync(path.join(root, 'reverse-patch.json'), 'utf8');
  assert.equal(hash(reversePatch), manifest.reverse_patch_sha256);
  const edits = JSON.parse(reversePatch);
  assert.equal(edits.length, 3);
  for (const edit of [...edits].reverse()) { assert.equal(restored.split(edit.after).length, 2); restored = restored.replace(edit.after, () => edit.before); }
  assert.equal(restored, productionGateway);
  const section = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start) + start.length));
  for (const [start, end] of [['// qq-cloudflare/proof.mjs', '// qq-cloudflare/admin.mjs'], ['// qq-cloudflare/admin.mjs', '// qq-cloudflare/worker.mjs'], ['// qq-cloudflare/actor.mjs', '// qq-cloudflare/worker.mjs']]) assert.equal(section(gatewaySource, start, end), section(productionGateway, start, end));
  const gatingLines = text => text.split('\n').filter(line => /QQ_(ENABLED|DELIVERY_ENABLED|PROOF_ENABLED|SETUP_ENABLED)/.test(line));
  assert.deepEqual(gatingLines(gatewaySource), gatingLines(productionGateway));
  assert.equal(ownerSource, readFileSync(path.join(base, 'bbbot-pa-terminal/modules/qq-integration.mjs'), 'utf8'));
  assert.equal(hash(ownerSource), manifest.preserved_owner_integration_sha256);
  assert.equal(owner.qqInteractionResponse.length, 11);
  assert.equal(manifest.configuration_files_created, false);
  assert.equal(manifest.runtime_flags_changed, false);
  assert.equal(manifest.deployed, false);
});

const known = [[40034105, 'proactive_permission_denied'], [40034100, 'rate_limited'], [40054004, 'friendship_missing'], [40054013, 'recipient_refused'], [40054016, 'bot_offline']];
for (const [code, reason] of known) for (const field of ['code', 'err_code']) {
  test(`owner queue → exact gateway transport → signed receipt: ${field} ${code}`, async t => {
    const h = await harness(t, { body: { [field]: code, message: 'PRIVATE_PROVIDER_CANARY' } });
    assert.equal(h.accept(), true);
    const expected = { state: 'not_sent', reason, providerCode: code };
    assert.deepEqual(clean(await h.queue.drain()), expected);
    assert.deepEqual(clean(h.queue.receipt(SOURCE, receiptId('1'))), expected);
    assert.deepEqual(clean(await h.dispatchAgain()), expected, 'new signed nonce still uses durable receipt');
    assert.equal(h.accept('2'), true);
    assert.equal(h.queue.nextAlarmAt(), null, 'definitive rejection remains a queue-review fence');
    assert.equal((await h.queue.drain()).state, 'idle');
    const sends = h.calls.filter(call => call.path.endsWith('/messages'));
    assert.equal(sends.length, 1);
    assert.equal(h.calls.length, 2, 'one token fetch and one message call');
    assert.deepEqual(Object.keys(sends[0].body).sort(), ['content', 'msg_type']);
    assert.equal(JSON.stringify(h.queue.receipt(SOURCE, receiptId('1'))).includes('PRIVATE_PROVIDER_CANARY'), false);
    const transportRows = h.gatewayStorage.sql.exec('SELECT v FROM qq_gateway_state WHERE k LIKE ?', '%qqTransport%').toArray();
    assert.ok(transportRows.some(row => JSON.parse(row.v)?.receipt?.providerCode === code), 'transport durable receipt retains code');
  });
}

test('unknown codes, other known rejections and missing codes preserve safe generic outcomes', async t => {
  for (const entry of [
    { body: { code: 98765432, message: 'PRIVATE' }, status: 400, expected: { state: 'uncertain', reason: 'provider_outcome_unknown' } },
    { body: { code: 40034005, message: 'PRIVATE' }, status: 400, expected: { state: 'not_sent', reason: 'provider_rejected' } },
    { body: { message: 'PRIVATE' }, status: 403, expected: { state: 'not_sent', reason: 'provider_rejected' } },
    { body: { message: 'PRIVATE' }, status: 500, expected: { state: 'uncertain', reason: 'provider_outcome_unknown' } },
    { body: { code: 40034105, message: 'PRIVATE' }, status: 429, expected: { state: 'not_sent', reason: 'provider_rejected' } },
  ]) {
    const h = await harness(t, entry); h.accept();
    assert.deepEqual(clean(await h.queue.drain()), entry.expected);
    assert.deepEqual(clean(await h.dispatchAgain()), entry.expected);
    assert.equal(h.calls.filter(call => call.path.endsWith('/messages')).length, 1);
  }
});

test('bridge strips arbitrary diagnostics, string codes, mismatched pairs and blocked-code claims', async t => {
  const h = await harness(t);
  for (const result of [
    { state: 'not_sent', reason: 'PRIVATE', providerCode: 40034105 },
    { state: 'not_sent', reason: 'proactive_permission_denied', providerCode: '40034105' },
    { state: 'not_sent', reason: 'proactive_permission_denied', providerCode: 40054004 },
    { state: 'not_sent', reason: 'proactive_permission_denied', providerCode: 98765432 },
    { state: 'blocked', reason: 'proactive_permission_denied', providerCode: 40034105 },
  ]) {
    const store = { async transaction(fn) { return fn(this.state); }, state: { binding: { ownerId: 'owner', appId: '123', userOpenId: 'fixed-user' }, qqIngestionHealth: { healthy: true } } };
    const bridge = new gateway.NotificationBridge({ store, key: () => KEY, appId: '123', ownerId: 'owner', allowedSourceIds: ['source'], allowedProjectIds: ['project'], enabled: true, evidence, now: () => NOW, deliver: async () => ({ ...result, message: 'PRIVATE', arbitrary: 'PRIVATE' }) });
    const request = await owner.signBridgeRequest({ job: job(), nonce: 'synthetic_pair_check_1', now: NOW }, KEY);
    const receipt = await owner.verifyBridgeResponse(await bridge.receive(request), request, KEY);
    assert.deepEqual(clean(receipt), { state: result.state, reason: 'provider_rejected' });
  }
  assert.equal(h.calls.length, 0);
});

test('disabled gateway and delivery flags cannot be opened by the patch', async t => {
  for (const enabled of ['false', undefined]) {
    const h = await harness(t, { environment: { QQ_ENABLED: enabled, QQ_DELIVERY_ENABLED: 'false' } });
    assert.equal(h.accept(), false);
    await assert.rejects(h.direct(), /qq_disabled/);
    await assert.rejects(h.actor.start(), /qq_disabled/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.gatewayStorage.alarm, null);
  }
  const h = await harness(t, { environment: { QQ_DELIVERY_ENABLED: 'false' } });
  assert.equal(h.accept(), false);
  assert.deepEqual(await h.direct(), { state: 'blocked', reason: 'disabled' });
  assert.equal(h.calls.length, 0);
  assert.equal(h.env.QQ_PROOF_ENABLED, 'false');
  assert.deepEqual(clean(await gateway.fixedReplyProof(h.actor)), { state: 'blocked', reason: 'proof_not_eligible' });
  assert.equal(await h.actor.store.transaction(s => Boolean(s.qqProof)), false);
  assert.equal(h.calls.length, 0);
});

test('binding, capability, revocation, connection and ingestion gates still reject without HTTP', async t => {
  for (const config of [
    { state: { binding: null } }, { state: { qqRevoked: true } },
    { state: { qqIngestionHealth: { healthy: false } } }, { state: { control: { running: false } } },
    { ready: false },
    { environment: { QQ_CAPABILITIES_JSON: JSON.stringify({ ...evidence(), proactive: false }) } },
    { environment: { QQ_CAPABILITIES_JSON: JSON.stringify({ ...evidence(), validUntil: NOW }) } },
  ]) {
    const h = await harness(t, config);
    assert.equal((await h.direct()).state, 'blocked');
    assert.equal(h.calls.length, 0);
  }
});

test('timeouts remain uncertain and never acquire a fallback reply or second dispatch', async t => {
  const h = await harness(t, { onMessage: () => { throw Error('synthetic_network_timeout'); } }); h.accept();
  const expected = { state: 'uncertain', reason: 'provider_outcome_unknown' };
  assert.deepEqual(clean(await h.queue.drain()), expected);
  assert.deepEqual(clean(await h.dispatchAgain()), expected);
  assert.equal(h.calls.filter(call => call.path.endsWith('/messages')).length, 1);
  assert.equal(h.queue.nextAlarmAt(), null);
});

test('concurrent duplicate sees reserved uncertainty, then the exact stored failure', async t => {
  let release, started;
  const begun = new Promise(resolve => { started = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  const h = await harness(t, { onMessage: () => { started(); return response; } });
  h.accept();
  const first = h.queue.drain(); await begun;
  assert.deepEqual(clean(await h.dispatchAgain()), { state: 'uncertain', reason: 'reserved_before_send' });
  release(Response.json({ code: 40054013 }, { status: 400 }));
  const expected = { state: 'not_sent', reason: 'recipient_refused', providerCode: 40054013 };
  assert.deepEqual(clean(await first), expected);
  assert.deepEqual(clean(await h.dispatchAgain()), expected);
  assert.equal(h.calls.filter(call => call.path.endsWith('/messages')).length, 1);
});

test('successful deliveries remain the original receipt shape', async t => {
  const h = await harness(t, { body: { id: 'synthetic-provider-id' }, status: 200 }); h.accept();
  assert.deepEqual(clean(await h.queue.drain()), { state: 'sent', reason: 'provider_accepted', messageId: 'synthetic-provider-id' });
  assert.deepEqual(clean(await h.dispatchAgain()), { state: 'sent', reason: 'provider_accepted', messageId: 'synthetic-provider-id' });
  assert.equal(h.calls.filter(call => call.path.endsWith('/messages')).length, 1);
});

test('gateway and owner recreation retain the durable rejected receipt without redispatch', async t => {
  const h = await harness(t, { body: { err_code: 40054004 }, status: 400 }); h.accept();
  const expected = { state: 'not_sent', reason: 'friendship_missing', providerCode: 40054004 };
  assert.deepEqual(clean(await h.queue.drain()), expected);
  const reopened = new gateway.GatewayActor({ storage: h.gatewayStorage, waitUntil: () => {} }, h.env, { fetch: forbiddenFetch, now: () => NOW });
  reopened.runtime = { client: { ready: true }, stop() { this.client.ready = false; } };
  assert.deepEqual(clean(await h.dispatchAgain(reopened)), expected);
  const reopenedQueue = new owner.QQBridgeQueue(h.ownerStorage, h.ownerEnv, 'owner', [SOURCE], forbiddenFetch, () => NOW);
  await reopenedQueue.initialize();
  assert.deepEqual(clean(reopenedQueue.receipt(SOURCE, receiptId('1'))), expected);
  assert.equal(reopenedQueue.nextAlarmAt(), null);
  assert.equal((await reopenedQueue.drain()).state, 'idle');
  assert.equal(h.calls.filter(call => call.path.endsWith('/messages')).length, 1);
});

test('no test reached unmocked outbound fetch', () => assert.equal(forbiddenFetchCalls, 0));
