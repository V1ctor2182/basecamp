#!/usr/bin/env node
// Smoke for 07-applier/self-iteration/01-code-calibration m1:
// schema.mjs (Zod GroundTruthSchema) + loader.mjs (loadFixtures + per-dir
// signature cache + orphan detection) + capture.mjs scaffoldGroundTruthTemplate.
//
// Pure-Node — uses os.tmpdir() for malformed/orphan/cache tests so we
// don't touch the real data/career/eval-fixtures/ shipped seeds. The
// final block validates the 3 shipped seed fixtures parse end-to-end.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import {
  GroundTruthSchema,
  validateGroundTruth,
} from '../src/career/eval/fixtures/schema.mjs';
import {
  loadFixtures,
  loadFixture,
  _clearCache,
  DEFAULT_FIXTURES_DIR,
  HTML_EXT,
  TRUTH_EXT,
} from '../src/career/eval/fixtures/loader.mjs';
import { scaffoldGroundTruthTemplate } from '../src/career/eval/fixtures/capture.mjs';

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

// ── Fixtures (in-memory) ───────────────────────────────────────────────

const VALID_HTML = `<!doctype html><html><body><form><label>X</label><input/></form></body></html>`;

const VALID_TRUTH_YML = `url: "https://boards.example.com/x/jobs/1"
captured_at: 2026-05-18
vendor: greenhouse
must_detect:
  - { role: textbox, name: "First Name", required: true }
must_not_detect:
  - { name: "Privacy", reason: "footer" }
`;

async function makeTmpDir(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-fixtures-smoke-'));
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), body);
  }
  return dir;
}

// ── 1. Schema ──────────────────────────────────────────────────────────

await test('GroundTruthSchema: minimal valid ground truth accepted', () => {
  const result = GroundTruthSchema.parse({
    url: 'https://boards.example.com/x/jobs/1',
    captured_at: '2026-05-18',
    vendor: 'greenhouse',
    must_detect: [{ role: 'textbox', name: 'First Name' }],
  });
  assert.equal(result.vendor, 'greenhouse');
  assert.equal(result.must_detect.length, 1);
  assert.deepEqual(result.must_not_detect, []); // default
});

await test('GroundTruthSchema: accepts full ISO datetime', () => {
  const result = GroundTruthSchema.parse({
    url: 'https://x.example.com/1',
    captured_at: '2026-05-18T10:00:00-07:00',
    vendor: 'lever',
    must_detect: [{ role: 'button', name: 'Submit' }],
  });
  assert.equal(result.captured_at, '2026-05-18T10:00:00-07:00');
});

await test('GroundTruthSchema: rejects unknown top-level keys (strict)', () => {
  assert.throws(
    () =>
      GroundTruthSchema.parse({
        url: 'https://x.example.com/1',
        captured_at: '2026-05-18',
        vendor: 'x',
        must_detect: [{ role: 'textbox', name: 'A' }],
        bogus_field: 42,
      }),
    /Unrecognized key|bogus_field/,
  );
});

await test('GroundTruthSchema: rejects unknown key in must_detect item (strict)', () => {
  assert.throws(
    () =>
      GroundTruthSchema.parse({
        url: 'https://x.example.com/1',
        captured_at: '2026-05-18',
        vendor: 'x',
        must_detect: [{ role: 'textbox', name: 'A', extra: 'no' }],
      }),
    /Unrecognized key|extra/,
  );
});

await test('GroundTruthSchema: vendor must be kebab-case slug', () => {
  assert.throws(
    () =>
      GroundTruthSchema.parse({
        url: 'https://x.example.com/1',
        captured_at: '2026-05-18',
        vendor: 'Green House', // space + capital
        must_detect: [{ role: 'textbox', name: 'A' }],
      }),
    /kebab-case/,
  );
});

await test('GroundTruthSchema: captured_at rejects free-form text', () => {
  assert.throws(
    () =>
      GroundTruthSchema.parse({
        url: 'https://x.example.com/1',
        captured_at: 'yesterday',
        vendor: 'x',
        must_detect: [{ role: 'textbox', name: 'A' }],
      }),
    /captured_at|YYYY-MM-DD|datetime/i,
  );
});

await test('GroundTruthSchema: must_detect requires ≥ 1 item', () => {
  assert.throws(
    () =>
      GroundTruthSchema.parse({
        url: 'https://x.example.com/1',
        captured_at: '2026-05-18',
        vendor: 'x',
        must_detect: [],
      }),
    /must_detect|at least 1|>=\s*1/i,
  );
});

await test('GroundTruthSchema: must_not_detect requires reason field', () => {
  assert.throws(
    () =>
      GroundTruthSchema.parse({
        url: 'https://x.example.com/1',
        captured_at: '2026-05-18',
        vendor: 'x',
        must_detect: [{ role: 'textbox', name: 'A' }],
        must_not_detect: [{ name: 'Privacy' }], // missing reason
      }),
    /reason/i,
  );
});

await test('GroundTruthSchema: rejects non-URL string', () => {
  assert.throws(
    () =>
      GroundTruthSchema.parse({
        url: 'not-a-url',
        captured_at: '2026-05-18',
        vendor: 'x',
        must_detect: [{ role: 'textbox', name: 'A' }],
      }),
    /url/i,
  );
});

await test('validateGroundTruth: formats error with filename + paths', () => {
  assert.throws(
    () => validateGroundTruth({ vendor: 'x' }, 'broken.truth.yml'),
    (err) =>
      err.message.includes('broken.truth.yml') &&
      err.message.includes('schema validation failed'),
  );
});

// ── 2. Loader: happy path ──────────────────────────────────────────────

await test('loadFixtures: single valid pair → registry of 1', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'greenhouse-x.html': VALID_HTML,
    'greenhouse-x.truth.yml': VALID_TRUTH_YML,
  });
  const reg = await loadFixtures(dir);
  assert.equal(reg.fixtures.length, 1);
  const fx = reg.fixtures[0];
  assert.equal(fx.id, 'greenhouse-x');
  assert.equal(fx.vendor, 'greenhouse');
  assert.equal(fx.html, VALID_HTML);
  assert.equal(fx.truth.must_detect.length, 1);
});

await test('loadFixtures: multiple pairs sorted by id alpha', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'zebra-z.html': VALID_HTML,
    'zebra-z.truth.yml': VALID_TRUTH_YML,
    'alpha-a.html': VALID_HTML,
    'alpha-a.truth.yml': VALID_TRUTH_YML.replace('greenhouse', 'lever'),
  });
  const reg = await loadFixtures(dir);
  assert.equal(reg.fixtures.length, 2);
  assert.equal(reg.fixtures[0].id, 'alpha-a');
  assert.equal(reg.fixtures[1].id, 'zebra-z');
});

await test('loadFixtures: ignores non-fixture files (README, .gitkeep)', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'greenhouse-x.html': VALID_HTML,
    'greenhouse-x.truth.yml': VALID_TRUTH_YML,
    'README.md': '# fixtures',
    '.gitkeep': '',
    'notes.txt': 'something',
  });
  const reg = await loadFixtures(dir);
  assert.equal(reg.fixtures.length, 1);
});

// ── 3. Loader: error paths ─────────────────────────────────────────────

await test('loadFixtures: orphan HTML (no matching truth.yml) → throws', async () => {
  _clearCache();
  const dir = await makeTmpDir({ 'greenhouse-x.html': VALID_HTML });
  await assert.rejects(loadFixtures(dir), /orphan|HTML without truth/i);
});

await test('loadFixtures: orphan truth.yml (no matching HTML) → throws', async () => {
  _clearCache();
  const dir = await makeTmpDir({ 'greenhouse-x.truth.yml': VALID_TRUTH_YML });
  await assert.rejects(loadFixtures(dir), /orphan|truth without HTML/i);
});

await test('loadFixtures: malformed YAML → throws with filename', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'greenhouse-x.html': VALID_HTML,
    'greenhouse-x.truth.yml': '!!! not valid yaml :::: \n  - [unterminated',
  });
  await assert.rejects(loadFixtures(dir), /greenhouse-x.truth.yml|failed to parse/i);
});

await test('loadFixtures: schema-invalid truth → throws with filename', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'greenhouse-x.html': VALID_HTML,
    'greenhouse-x.truth.yml': `url: "https://x.example.com/1"
captured_at: 2026-05-18
vendor: greenhouse
must_detect: []   # violates min(1)
`,
  });
  await assert.rejects(loadFixtures(dir), /greenhouse-x.truth.yml|must_detect/i);
});

await test('loadFixtures: YAML that parses to non-object → throws', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'greenhouse-x.html': VALID_HTML,
    'greenhouse-x.truth.yml': '- just a list',
  });
  await assert.rejects(loadFixtures(dir), /did not parse to an object/i);
});

// ── 4. Loader: cache invalidation ──────────────────────────────────────

await test('loadFixtures: signature includes file size — content change invalidates cache', async () => {
  // REVIEW M3 (adv) fix: previous version relied on fs.utimes(future)
  // which is non-portable across Docker overlay / tmpfs filesystems
  // that clamp mtimes. The signature now includes size, so a content
  // change of different length deterministically alters the signature.
  _clearCache();
  const dir = await makeTmpDir({
    'greenhouse-x.html': VALID_HTML,
    'greenhouse-x.truth.yml': VALID_TRUTH_YML,
  });
  const reg1 = await loadFixtures(dir);
  // Rewrite with a longer body — vendor changed + extra padding line
  // ensures the byte count differs even if mtime resolution is coarse.
  const modified =
    VALID_TRUTH_YML.replace('greenhouse', 'lever') +
    '# extra padding for size-derived signature\n';
  await fs.writeFile(path.join(dir, 'greenhouse-x.truth.yml'), modified);
  const reg2 = await loadFixtures(dir);
  assert.notEqual(reg1.signature, reg2.signature);
  assert.equal(reg2.fixtures[0].vendor, 'lever');
});

await test('loadFixtures: signature cache invalidates on file delete', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'a.html': VALID_HTML,
    'a.truth.yml': VALID_TRUTH_YML,
    'b.html': VALID_HTML,
    'b.truth.yml': VALID_TRUTH_YML,
  });
  const reg1 = await loadFixtures(dir);
  assert.equal(reg1.fixtures.length, 2);
  // Delete a.html + a.truth.yml — naive max-mtime cache would not notice
  await fs.unlink(path.join(dir, 'a.html'));
  await fs.unlink(path.join(dir, 'a.truth.yml'));
  const reg2 = await loadFixtures(dir);
  assert.equal(reg2.fixtures.length, 1);
  assert.equal(reg2.fixtures[0].id, 'b');
});

await test('loadFixtures: same signature → cached registry returned (identity)', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'x.html': VALID_HTML,
    'x.truth.yml': VALID_TRUTH_YML,
  });
  const reg1 = await loadFixtures(dir);
  const reg2 = await loadFixtures(dir);
  assert.equal(reg1, reg2, 'cached registry should be same object');
});

// ── 5. loadFixture(id) ─────────────────────────────────────────────────

await test('loadFixture: by id finds the fixture', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'x.html': VALID_HTML,
    'x.truth.yml': VALID_TRUTH_YML,
  });
  const fx = await loadFixture('x', dir);
  assert.equal(fx.id, 'x');
});

await test('loadFixture: unknown id throws', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'x.html': VALID_HTML,
    'x.truth.yml': VALID_TRUTH_YML,
  });
  await assert.rejects(loadFixture('nope', dir), /nope.*not found/i);
});

// ── 6. scaffoldGroundTruthTemplate ─────────────────────────────────────

await test('scaffoldGroundTruthTemplate: emits valid YAML with required fields', () => {
  const out = scaffoldGroundTruthTemplate({
    url: 'https://boards.example.com/x/jobs/1',
    vendor: 'greenhouse',
  });
  // Use CORE_SCHEMA to match loader behavior — bare YAML dates would
  // otherwise be coerced to Date and fail the regex match.
  const parsed = yaml.load(out, { schema: yaml.CORE_SCHEMA });
  assert.equal(parsed.url, 'https://boards.example.com/x/jobs/1');
  assert.equal(parsed.vendor, 'greenhouse');
  // captured_at should default to today's YYYY-MM-DD
  assert.match(parsed.captured_at, /^\d{4}-\d{2}-\d{2}$/);
});

await test('scaffoldGroundTruthTemplate: includes page_type when provided', () => {
  const out = scaffoldGroundTruthTemplate({
    url: 'https://x.example.com/1',
    vendor: 'workday',
    page_type: 'review',
  });
  assert.match(out, /page_type: review/);
});

await test('scaffoldGroundTruthTemplate: rejects missing url', () => {
  assert.throws(() => scaffoldGroundTruthTemplate({ vendor: 'x' }), /url required/);
});

await test('scaffoldGroundTruthTemplate: rejects missing vendor', () => {
  assert.throws(
    () => scaffoldGroundTruthTemplate({ url: 'https://x.example.com/1' }),
    /vendor required/,
  );
});

// ── 6.5 Review regression tests ────────────────────────────────────────

await test('REVIEW H4 (adv): captured_at rejects impossible calendar dates', () => {
  // 2026-13-45 matched the bare regex pre-fix; Date.UTC roundtrip catches it.
  assert.throws(
    () =>
      GroundTruthSchema.parse({
        url: 'https://x.example.com/1',
        captured_at: '2026-13-45',
        vendor: 'x',
        must_detect: [{ role: 'textbox', name: 'A' }],
      }),
    /captured_at|out-of-range/i,
  );
});

await test('REVIEW H4 (adv): captured_at rejects Feb 31', () => {
  assert.throws(
    () =>
      GroundTruthSchema.parse({
        url: 'https://x.example.com/1',
        captured_at: '2026-02-31',
        vendor: 'x',
        must_detect: [{ role: 'textbox', name: 'A' }],
      }),
    /captured_at|out-of-range/i,
  );
});

await test('REVIEW H3 (adv): name rejects RTL-override character', () => {
  assert.throws(
    () =>
      GroundTruthSchema.parse({
        url: 'https://x.example.com/1',
        captured_at: '2026-05-18',
        vendor: 'x',
        must_detect: [{ role: 'textbox', name: 'Email‮Evil' }],
      }),
    /bidi-override|zero-width|BOM/i,
  );
});

await test('REVIEW H3 (adv): name rejects zero-width space', () => {
  assert.throws(
    () =>
      GroundTruthSchema.parse({
        url: 'https://x.example.com/1',
        captured_at: '2026-05-18',
        vendor: 'x',
        must_detect: [{ role: 'textbox', name: 'Email​Trap' }],
      }),
    /bidi-override|zero-width|BOM/i,
  );
});

await test('REVIEW M7 (Plan) / C1 (adv): url rejects file:// scheme', () => {
  assert.throws(
    () =>
      GroundTruthSchema.parse({
        url: 'file:///etc/passwd',
        captured_at: '2026-05-18',
        vendor: 'x',
        must_detect: [{ role: 'textbox', name: 'A' }],
      }),
    /http or https/i,
  );
});

await test('REVIEW M7 (Plan): url rejects javascript: scheme', () => {
  assert.throws(
    () =>
      GroundTruthSchema.parse({
        url: 'javascript:alert(1)',
        captured_at: '2026-05-18',
        vendor: 'x',
        must_detect: [{ role: 'textbox', name: 'A' }],
      }),
    /url|invalid|http or https/i,
  );
});

await test('REVIEW M6 (adv): loadFixtures rejects symlinked entries', async () => {
  _clearCache();
  const dir = await makeTmpDir({
    'real.html': VALID_HTML,
    'real.truth.yml': VALID_TRUTH_YML,
  });
  // Create a symlink {linked.truth.yml} pointing at the real one — loader
  // should refuse to follow it regardless of pair-completeness.
  try {
    await fs.symlink(path.join(dir, 'real.truth.yml'), path.join(dir, 'linked.truth.yml'));
  } catch {
    return; // platforms without symlink permission (Windows non-admin) — skip
  }
  await assert.rejects(loadFixtures(dir), /symlinked entries are not permitted/);
});

await test('REVIEW H1 (Plan + adv): signature derives from same readdir as file list', async () => {
  // Regression: pre-fix _dirSignature ran its own readdir + the loader
  // ran a second one, so the cache could store a registry whose file
  // set didn't match its signature. After fix, a cache hit guarantees
  // an exact match to current disk state.
  _clearCache();
  const dir = await makeTmpDir({
    'a.html': VALID_HTML,
    'a.truth.yml': VALID_TRUTH_YML,
  });
  const reg1 = await loadFixtures(dir);
  const reg2 = await loadFixtures(dir);
  assert.equal(reg1, reg2, 'identity must hold under repeat load on unchanged dir');
  assert.equal(reg1.signature, reg2.signature);
});

// ── 7. Shipped seed fixtures ───────────────────────────────────────────

await test('shipped fixtures: loadFixtures(DEFAULT_FIXTURES_DIR) returns ≥ 3', async () => {
  _clearCache();
  const reg = await loadFixtures(DEFAULT_FIXTURES_DIR);
  assert.ok(reg.fixtures.length >= 3, `expected ≥ 3 fixtures, got ${reg.fixtures.length}`);
});

await test('shipped fixtures: greenhouse-anthropic loads + has Submit Application button', async () => {
  _clearCache();
  const fx = await loadFixture('greenhouse-anthropic');
  assert.equal(fx.vendor, 'greenhouse');
  const submit = fx.truth.must_detect.find((m) => m.name === 'Submit Application');
  assert.ok(submit, 'must_detect should include Submit Application');
  assert.equal(submit.role, 'button');
});

await test('shipped fixtures: lever-stripe loads + has radio + checkbox + consent', async () => {
  _clearCache();
  const fx = await loadFixture('lever-stripe');
  assert.equal(fx.vendor, 'lever');
  assert.ok(fx.truth.must_detect.some((m) => m.role === 'radio'));
  assert.ok(fx.truth.must_detect.some((m) => m.role === 'checkbox'));
});

await test('shipped fixtures: custom-acme loads + vendor=custom', async () => {
  _clearCache();
  const fx = await loadFixture('custom-acme');
  assert.equal(fx.vendor, 'custom');
});

// ── 8. captureFromUrl (validation paths — no Playwright launched) ──────

await test('REVIEW C1 (adv): captureFromUrl rejects file:// URL pre-browser', async () => {
  const { captureFromUrl } = await import('../src/career/eval/fixtures/capture.mjs');
  await assert.rejects(
    captureFromUrl({ url: 'file:///etc/passwd', vendor: 'greenhouse', slug: 'pwn' }),
    /protocol|not allowed|http\(s\)/i,
  );
});

await test('REVIEW C1 (adv): captureFromUrl rejects javascript: URL pre-browser', async () => {
  const { captureFromUrl } = await import('../src/career/eval/fixtures/capture.mjs');
  await assert.rejects(
    captureFromUrl({ url: 'javascript:alert(1)', vendor: 'x', slug: 'y' }),
    /protocol|not allowed|http\(s\)/i,
  );
});

await test('REVIEW C2 (adv): captureFromUrl rejects page_type with newline', async () => {
  const { captureFromUrl } = await import('../src/career/eval/fixtures/capture.mjs');
  await assert.rejects(
    captureFromUrl({
      url: 'https://x.example.com/1',
      vendor: 'x',
      slug: 'y',
      page_type: 'review\nrm: -rf',
    }),
    /page_type.*kebab-case/i,
  );
});

await test('captureFromUrl: vendor must be kebab-case (path traversal guard)', async () => {
  const { captureFromUrl } = await import('../src/career/eval/fixtures/capture.mjs');
  await assert.rejects(
    captureFromUrl({ url: 'https://x.example.com/1', vendor: '../etc', slug: 'y' }),
    /vendor.*kebab-case/i,
  );
});

await test('captureFromUrl: slug must be kebab-case (path traversal guard)', async () => {
  const { captureFromUrl } = await import('../src/career/eval/fixtures/capture.mjs');
  await assert.rejects(
    captureFromUrl({ url: 'https://x.example.com/1', vendor: 'x', slug: '../../etc/passwd' }),
    /slug.*kebab-case/i,
  );
});

await test('shipped fixtures: every must_detect has role + name; every must_not_detect has reason', async () => {
  _clearCache();
  const reg = await loadFixtures(DEFAULT_FIXTURES_DIR);
  for (const fx of reg.fixtures) {
    for (const m of fx.truth.must_detect) {
      assert.ok(typeof m.role === 'string' && m.role.length > 0, `${fx.id}: must_detect.role missing`);
      assert.ok(typeof m.name === 'string' && m.name.length > 0, `${fx.id}: must_detect.name missing`);
    }
    for (const m of fx.truth.must_not_detect) {
      assert.ok(typeof m.reason === 'string' && m.reason.length > 0, `${fx.id}: must_not_detect.reason missing`);
    }
  }
});

// ── Wrap-up ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
