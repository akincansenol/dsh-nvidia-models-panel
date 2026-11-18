// Unit tests for the daily usage registry (pure, no deps).
// Run: ELECTRON_RUN_AS_NODE=1 "<DSH_NODE_EXECUTABLE>" --test src/usage.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageRegistry, dayKeyOf } from './usage.js';

const FIXED = new Date(2026, 10, 16, 10, 0, 0).getTime(); // 2026-11-16 10:00 local

test('dayKeyOf formats a local YYYY-MM-DD', () => {
  assert.equal(dayKeyOf(FIXED), '2026-11-16');
  assert.equal(dayKeyOf(new Date(2026, 0, 5).getTime()), '2026-01-05');
});

test('record aggregates total, per-member and log', () => {
  const reg = createUsageRegistry({ now: () => FIXED });
  reg.record({ memberId: 'a', ok: true, firstByteMs: 200, inputTokens: 100, outputTokens: 40 });
  reg.record({ memberId: 'a', ok: true, firstByteMs: 400, inputTokens: 50, outputTokens: 10 });
  reg.record({ memberId: 'b', ok: false, error: 'boom' });
  reg.record({ memberId: 'b', ok: true, failover: true, failoverFrom: 'a', firstByteMs: 600 });

  const s = reg.snapshot();
  assert.equal(s.day, '2026-11-16');
  assert.equal(s.total.calls, 4);
  assert.equal(s.total.ok, 3);
  assert.equal(s.total.fail, 1);
  assert.equal(s.total.failovers, 1);
  assert.equal(s.total.inputTokens, 150);
  assert.equal(s.total.outputTokens, 50);

  const a = s.members.find((m) => m.id === 'a');
  assert.equal(a.calls, 2);
  assert.equal(a.ok, 2);
  assert.equal(a.avgFirstByteMs, 300); // (200+400)/2
  const b = s.members.find((m) => m.id === 'b');
  assert.equal(b.calls, 2);
  assert.equal(b.fail, 1);
  assert.equal(b.failovers, 1);
  assert.equal(b.lastError, 'boom');

  // log is newest-first
  assert.equal(s.log.length, 4);
  assert.equal(s.log[0].memberId, 'b');
  assert.equal(s.log[0].failoverFrom, 'a');
});

test('snapshot of an unknown day is a valid empty summary', () => {
  const reg = createUsageRegistry({ now: () => FIXED });
  const s = reg.snapshot('2020-01-01');
  assert.equal(s.total.calls, 0);
  assert.deepEqual(s.members, []);
  assert.deepEqual(s.log, []);
});

test('reset clears one day or everything', () => {
  const reg = createUsageRegistry({ now: () => FIXED });
  reg.record({ memberId: 'a', ok: true });
  reg.reset('2026-11-16');
  assert.equal(reg.snapshot('2026-11-16').total.calls, 0);

  reg.record({ memberId: 'a', ok: true });
  reg.reset();
  assert.equal(reg.snapshot().total.calls, 0);
});

test('per-day buckets are keyed by local date', () => {
  let clock = FIXED;
  const reg = createUsageRegistry({ now: () => clock });
  reg.record({ memberId: 'a', ok: true });
  clock = new Date(2026, 10, 17, 9, 0, 0).getTime();
  reg.record({ memberId: 'a', ok: true });
  assert.equal(reg.snapshot('2026-11-16').total.calls, 1);
  assert.equal(reg.snapshot('2026-11-17').total.calls, 1);
});

test('log is capped by maxLogPerDay (rolling)', () => {
  const reg = createUsageRegistry({ now: () => FIXED, maxLogPerDay: 3 });
  for (let i = 0; i < 5; i += 1) reg.record({ memberId: 'm' + i, ok: true });
  const s = reg.snapshot();
  assert.equal(s.log.length, 3);
  // newest first => m4,m3,m2
  assert.equal(s.log[0].memberId, 'm4');
  assert.equal(s.log[2].memberId, 'm2');
  // but totals still count all 5
  assert.equal(s.total.calls, 5);
});

test('prune drops buckets older than retentionDays', () => {
  let clock = FIXED;
  const reg = createUsageRegistry({ now: () => clock, retentionDays: 2 });
  reg.record({ memberId: 'a', ok: true }); // 2026-11-16
  clock = new Date(2026, 10, 20, 9, 0, 0).getTime(); // 4 days later
  reg.prune();
  assert.deepEqual(reg.days(), []);
});

// ---- persistence ---------------------------------------------------------
function memStorage() {
  let blob = null;
  return {
    async load() { return blob; },
    async save(data) { blob = JSON.parse(JSON.stringify(data)); },
    peek() { return blob; },
    set raw(v) { blob = v; },
  };
}

test('hydrate restores a persisted snapshot into a fresh registry', async () => {
  const storage = memStorage();
  const reg1 = createUsageRegistry({ now: () => FIXED, storage });
  reg1.record({ memberId: 'a', ok: true, firstByteMs: 200, inputTokens: 100, outputTokens: 40 });
  reg1.record({ memberId: 'b', ok: false, failover: true, failoverFrom: 'a', error: 'boom' });
  // persist() is queued on a promise chain; let it flush.
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(storage.peek(), 'storage should hold a snapshot');

  const reg2 = createUsageRegistry({ now: () => FIXED, storage });
  await reg2.hydrate();
  const s = reg2.snapshot();
  assert.equal(s.total.calls, 2);
  assert.equal(s.total.ok, 1);
  assert.equal(s.total.fail, 1);
  assert.equal(s.total.failovers, 1);
  assert.equal(s.total.inputTokens, 100);
  const a = s.members.find((m) => m.id === 'a');
  assert.equal(a.avgFirstByteMs, 200);
  assert.equal(s.log[0].memberId, 'b');
  assert.equal(s.log[0].failoverFrom, 'a');
});

test('reset persists the cleared state (no zombie logs after reload)', async () => {
  const storage = memStorage();
  const reg = createUsageRegistry({ now: () => FIXED, storage });
  reg.record({ memberId: 'a', ok: true });
  await new Promise((r) => setTimeout(r, 0));
  reg.reset();
  await new Promise((r) => setTimeout(r, 0));

  const reg2 = createUsageRegistry({ now: () => FIXED, storage });
  await reg2.hydrate();
  assert.equal(reg2.snapshot().total.calls, 0);
});

test('hydrate survives corrupt / missing storage', async () => {
  const storage = memStorage();
  storage.raw = '{not valid json';
  const reg = createUsageRegistry({ now: () => FIXED, storage });
  await reg.hydrate(); // must not throw
  assert.equal(reg.snapshot().total.calls, 0);
  reg.record({ memberId: 'a', ok: true }); // still works in memory
  assert.equal(reg.snapshot().total.calls, 1);
});

test('hydrate prunes expired buckets loaded from disk', async () => {
  let clock = FIXED;
  const storage = memStorage();
  const reg1 = createUsageRegistry({ now: () => clock, storage, retentionDays: 2 });
  reg1.record({ memberId: 'a', ok: true }); // 2026-11-16
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(Object.keys(storage.peek().days), ['2026-11-16']);

  clock = new Date(2026, 10, 20, 9, 0, 0).getTime(); // 4 days later
  const reg2 = createUsageRegistry({ now: () => clock, storage, retentionDays: 2 });
  await reg2.hydrate();
  assert.deepEqual(reg2.days(), []);
});
