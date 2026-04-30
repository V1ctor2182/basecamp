#!/usr/bin/env node
// Smoke test for src/career/lib/jobSchema.mjs
// Run: node scripts/smoke-job-schema.mjs
// Exits 0 on all pass, 1 on first failure.

import assert from 'node:assert/strict';
import {
  JobSchema,
  SOURCE_TYPES,
  slugify,
  hashJobId,
  stripHtml,
  parseLocation,
  normalizeJob,
} from '../src/career/lib/jobSchema.mjs';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('PASS:', name);
    passed += 1;
  } catch (err) {
    console.error('FAIL:', name);
    console.error(err);
    process.exit(1);
  }
}

const validJob = {
  id: 'a1b2c3d4e5f6',
  source: { type: 'greenhouse', name: 'Anthropic GH', url: 'https://boards.greenhouse.io/anthropic' },
  company: 'Anthropic',
  role: 'Backend SDE',
  location: ['San Francisco', 'Remote'],
  url: 'https://example.com/job/123',
  description: 'Build distributed systems.',
  posted_at: '2026-04-15T00:00:00.000Z',
  scraped_at: '2026-04-30T12:00:00.000Z',
  comp_hint: { min: 180000, max: 240000, currency: 'USD', period: 'yr' },
  tags: ['Remote', 'Senior'],
  raw: { foo: 'bar' },
  schema_version: 1,
};

test('1. valid Job parse OK', () => {
  const out = JobSchema.parse(validJob);
  assert.equal(out.id, 'a1b2c3d4e5f6');
  assert.equal(out.source.type, 'greenhouse');
});

test('2. missing company → ZodError', () => {
  const bad = { ...validJob };
  delete bad.company;
  assert.throws(() => JobSchema.parse(bad));
});

test('3. unknown source.type rejected', () => {
  const bad = { ...validJob, source: { ...validJob.source, type: 'linkedin' } };
  assert.throws(() => JobSchema.parse(bad));
});

test('4. description=null OK', () => {
  const out = JobSchema.parse({ ...validJob, description: null });
  assert.equal(out.description, null);
});

test('5. comp_hint=null OK', () => {
  const out = JobSchema.parse({ ...validJob, comp_hint: null });
  assert.equal(out.comp_hint, null);
});

test('6. comp_hint.currency length != 3 rejected', () => {
  assert.throws(() =>
    JobSchema.parse({ ...validJob, comp_hint: { currency: 'USDD' } })
  );
});

test('7. hashJobId stable + 12 hex char', () => {
  const a = hashJobId('Anthropic', 'Backend SDE', 'greenhouse', 'gh-123');
  const b = hashJobId('Anthropic', 'Backend SDE', 'greenhouse', 'gh-123');
  assert.equal(a, b);
  assert.equal(a.length, 12);
  assert.match(a, /^[a-f0-9]{12}$/);
});

test('8. hashJobId case-insensitive on company/role', () => {
  const a = hashJobId('Anthropic', 'Backend SDE', 'greenhouse', 'gh-123');
  const b = hashJobId('anthropic', 'backend sde', 'greenhouse', 'gh-123');
  assert.equal(a, b);
});

test('9. parseLocation multi-separator + dedupe (case-insensitive)', () => {
  const out = parseLocation('NYC; New York / nyc | NYC');
  assert.deepEqual(out, ['NYC', 'New York']);
});

test('10. parseLocation empty input → []', () => {
  assert.deepEqual(parseLocation(''), []);
  assert.deepEqual(parseLocation(null), []);
  assert.deepEqual(parseLocation(undefined), []);
});

test('11. stripHtml decodes entities + strips tags', () => {
  const out = stripHtml('<p>Hello&amp; <br/>world</p>');
  assert.equal(out, 'Hello& world');
});

test('12. stripHtml(null) → null, stripHtml("") → ""', () => {
  assert.equal(stripHtml(null), null);
  assert.equal(stripHtml(undefined), null);
  assert.equal(stripHtml(''), '');
});

test('13. normalizeJob fills defaults (tags / schema_version / scraped_at)', () => {
  const partial = {
    id: hashJobId('Acme', 'Eng', 'manual', 'm1'),
    source: { type: 'manual', name: 'Manual paste', url: null },
    company: 'Acme',
    role: 'Eng',
    location: [],
    url: 'https://example.com/job/abc',
    description: null,
    posted_at: null,
    comp_hint: null,
    raw: null,
  };
  const out = normalizeJob(partial);
  assert.deepEqual(out.tags, []);
  assert.equal(out.schema_version, 1);
  assert.ok(typeof out.scraped_at === 'string' && out.scraped_at.length > 0);
  assert.doesNotThrow(() => new Date(out.scraped_at).toISOString());
});

test('14. posted_at non-ISO rejected', () => {
  assert.throws(() => JobSchema.parse({ ...validJob, posted_at: 'yesterday' }));
});

test('15. id format /^[a-f0-9]{12}$/ enforced', () => {
  assert.throws(() => JobSchema.parse({ ...validJob, id: 'XYZ' }));
});

test('16. slugify normalizes', () => {
  assert.equal(slugify('Anthropic, Inc.'), 'anthropic-inc');
  assert.equal(slugify('  --foo  '), 'foo');
  assert.equal(slugify(''), '');
});

test('17. SOURCE_TYPES enum has 7 entries', () => {
  assert.equal(SOURCE_TYPES.length, 7);
  assert.ok(SOURCE_TYPES.includes('manual'));
  assert.ok(!SOURCE_TYPES.includes('linkedin'));
});

console.log(`\n✅ All ${passed} smoke tests passed.`);
