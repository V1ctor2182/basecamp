#!/usr/bin/env node
// Smoke for cadenceState.mjs (m1 of 05-scan-scheduler).

import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import {
  parseCadence,
  cadenceToMs,
  readCadenceState,
  writeCadenceState,
  updateForTypes,
  isDue,
} from '../src/career/finder/cadenceState.mjs';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    process.exit(1);
  }
}

async function withTempFile(fn) {
  const tmp = path.join(os.tmpdir(), `cadence-${process.pid}-${Date.now()}.json`);
  try {
    await fn(tmp);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

// ── parseCadence ────────────────────────────────────────────────────────
await test('parseCadence-1. positive cases', () => {
  assert.equal(parseCadence('72h'), 72 * 60 * 60 * 1000);
  assert.equal(parseCadence('24h'), 24 * 60 * 60 * 1000);
  assert.equal(parseCadence('30m'), 30 * 60 * 1000);
  assert.equal(parseCadence('1d'), 24 * 60 * 60 * 1000);
  assert.equal(parseCadence('45s'), 45_000);
  assert.equal(parseCadence('  72h  '), 72 * 60 * 60 * 1000); // trim
});

await test('parseCadence-2. malformed throws', () => {
  assert.throws(() => parseCadence('72'));        // no unit
  assert.throws(() => parseCadence('72ms'));      // unsupported unit
  assert.throws(() => parseCadence('72y'));       // bad unit char
  assert.throws(() => parseCadence(''));          // empty
  assert.throws(() => parseCadence('  '));        // whitespace only
  assert.throws(() => parseCadence('-1h'));       // negative not matched by ^\d+
  assert.throws(() => parseCadence('1.5h'));      // decimal not matched
  assert.throws(() => parseCadence('h72'));       // unit-first
  assert.throws(() => parseCadence('0h'));        // zero rejected (review fix)
  assert.throws(() => parseCadence('0m'));
  assert.throws(() => parseCadence('0d'));
  assert.throws(() => parseCadence('0s'));
});

await test('parseCadence-3. non-string throws TypeError', () => {
  assert.throws(() => parseCadence(null), TypeError);
  assert.throws(() => parseCadence(undefined), TypeError);
  assert.throws(() => parseCadence(72), TypeError);
});

// ── cadenceToMs ─────────────────────────────────────────────────────────
await test('cadenceToMs-1. full map round-trip', () => {
  const r = cadenceToMs({ greenhouse: '72h', 'github-md': '24h', scrape: '168h' });
  assert.deepEqual(r, {
    greenhouse: 72 * 60 * 60 * 1000,
    'github-md': 24 * 60 * 60 * 1000,
    scrape: 168 * 60 * 60 * 1000,
  });
});

await test('cadenceToMs-2. bad key warned + skipped, others proceed', () => {
  const origWarn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    const r = cadenceToMs({ greenhouse: '72h', ashby: 'nonsense', lever: '24h' });
    assert.equal(r.greenhouse, 72 * 60 * 60 * 1000);
    assert.equal(r.lever, 24 * 60 * 60 * 1000);
    assert.equal('ashby' in r, false, 'ashby should be skipped');
    assert.ok(warned >= 1, 'expected console.warn for bad ashby cadence');
  } finally {
    console.warn = origWarn;
  }
});

await test('cadenceToMs-3. null/undefined/non-object → {}', () => {
  assert.deepEqual(cadenceToMs(null), {});
  assert.deepEqual(cadenceToMs(undefined), {});
  assert.deepEqual(cadenceToMs('lol'), {});
});

// ── isDue ───────────────────────────────────────────────────────────────
await test('isDue-1. never run → due', () => {
  const cm = { greenhouse: 60_000 };
  assert.equal(isDue('greenhouse', {}, cm, 1_000_000), true);
});

await test('isDue-2. just ran (< cadence) → not due', () => {
  const cm = { greenhouse: 60_000 };
  const now = 1_000_000;
  const state = { greenhouse: { last_run_at: new Date(now - 10_000).toISOString() } };
  assert.equal(isDue('greenhouse', state, cm, now), false);
});

await test('isDue-3. past-due (>= cadence) → due', () => {
  const cm = { greenhouse: 60_000 };
  const now = 1_000_000;
  const state = { greenhouse: { last_run_at: new Date(now - 120_000).toISOString() } };
  assert.equal(isDue('greenhouse', state, cm, now), true);
});

await test('isDue-4. exact-edge (now == last + cadence) → due', () => {
  const cm = { greenhouse: 60_000 };
  const now = 1_000_000;
  const state = { greenhouse: { last_run_at: new Date(now - 60_000).toISOString() } };
  assert.equal(isDue('greenhouse', state, cm, now), true);
});

await test('isDue-5. type missing in cadenceMap → not due', () => {
  assert.equal(isDue('ashby', {}, { greenhouse: 60_000 }, 1_000_000), false);
});

await test('isDue-6. corrupt last_run_at → re-run (treated as never)', () => {
  const cm = { greenhouse: 60_000 };
  const state = { greenhouse: { last_run_at: 'not-a-date' } };
  assert.equal(isDue('greenhouse', state, cm, 1_000_000), true);
});

await test('isDue-7. future last_run_at → due (clock skew defense, review fix)', () => {
  const cm = { greenhouse: 60_000 };
  const now = 1_000_000;
  const state = { greenhouse: { last_run_at: new Date(now + 60_000).toISOString() } };
  assert.equal(isDue('greenhouse', state, cm, now), true);
});

await test('isDue-8. cadence 0 ms → never due (defensive even after parseCadence rejects 0)', () => {
  const cm = { greenhouse: 0 };
  assert.equal(isDue('greenhouse', {}, cm, 1_000_000), false);
});

// ── State file I/O ──────────────────────────────────────────────────────
await test('readCadenceState-1. missing file → {}', async () => {
  const r = await readCadenceState('/tmp/nonexistent-xyz.json');
  assert.deepEqual(r, {});
});

await test('readCadenceState-2. malformed JSON → {} + warn (no throw)', async () => {
  await withTempFile(async (tmp) => {
    await fs.writeFile(tmp, 'not valid json');
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const r = await readCadenceState(tmp);
      assert.deepEqual(r, {});
    } finally {
      console.warn = origWarn;
    }
  });
});

await test('writeCadenceState + readCadenceState round-trip', async () => {
  await withTempFile(async (tmp) => {
    const state = {
      greenhouse: {
        last_run_at: '2026-05-01T00:00:00.000Z',
        last_outcome: 'ok',
        last_jobs_count: 42,
      },
    };
    await writeCadenceState(state, tmp);
    const r = await readCadenceState(tmp);
    assert.deepEqual(r, state);
  });
});

// ── updateForTypes ──────────────────────────────────────────────────────
await test('updateForTypes-1. preserves other types untouched', async () => {
  await withTempFile(async (tmp) => {
    await writeCadenceState(
      {
        greenhouse: { last_run_at: '2026-04-30T00:00:00.000Z', last_outcome: 'ok' },
        ashby: { last_run_at: '2026-04-29T00:00:00.000Z', last_outcome: 'ok' },
      },
      tmp
    );
    await updateForTypes(['greenhouse'], { last_run_at: '2026-05-01T00:00:00.000Z' }, tmp);
    const r = await readCadenceState(tmp);
    assert.equal(r.greenhouse.last_run_at, '2026-05-01T00:00:00.000Z');
    assert.equal(r.greenhouse.last_outcome, 'ok'); // shallow merge preserves
    assert.equal(r.ashby.last_run_at, '2026-04-29T00:00:00.000Z'); // untouched
  });
});

await test('updateForTypes-2. multi-type update + missing file fresh', async () => {
  await withTempFile(async (tmp) => {
    // file doesn't exist yet — readCadenceState returns {}
    await updateForTypes(
      ['greenhouse', 'ashby'],
      { last_run_at: '2026-05-01T00:00:00.000Z', last_outcome: 'ok' },
      tmp
    );
    const r = await readCadenceState(tmp);
    assert.equal(r.greenhouse.last_outcome, 'ok');
    assert.equal(r.ashby.last_outcome, 'ok');
  });
});

await test('updateForTypes-3. empty types array is a no-op (no file write)', async () => {
  await withTempFile(async (tmp) => {
    // Don't pre-write — empty types should leave file missing
    await updateForTypes([], { last_outcome: 'ok' }, tmp);
    const exists = await fs.stat(tmp).then(() => true).catch(() => false);
    assert.equal(exists, false, 'empty types should not create file');
  });
});

await test('updateForTypes-4. concurrent updates serialize (no lost-update race, review fix)', async () => {
  await withTempFile(async (tmp) => {
    // Two concurrent updateForTypes on disjoint types should both land.
    // Without the promise queue, B would read state before A wrote, then
    // overwrite A's patch with B's snapshot.
    const p1 = updateForTypes(
      ['greenhouse'],
      { last_run_at: '2026-05-02T00:00:00.000Z', last_outcome: 'ok' },
      tmp
    );
    const p2 = updateForTypes(
      ['ashby'],
      { last_run_at: '2026-05-02T00:01:00.000Z', last_outcome: 'ok' },
      tmp
    );
    await Promise.all([p1, p2]);
    const r = await readCadenceState(tmp);
    assert.equal(r.greenhouse?.last_run_at, '2026-05-02T00:00:00.000Z', 'A patch survived');
    assert.equal(r.ashby?.last_run_at, '2026-05-02T00:01:00.000Z', 'B patch survived');
  });
});

await test('updateForTypes-5. whitespace-only type names skipped', async () => {
  await withTempFile(async (tmp) => {
    await updateForTypes(['  ', 'greenhouse'], { last_outcome: 'ok' }, tmp);
    const r = await readCadenceState(tmp);
    assert.equal('greenhouse' in r, true);
    assert.equal('  ' in r, false, 'whitespace-only type should be skipped');
  });
});

console.log(`\n✅ All ${passed} smoke tests passed.`);
