#!/usr/bin/env node
// Parametric smoke for all 3 ATS adapters: greenhouse / ashby / lever.
// Default: fixture-only (offline). --live also hits 1 real board per adapter.
//
// Run:
//   node scripts/smoke-ats-adapters.mjs
//   node scripts/smoke-ats-adapters.mjs --live

import assert from 'node:assert/strict';
import { greenhouseAdapter } from '../src/career/finder/adapters/greenhouse.mjs';
import { ashbyAdapter } from '../src/career/finder/adapters/ashby.mjs';
import { leverAdapter } from '../src/career/finder/adapters/lever.mjs';
import { JobSchema } from '../src/career/lib/jobSchema.mjs';
import { resetRobotsCache } from '../src/career/finder/httpFetch.mjs';

const LIVE = process.argv.includes('--live');

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

// ─── Fixtures ──────────────────────────────────────────────────────────
const GH_FIXTURE = {
  id: 5161980008,
  title: 'Backend SDE',
  location: { name: 'San Francisco; Remote' },
  absolute_url: 'https://job-boards.greenhouse.io/anthropic/jobs/5161980008',
  updated_at: '2026-04-01T10:49:08-04:00',
  first_published: '2026-03-15T09:00:00-04:00',
  content: '<p>We are <strong>hiring</strong>.</p>',
  metadata: [{ id: 1, name: 'Department', value: 'Engineering', value_type: 'single_select' }],
};
const GH_SOURCE = { type: 'greenhouse', name: 'Anthropic', config: { slug: 'anthropic' } };

const ASHBY_FIXTURE = {
  id: '8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3',
  title: 'TPM, Compute Infrastructure',
  location: 'San Francisco',
  secondaryLocations: [{ locationName: 'New York' }, 'Remote'],
  applyUrl: 'https://jobs.ashbyhq.com/openai/8fb1615c/application',
  jobUrl: 'https://jobs.ashbyhq.com/openai/8fb1615c',
  publishedAt: '2026-03-12T16:38:15.322+00:00',
  descriptionHtml: '<p>Build <em>compute</em>.</p>',
  department: 'Engineering',
  team: 'Compute',
  employmentType: 'FullTime',
  isRemote: false,
  workplaceType: 'OnSite',
};
const ASHBY_SOURCE = { type: 'ashby', name: 'OpenAI', config: { slug: 'openai' } };

const LEVER_FIXTURE = {
  id: '529e32e5-d849-498f-b313-29b6cc99e593',
  text: 'Account Executive — Fintech Named',
  categories: {
    commitment: 'Full-time',
    department: 'Sales',
    location: 'New York',
    team: 'Sales',
    allLocations: ['New York', 'San Francisco'],
  },
  hostedUrl: 'https://jobs.lever.co/plaid/529e32e5',
  applyUrl: 'https://jobs.lever.co/plaid/529e32e5/apply',
  createdAt: 1746060000000,
  descriptionPlain: 'We sell to fintechs.',
  salaryRange: { min: 180000, max: 240000, currency: 'USD', interval: 'year' },
  workplaceType: 'hybrid',
};
const LEVER_SOURCE = { type: 'lever', name: 'Plaid', config: { slug: 'plaid' } };

// ─── Greenhouse ────────────────────────────────────────────────────────
await test('GH-1. normalize → JobSchema parse OK', () => {
  const job = greenhouseAdapter.normalize(GH_FIXTURE, GH_SOURCE);
  JobSchema.parse(job);
  assert.equal(job.source.type, 'greenhouse');
  assert.equal(job.company, 'Anthropic');
});
await test('GH-2. description stripped HTML', () => {
  const job = greenhouseAdapter.normalize(GH_FIXTURE, GH_SOURCE);
  assert.ok(!/<\w+/.test(job.description));
});
await test('GH-3. posted_at UTC Z form', () => {
  const job = greenhouseAdapter.normalize(GH_FIXTURE, GH_SOURCE);
  assert.match(job.posted_at, /Z$/);
});

// ─── Ashby ─────────────────────────────────────────────────────────────
await test('ASHBY-1. normalize → JobSchema parse OK', () => {
  const job = ashbyAdapter.normalize(ASHBY_FIXTURE, ASHBY_SOURCE);
  JobSchema.parse(job);
  assert.equal(job.source.type, 'ashby');
});
await test('ASHBY-2. location merges primary + secondary', () => {
  const job = ashbyAdapter.normalize(ASHBY_FIXTURE, ASHBY_SOURCE);
  assert.deepEqual(job.location, ['San Francisco', 'New York', 'Remote']);
});
await test('ASHBY-3. tags include department/team/employmentType/workplaceType', () => {
  const job = ashbyAdapter.normalize(ASHBY_FIXTURE, ASHBY_SOURCE);
  for (const t of ['Engineering', 'Compute', 'FullTime', 'OnSite']) {
    assert.ok(job.tags.includes(t), `missing tag ${t}`);
  }
});
await test('ASHBY-4. publishedAt offset normalized to Z', () => {
  const job = ashbyAdapter.normalize(ASHBY_FIXTURE, ASHBY_SOURCE);
  assert.match(job.posted_at, /Z$/);
});
await test('ASHBY-5. isRemote=true adds Remote tag', () => {
  const job = ashbyAdapter.normalize({ ...ASHBY_FIXTURE, isRemote: true }, ASHBY_SOURCE);
  assert.ok(job.tags.includes('Remote'));
});
await test('ASHBY-6. fetch missing slug rejects', async () => {
  await assert.rejects(ashbyAdapter.fetch({}), /missing config\.slug/);
});

// ─── Lever ─────────────────────────────────────────────────────────────
await test('LEVER-1. normalize → JobSchema parse OK', () => {
  const job = leverAdapter.normalize(LEVER_FIXTURE, LEVER_SOURCE);
  JobSchema.parse(job);
  assert.equal(job.source.type, 'lever');
});
await test('LEVER-2. location dedupes (allLocations + categories.location)', () => {
  const job = leverAdapter.normalize(LEVER_FIXTURE, LEVER_SOURCE);
  assert.deepEqual(job.location, ['New York', 'San Francisco']);
});
await test('LEVER-3. createdAt unix-ms → ISO Z', () => {
  const job = leverAdapter.normalize(LEVER_FIXTURE, LEVER_SOURCE);
  assert.match(job.posted_at, /Z$/);
});
await test('LEVER-4. tags include commitment / dept / team / workplaceType', () => {
  const job = leverAdapter.normalize(LEVER_FIXTURE, LEVER_SOURCE);
  for (const t of ['Full-time', 'Sales', 'hybrid']) {
    assert.ok(job.tags.includes(t), `missing tag ${t}`);
  }
});
await test('LEVER-5. comp_hint extracted from salaryRange (year → yr)', () => {
  const job = leverAdapter.normalize(LEVER_FIXTURE, LEVER_SOURCE);
  assert.equal(job.comp_hint?.min, 180000);
  assert.equal(job.comp_hint?.max, 240000);
  assert.equal(job.comp_hint?.currency, 'USD');
  assert.equal(job.comp_hint?.period, 'yr');
});
await test('LEVER-6. salaryRange absent → comp_hint null', () => {
  const r = { ...LEVER_FIXTURE };
  delete r.salaryRange;
  const job = leverAdapter.normalize(r, LEVER_SOURCE);
  assert.equal(job.comp_hint, null);
});
await test('LEVER-7. fetch missing slug rejects', async () => {
  await assert.rejects(leverAdapter.fetch({}), /missing config\.slug/);
});

// ─── Live ──────────────────────────────────────────────────────────────
if (LIVE) {
  await test('LIVE-GH. Anthropic Greenhouse ≥ 10 jobs + Zod', async () => {
    resetRobotsCache();
    const raws = await greenhouseAdapter.fetch({ slug: 'anthropic' });
    assert.ok(raws.length >= 10);
    JobSchema.parse(greenhouseAdapter.normalize(raws[0], GH_SOURCE));
  });
  await test('LIVE-ASHBY. OpenAI Ashby ≥ 10 jobs + Zod', async () => {
    resetRobotsCache();
    const raws = await ashbyAdapter.fetch({ slug: 'openai' });
    assert.ok(raws.length >= 10);
    JobSchema.parse(ashbyAdapter.normalize(raws[0], ASHBY_SOURCE));
  });
  await test('LIVE-LEVER. Plaid Lever ≥ 10 jobs + Zod', async () => {
    resetRobotsCache();
    const raws = await leverAdapter.fetch({ slug: 'plaid' });
    assert.ok(raws.length >= 10);
    JobSchema.parse(leverAdapter.normalize(raws[0], LEVER_SOURCE));
  });
}

console.log(`\n✅ All ${passed} smoke tests passed${LIVE ? ' (incl. live)' : ''}.`);
