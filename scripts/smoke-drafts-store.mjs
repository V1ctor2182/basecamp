#!/usr/bin/env node
// Smoke for 07-applier/01-mode1-simplify-hybrid m1: drafts store module.
// Pure-Node asserts — no server spawn, no API calls. Exercises schema,
// atomic CRUD, and orphan cleanup.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  JOB_ID_RE,
  FIELD_CLASSES,
  CONFIDENCE_TIERS,
  DraftFieldSchema,
  DraftSchema,
  DRAFTS_DIR,
  readDraft,
  writeDraft,
  deleteDraft,
  listDraftJobIds,
} from '../src/career/applier/draftsStore.mjs';

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

// ── Fixture isolation: track what we create + restore on teardown
const SUFFIX = `.smoke-backup.${process.pid}`;
let preExisting = new Set();
if (existsSync(DRAFTS_DIR)) {
  for (const f of await fs.readdir(DRAFTS_DIR)) preExisting.add(f);
}

async function cleanup() {
  if (!existsSync(DRAFTS_DIR)) return;
  for (const f of await fs.readdir(DRAFTS_DIR)) {
    if (preExisting.has(f)) continue;
    await fs.unlink(path.join(DRAFTS_DIR, f)).catch(() => {});
  }
}

function makeDraft(jobId, over = {}) {
  return {
    jobId,
    fields: [
      {
        label: 'Why this company?',
        class: 'open',
        suggested_value: 'I admire the team building safe AI.',
        confidence: 'medium',
        source_ref: 'qa-bank/templates.md#why-company',
      },
      {
        label: 'Authorized to work in US?',
        class: 'legal',
        suggested_value: 'Yes',
        confidence: 'high',
        source_ref: 'qa-bank/legal.yml#authorized_us_yes_no',
      },
    ],
    generated_at: '2026-05-09T10:00:00Z',
    model: 'claude-sonnet-4-6',
    cost_usd: 0.05,
    ...over,
  };
}

try {
  // ── 1. Schema basics ───────────────────────────────────────────────────
  await test('DraftSchema accepts a valid draft', () => {
    const r = DraftSchema.parse(makeDraft('aaaaaaaaaaaa'));
    assert.equal(r.jobId, 'aaaaaaaaaaaa');
    assert.equal(r.fields.length, 2);
  });

  await test('DraftSchema rejects bad jobId regex', () => {
    assert.throws(() => DraftSchema.parse(makeDraft('bad-id')), /jobId must match/);
    assert.throws(() => DraftSchema.parse(makeDraft('AAAAAAAAAAAA')));
    assert.throws(() => DraftSchema.parse(makeDraft('aaaaaaaaaaa'))); // 11 hex
    assert.throws(() => DraftSchema.parse(makeDraft('aaaaaaaaaaaaa'))); // 13 hex
  });

  await test('DraftFieldSchema rejects unknown class / confidence / oversized fields', () => {
    const baseField = { label: 'Q', class: 'open', suggested_value: 'A', confidence: 'medium' };
    assert.throws(() => DraftFieldSchema.parse({ ...baseField, class: 'unknown' }));
    assert.throws(() => DraftFieldSchema.parse({ ...baseField, confidence: 'maybe' }));
    assert.throws(() => DraftFieldSchema.parse({ ...baseField, label: '' })); // min(1)
    // suggested_value over 4000 chars
    assert.throws(() => DraftFieldSchema.parse({
      ...baseField,
      suggested_value: 'x'.repeat(4001),
    }));
    // unknown extra field — .strict() should reject
    assert.throws(() => DraftFieldSchema.parse({ ...baseField, mystery: 'oops' }));
  });

  await test('DraftSchema rejects empty fields array (min(1))', () => {
    assert.throws(() => DraftSchema.parse(makeDraft('aaaaaaaaaaaa', { fields: [] })));
  });

  await test('Constants are frozen and have expected shape', () => {
    assert.ok(Object.isFrozen(FIELD_CLASSES));
    assert.ok(Object.isFrozen(CONFIDENCE_TIERS));
    assert.deepEqual([...FIELD_CLASSES], ['hard', 'legal', 'open', 'file']);
    assert.deepEqual([...CONFIDENCE_TIERS], ['high', 'medium', 'low']);
    assert.ok(JOB_ID_RE.test('0123456789ab'));
    assert.ok(!JOB_ID_RE.test('0123456789AB'));
  });

  // ── 2. CRUD round-trip ─────────────────────────────────────────────────
  await test('readDraft returns null on ENOENT (no draft for jobId)', async () => {
    const r = await readDraft('cccccccccccc');
    assert.equal(r, null);
  });

  await test('writeDraft → readDraft round-trips through Zod', async () => {
    const jobId = 'dddddddddddd';
    const draft = makeDraft(jobId);
    const written = await writeDraft(jobId, draft);
    assert.equal(written.jobId, jobId);
    const read = await readDraft(jobId);
    assert.deepEqual(read, written);
    await deleteDraft(jobId);
  });

  await test('writeDraft rejects mismatched jobId vs draft.jobId', async () => {
    await assert.rejects(
      writeDraft('eeeeeeeeeeee', makeDraft('ffffffffffff')),
      /jobId mismatch/
    );
  });

  // ── 3. Atomic write + orphan cleanup ───────────────────────────────────
  await test('Schema-violation write does not leave .tmp orphans', async () => {
    const jobId = '111111111111';
    // Bad draft (negative cost) — schema rejects before atomicWriteJson
    // gets called, so no tmp file should ever appear. But also defend
    // against a future change that might validate inside atomicWriteJson:
    // verify drafts dir has no .tmp residue after the failure.
    await assert.rejects(
      writeDraft(jobId, makeDraft(jobId, { cost_usd: -1 }))
    );
    if (existsSync(DRAFTS_DIR)) {
      const files = await fs.readdir(DRAFTS_DIR);
      const orphans = files.filter((f) => f.startsWith(`${jobId}.json.tmp`));
      assert.equal(orphans.length, 0, `expected no .tmp orphans, found: ${orphans}`);
    }
  });

  // ── 4. listDraftJobIds + deleteDraft ───────────────────────────────────
  await test('listDraftJobIds returns only valid 12-hex ids', async () => {
    // Write 2 valid drafts + drop a malformed file in DRAFTS_DIR to verify
    // the regex filter excludes it
    await writeDraft('222222222222', makeDraft('222222222222'));
    await writeDraft('333333333333', makeDraft('333333333333'));
    // Plant unrelated files. Use distinct names that don't collide with
    // existing files like README.md (which is shipped by init-career.sh).
    if (!existsSync(DRAFTS_DIR)) await fs.mkdir(DRAFTS_DIR, { recursive: true });
    const orphan1 = path.join(DRAFTS_DIR, '_smoke_orphan_text.txt');
    const orphan2 = path.join(DRAFTS_DIR, 'NOT_HEX_AT_ALL.json');
    await fs.writeFile(orphan1, 'unrelated\n');
    await fs.writeFile(orphan2, '{}\n');

    const ids = await listDraftJobIds();
    assert.ok(ids.includes('222222222222'));
    assert.ok(ids.includes('333333333333'));
    assert.ok(!ids.some((i) => i.includes('orphan')));
    assert.ok(!ids.some((i) => i.includes('NOT_HEX')));

    // Cleanup
    await deleteDraft('222222222222');
    await deleteDraft('333333333333');
    await fs.unlink(orphan1).catch(() => {});
    await fs.unlink(orphan2).catch(() => {});
  });

  await test('deleteDraft is idempotent (ENOENT swallowed)', async () => {
    // Delete nonexistent — should not throw
    await deleteDraft('444444444444');
    // Write + delete + re-delete
    await writeDraft('555555555555', makeDraft('555555555555'));
    await deleteDraft('555555555555');
    await deleteDraft('555555555555'); // second time — still fine
    assert.equal(await readDraft('555555555555'), null);
  });

  // ── 5. Bad-jobId guards on the public API ──────────────────────────────
  await test('readDraft / writeDraft / deleteDraft throw TypeError on bad jobId', async () => {
    await assert.rejects(readDraft('not-hex'), /invalid jobId/);
    await assert.rejects(writeDraft('not-hex', makeDraft('aaaaaaaaaaaa')), /invalid jobId/);
    await assert.rejects(deleteDraft('not-hex'), /invalid jobId/);
  });
} finally {
  await cleanup();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
