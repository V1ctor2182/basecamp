#!/usr/bin/env node
// Smoke for 07-applier/06-site-adapters m1:
// schema.mjs (Zod SiteAdapterSchema + compileAdapter + mergeCommonDefaults) +
// loader.mjs (loadAdapters + _common merge + mtime cache) +
// detector.mjs (detectSiteAdapter URL → adapter; default fallback).
//
// Pure-Node — uses os.tmpdir() to write throwaway YAML fixtures so we
// can test load failures + bad schemas without touching the real
// data/career/site-adapters/ files.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SiteAdapterSchema,
  CommonDefaultsSchema,
  compileAdapter,
  mergeCommonDefaults,
} from '../src/career/applier/siteAdapters/schema.mjs';
import {
  loadAdapters,
  _clearCache,
  DEFAULT_ADAPTERS_DIR,
} from '../src/career/applier/siteAdapters/loader.mjs';
import {
  detectSiteAdapter,
  listMatchingAdapters,
} from '../src/career/applier/siteAdapters/detector.mjs';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    failed++;
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────

async function makeTmpDir(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-adapters-smoke-'));
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), body);
  }
  return dir;
}

const MIN_DEFAULT_YML = `name: Default
id: default
priority: 0
detection:
  url_patterns:
    - ".*"
flow:
  type: single-step
`;

const MIN_GREENHOUSE_YML = `name: Greenhouse
id: greenhouse
priority: 100
detection:
  url_patterns:
    - "boards\\\\.greenhouse\\\\.io"
flow:
  type: single-step
  submit_button:
    selectors: ["#submit_app"]
`;

const MIN_COMMON_YML = `flow:
  next_button:
    name_hints:
      - Next
      - Continue
  submit_button:
    name_hints:
      - Submit
`;

// ── 1. Schema ──────────────────────────────────────────────────────────

await test('SiteAdapterSchema: minimal adapter accepted', () => {
  const result = SiteAdapterSchema.parse({
    name: 'Greenhouse',
    id: 'greenhouse',
    detection: { url_patterns: ['boards\\.greenhouse\\.io'] },
    flow: { type: 'single-step' },
  });
  assert.equal(result.priority, 100); // default
  assert.deepEqual(result.detection.dom_signatures, []); // default
  assert.equal(result.flow.type, 'single-step');
  assert.deepEqual(result.known_fields, []);
});

await test('SiteAdapterSchema: rejects unknown top-level keys (strict)', () => {
  assert.throws(
    () =>
      SiteAdapterSchema.parse({
        name: 'X',
        id: 'x',
        detection: { url_patterns: ['.*'] },
        flow: { type: 'single-step' },
        bogus_field: 42,
      }),
    /Unrecognized key|bogus_field/,
  );
});

await test('SiteAdapterSchema: id must be lowercase slug', () => {
  assert.throws(
    () =>
      SiteAdapterSchema.parse({
        name: 'X',
        id: 'Greenhouse', // uppercase
        detection: { url_patterns: ['.*'] },
        flow: { type: 'single-step' },
      }),
    /id must be lowercase slug/,
  );
});

await test('SiteAdapterSchema: url_patterns required (min 1)', () => {
  assert.throws(
    () =>
      SiteAdapterSchema.parse({
        name: 'X',
        id: 'x',
        detection: { url_patterns: [] },
        flow: { type: 'single-step' },
      }),
    /url_patterns/,
  );
});

await test('SiteAdapterSchema: known_field class enum guarded', () => {
  assert.throws(
    () =>
      SiteAdapterSchema.parse({
        name: 'X',
        id: 'x',
        detection: { url_patterns: ['.*'] },
        flow: { type: 'single-step' },
        known_fields: [{ label_pattern: 'x', class: 'unknown', maps_to: 'y' }],
      }),
    /class/,
  );
});

await test('compileAdapter: url_patterns + label_patterns compiled to RegExp /i', () => {
  const raw = SiteAdapterSchema.parse({
    name: 'X',
    id: 'x',
    detection: { url_patterns: ['boards\\.greenhouse\\.io', 'ASHBY\\.com'] },
    flow: { type: 'single-step' },
    known_fields: [{ label_pattern: '^first name', class: 'hard', maps_to: 'identity.first_name' }],
  });
  const compiled = compileAdapter(raw);
  assert.equal(compiled.detection.urlRegexes.length, 2);
  assert.ok(compiled.detection.urlRegexes[0] instanceof RegExp);
  assert.equal(compiled.detection.urlRegexes[0].flags, 'i');
  assert.ok(compiled.detection.urlRegexes[0].test('boards.greenhouse.io/x/jobs/y'));
  // Case-insensitive
  assert.ok(compiled.detection.urlRegexes[1].test('ashby.com'));
  // known_fields compiled
  assert.ok(compiled.known_fields[0].labelRegex instanceof RegExp);
  assert.ok(compiled.known_fields[0].labelRegex.test('First Name *'));
});

await test('compileAdapter: invalid regex throws with adapter id context', () => {
  const bad = SiteAdapterSchema.parse({
    name: 'X',
    id: 'bad',
    detection: { url_patterns: ['[invalid('] },
    flow: { type: 'single-step' },
  });
  assert.throws(() => compileAdapter(bad), /compileAdapter\(bad\): invalid regex/);
});

await test('mergeCommonDefaults: adapter hints come BEFORE common hints', () => {
  const adapter = {
    flow: {
      type: 'single-step',
      next_button: { selectors: ['#adapter-next'], name_hints: ['Adapter Next'] },
      submit_button: { selectors: [], name_hints: [] },
      progress_bar: { selectors: [], name_hints: [] },
      step_list: { selectors: [], name_hints: [] },
    },
  };
  const common = {
    flow: {
      next_button: { selectors: [], name_hints: ['Common Next', 'Continue'] },
      submit_button: { selectors: [], name_hints: ['Submit'] },
    },
  };
  const merged = mergeCommonDefaults(adapter, common);
  assert.deepEqual(merged.flow.next_button.name_hints, [
    'Adapter Next',
    'Common Next',
    'Continue',
  ]);
  assert.deepEqual(merged.flow.next_button.selectors, ['#adapter-next']);
  assert.deepEqual(merged.flow.submit_button.name_hints, ['Submit']);
});

// ── 2. Loader ──────────────────────────────────────────────────────────

await test('loadAdapters: reads default + greenhouse + _common, returns priority-sorted registry', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'default.yml': MIN_DEFAULT_YML,
    'greenhouse.yml': MIN_GREENHOUSE_YML,
    '_common.yml': MIN_COMMON_YML,
  });
  const reg = await loadAdapters(dir);
  assert.equal(reg.adapters.length, 1, 'one non-default adapter');
  assert.equal(reg.adapters[0].id, 'greenhouse');
  assert.equal(reg.default.id, 'default');
  assert.ok(reg.common, 'common parsed');
  // _common.submit_button.name_hints merged into greenhouse
  assert.ok(reg.adapters[0].flow.submit_button.name_hints.includes('Submit'));
  // Adapter's own hints take precedence in order
  assert.equal(reg.adapters[0].flow.submit_button.selectors[0], '#submit_app');
});

await test('loadAdapters: missing default.yml throws clearly', async () => {
  _clearCache();
  const dir = await makeTmpDir({ 'greenhouse.yml': MIN_GREENHOUSE_YML });
  await assert.rejects(() => loadAdapters(dir), /default\.yml is required/);
});

await test('loadAdapters: id must match filename slug', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'default.yml': MIN_DEFAULT_YML,
    'greenhouse.yml': MIN_GREENHOUSE_YML.replace('id: greenhouse', 'id: wrong'),
  });
  await assert.rejects(
    () => loadAdapters(dir),
    /id="wrong" must match filename slug "greenhouse"/,
  );
});

await test('loadAdapters: malformed YAML throws with file path', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'default.yml': MIN_DEFAULT_YML,
    'greenhouse.yml': '[ this is : not : valid yaml',
  });
  await assert.rejects(() => loadAdapters(dir), /failed to parse.*greenhouse\.yml/);
});

await test('loadAdapters: ZodError annotated with filename', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'default.yml': MIN_DEFAULT_YML,
    'greenhouse.yml': MIN_GREENHOUSE_YML.replace('flow:\n  type: single-step', 'flow:\n  type: bogus'),
  });
  await assert.rejects(
    () => loadAdapters(dir),
    /greenhouse\.yml schema validation failed/,
  );
});

await test('loadAdapters: mtime cache reuses on identical second load', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'default.yml': MIN_DEFAULT_YML,
    'greenhouse.yml': MIN_GREENHOUSE_YML,
  });
  const first = await loadAdapters(dir);
  const second = await loadAdapters(dir);
  assert.equal(first, second, 'cache returns same registry object');
});

await test('loadAdapters: cache invalidates after file mtime bump', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'default.yml': MIN_DEFAULT_YML,
    'greenhouse.yml': MIN_GREENHOUSE_YML,
  });
  const first = await loadAdapters(dir);
  // Bump mtime by waiting + rewriting (mtime granularity on macOS is 1ms but
  // can be coarser; sleep is unreliable so explicitly set mtime).
  const greenhousePath = path.join(dir, 'greenhouse.yml');
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(greenhousePath, future, future);
  const second = await loadAdapters(dir);
  assert.notEqual(first, second, 'cache invalidated after mtime change');
});

// ── 3. Detector ───────────────────────────────────────────────────────

await test('detectSiteAdapter: matches greenhouse URL → greenhouse adapter', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'default.yml': MIN_DEFAULT_YML,
    'greenhouse.yml': MIN_GREENHOUSE_YML,
  });
  const reg = await loadAdapters(dir);
  const adapter = detectSiteAdapter('https://boards.greenhouse.io/anthropic/jobs/123', reg);
  assert.equal(adapter.id, 'greenhouse');
});

await test('detectSiteAdapter: unknown domain → default', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'default.yml': MIN_DEFAULT_YML,
    'greenhouse.yml': MIN_GREENHOUSE_YML,
  });
  const reg = await loadAdapters(dir);
  const adapter = detectSiteAdapter('https://example.com/careers/role', reg);
  assert.equal(adapter.id, 'default');
});

await test('detectSiteAdapter: malformed URL → default (no throw)', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'default.yml': MIN_DEFAULT_YML,
    'greenhouse.yml': MIN_GREENHOUSE_YML,
  });
  const reg = await loadAdapters(dir);
  const adapter = detectSiteAdapter('::: not a url :::', reg);
  // Falls through to raw-string match; greenhouse pattern doesn't hit, so default wins.
  assert.equal(adapter.id, 'default');
});

await test('detectSiteAdapter: priority DESC ordering', async () => {
  _clearCache();
  // Two adapters both match boards.example.com but different priority.
  const HIGH = `name: High
id: high
priority: 200
detection:
  url_patterns:
    - "example\\\\.com"
flow:
  type: single-step
`;
  const LOW = `name: Low
id: low
priority: 50
detection:
  url_patterns:
    - "example\\\\.com"
flow:
  type: single-step
`;
  const dir = await makeTmpDir({
    'default.yml': MIN_DEFAULT_YML,
    'high.yml': HIGH,
    'low.yml': LOW,
  });
  const reg = await loadAdapters(dir);
  const adapter = detectSiteAdapter('https://example.com/jobs/1', reg);
  assert.equal(adapter.id, 'high', 'higher priority wins');
});

await test('listMatchingAdapters: returns all matches priority-DESC + default at tail', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'default.yml': MIN_DEFAULT_YML,
    'greenhouse.yml': MIN_GREENHOUSE_YML,
  });
  const reg = await loadAdapters(dir);
  const matches = listMatchingAdapters('https://boards.greenhouse.io/x/jobs/1', reg);
  assert.equal(matches.length, 2, 'greenhouse + default');
  assert.equal(matches[0].id, 'greenhouse');
  assert.equal(matches[1].id, 'default');
});

// ── 4. Real bundled YAMLs validate ────────────────────────────────────

await test('Real data/career/site-adapters/ — all 5 bundled YAMLs validate + load', async () => {
  _clearCache();
  const reg = await loadAdapters(DEFAULT_ADAPTERS_DIR);
  const ids = reg.adapters.map((a) => a.id).sort();
  assert.deepEqual(ids, ['ashby', 'greenhouse', 'lever'], '3 non-default adapters');
  assert.equal(reg.default.id, 'default');
  assert.ok(reg.common, '_common.yml loaded');
});

await test('Real bundled YAMLs: greenhouse URL → greenhouse', async () => {
  _clearCache();
  const reg = await loadAdapters(DEFAULT_ADAPTERS_DIR);
  assert.equal(
    detectSiteAdapter('https://boards.greenhouse.io/anthropic/jobs/123', reg).id,
    'greenhouse',
  );
  assert.equal(
    detectSiteAdapter('https://job-boards.greenhouse.io/stripe/jobs/456', reg).id,
    'greenhouse',
  );
  assert.equal(detectSiteAdapter('https://jobs.ashbyhq.com/openai/abc', reg).id, 'ashby');
  assert.equal(detectSiteAdapter('https://jobs.lever.co/coinbase/xyz', reg).id, 'lever');
  assert.equal(detectSiteAdapter('https://example.com/careers', reg).id, 'default');
});

// ── 5. Review-driven regression tests ──────────────────────────────────

await test('REVIEW C2: regex source > 256 chars rejected by compileAdapter', () => {
  const longSource = 'a'.repeat(257);
  const raw = SiteAdapterSchema.parse({
    name: 'X',
    id: 'x',
    detection: { url_patterns: [longSource] },
    flow: { type: 'single-step' },
  });
  assert.throws(() => compileAdapter(raw), /pattern length 257 exceeds cap 256/);
});

await test('REVIEW C3: stale cache after deleting non-newest file', async () => {
  _clearCache();
  const HIGH_PRIORITY = `name: High
id: high
priority: 200
detection:
  url_patterns:
    - "example\\\\.com"
flow:
  type: single-step
`;
  const dir = await makeTmpDir({
    'default.yml': MIN_DEFAULT_YML,
    'greenhouse.yml': MIN_GREENHOUSE_YML,
    'high.yml': HIGH_PRIORITY,
  });
  // Make sure high.yml is the newest, then delete greenhouse.yml.
  const highPath = path.join(dir, 'high.yml');
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(highPath, future, future);
  const first = await loadAdapters(dir);
  assert.equal(first.adapters.length, 2, 'high + greenhouse');

  await fs.unlink(path.join(dir, 'greenhouse.yml'));
  const second = await loadAdapters(dir);
  // Without C3 fix, cache key (max mtime) is unchanged → stale registry
  // still has greenhouse. With fix: signature differs → fresh load.
  assert.notEqual(first, second, 'cache invalidated after delete');
  assert.equal(second.adapters.length, 1, 'only high remains');
  assert.equal(second.adapters[0].id, 'high');
});

await test('REVIEW H1: cache key normalizes path (./data/x vs data/x)', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'default.yml': MIN_DEFAULT_YML,
  });
  const abs = await loadAdapters(dir);
  // Same dir via a relative-style path (resolved to same canonical)
  const rel = path.relative(process.cwd(), dir);
  const viaRelative = await loadAdapters(rel);
  assert.equal(abs, viaRelative, 'normalized cache returns identical registry');
});

await test('REVIEW H3: mergeCommonDefaults handles undefined/null flow without TypeError', () => {
  // Bypass schema validation — caller is the loader, which calls merge BEFORE parse.
  const adapterWithoutFlow = { name: 'X', id: 'x' };
  const common = { flow: { next_button: { name_hints: ['Next'] } } };
  const out = mergeCommonDefaults(adapterWithoutFlow, common);
  assert.equal(out, adapterWithoutFlow, 'no flow → returns unchanged');

  const adapterNullFlow = { name: 'X', id: 'x', flow: null };
  const out2 = mergeCommonDefaults(adapterNullFlow, common);
  assert.equal(out2, adapterNullFlow, 'null flow → returns unchanged');
});

await test('REVIEW H5: deep freeze prevents mutation of flow/controls/known_fields', () => {
  const raw = SiteAdapterSchema.parse({
    name: 'X',
    id: 'x',
    detection: { url_patterns: ['x\\.com'] },
    flow: { type: 'single-step', next_button: { selectors: ['#x'], name_hints: ['Next'] } },
    controls: { date_picker: { control_type: 'html5_date' } },
    known_fields: [{ label_pattern: '^name', class: 'hard', maps_to: 'identity.name' }],
  });
  const compiled = compileAdapter(raw);
  assert.throws(() => compiled.flow.next_button.selectors.push('boom'), TypeError);
  assert.throws(() => (compiled.controls.date_picker.control_type = 'flatpickr'), TypeError);
  assert.throws(() => compiled.known_fields.push({}), TypeError);
  assert.throws(() => (compiled.known_fields[0].class = 'open'), TypeError);
});

await test('REVIEW L1: known_field default confidence is medium (not high)', () => {
  const raw = SiteAdapterSchema.parse({
    name: 'X',
    id: 'x',
    detection: { url_patterns: ['x\\.com'] },
    flow: { type: 'single-step' },
    known_fields: [{ label_pattern: '^name', class: 'hard', maps_to: 'identity.name' }],
  });
  assert.equal(raw.known_fields[0].confidence, 'medium');
});

await test('REVIEW lever-yml: hostname-anchored pattern matches subdomains', async () => {
  _clearCache();
  const reg = await loadAdapters(DEFAULT_ADAPTERS_DIR);
  assert.equal(detectSiteAdapter('https://jobs.lever.co/x/abc', reg).id, 'lever');
  // Subdomain variant: hire.lever.co should also hit (hostname-anchored)
  assert.equal(detectSiteAdapter('https://hire.lever.co/y/def', reg).id, 'lever');
  // Bare lever.co (no subdomain) — anchored pattern (^|\.)lever\.co$ — host must match
  assert.equal(detectSiteAdapter('https://lever.co/z', reg).id, 'lever');
});

// ── Summary ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
