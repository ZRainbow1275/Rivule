import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Run the shipped bundle, not a second implementation. Only the Cloudflare host
// class and module export syntax are adapted for Node; no Worker is started.
const gateway = await readFile(new URL('../src/gateway/worker.mjs', import.meta.url), 'utf8');
assert.equal((gateway.match(/import \{ DurableObject \} from "cloudflare:workers";/g) ?? []).length, 1);
const sandbox = vm.createContext({
  structuredClone, TextEncoder, TextDecoder, EventTarget, URL, Response,
  fetch() { throw new Error('Network is forbidden in offline tests'); },
});
vm.runInContext(gateway
  .replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject {}')
  .replace('export { QQGatewayObject, worker_default as default };', '')
  + '\nglobalThis.subject = { RivuleContinuous, runtimeBudgetPolicy, runtimeBudgetView };', sandbox, { timeout: 2000 });
const { RivuleContinuous: continuous, runtimeBudgetPolicy, runtimeBudgetView } = sandbox.subject;

test('default runtime threshold warns without pausing; explicit stop remains available', () => {
  const now = 8_000_000, limit = 7_200_000;
  const state = { activeBudget: { day: 0, usedMs: limit, lastAt: now }, control: { running: true } };
  assert.equal(runtimeBudgetPolicy(state, limit).mode, 'warn');
  const warning = runtimeBudgetView(state, limit, now);
  assert.equal(warning.warningReached, true);
  assert.equal(warning.exhausted, false);
  assert.ok(warning.availableMs > 0);
  state.qqRuntimeBudgetPolicy = { version: 1, mode: 'stop', limitMs: limit, revision: 1 };
  const stopped = runtimeBudgetView(state, limit, now);
  assert.equal(stopped.exhausted, true);
  assert.equal(stopped.availableMs, 0);
});

test('unknown outcome pauses and cannot be resent, including after review or restart', async () => {
  let now = 400_000, posts = 0;
  const state = {};
  const binding = { ownerId: 'test-owner', appId: 'test-app', userOpenId: 'test-recipient', confirmedAt: 100 };
  const permission = { kind: 'authenticated_C2C_MSG_RECEIVE', eventKey: 'test-permission', revision: 1,
    confirmedAt: 100, bindingFingerprint: 'test-binding', sessionFingerprint: 'test-session', eventAt: now, receivedAt: now };
  const context = { enabled: true, running: true, ready: true, healthy: true, credentialsCurrent: true,
    ownerId: binding.ownerId, appId: binding.appId, binding, bindingFingerprint: 'test-binding',
    projectIds: ['test-project'], remainingMs: 7_200_000, runtimeLimitMs: 7_200_000, budgetRevision: 0,
    runtimeEpoch: 'test-runtime', permission, permissionRevision: 1, permissionSessionFingerprint: 'test-session',
    probe: { kind: 'isolated_active_probe_observation', bindingFingerprint: 'test-binding', confirmedAt: 100,
      permissionRevision: 1, receipt: { state: 'sent', messageId: 'test-proof' }, checkedAt: now, validUntil: now + 300_000 } };
  const options = { store: { transaction: async fn => fn(state) }, command: async fn => fn(), context: () => context,
    acquireToken: async () => 'offline-token', post: async () => { posts++; throw new Error('simulated timeout'); },
    random: () => 'test-challenge-012345678901234567890123', now: () => now };
  const controller = new continuous.ContinuousDeliveryController(options);
  const grant = await controller.enroll({ ownerAuthenticated: true, interactionId: 'test-approval',
    policyFingerprint: JSON.stringify(continuous.POLICY), policyRevision: continuous.POLICY.revision,
    budgetRevision: 0, backlog: 'new_only', startAfterRevision: 0, expiresAt: now + 300_000 });
  await controller.acknowledgeProducer({ approvalInteractionId: 'test-approval', grantId: grant.id, startAfterRevision: 0 });
  const job = { intentId: 'test-intent', sourceId: 'test-source', sourceGeneration: 1, sourceBindingDigest: 'test-source-binding',
    projectId: 'test-project', receiptId: 'test-receipt', eventId: 'test-event', acceptedRevision: 1,
    payloadHash: 'test-hash', content: 'Offline fixture only', grantId: grant.id, bindingFingerprint: 'test-binding' };
  const source = { selectable: true, enabled: true, sourceId: job.sourceId, generation: 1,
    bindingDigest: job.sourceBindingDigest, verifiedAt: now, applied: true, receiptId: job.receiptId,
    eventId: job.eventId, acceptedRevision: 1, projectAllowed: true, projectId: job.projectId,
    sensitivity: 'normal', kind: 'task', payloadHash: job.payloadHash };
  const prepared = await controller.prepare(job, source);
  assert.equal(prepared.state, 'prepared');
  const permit = { intentId: job.intentId, challenge: prepared.challenge, expiresAt: prepared.expiresAt,
    grantRevision: prepared.grantRevision, payloadHash: job.payloadHash };
  const result = await controller.commit(job.intentId, permit, source);
  assert.equal(result.state, 'uncertain');
  assert.equal(result.reason, 'provider_outcome_unknown');
  assert.equal((await controller.status()).grantState, 'paused');
  assert.equal(posts, 1);
  assert.equal((await controller.commit(job.intentId, permit, source)).state, 'suppressed');
  await assert.rejects(controller.prepare(job, source), /grant_inactive/);
  assert.throws(() => continuous.acknowledgeUnknown(state, 'test-binding', ['normal:test-intent'], 'review', now), /review_changed/);
  now += 30_001;
  const pending = continuous.unresolvedAttempts(state, 'test-binding', now);
  continuous.acknowledgeUnknown(state, 'test-binding', pending.keys, 'review', now);
  assert.equal(state.qqContinuous.attempts[job.intentId].state, 'uncertain');
  assert.equal((await controller.status()).grantState, 'paused');
  const restarted = new continuous.ContinuousDeliveryController(options);
  assert.equal((await restarted.commit(job.intentId, permit, source)).state, 'suppressed');
  assert.equal(posts, 1);
});

test('showcase source filter and restored selection use actual markup and script', async () => {
  const html = await readFile(new URL('../docs/showcase/index.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../docs/showcase/script.js', import.meta.url), 'utf8');
  const tasks = [...html.matchAll(/data-source="([^"]*)" data-action="([^"]*)"/g)]
    .map(match => ({ dataset: { source: match[1], action: match[2] } }));
  assert.equal(tasks.length, 3);
  const events = {}, elements = { 'source-filter': { value: 'all', addEventListener: (name, fn) => events[name] = fn },
    'task-count': {}, 'action-count': {}, 'sidebar-count': {} };
  vm.runInNewContext(script, { document: { getElementById: id => elements[id], querySelectorAll: () => tasks },
    window: { addEventListener: (name, fn) => events[name] = fn } });
  for (const [value, total, actions] of [['all', 3, 1], ['助手 A', 1, 1], ['助手 B', 1, 0], ['助手 C', 1, 0], ['missing', 0, 0]]) {
    elements['source-filter'].value = value;
    events.change();
    assert.equal(elements['task-count'].textContent, total);
    assert.equal(elements['action-count'].textContent, actions);
    assert.equal(elements['sidebar-count'].textContent, total);
    assert.equal(tasks.filter(task => !task.hidden).length, total);
  }
  elements['source-filter'].value = 'all';
  events.pageshow();
  assert.equal(elements['task-count'].textContent, 3);
});
