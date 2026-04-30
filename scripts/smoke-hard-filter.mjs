#!/usr/bin/env node
// Smoke for matchUtils + hardFilter.

import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { compileMatcher } from '../src/career/finder/matchUtils.mjs';
import {
  applyHardFilter,
  applyHardFilterBatch,
  archiveDropped,
  extractSeniority,
} from '../src/career/finder/hardFilter.mjs';

let passed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r.then(
        () => { console.log('PASS:', name); passed++; },
        (e) => { console.error('FAIL:', name); console.error(e); process.exit(1); }
      );
    }
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
    url: 'https://example.com/job/1',
    description: 'Build AI safely.',
    posted_at: new Date().toISOString(),
    scraped_at: new Date().toISOString(),
    comp_hint: null,
    tags: [],
    raw: null,
    schema_version: 1,
    ...over,
  };
}

const BASE_PREFS = {
  hard_filters: {
    source_filter: { blocked_sources: [] },
    company_blocklist: [],
    title_blocklist: [],
    title_allowlist: [],
    location: { allowed_countries: [], allowed_cities: [], disallowed_countries: [] },
    seniority: { allowed: [] },
    posted_within_days: 0,
    comp_floor: { currency: 'USD' },
    jd_text_blocklist: [],
  },
};

// ─── matchUtils ────────────────────────────────────────────────────────
await test('matchUtils-1. empty list → no-op matcher', () => {
  const m = compileMatcher([], 'contains');
  assert.equal(m('anything'), null);
});

await test('matchUtils-2. contains is case-insensitive by default', () => {
  const m = compileMatcher(['Embedded'], 'contains');
  assert.equal(m('we hire embedded engineers'), 'Embedded');
  assert.equal(m('software engineer'), null);
});

await test('matchUtils-3. contains case-sensitive when requested', () => {
  const m = compileMatcher(['Embedded'], 'contains', true);
  assert.equal(m('embedded'), null);
  assert.equal(m('Embedded'), 'Embedded');
});

await test('matchUtils-4. whole_word respects \\b', () => {
  const m = compileMatcher(['SDE'], 'whole_word');
  assert.equal(m('SDE 2 role'), 'SDE');
  assert.equal(m('SDEX something'), null);
});

await test('matchUtils-5. regex mode with valid pattern', () => {
  const m = compileMatcher(['^Senior\\b'], 'regex');
  assert.equal(m('Senior Engineer'), '^Senior\\b');
  assert.equal(m('Junior Senior helper'), null);
});

await test('matchUtils-6. bad regex pattern is skipped (warns)', () => {
  const orig = console.warn; let warned = 0; console.warn = () => { warned++; };
  try {
    const m = compileMatcher(['valid', '[unclosed'], 'regex');
    assert.equal(m('this is valid text'), 'valid');
    assert.ok(warned >= 1);
  } finally { console.warn = orig; }
});

await test('matchUtils-7. unknown mode falls back to contains (warns)', () => {
  const orig = console.warn; let warned = 0; console.warn = () => { warned++; };
  try {
    const m = compileMatcher(['foo'], 'something-bad');
    assert.equal(m('foo bar'), 'foo');
    assert.ok(warned >= 1);
  } finally { console.warn = orig; }
});

// ─── extractSeniority ──────────────────────────────────────────────────
await test('seniority-1. Senior detected', () => {
  assert.equal(extractSeniority('Senior Software Engineer'), 'Senior');
});
await test('seniority-2. Sr. → Senior', () => {
  assert.equal(extractSeniority('Sr. Backend Engineer'), 'Senior');
});
await test('seniority-3. IC4 detected', () => {
  assert.equal(extractSeniority('Backend Engineer (IC4)'), 'Ic4');
});
await test('seniority-4. None found → null', () => {
  assert.equal(extractSeniority('Backend Engineer'), null);
});

// ─── Rule 1: source_filter ─────────────────────────────────────────────
await test('rule-1.a source.type in blocklist → drop', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    source_filter: { blocked_sources: ['greenhouse'] } } };
  const r = applyHardFilter(makeJob(), prefs);
  assert.equal(r.kept, false);
  assert.equal(r.rule_id, 'source_filter');
  assert.equal(r.matched_value, 'greenhouse');
});
await test('rule-1.b source.type not in blocklist → keep', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    source_filter: { blocked_sources: ['linkedin'] } } };
  assert.equal(applyHardFilter(makeJob(), prefs).kept, true);
});

// ─── Rule 2: company_blocklist ─────────────────────────────────────────
await test('rule-2.a company match → drop', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    company_blocklist: ['Palantir', 'Anthropic'] } };
  const r = applyHardFilter(makeJob(), prefs);
  assert.equal(r.kept, false);
  assert.equal(r.rule_id, 'company_blocklist');
  assert.equal(r.matched_value, 'Anthropic');
});
await test('rule-2.b company miss → keep', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    company_blocklist: ['Palantir'] } };
  assert.equal(applyHardFilter(makeJob(), prefs).kept, true);
});

// ─── Rule 3: title_blocklist ───────────────────────────────────────────
await test('rule-3.a role match → drop', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    title_blocklist: ['Embedded', 'Firmware'] } };
  const r = applyHardFilter(makeJob({ role: 'Senior Embedded Engineer' }), prefs);
  assert.equal(r.kept, false);
  assert.equal(r.rule_id, 'title_blocklist');
});
await test('rule-3.b role miss → keep', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    title_blocklist: ['Embedded'] } };
  assert.equal(applyHardFilter(makeJob(), prefs).kept, true);
});

// ─── Rule 4: title_allowlist ───────────────────────────────────────────
await test('rule-4.a non-empty allowlist + no match → drop', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    title_allowlist: ['Backend', 'AI'] } };
  const r = applyHardFilter(makeJob({ role: 'Marketing Manager' }), prefs);
  assert.equal(r.kept, false);
  assert.equal(r.rule_id, 'title_allowlist');
});
await test('rule-4.b allowlist match → keep', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    title_allowlist: ['Backend', 'AI'] } };
  assert.equal(applyHardFilter(makeJob({ role: 'Backend Engineer' }), prefs).kept, true);
});
await test('rule-4.c empty allowlist → no-op (keep)', () => {
  const prefs = { hard_filters: BASE_PREFS.hard_filters };
  assert.equal(applyHardFilter(makeJob({ role: 'Marketing Manager' }), prefs).kept, true);
});

// ─── Rule 5: location ──────────────────────────────────────────────────
await test('rule-5.a allowed_countries=US, location SF, CA → keep (state map)', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    location: { allowed_countries: ['United States'], allowed_cities: [], disallowed_countries: [] } } };
  assert.equal(applyHardFilter(makeJob({ location: ['San Francisco, CA'] }), prefs).kept, true);
});
await test('rule-5.b allowed_countries=US, location London, UK → drop', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    location: { allowed_countries: ['United States'], allowed_cities: [], disallowed_countries: [] } } };
  const r = applyHardFilter(makeJob({ location: ['London, UK'] }), prefs);
  assert.equal(r.kept, false);
  assert.equal(r.rule_id, 'location');
});
await test('rule-5.c "Remote" bypasses location filter', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    location: { allowed_countries: ['United States'], allowed_cities: [], disallowed_countries: [] } } };
  assert.equal(applyHardFilter(makeJob({ location: ['Remote', 'London, UK'] }), prefs).kept, true);
});
await test('rule-5.d disallowed_countries kills even with Remote', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    location: { allowed_countries: [], allowed_cities: [], disallowed_countries: ['United States'] } } };
  const r = applyHardFilter(makeJob({ location: ['Remote', 'San Francisco, CA'] }), prefs);
  assert.equal(r.kept, false);
  assert.match(r.matched_value, /disallowed:United States/);
});
await test('rule-5.e empty location array → keep (conservative)', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    location: { allowed_countries: ['United States'], allowed_cities: [], disallowed_countries: [] } } };
  assert.equal(applyHardFilter(makeJob({ location: [] }), prefs).kept, true);
});
await test('rule-5.f allowed_cities substring match', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    location: { allowed_countries: [], allowed_cities: ['New York'], disallowed_countries: [] } } };
  assert.equal(applyHardFilter(makeJob({ location: ['New York, NY'] }), prefs).kept, true);
});
await test('rule-5.g all empty → no-op (keep)', () => {
  assert.equal(applyHardFilter(makeJob({ location: ['London, UK'] }), BASE_PREFS).kept, true);
});

// ─── Rule 6: seniority ─────────────────────────────────────────────────
await test('rule-6.a role Senior + allowed=[Senior, Staff] → keep', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    seniority: { allowed: ['Senior', 'Staff'] } } };
  assert.equal(applyHardFilter(makeJob({ role: 'Senior SDE' }), prefs).kept, true);
});
await test('rule-6.b role Junior + allowed=[Senior, Staff] → drop', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    seniority: { allowed: ['Senior', 'Staff'] } } };
  const r = applyHardFilter(makeJob({ role: 'Junior SDE' }), prefs);
  assert.equal(r.kept, false);
  assert.equal(r.rule_id, 'seniority');
});
await test('rule-6.c unknown seniority → keep (conservative)', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    seniority: { allowed: ['Senior'] } } };
  assert.equal(applyHardFilter(makeJob({ role: 'Backend Engineer' }), prefs).kept, true);
});
await test('rule-6.d allowed=[] → no-op (keep)', () => {
  const prefs = { hard_filters: BASE_PREFS.hard_filters };
  assert.equal(applyHardFilter(makeJob({ role: 'Junior SDE' }), prefs).kept, true);
});

// ─── Rule 7: posted_within_days ────────────────────────────────────────
await test('rule-7.a posted today + threshold 60 → keep', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters, posted_within_days: 60 } };
  assert.equal(applyHardFilter(makeJob(), prefs).kept, true);
});
await test('rule-7.b posted 90 days ago + threshold 60 → drop', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters, posted_within_days: 60 } };
  const oldDate = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const r = applyHardFilter(makeJob({ posted_at: oldDate }), prefs);
  assert.equal(r.kept, false);
  assert.equal(r.rule_id, 'posted_within_days');
});
await test('rule-7.c posted_at=null → keep', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters, posted_within_days: 60 } };
  assert.equal(applyHardFilter(makeJob({ posted_at: null }), prefs).kept, true);
});
await test('rule-7.d threshold 0 → no-op (keep ancient)', () => {
  const prefs = { hard_filters: BASE_PREFS.hard_filters };
  const oldDate = new Date(Date.now() - 365 * 86_400_000).toISOString();
  assert.equal(applyHardFilter(makeJob({ posted_at: oldDate }), prefs).kept, true);
});

// ─── Rule 8: comp_floor ────────────────────────────────────────────────
await test('rule-8.a comp_hint < base_min same currency → drop', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    comp_floor: { base_min: 150_000, currency: 'USD' } } };
  const r = applyHardFilter(makeJob({
    comp_hint: { min: 80_000, max: 100_000, currency: 'USD', period: 'yr' }
  }), prefs);
  assert.equal(r.kept, false);
  assert.equal(r.rule_id, 'comp_floor');
});
await test('rule-8.b comp_hint >= base_min → keep', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    comp_floor: { base_min: 150_000, currency: 'USD' } } };
  assert.equal(applyHardFilter(makeJob({
    comp_hint: { min: 180_000, max: 240_000, currency: 'USD', period: 'yr' }
  }), prefs).kept, true);
});
await test('rule-8.c comp_hint=null → keep (conservative)', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    comp_floor: { base_min: 150_000, currency: 'USD' } } };
  assert.equal(applyHardFilter(makeJob({ comp_hint: null }), prefs).kept, true);
});
await test('rule-8.d currency mismatch → keep (conservative)', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    comp_floor: { base_min: 150_000, currency: 'USD' } } };
  assert.equal(applyHardFilter(makeJob({
    comp_hint: { min: 80_000, max: 100_000, currency: 'EUR', period: 'yr' }
  }), prefs).kept, true);
});
await test('rule-8.e base_min undefined/0 → no-op', () => {
  const prefs = { hard_filters: BASE_PREFS.hard_filters };
  assert.equal(applyHardFilter(makeJob({
    comp_hint: { min: 50_000, max: 60_000, currency: 'USD', period: 'yr' }
  }), prefs).kept, true);
});

// ─── Rule 9: jd_text_blocklist ─────────────────────────────────────────
await test('rule-9.a description contains blocked phrase → drop', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    jd_text_blocklist: ['No sponsorship'] } };
  const r = applyHardFilter(makeJob({ description: 'We do not provide visa or No sponsorship.' }), prefs);
  assert.equal(r.kept, false);
  assert.equal(r.rule_id, 'jd_text_blocklist');
});
await test('rule-9.b description=null → keep (defer post-enrich)', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    jd_text_blocklist: ['No sponsorship'] } };
  assert.equal(applyHardFilter(makeJob({ description: null }), prefs).kept, true);
});

// ─── Short-circuit ordering ────────────────────────────────────────────
await test('order. source_filter wins before company_blocklist', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    source_filter: { blocked_sources: ['greenhouse'] },
    company_blocklist: ['Anthropic'] } };
  const r = applyHardFilter(makeJob(), prefs);
  assert.equal(r.rule_id, 'source_filter');
});

// ─── Batch + archive ───────────────────────────────────────────────────
await test('batch. mixed → kept[2] dropped[2]', () => {
  const prefs = { hard_filters: { ...BASE_PREFS.hard_filters,
    company_blocklist: ['EvilCo'] } };
  const jobs = [
    makeJob({ id: 'aaaaaaaaaaaa', company: 'GoodCo' }),
    makeJob({ id: 'bbbbbbbbbbbb', company: 'EvilCo' }),
    makeJob({ id: 'cccccccccccc', company: 'AlsoGood' }),
    makeJob({ id: 'dddddddddddd', company: 'EvilCo Subsidiary' }),
  ];
  const { kept, dropped } = applyHardFilterBatch(jobs, prefs);
  assert.equal(kept.length, 2);
  assert.equal(dropped.length, 2);
  for (const d of dropped) assert.equal(d.rule_id, 'company_blocklist');
});

await test('archive. roundtrip JSONL append', async () => {
  const tmp = path.join(os.tmpdir(), `smoke-archive-${process.pid}-${Date.now()}.jsonl`);
  try {
    const dropped = [
      { job: makeJob({ id: 'xx1' }), rule_id: 'company_blocklist', matched_value: 'EvilCo' },
      { job: makeJob({ id: 'xx2' }), rule_id: 'title_blocklist', matched_value: 'Embedded' },
    ];
    await archiveDropped(dropped, tmp);
    const txt = await fs.readFile(tmp, 'utf-8');
    const lines = txt.trim().split('\n');
    assert.equal(lines.length, 2);
    const r0 = JSON.parse(lines[0]);
    assert.equal(r0.job.id, 'xx1');
    assert.equal(r0.rule_id, 'company_blocklist');
    assert.equal(r0.matched_value, 'EvilCo');
    assert.ok(r0.ts);
    assert.equal(r0.job.source.type, 'greenhouse');
  } finally {
    try { await fs.unlink(tmp); } catch {}
  }
});

await test('archive. empty list → 0 written', async () => {
  const tmp = path.join(os.tmpdir(), `smoke-archive-empty-${process.pid}-${Date.now()}.jsonl`);
  const n = await archiveDropped([], tmp);
  assert.equal(n, 0);
});

console.log(`\n✅ All ${passed} smoke tests passed.`);
