#!/usr/bin/env node
// Smoke for previewHardFilter (m3 dry-run). Direct module call — no HTTP.

import assert from 'node:assert/strict';

import { previewHardFilter, RULE_ORDER } from '../src/career/finder/dryRun.mjs';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    process.exit(1);
  }
}

function makeJob(over = {}) {
  return {
    id: '0123456789ab',
    source: { type: 'greenhouse', name: 'Anthropic', url: null },
    company: 'Anthropic',
    role: 'Software Engineer',
    location: ['San Francisco, CA'],
    url: 'https://example.com/job',
    posted_at: null,
    description: null,
    comp_hint: null,
    ...over,
  };
}

// ── Empty / shape ─────────────────────────────────────────────────────
test('empty jobs[] → all zeros + breakdown has 9 rules in fixed order', () => {
  const r = previewHardFilter({ hard_filters: {} }, null, []);
  assert.equal(r.total_jobs, 0);
  assert.equal(r.would_drop, 0);
  assert.equal(r.would_pass, 0);
  assert.equal(r.breakdown.length, 9);
  assert.deepEqual(r.breakdown.map((b) => b.rule), RULE_ORDER);
  for (const b of r.breakdown) assert.equal(b.drops, 0);
});

test('response shape has no new_drops field (removed — semantically dead against kept-only pipeline)', () => {
  const r = previewHardFilter({ hard_filters: {} }, { hard_filters: {} }, []);
  assert.equal('new_drops' in r, false);
});

test('null/undefined jobs treated as empty', () => {
  const r1 = previewHardFilter({ hard_filters: {} }, null, null);
  const r2 = previewHardFilter({ hard_filters: {} }, null, undefined);
  assert.equal(r1.total_jobs, 0);
  assert.equal(r2.total_jobs, 0);
});

test('no hard_filters at all → keeps everyone', () => {
  const jobs = [makeJob(), makeJob({ id: 'b' }), makeJob({ id: 'c' })];
  const r = previewHardFilter({}, null, jobs);
  assert.equal(r.total_jobs, 3);
  assert.equal(r.would_drop, 0);
  assert.equal(r.would_pass, 3);
});

// ── Single rule counts ────────────────────────────────────────────────
test('company_blocklist drops matching company, breakdown reflects it', () => {
  const jobs = [
    makeJob({ id: 'a', company: 'Palantir' }),
    makeJob({ id: 'b', company: 'Anthropic' }),
    makeJob({ id: 'c', company: 'Palantir Inc' }),
    makeJob({ id: 'd', company: 'Stripe' }),
  ];
  const r = previewHardFilter(
    { hard_filters: { company_blocklist: ['Palantir'] } },
    null,
    jobs
  );
  assert.equal(r.total_jobs, 4);
  assert.equal(r.would_drop, 2);
  assert.equal(r.would_pass, 2);
  const byRule = Object.fromEntries(r.breakdown.map((b) => [b.rule, b.drops]));
  assert.equal(byRule.company_blocklist, 2);
  assert.equal(byRule.title_blocklist, 0);
});

test('title_blocklist + company_blocklist tally to correct rules', () => {
  const jobs = [
    makeJob({ id: 'a', company: 'Palantir', role: 'Software Engineer' }),
    makeJob({ id: 'b', company: 'Stripe', role: 'Embedded Engineer' }),
    makeJob({ id: 'c', company: 'Stripe', role: 'Backend Engineer' }),
  ];
  const r = previewHardFilter(
    {
      hard_filters: {
        company_blocklist: ['Palantir'],
        title_blocklist: ['Embedded'],
      },
    },
    null,
    jobs
  );
  assert.equal(r.would_drop, 2);
  const byRule = Object.fromEntries(r.breakdown.map((b) => [b.rule, b.drops]));
  assert.equal(byRule.company_blocklist, 1);
  assert.equal(byRule.title_blocklist, 1);
});

// ── Short-circuit accounting ──────────────────────────────────────────
test('rule order short-circuit: source_filter wins over company_blocklist', () => {
  const jobs = [
    makeJob({
      id: 'a',
      source: { type: 'linkedin', name: 'LinkedIn', url: null },
      company: 'Palantir',
    }),
  ];
  const r = previewHardFilter(
    {
      hard_filters: {
        source_filter: { blocked_sources: ['linkedin'] },
        company_blocklist: ['Palantir'],
      },
    },
    null,
    jobs
  );
  assert.equal(r.would_drop, 1);
  const byRule = Object.fromEntries(r.breakdown.map((b) => [b.rule, b.drops]));
  // Earlier rule wins; later rule must NOT also count this job.
  assert.equal(byRule.source_filter, 1);
  assert.equal(byRule.company_blocklist, 0);
});

// ── Conservative drop semantics (carried from hardFilter) ─────────────
test('comp_floor currency mismatch → keep (conservative)', () => {
  const jobs = [
    makeJob({
      id: 'a',
      comp_hint: { min: 50000, max: 80000, currency: 'EUR' },
    }),
  ];
  const r = previewHardFilter(
    { hard_filters: { comp_floor: { base_min: 150000, currency: 'USD' } } },
    null,
    jobs
  );
  assert.equal(r.would_drop, 0);
});

test('jd_text_blocklist with description=null → keep (defer post-enrich)', () => {
  const jobs = [makeJob({ id: 'a', description: null })];
  const r = previewHardFilter(
    { hard_filters: { jd_text_blocklist: ['No sponsorship'] } },
    null,
    jobs
  );
  assert.equal(r.would_drop, 0);
});

// ── savedPrefs argument is accepted but ignored (kept-only pipeline) ─
test('savedPrefs is accepted but does not change result (forward-compat slot)', () => {
  const jobs = [
    makeJob({ id: 'a', company: 'Palantir' }),
    makeJob({ id: 'b', company: 'Oracle' }),
  ];
  const current = { hard_filters: { company_blocklist: ['Palantir', 'Oracle'] } };
  const withSaved = previewHardFilter(current, { hard_filters: { company_blocklist: ['Palantir'] } }, jobs);
  const withoutSaved = previewHardFilter(current, null, jobs);
  assert.equal(withSaved.would_drop, withoutSaved.would_drop);
  assert.equal(withSaved.would_pass, withoutSaved.would_pass);
});

// Robustness: malformed prefs body shapes (form drafts) shouldn't crash.
test('non-array blocked_sources (string) → asArr coerces to no-op, no crash', () => {
  const jobs = [makeJob({ source: { type: 'linkedin', name: 'LinkedIn' } })];
  const r = previewHardFilter(
    { hard_filters: { source_filter: { blocked_sources: 'linkedin' } } },
    null,
    jobs
  );
  assert.equal(r.total_jobs, 1);
  assert.equal(r.would_drop, 0);
});

test('hard_filters is a non-object value → no-op, all kept', () => {
  const jobs = [makeJob(), makeJob({ id: 'b' })];
  const r = previewHardFilter({ hard_filters: 'lol' }, null, jobs);
  assert.equal(r.total_jobs, 2);
  assert.equal(r.would_drop, 0);
});

// ── breakdown is order-stable across previews ─────────────────────────
test('breakdown preserves RULE_ORDER even when only late rules fire', () => {
  const jobs = [makeJob({ id: 'a', description: 'No sponsorship.' })];
  const r = previewHardFilter(
    { hard_filters: { jd_text_blocklist: ['No sponsorship'] } },
    null,
    jobs
  );
  assert.deepEqual(r.breakdown.map((b) => b.rule), RULE_ORDER);
  const byRule = Object.fromEntries(r.breakdown.map((b) => [b.rule, b.drops]));
  assert.equal(byRule.jd_text_blocklist, 1);
});

console.log(`\n${passed} assertions passed`);
