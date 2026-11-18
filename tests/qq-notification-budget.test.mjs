import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import vm from 'node:vm';
import { formatQQNotification } from '../src/owner/notification-policy.mjs';
import { QQBridgeQueue } from '../src/owner/qq-integration.mjs';

const now = 1800000000000;
const source = { source_id: 'sample-pa', display_name: '排版助手', enabled: true, allowed_hosts: ['example.org'] };
const ref = '12345678-1234-4234-8234-123456789abc';
const footer = '\n\n回复指令：/rivule ' + ref + ' <指令>';
const receipt = 'rcpt_' + 'a'.repeat(32);
const asciiHash = text => createHash('sha256').update(text, 'utf8').digest('hex');
function event(overrides = {}) {
  return {
    event_id: 'layout-note', source_id: source.source_id, project_id: 'project',
    task_id: 'layout', run_id: 'edition', branch_id: 'main',
    project_name: '📚'.repeat(120), task_name: '📖'.repeat(120), branch_name: '📋'.repeat(80),
    kind: 'needs_input', source_status: 'needs_input', occurred_at: new Date(now).toISOString(),
    summary: '🌿'.repeat(1200), blocker: '📌'.repeat(400),
    action: { request_id: 'choose-layout', question: '🌸'.repeat(400) },
    progress: { done: 3, total: 8, unit: '项' }, sensitivity: 'normal', ...overrides
  };
}
const sandbox = vm.createContext({
  structuredClone, TextEncoder, TextDecoder, EventTarget, URL, Response, Request,
  AbortSignal, setTimeout, clearTimeout, crypto: webcrypto,
  fetch() { throw Error('offline test'); }
});
const raw = readFileSync(new URL('../src/gateway/worker.mjs', import.meta.url), 'utf8');
vm.runInContext(raw.replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject {}')
  .replace('export { QQGatewayObject, worker_default as default };', '') + '\nglobalThis.C = RivuleContinuous;', sandbox);

async function fixture(t, input, registered = true) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE events(revision INTEGER,receipt TEXT,source_id TEXT,payload TEXT,decision TEXT)');
  const storage = { sql: { exec(sql, ...args) {
    if (sql.split(';').filter(x => x.trim()).length > 1) { db.exec(sql); return { toArray: () => [] }; }
    return { toArray: () => db.prepare(sql).all(...args) };
  } }, transaction: async fn => fn(), transactionSync: fn => fn(), sync: async () => {} };
  const env = { QQ_ENABLED:'true', QQ_OWNER_ID:'owner', QQ_APP_ID:'123', QQ_DELIVERY_ENABLED:'true',
    QQ_ALLOWED_SOURCE_IDS:JSON.stringify([source.source_id]), QQ_ALLOWED_PROJECT_IDS:'["project"]' };
  const queue = new QQBridgeQueue(storage, env, 'owner', [source], () => { throw Error('offline test'); }, () => now);
  queue.attachAuthority(() => ({ selectable: true, binding: 'fixture-binding', connection_generation: 1, last_verified_at: now }));
  queue.attachMessageBridge({ taskAuthority: () => registered ? { context_ref: ref, consent_revision: 3 } : null });
  const binding = { ownerId:'owner', appId:'123', userOpenId:'fixture-recipient', confirmedAt:now - 1000 };
  const permission = { kind:'authenticated_C2C_MSG_RECEIVE', eventKey:'permission', revision:1, confirmedAt:now - 1000,
    bindingFingerprint:'binding', sessionFingerprint:'session', eventAt:now, receivedAt:now };
  const context = { enabled:true, running:true, ready:true, healthy:true, credentialsCurrent:true,
    ownerId:'owner', appId:'123', binding, bindingFingerprint:'binding', projectIds:['project'],
    remainingMs:7200000, runtimeLimitMs:7200000, budgetRevision:0, runtimeEpoch:'runtime', permission,
    permissionRevision:1, permissionSessionFingerprint:'session', probe:{kind:'isolated_active_probe_observation',
      bindingFingerprint:'binding', confirmedAt:now - 1000, permissionRevision:1, receipt:{state:'sent',messageId:'fixture-proof'},
      checkedAt:now, validUntil:now+300000} };
  let posts = 0; const state = {};
  const { ContinuousDeliveryController, POLICY } = sandbox.C;
  const gateway = new ContinuousDeliveryController({
    store:{transaction:async fn => fn(state)}, command:async fn => fn(), context:() => context, now:() => now,
    acquireToken:async () => 'fixture-only', random:() => 'fixture-challenge-012345678901234567890123456789',
    post:async () => { posts++; throw Error('preflight must not post'); }
  });
  const grant = await gateway.enroll({ ownerAuthenticated:true, interactionId:'fixture-approval',
    policyFingerprint:JSON.stringify(POLICY), policyRevision:POLICY.revision,
    budgetRevision:0, backlog:'new_only', startAfterRevision:1, expiresAt:now+300000 });
  await gateway.acknowledgeProducer({ approvalInteractionId:'fixture-approval', grantId:grant.id, startAfterRevision:1 });
  await queue.initializeContinuous();
  queue.saveActivation({ active:true, grantId:grant.id, bindingFingerprint:'binding', startAfterRevision:1, expiresAt:now+300000 });
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(2, receipt, source.source_id, JSON.stringify(input), 'applied');
  assert.equal(queue.enqueue(input,receipt), true, 'real admission accepts this event');
  const row = queue.rows('SELECT * FROM qq_continuous_outbox WHERE receipt=?',receipt)[0];
  const read = () => queue.currentJob(row,queue.activation());
  return { read, gateway, registered: v => { registered = v; }, posts: () => posts };
}

test('a valid long registered task reaches the actual gateway preparation gate without provider traffic', async t => {
  const input = event(); const f = await fixture(t,input);
  const {job, source: evidence} = await f.read();
  t.diagnostic('owner output: ' + job.content.length + ' UTF-16 units, including complete command footer: ' + job.content.endsWith(footer));
  let outcome; try { outcome = (await f.gateway.prepare(job,evidence)).state; }
  catch (e) { outcome = e.message; }
  t.diagnostic('gateway preparation: ' + outcome + '; provider posts: ' + f.posts());
  assert.equal(outcome, 'prepared'); assert.equal(f.posts(),0);
  assert.ok(job.content.length <= 4000); assert.ok(job.content.endsWith(footer));
  assert.ok(job.content.includes('受阻  ' + input.blocker));
  assert.ok(job.content.includes('待办  ' + input.action.question));
  assert.ok(job.content.includes('进展  3 / 8 项')); assert.ok(job.content.includes('…'));
  assert.equal(job.contentKind, 'task_update'); assert.equal(job.contextRef, ref);
  assert.equal(job.payloadHash, asciiHash(job.content)); assert.equal(evidence.payloadHash, job.payloadHash);
  assert.equal((await f.read()).job.content,job.content,'re-reading with unchanged input is deterministic');
});

test('a short task retains its original compact format and the exact existing command syntax',async t => {
  const input = event({project_name:'书稿',task_name:'排版',branch_name:'主路线',summary:'已完成目录。',
    blocker:null,action:null,kind:'progress',source_status:'running',progress:{done:1,total:3,unit:'页'}});
  const f = await fixture(t,input); const {job} = await f.read();
  const expected = '◇ 排版助手 → 🐧 QQ\n⏳ 进行中 · 书稿\n排版\n\n已完成目录。\n进展  1 / 3 页';
  assert.equal(job.content,expected + footer);
  f.registered(false);
  const {job: noFooter} = await f.read();
  assert.equal(noFooter.content,expected); assert.equal(noFooter.contentKind,undefined);
  assert.notEqual(noFooter.payloadHash,job.payloadHash); assert.equal(f.posts(),0);
});

function nearLimit() {
  return event({ source_url: 'https://example.org/' + 'a'.repeat(1450) });
}
for (const [name, group, partial] of [
  ['emoji with modifier and joiner','👩🏽‍💻',4], ['regional flag','🇨🇳',2],
  ['combining accent','e\u0301',1], ['variation selector','☕️',1], ['keycap','1️⃣',2],
]) {
  test('tightening the summary preserves the whole ' + name, () => {
    const e = nearLimit(), opts = { includeSourceUrl:true };
    const emptyLength = formatQQNotification({...e,summary:''},source,now,opts).length;
    const room = 4000 - emptyLength;
    assert.ok(room > 16 && room < 500);
    const prefix = '前'.repeat(room - 1 - partial);
    const summary = prefix + group + '尾'.repeat(20);
    const text = formatQQNotification({...e,summary},source,now,opts);
    assert.ok(text.includes('\n\n' + prefix + '…\n'),'only complete visible characters remain before the ellipsis');
    assert.ok(text.includes('待办  ' + e.action.question)); assert.ok(text.includes('受阻  ' + e.blocker));
    assert.ok(text.endsWith(e.source_url)); assert.ok(text.length <= 4000); assert.ok(text.isWellFormed());
  });
}
test('a format that fits exactly keeps the final complete cluster and has no added ellipsis', () => {
  const e = nearLimit(), opts = {includeSourceUrl:true}, end='👩🏽‍💻';
  const fixed = formatQQNotification({...e,summary:''},source,now,opts).length;
  const fit = '前'.repeat(4000-fixed-end.length) + end;
  const out = formatQQNotification({...e,summary:fit},source,now,opts);
  assert.equal(out.length,4000); assert.ok(out.includes('\n\n'+fit+'\n')); assert.ok(!out.includes('…')); assert.ok(out.endsWith(e.source_url));
});

function fixedRoom(room) {
  const e = nearLimit();
  Object.assign(e,{ progress:null, phase_id:'layout', phase_label:'🌿'.repeat(100), source_url:'https://example.org/' });
  const base = formatQQNotification({...e,summary:''},source,now,{includeSourceUrl:true}).length;
  e.source_url += 'x'.repeat(4000 - room - base);
  assert.ok(e.source_url.length <= 1600,'source URL remains within the event contract');
  return e;
}
test('one free UTF-16 unit fits the omission marker, while zero still fits all required facts',() => {
  for(const room of [1,0]) {
    const e = fixedRoom(room);
    const out = formatQQNotification(e,source,now,{includeSourceUrl:true});
    assert.equal(out.length,4000);
    assert.ok(out.includes('\n\n'+(room===1?'…':'')+'\n阶段  '+e.phase_label));
    assert.ok(out.includes('受阻  '+e.blocker)); assert.ok(out.includes('待办  '+e.action.question)); assert.ok(out.endsWith(e.source_url));
  }
});
test('content that cannot fit even with an empty summary is not silently chopped or sent as fragments',() => {
  const e = fixedRoom(-1);
  assert.throws(() => formatQQNotification(e,source,now,{includeSourceUrl:true}),/qq_notification_required_content_too_long/);
});
test('the combined authorized footer and an exact-boundary summary are kept in full',async t => {
  const e = event({summary:''});
  const available = 4000 - footer.length - formatQQNotification(e,source,now).length;
  assert.ok(available>1200 && available<2400);
  e.summary = '🌿'.repeat(Math.floor(available/2)) + '前'.repeat(available%2);
  const f = await fixture(t,e);
  const {job,source:proof} = await f.read();
  assert.equal(job.content.length,4000); assert.ok(job.content.endsWith(footer));
  assert.ok(job.content.includes('\n\n'+e.summary+'\n')); assert.ok(!job.content.includes('…'));
  assert.equal((await f.gateway.prepare(job,proof)).state,'prepared'); assert.equal(f.posts(),0);
});
test('small Intl runtimes preserve readable ASCII/Han prefixes without cutting a complex cluster',() => {
  const saved = Intl.Segmenter;
  try {
    Intl.Segmenter = undefined;
    const e = fixedRoom(8), opts={includeSourceUrl:true};
    const simple = formatQQNotification({...e,summary:'字体样张 A B C D E'},source,now,opts);
    assert.ok(simple.includes('\n\n字体样张 A …\n'));
    const mixed = formatQQNotification({...e,summary:'校对。\n草稿👩🏽‍💻🌿'},source,now,opts);
    const cut = mixed.split('\n\n')[1].split('\n阶段')[0];
    assert.ok(cut.startsWith('校对。\n草')); assert.ok(cut.endsWith('…')); assert.ok(!cut.includes('👩'));
    const complex = formatQQNotification({...e,summary:'🇨🇳'.repeat(12)},source,now,opts);
    assert.ok(complex.includes('\n\n…\n阶段')); assert.ok(complex.length<=4000);
  } finally { Intl.Segmenter=saved; }
});
