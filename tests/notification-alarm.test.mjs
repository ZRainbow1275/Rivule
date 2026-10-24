import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import vm from 'node:vm';
import {QQBridgeQueue} from '../src/owner/qq-integration.mjs';

// Exercise the final, production OwnerCore scheduler and the real QQ queue.
// Host alarms are modeled locally; these tests never start a Worker or send messages.
const worker = readFileSync(new URL('../src/owner/worker.js', import.meta.url), 'utf8');
const start = worker.lastIndexOf('            async schedule() {');
const end = worker.indexOf('            enqueue(', start);
assert.ok(start > 0 && end > start);
const context = vm.createContext({});
vm.runInContext('this.Scheduler = class {' + worker.slice(start, end) + '}', context);

function fixture(t) {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    db.exec(`
        CREATE TABLE events(receipt TEXT PRIMARY KEY,revision INTEGER,source_id TEXT,payload TEXT,decision TEXT);
        CREATE TABLE qq_continuous_outbox(receipt TEXT PRIMARY KEY,source_id TEXT,source_generation INTEGER,revision INTEGER,payload TEXT,status TEXT,recorded_at INTEGER,result TEXT);
        CREATE TABLE outbox(id INTEGER PRIMARY KEY,status TEXT,next_at INTEGER);
        CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
    `);
    const rows = (sql, ...args) => db.prepare(sql).all(...args);
    const state = {now: 1000, alarm: null, writes: [], deletes: 0, diagnostic: Infinity, expiry: Infinity, freshness: Infinity};
    const activation = {active: true, expiresAt: 1e9, startAfterRevision: 0};
    const config = {enabled: true, allowedSources: ['source'], allowedProjects: ['project']};
    const storage = {
        getAlarm: async () => state.alarm,
        setAlarm: async at => { state.alarm = at; state.writes.push(at); },
        deleteAlarm: async () => { state.alarm = null; state.deletes++; },
        transactionSync(fn) {
            db.exec('BEGIN');
            try { const result = fn(); db.exec('COMMIT'); return result; }
            catch (error) { db.exec('ROLLBACK'); throw error; }
        }
    };
    const queue = Object.create(QQBridgeQueue.prototype);
    Object.assign(queue, {
        storage, rows, now: () => state.now,
        sources: [{source_id: 'source', enabled: true}],
        config: () => config, activation: () => activation,
        readAuthority: () => ({selectable: true, connection_generation: 1}),
        retentionFloor: () => 0, capacityFloor: () => 0,
        recordAdmissionSkip: () => { throw Error('unexpected admission skip'); }
    });
    const scheduler = new context.Scheduler();
    Object.assign(scheduler, {
        storage, clock: () => state.now, enabled: false,
        one: (sql, ...args) => rows(sql, ...args)[0] ?? null,
        diagnostics: {prune() {}, nextExpiry: () => state.diagnostic},
        suppressDisallowedJobs() {},
        pendingExpiries: () => Number.isFinite(state.expiry) ? [{expires: state.expiry}] : [],
        freshness: () => Number.isFinite(state.freshness) ? [{last_confirmed: state.freshness - 1800000}] : [],
        channels: {nextAlarmAt: () => queue.nextAlarmAt()}
    });
    let revision = 0;
    const accept = async (patch = {}) => {
        const id = 'event-' + ++revision;
        const event = {
            event_id: id, source_id: 'source', project_id: 'project', task_id: 'task', run_id: 'run', branch_id: 'branch',
            project_name: 'Offline fixture', task_name: 'Alarm test', kind: 'progress', source_status: 'running',
            occurred_at: new Date(state.now).toISOString(), sensitivity: 'normal', ...patch
        };
        rows('INSERT INTO events VALUES(?,?,?,?,?)', id, revision, event.source_id, JSON.stringify(event), 'applied');
        assert.equal(queue.enqueue(event, id), true);
        // Production ingest admits QQ first, then schedules the shared owner alarm.
        await scheduler.schedule();
        return id;
    };
    return {state, activation, config, rows, queue, scheduler, accept};
}

test('sustained urgent QQ events preserve the first wake, including an overdue alarm', async t => {
    const {state, accept, rows} = fixture(t);
    await accept({kind: 'failed', source_status: 'failed'});
    assert.equal(state.alarm, 4100);
    for (state.now = 2000; state.now <= 10000; state.now += 1000) {
        await accept({kind: 'failed', source_status: 'failed'});
        assert.equal(state.alarm, 4100);
    }
    assert.deepEqual(state.writes, [4100]);
    assert.equal(rows("SELECT COUNT(*) AS n FROM qq_continuous_outbox WHERE status='queued'")[0].n, 10);
});

test('coalesced QQ progress keeps its original one-minute wake under continuous traffic', async t => {
    const {state, accept, rows, queue} = fixture(t);
    await accept();
    assert.equal(state.alarm, 61000);
    for (state.now = 2000; state.now <= 65000; state.now += 1000) {
        await accept();
        assert.equal(state.alarm, 61000);
    }
    assert.ok(queue.nextAlarmAt() > state.alarm);
    assert.deepEqual(state.writes, [61000]);
    const pending = rows("SELECT recorded_at FROM qq_continuous_outbox WHERE status='queued'");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].recorded_at, 1000);
});

test('a consumed QQ alarm re-arms with the existing delay instead of an immediate loop', async t => {
    const {state, accept, scheduler, rows} = fixture(t);
    await accept({kind: 'failed', source_status: 'failed'});
    state.now = state.alarm;
    // Durable Objects getAlarm() returns null once the handler starts, unless
    // that handler has subsequently scheduled a new alarm.
    state.alarm = null;
    await scheduler.schedule();
    assert.equal(state.alarm, 7200);
    await scheduler.schedule();
    assert.deepEqual(state.writes, [4100, 7200]);
    rows("UPDATE qq_continuous_outbox SET status='sent' WHERE status='queued'");
    await scheduler.schedule();
    assert.equal(state.alarm, null);
});

test('new urgent QQ work advances an existing progress alarm without postponing it again', async t => {
    const {state, accept} = fixture(t);
    await accept();
    assert.equal(state.alarm, 61000);
    state.now = 2000;
    await accept({kind: 'failed', source_status: 'failed'});
    assert.equal(state.alarm, 5100);
    state.now = 3000;
    await accept({kind: 'failed', source_status: 'failed'});
    assert.deepEqual(state.writes, [61000, 5100]);
});

test('diagnostics, request expiry, Discord rate limits and freshness still select earlier wakes', async t => {
    const {state, accept, scheduler, rows} = fixture(t);
    await accept();
    state.diagnostic = 50000;
    await scheduler.schedule();
    assert.equal(state.alarm, 50000);
    state.expiry = 40000;
    await scheduler.schedule();
    assert.equal(state.alarm, 40000);
    scheduler.enabled = true;
    rows("INSERT INTO outbox VALUES(1,'retry_wait',2000)");
    rows("INSERT INTO meta VALUES('rate_until','30000')");
    await scheduler.schedule();
    assert.equal(state.alarm, 30000);
    state.freshness = 20000;
    await scheduler.schedule();
    assert.equal(state.alarm, 20000);
    state.expiry = 999;
    await scheduler.schedule();
    assert.equal(state.alarm, state.now + 1);
});

test('disabled, paused, expired and empty QQ queues do not retain idle alarms', async t => {
    for (const mode of ['disabled', 'paused', 'expired', 'empty']) {
        await t.test(mode, async t => {
            const {state, activation, config, rows, scheduler, accept} = fixture(t);
            await accept({kind: 'failed', source_status: 'failed'});
            if (mode === 'disabled') config.enabled = false;
            if (mode === 'paused') activation.active = false;
            if (mode === 'expired') activation.expiresAt = state.now;
            if (mode === 'empty') rows("UPDATE qq_continuous_outbox SET status='sent'");
            await scheduler.schedule();
            assert.equal(state.alarm, null);
            assert.equal(state.deletes, 1);
            assert.deepEqual(state.writes, [4100]);
        });
    }
});

test('Discord quarantine and disabled delivery do not become eligible through a preserved alarm', async t => {
    const {state, rows, scheduler, accept, activation} = fixture(t);
    await accept({kind: 'failed', source_status: 'failed'});
    rows("INSERT INTO outbox VALUES(1,'queued',1000)");
    activation.active = false;
    await scheduler.schedule();
    assert.equal(state.alarm, null);
    scheduler.enabled = true;
    rows("INSERT INTO outbox VALUES(2,'uncertain',1000)");
    await scheduler.schedule();
    assert.equal(state.alarm, null);
    // An independent diagnostic expiry still wakes the owner, not a dispatch.
    state.diagnostic = 20000;
    await scheduler.schedule();
    assert.equal(state.alarm, 20000);
});
