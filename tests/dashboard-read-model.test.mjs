import test from 'node:test';
import assert from 'node:assert/strict';
import { readDashboardWatchlist, dashboardViewState } from '../src/owner/dashboard-read-model.mjs';
const query = { project_id: 'project', task_id: 'task', run_id: 'run', branch_id: 'main' };
const response = () => ({ schema_version: '1.0', source_id: 'zot-main', ...query,
  observed_at: '2026-10-22T10:00:00Z', found: true, sequence: { next_seq: 45 },
  snapshot: { sensitivity: 'normal', source_status: 'running', project_name: 'Project', task_name: 'Task',
    branch_name: 'Main', summary: 'Reported progress', stale: true, archived: false,
    last_confirmed_at: '2026-10-21T10:00:00Z', pending_actions: { stored_pending_count: 1, items: [{ question: 'private detail' }] } } });
const read = (reader, watchlist = [query]) => readDashboardWatchlist({ sourceId: 'zot-main', watchlist, readSnapshot: reader });
test('reads exact selected branches once and strips write advice and action payloads', async () => {
  let calls = 0;
  const result = await read(async q => { calls++; assert.deepEqual(q, query); return response(); });
  assert.equal(calls, 1); assert.equal(result.items[0].state, 'available');
  assert.equal(result.items[0].stale, true); assert.equal(result.items[0].pending_action_count, 1);
  assert.equal(result.live_subscription, false);
  assert.ok(!JSON.stringify(result).includes('next_seq')); assert.ok(!JSON.stringify(result).includes('private detail'));
});
test('rejects extra scope, duplicate branches and oversized watchlists before reading', async () => {
  let calls = 0; const reader = () => { calls++; };
  for (const list of [[{ ...query, source_id: 'other' }], [query, query], Array(21).fill(query), [{ ...query, task_id: '' }]])
    await assert.rejects(read(reader, list));
  assert.equal(calls, 0);
});
test('withholds restricted content and fails closed on foreign-source or malformed responses', async () => {
  const restricted = response(); restricted.snapshot.sensitivity = 'restricted';
  const hidden = await read(() => restricted); assert.equal(hidden.items[0].state, 'withheld');
  assert.ok(!JSON.stringify(hidden).includes('Reported progress'));
  for (const mutate of [r => { r.source_id = 'other'; }, r => { r.run_id = 'other'; },
    r => { r.snapshot.pending_actions.stored_pending_count = -1; }, r => { r.observed_at = 'bad'; }]) {
    const r = response(); mutate(r); assert.equal((await read(() => r)).items[0].state, 'unavailable');
  }
});
test('distinguishes not found from read failure without leaking transport errors', async () => {
  const missing = { ...response(), found: false, snapshot: null };
  assert.equal((await read(() => missing)).items[0].state, 'not_found');
  const failed = await read(() => { throw Error('Bearer secret'); });
  assert.equal(failed.items[0].state, 'unavailable'); assert.ok(!JSON.stringify(failed).includes('secret'));
  assert.deepEqual((await read(() => { throw Error('must not read'); }, [])).items, []);
});

test('presentation distinguishes unconfigured, connected snapshot and errors without demo fallback', async () => {
  assert.equal(dashboardViewState(null).state, 'unconfigured');
  assert.deepEqual(dashboardViewState(null).items, []);
  assert.equal(dashboardViewState(await read(() => response())).state, 'connected');
  assert.equal(dashboardViewState(await read(() => { throw Error('offline'); })).state, 'error');
  assert.equal(dashboardViewState({}).state, 'error');
  await assert.rejects(readDashboardWatchlist({ sourceId: 'other', watchlist: [], readSnapshot() {} }));
});
