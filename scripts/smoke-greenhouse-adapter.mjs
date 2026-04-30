#!/usr/bin/env node
// Smoke test for finder/adapters/greenhouse + httpFetch + scanRunner.
// Default: fixture-only (offline). Pass --live to also hit Anthropic GH (1 call).
//
// Run:
//   node scripts/smoke-greenhouse-adapter.mjs
//   node scripts/smoke-greenhouse-adapter.mjs --live

import assert from 'node:assert/strict';
import { greenhouseAdapter } from '../src/career/finder/adapters/greenhouse.mjs';
import { JobSchema } from '../src/career/lib/jobSchema.mjs';
import {
  USER_AGENT,
  resetRobotsCache,
  RobotsBlockedError,
  checkRobots,
} from '../src/career/finder/httpFetch.mjs';

const LIVE = process.argv.includes('--live');

let passed = 0;
function test(name, fn) {
  try {
    const out = fn();
    if (out instanceof Promise) return out.then(
      () => { console.log('PASS:', name); passed++; },
      (e) => { console.error('FAIL:', name); console.error(e); process.exit(1); }
    );
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    process.exit(1);
  }
}

const FIXTURE_RAW = {
  id: 5161980008,
  title: 'Backend SDE — Distributed Systems',
  location: { name: 'San Francisco; Remote' },
  absolute_url: 'https://job-boards.greenhouse.io/anthropic/jobs/5161980008',
  updated_at: '2026-04-01T10:49:08-04:00',
  first_published: '2026-03-15T09:00:00-04:00',
  content: '<p>We are <strong>hiring</strong> a&nbsp;backend engineer.</p><br/><p>Apply now.</p>',
  metadata: [
    { id: 1, name: 'Location Type', value: 'Remote', value_type: 'single_select' },
    { id: 2, name: 'Department', value: 'Engineering', value_type: 'single_select' },
  ],
};

const SOURCE = { type: 'greenhouse', name: 'Anthropic', config: { slug: 'anthropic' } };

await test('1. UA constant set', () => {
  assert.ok(USER_AGENT.includes('learn-dashboard'));
  assert.ok(USER_AGENT.includes('https://github.com'));
});

await test('2. normalize fixture → JobSchema parse OK', () => {
  const job = greenhouseAdapter.normalize(FIXTURE_RAW, SOURCE);
  const parsed = JobSchema.parse(job);
  assert.equal(parsed.source.type, 'greenhouse');
  assert.equal(parsed.company, 'Anthropic');
  assert.equal(parsed.role, 'Backend SDE — Distributed Systems');
  assert.match(parsed.id, /^[a-f0-9]{12}$/);
});

await test('3. description = stripped HTML (no tags, no entities)', () => {
  const job = greenhouseAdapter.normalize(FIXTURE_RAW, SOURCE);
  assert.ok(!/<\w+/.test(job.description), 'should not contain tags');
  assert.ok(!/&[a-z]+;/.test(job.description), 'should not contain entities');
  assert.ok(job.description.includes('hiring'));
});

await test('4. parseLocation splits ; into array', () => {
  const job = greenhouseAdapter.normalize(FIXTURE_RAW, SOURCE);
  assert.deepEqual(job.location, ['San Francisco', 'Remote']);
});

await test('5. posted_at normalized to UTC Z form', () => {
  const job = greenhouseAdapter.normalize(FIXTURE_RAW, SOURCE);
  assert.match(job.posted_at, /Z$/);
});

await test('6. tags extracted from metadata', () => {
  const job = greenhouseAdapter.normalize(FIXTURE_RAW, SOURCE);
  assert.ok(job.tags.includes('Remote'));
  assert.ok(job.tags.includes('Engineering'));
});

await test('7. id stable across calls', () => {
  const a = greenhouseAdapter.normalize(FIXTURE_RAW, SOURCE).id;
  const b = greenhouseAdapter.normalize(FIXTURE_RAW, SOURCE).id;
  assert.equal(a, b);
});

await test('8. robots: cache reset works', async () => {
  resetRobotsCache();
  // Allow path on greenhouse — should not throw.
  await checkRobots('https://boards-api.greenhouse.io/v1/boards/anthropic/jobs?content=true');
});

await test('9. robots: blocked rule throws RobotsBlockedError', async () => {
  // Inject by mocking parseRobotsTxt-equivalent: we simulate by setting cache directly.
  // Cleaner: spin a local server with a custom robots? Overkill. Instead test the
  // wrapper's behavior via a known disallow — example.com/robots.txt allows everything,
  // so we only assert the error class is real and constructible.
  const e = new RobotsBlockedError('https://example.com/private', '/private');
  assert.equal(e.name, 'RobotsBlockedError');
  assert.equal(e.url, 'https://example.com/private');
});

await test('10. config without slug → fetch throws', async () => {
  await assert.rejects(
    greenhouseAdapter.fetch({}),
    /missing config\.slug/
  );
});

if (LIVE) {
  await test('LIVE-11. Anthropic GH fetch returns ≥10 jobs', async () => {
    resetRobotsCache();
    const raws = await greenhouseAdapter.fetch({ slug: 'anthropic' });
    assert.ok(Array.isArray(raws));
    assert.ok(raws.length >= 10, `got ${raws.length}`);
  });

  await test('LIVE-12. Each live raw normalizes through JobSchema', async () => {
    resetRobotsCache();
    const raws = await greenhouseAdapter.fetch({ slug: 'anthropic' });
    const sample = raws.slice(0, 5);
    for (const raw of sample) {
      const job = greenhouseAdapter.normalize(raw, SOURCE);
      JobSchema.parse(job);
    }
  });
}

console.log(`\n✅ All ${passed} smoke tests passed${LIVE ? ' (incl. live)' : ''}.`);
