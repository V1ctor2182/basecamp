#!/usr/bin/env node
// Smoke for jdEnrich orchestrator. Uses dependency injection (the _deps option
// on enrichBatch + deps arg on enrichJob) to mock atsByUrl + pageScraper so we
// don't hit the network or launch chromium during this smoke. The real
// integration paths are exercised by the m1 + m2 smokes already.

import assert from 'node:assert/strict';
import { enrichJob, enrichBatch, OUTCOME } from '../src/career/finder/jdEnrich.mjs';

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

function makeJob(over = {}) {
  return {
    id: 'aaaabbbbcccc',
    source: { type: 'greenhouse', name: 'Anthropic', url: null },
    company: 'Anthropic',
    role: 'SWE',
    location: ['SF, CA'],
    url: 'https://boards.greenhouse.io/anthropic/jobs/4012345',
    description: null,
    posted_at: null,
    scraped_at: new Date().toISOString(),
    comp_hint: null,
    tags: [],
    raw: null,
    schema_version: 1,
    needs_manual_enrich: false,
    ...over,
  };
}

// Mock dep factory — track call counts so we can assert which tiers fired.
function makeDeps({ ats = null, scrape = null, atsThrows = false, scrapeThrows = null } = {}) {
  const calls = { detect: 0, refetch: 0, scrape: 0 };
  return {
    calls,
    deps: {
      detectAtsType: (url) => {
        calls.detect++;
        return ats === null
          ? null
          : { type: ats.type ?? 'greenhouse', slug: 'x', id: '1' };
      },
      refetchAtsContent: async () => {
        calls.refetch++;
        if (atsThrows) throw new Error('synthetic ats throw');
        return ats === null ? { description: null } : ats.result;
      },
      scrapeJdText: async () => {
        calls.scrape++;
        if (scrapeThrows) throw scrapeThrows;
        return scrape;
      },
    },
  };
}

// ── Tier 1: skip ─────────────────────────────────────────────────────────
await test('tier-1. description.length > 500 → SKIPPED, no fetch attempted', async () => {
  const j = makeJob({ description: 'x'.repeat(501) });
  const { calls, deps } = makeDeps();
  const r = await enrichJob(j, deps);
  assert.equal(r.outcome, OUTCOME.SKIPPED);
  assert.equal(j.description, 'x'.repeat(501)); // unchanged
  assert.equal(j.needs_manual_enrich, false);
  assert.equal(calls.detect, 0);
  assert.equal(calls.refetch, 0);
  assert.equal(calls.scrape, 0);
});

// ── Tier 2: ATS hit ──────────────────────────────────────────────────────
await test('tier-2. ATS detection + refetch with description → ENRICHED_ATS, no scrape', async () => {
  const j = makeJob();
  const { calls, deps } = makeDeps({
    ats: { type: 'greenhouse', result: { description: 'Real JD body from API.' } },
  });
  const r = await enrichJob(j, deps);
  assert.equal(r.outcome, OUTCOME.ENRICHED_ATS);
  assert.equal(j.description, 'Real JD body from API.');
  assert.equal(j.needs_manual_enrich, false);
  assert.equal(calls.detect, 1);
  assert.equal(calls.refetch, 1);
  assert.equal(calls.scrape, 0);
});

await test('tier-2 fallthrough. ATS returns null description → ENRICHED_SCRAPE on tier 3', async () => {
  const j = makeJob();
  const { calls, deps } = makeDeps({
    ats: { type: 'greenhouse', result: { description: null, error: 'not found' } },
    scrape: 'Scraped JD body.',
  });
  const r = await enrichJob(j, deps);
  assert.equal(r.outcome, OUTCOME.ENRICHED_SCRAPE);
  assert.equal(j.description, 'Scraped JD body.');
  assert.equal(calls.refetch, 1);
  assert.equal(calls.scrape, 1);
});

await test('tier-2 workday-skip. detection.skip → straight to tier 3', async () => {
  const j = makeJob({ url: 'https://acme.wd1.myworkdayjobs.com/x/job/y/z' });
  const { calls, deps } = makeDeps({
    ats: { type: 'workday', result: { skip: true } },
    scrape: 'Workday JD via scraper.',
  });
  const r = await enrichJob(j, deps);
  assert.equal(r.outcome, OUTCOME.ENRICHED_SCRAPE);
  assert.equal(j.description, 'Workday JD via scraper.');
  assert.equal(calls.refetch, 1);
  assert.equal(calls.scrape, 1);
});

await test('tier-2 throws. defensive catch → tier 3', async () => {
  const j = makeJob();
  const origWarn = console.warn;
  console.warn = () => {}; // silence the defensive log
  try {
    const { calls, deps } = makeDeps({
      ats: { type: 'greenhouse', result: { description: null } },
      atsThrows: true,
      scrape: 'Scraped after ats throw.',
    });
    const r = await enrichJob(j, deps);
    assert.equal(r.outcome, OUTCOME.ENRICHED_SCRAPE);
    assert.equal(j.description, 'Scraped after ats throw.');
    assert.equal(calls.scrape, 1);
  } finally {
    console.warn = origWarn;
  }
});

// ── Tier 3: scrape ──────────────────────────────────────────────────────
await test('tier-3. no ATS detection → straight scrape success', async () => {
  const j = makeJob({ url: 'https://example.com/random/job' });
  const { calls, deps } = makeDeps({ scrape: 'Generic scrape body.' });
  const r = await enrichJob(j, deps);
  assert.equal(r.outcome, OUTCOME.ENRICHED_SCRAPE);
  assert.equal(j.description, 'Generic scrape body.');
  assert.equal(calls.detect, 1);
  assert.equal(calls.refetch, 0);
  assert.equal(calls.scrape, 1);
});

await test('tier-3 timeout. EnrichTimeout → tier 4 (needs_manual)', async () => {
  const j = makeJob({ url: 'https://example.com/x' });
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const err = new Error('timeout 15000');
    err.name = 'EnrichTimeout';
    const { deps } = makeDeps({ scrapeThrows: err });
    const r = await enrichJob(j, deps);
    assert.equal(r.outcome, OUTCOME.NEEDS_MANUAL);
    assert.equal(j.needs_manual_enrich, true);
    assert.equal(j.description, null); // unchanged
  } finally {
    console.warn = origWarn;
  }
});

await test('tier-3 error. EnrichError → tier 4 (needs_manual)', async () => {
  const j = makeJob({ url: 'https://example.com/x' });
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const err = new Error('navigation failed');
    err.name = 'EnrichError';
    const { deps } = makeDeps({ scrapeThrows: err });
    const r = await enrichJob(j, deps);
    assert.equal(r.outcome, OUTCOME.NEEDS_MANUAL);
    assert.equal(j.needs_manual_enrich, true);
  } finally {
    console.warn = origWarn;
  }
});

await test('tier-3 unexpected throw. any error → tier 4 (never bubbles)', async () => {
  const j = makeJob({ url: 'https://example.com/x' });
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const { deps } = makeDeps({ scrapeThrows: new Error('weird internal error') });
    const r = await enrichJob(j, deps);
    assert.equal(r.outcome, OUTCOME.NEEDS_MANUAL);
    assert.equal(j.needs_manual_enrich, true);
  } finally {
    console.warn = origWarn;
  }
});

// ── Tier 3 with empty url → straight to tier 4 (no scrape attempt) ───────
await test('tier-3 skipped on empty url → tier 4 directly', async () => {
  const j = makeJob({ url: '' });
  // NB: Job schema requires url, but a pipeline.json record could carry empty
  // string defensively — enrichJob shouldn't crash.
  const { calls, deps } = makeDeps({ scrape: 'should not be called' });
  const r = await enrichJob(j, deps);
  assert.equal(r.outcome, OUTCOME.NEEDS_MANUAL);
  // detectAtsType returned null (mocked), then we don't scrape (empty url),
  // tier 4 fires.
  assert.equal(calls.scrape, 0);
});

// ── Bad input ────────────────────────────────────────────────────────────
await test('null/undefined job → SKIPPED, no crash', async () => {
  const r1 = await enrichJob(null);
  const r2 = await enrichJob(undefined);
  assert.equal(r1.outcome, OUTCOME.SKIPPED);
  assert.equal(r2.outcome, OUTCOME.SKIPPED);
});

// ── enrichBatch counter aggregation ─────────────────────────────────────
await test('batch. mixed outcomes counted correctly + concurrency observable', async () => {
  // 6 jobs: 2 already-enriched (skipped), 1 ats-hit, 1 scrape-hit, 2 all-fail
  const jobs = [
    makeJob({ id: 'aaaaaaaaaaa1', description: 'x'.repeat(501) }),
    makeJob({ id: 'aaaaaaaaaaa2', description: 'y'.repeat(501) }),
    makeJob({ id: 'aaaaaaaaaaa3' }),
    makeJob({ id: 'aaaaaaaaaaa4', url: 'https://example.com/x' }),
    makeJob({ id: 'aaaaaaaaaaa5', url: 'https://example.com/y' }),
    makeJob({ id: 'aaaaaaaaaaa6', url: 'https://example.com/z' }),
  ];

  // Per-job behavior driven by job.id suffix — keeps the test deterministic.
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const deps = {
      detectAtsType: (url) => (url.includes('greenhouse') ? { type: 'greenhouse', slug: 'x', id: '1' } : null),
      refetchAtsContent: async () => ({ description: 'ATS body.' }),
      scrapeJdText: async (url) => {
        if (url.endsWith('/x')) return 'Scrape body.';
        const e = new Error('fail'); e.name = 'EnrichError'; throw e;
      },
    };
    const r = await enrichBatch(jobs, { concurrency: 3, _deps: deps });
    assert.equal(r.skipped, 2);          // jobs 1,2
    assert.equal(r.ats_hits, 1);          // job 3 (greenhouse url)
    assert.equal(r.scrape_hits, 1);       // job 4 (.../x)
    assert.equal(r.needs_manual, 2);      // jobs 5,6 (scrape throws)
    assert.equal(r.enriched, 2);          // ats + scrape
    // mutations landed
    assert.equal(jobs[2].description, 'ATS body.');
    assert.equal(jobs[3].description, 'Scrape body.');
    assert.equal(jobs[4].needs_manual_enrich, true);
    assert.equal(jobs[5].needs_manual_enrich, true);
  } finally {
    console.warn = origWarn;
  }
});

await test('batch. empty input → all-zero counters, no crash', async () => {
  const r = await enrichBatch([]);
  assert.deepEqual(r, {
    skipped: 0,
    ats_hits: 0,
    scrape_hits: 0,
    needs_manual: 0,
    enriched: 0,
  });
});

// Concurrency assertion via direct max-concurrent counter (NOT wallclock).
// Wallclock tests are flaky on loaded CI / GC pauses. We instead instrument
// the mock to track entry/exit and assert the max in-flight count.
await test('batch. concurrency=3 observed via in-flight counter (max 3 simultaneous)', async () => {
  const jobs = Array.from({ length: 6 }, (_, i) =>
    makeJob({ id: 'aaaaaaaaaaa' + String(i), url: 'https://example.com/' + i })
  );
  let inflight = 0;
  let maxInflight = 0;
  const deps = {
    detectAtsType: () => null,
    refetchAtsContent: async () => ({ description: null }),
    scrapeJdText: async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 30));
      inflight--;
      return 'body';
    },
  };
  const r = await enrichBatch(jobs, { concurrency: 3, _deps: deps });
  assert.equal(r.scrape_hits, 6);
  assert.equal(r.enriched, 6);
  assert.equal(maxInflight, 3, `expected max 3 in-flight, observed ${maxInflight}`);
});

await test('batch. concurrency=1 → max 1 in-flight (sequential, no parallelism)', async () => {
  const jobs = Array.from({ length: 6 }, (_, i) =>
    makeJob({ id: 'aaaaaaaaaaa' + String(i), url: 'https://example.com/' + i })
  );
  let inflight = 0;
  let maxInflight = 0;
  const deps = {
    detectAtsType: () => null,
    refetchAtsContent: async () => ({ description: null }),
    scrapeJdText: async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return 'body';
    },
  };
  await enrichBatch(jobs, { concurrency: 1, _deps: deps });
  assert.equal(maxInflight, 1);
});

// ── Documented invariants (review-finding driven) ────────────────────────
await test('invariant. counter sum == jobs.length (no silent drops)', async () => {
  const jobs = [
    makeJob({ id: 'aaaaaaaaaaa1', description: 'x'.repeat(501) }),  // skipped
    makeJob({ id: 'aaaaaaaaaaa2' }),                                // ats hit
    makeJob({ id: 'aaaaaaaaaaa3', url: 'https://example.com/x' }),  // scrape hit
    makeJob({ id: 'aaaaaaaaaaa4', url: 'https://example.com/fail' }), // needs_manual
  ];
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const deps = {
      detectAtsType: (u) => (u.includes('greenhouse') ? { type: 'greenhouse', slug: 'x', id: '1' } : null),
      refetchAtsContent: async () => ({ description: 'ATS body.' }),
      scrapeJdText: async (u) => {
        if (u.endsWith('/x')) return 'Scrape body.';
        const e = new Error('fail'); e.name = 'EnrichError'; throw e;
      },
    };
    const r = await enrichBatch(jobs, { concurrency: 3, _deps: deps });
    const sum = r.skipped + r.ats_hits + r.scrape_hits + r.needs_manual;
    assert.equal(sum, jobs.length);
  } finally { console.warn = origWarn; }
});

await test('invariant. mutation surface limited to description + needs_manual_enrich', async () => {
  const original = makeJob({ url: 'https://example.com/x' });
  const before = JSON.parse(JSON.stringify(original));
  const deps = {
    detectAtsType: () => null,
    refetchAtsContent: async () => ({ description: null }),
    scrapeJdText: async () => 'New JD body.',
  };
  await enrichJob(original, deps);
  // Every field except description + needs_manual_enrich must be byte-identical.
  for (const k of Object.keys(before)) {
    if (k === 'description' || k === 'needs_manual_enrich') continue;
    assert.deepEqual(original[k], before[k], `field ${k} was mutated`);
  }
  assert.equal(original.description, 'New JD body.');
  assert.equal(original.needs_manual_enrich, false);
});

await test('invariant. successful retry clears stale needs_manual_enrich=true', async () => {
  // Simulates the retry case: a previously-failed job that's been re-queued.
  const j = makeJob({ description: null, needs_manual_enrich: true });
  const deps = {
    detectAtsType: () => ({ type: 'greenhouse', slug: 'x', id: '1' }),
    refetchAtsContent: async () => ({ description: 'Recovered JD.' }),
    scrapeJdText: async () => { throw new Error('should not be reached'); },
  };
  const r = await enrichJob(j, deps);
  assert.equal(r.outcome, OUTCOME.ENRICHED_ATS);
  assert.equal(j.description, 'Recovered JD.');
  assert.equal(j.needs_manual_enrich, false, 'retry success must clear stale manual flag');
});

await test('invariant. tier 3 success on retry also clears needs_manual_enrich', async () => {
  const j = makeJob({ description: null, needs_manual_enrich: true, url: 'https://example.com/x' });
  const deps = {
    detectAtsType: () => null,
    refetchAtsContent: async () => ({ description: null }),
    scrapeJdText: async () => 'Recovered via scrape.',
  };
  const r = await enrichJob(j, deps);
  assert.equal(r.outcome, OUTCOME.ENRICHED_SCRAPE);
  assert.equal(j.needs_manual_enrich, false);
});

await test('invariant. partial _deps merges with DEFAULT_DEPS (never-throws preserved)', async () => {
  // If a caller passes ONLY scrapeJdText, the real detectAtsType + refetchAtsContent
  // should still be in effect. enrichJob must NOT throw TypeError on undefined fns.
  const j = makeJob({ url: 'https://example.com/random' });
  const partialDeps = {
    scrapeJdText: async () => 'Scraped body.',
  };
  // Should not throw despite only providing one dep.
  const r = await enrichJob(j, partialDeps);
  assert.equal(r.outcome, OUTCOME.ENRICHED_SCRAPE);
  assert.equal(j.description, 'Scraped body.');
});

await test('invariant. partial _deps via enrichBatch also merges defaults', async () => {
  const j = makeJob({ url: 'https://example.com/random' });
  const r = await enrichBatch([j], {
    concurrency: 1,
    _deps: { scrapeJdText: async () => 'Body.' },
  });
  assert.equal(r.scrape_hits, 1);
  assert.equal(j.description, 'Body.');
});

await test('invariant. single job + concurrency=3 → exactly 1 enrichJob invocation', async () => {
  const jobs = [makeJob({ id: 'aaaaaaaaaaaa', url: 'https://example.com/x' })];
  let calls = 0;
  const deps = {
    detectAtsType: () => null,
    refetchAtsContent: async () => ({ description: null }),
    scrapeJdText: async () => { calls++; return 'body'; },
  };
  await enrichBatch(jobs, { concurrency: 3, _deps: deps });
  assert.equal(calls, 1, 'cursor-claim invariant: exactly 1 call for 1 job');
});

console.log(`\n✅ All ${passed} smoke tests passed.`);
