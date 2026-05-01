#!/usr/bin/env node
// Smoke for src/career/finder/dedupe.mjs. Uses temp-file paths so it doesn't
// touch the real data/career/scan-history.jsonl.

import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

import {
  loadSeenSet,
  dedupeJobs,
  markIdsAsSeen,
  SCAN_HISTORY_FILE,
} from '../src/career/finder/dedupe.mjs';

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

function makeJob(id, role = 'Engineer') {
  return {
    id,
    source: { type: 'greenhouse', name: 'X', url: null },
    company: 'X',
    role,
    location: [],
    url: 'https://example.com/j/' + id,
    description: null,
    posted_at: null,
    scraped_at: new Date().toISOString(),
    comp_hint: null,
    tags: [],
    raw: null,
    schema_version: 1,
  };
}

async function withTempFile(fn) {
  const tmp = path.join(os.tmpdir(), `smoke-dedupe-${process.pid}-${Date.now()}.jsonl`);
  try {
    await fn(tmp);
  } finally {
    try { await fs.unlink(tmp); } catch {}
  }
}

await test('1. SCAN_HISTORY_FILE points to data/career/scan-history.jsonl', () => {
  assert.match(SCAN_HISTORY_FILE, /data\/career\/scan-history\.jsonl$/);
});

await test('2. loadSeenSet on missing file returns empty Set', async () => {
  await withTempFile(async (tmp) => {
    const set = await loadSeenSet(tmp);
    assert.equal(set.size, 0);
  });
});

await test('3. markIdsAsSeen + loadSeenSet roundtrip', async () => {
  await withTempFile(async (tmp) => {
    await markIdsAsSeen(['abc123', 'def456', 'ghi789'], tmp);
    const set = await loadSeenSet(tmp);
    assert.equal(set.size, 3);
    assert.ok(set.has('abc123'));
    assert.ok(set.has('def456'));
    assert.ok(set.has('ghi789'));
  });
});

await test('4. dedupeJobs all-fresh on empty file → all new (via file= param)', async () => {
  await withTempFile(async (tmp) => {
    const jobs = [makeJob('a'), makeJob('b'), makeJob('c')];
    const r = await dedupeJobs(jobs, tmp);
    assert.equal(r.new.length, 3);
    assert.equal(r.duplicates.length, 0);
    assert.equal(r.seenCount, 0);
  });
});

await test('5. fresh + duplicate mix correctly partitioned (real dedupeJobs)', async () => {
  await withTempFile(async (tmp) => {
    await markIdsAsSeen(['old-1', 'old-2'], tmp);
    const jobs = [makeJob('old-1'), makeJob('new-1'), makeJob('old-2'), makeJob('new-2')];
    const r = await dedupeJobs(jobs, tmp);
    assert.deepEqual(r.new.map((j) => j.id), ['new-1', 'new-2']);
    assert.deepEqual(r.duplicates.map((j) => j.id), ['old-1', 'old-2']);
    assert.equal(r.seenCount, 2);
  });
});

await test('5b. intra-batch duplicates collapse: same id twice in one fetch → first is new, rest are dups', async () => {
  await withTempFile(async (tmp) => {
    const jobs = [makeJob('a'), makeJob('a'), makeJob('b'), makeJob('a')];
    const r = await dedupeJobs(jobs, tmp);
    assert.equal(r.new.length, 2);
    assert.equal(r.duplicates.length, 2);
    assert.deepEqual(r.new.map((j) => j.id), ['a', 'b']);
    assert.deepEqual(r.duplicates.map((j) => j.id), ['a', 'a']);
  });
});

await test('6. malformed line is skipped with warn (does not crash)', async () => {
  await withTempFile(async (tmp) => {
    // Mix valid + 1 garbage line + blank.
    const content =
      JSON.stringify({ id: 'good-1', seen_at: '2026-04-30T00:00:00.000Z' }) + '\n' +
      'this is not json\n' +
      '\n' +
      JSON.stringify({ id: 'good-2', seen_at: '2026-04-30T00:00:00.000Z' }) + '\n';
    await fs.writeFile(tmp, content);
    // Suppress stderr noise from console.warn during the test.
    const origWarn = console.warn;
    let warned = 0;
    console.warn = () => { warned++; };
    try {
      const set = await loadSeenSet(tmp);
      assert.equal(set.size, 2);
      assert.ok(set.has('good-1'));
      assert.ok(set.has('good-2'));
      assert.ok(warned >= 1, 'expected at least one warn');
    } finally {
      console.warn = origWarn;
    }
  });
});

await test('7. large file (10K rows) loads under 200ms', async () => {
  await withTempFile(async (tmp) => {
    const ids = Array.from({ length: 10_000 }, (_, i) => `id-${i.toString(16).padStart(12, '0')}`);
    await markIdsAsSeen(ids, tmp);
    const t0 = Date.now();
    const set = await loadSeenSet(tmp);
    const dt = Date.now() - t0;
    assert.equal(set.size, 10_000);
    assert.ok(dt < 200, `load took ${dt}ms (expected < 200ms)`);
  });
});

await test('8. job missing id is treated as new (with warn) — real dedupeJobs', async () => {
  await withTempFile(async (tmp) => {
    const jobs = [makeJob('a'), { ...makeJob('b'), id: undefined }];
    const origWarn = console.warn;
    let warned = 0;
    console.warn = () => { warned++; };
    try {
      const r = await dedupeJobs(jobs, tmp);
      assert.equal(r.new.length, 2);
      assert.ok(warned >= 1, 'expected console.warn for missing id');
    } finally {
      console.warn = origWarn;
    }
  });
});

console.log(`\n✅ All ${passed} smoke tests passed.`);
