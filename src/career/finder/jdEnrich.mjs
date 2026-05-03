// JD-Enrich orchestrator — 4-tier fallback for filling Job.description.
//
// Tiers (in order, short-circuit on success):
//   1. SKIP    — Job.description already present and > 500 chars (locked design)
//   2. ATS     — detectAtsType(url) → refetchAtsContent (greenhouse/ashby/lever/
//                recruitee/smartrecruiters); workday returns { skip: true } and
//                falls through to tier 3
//   3. SCRAPE  — Playwright headless scrape via pageScraper.scrapeJdText
//   4. MANUAL  — set Job.needs_manual_enrich = true, leave description as-is
//
// `enrichJob(job)` mutates the input job in-place — it only ever writes to
// `description` and `needs_manual_enrich`. Returns the same reference. NEVER
// throws; tier 4 catches every failure mode the lower tiers can produce.
//
// `enrichBatch(jobs, { concurrency=3 })` runs N parallel workers off a shared
// index counter. Concurrency 3 is the locked design (OQ-5=a) — chromium-friendly,
// gives ~12-15 jobs/min throughput on a single browser process.

import {
  detectAtsType as _detectAtsType,
  refetchAtsContent as _refetchAtsContent,
  shouldEnrich,
} from './atsByUrl.mjs';
import { scrapeJdText as _scrapeJdText } from '../lib/pageScraper.mjs';

const DEFAULT_DEPS = {
  detectAtsType: _detectAtsType,
  refetchAtsContent: _refetchAtsContent,
  scrapeJdText: _scrapeJdText,
};

// Outcome codes returned to the batch counter so totals are easy to aggregate.
export const OUTCOME = Object.freeze({
  SKIPPED: 'skipped',           // tier 1 — already had description
  ENRICHED_ATS: 'ats',          // tier 2 — ATS API hit
  ENRICHED_SCRAPE: 'scrape',    // tier 3 — Playwright scrape hit
  NEEDS_MANUAL: 'needs_manual', // tier 4 — flagged for user paste
});

// Merges caller-provided deps over DEFAULT_DEPS so partial overrides don't
// blow away the unspecified entries (`{ scrapeJdText: mock }` keeps the real
// detectAtsType + refetchAtsContent — preserves the never-throws guarantee).
function mergeDeps(deps) {
  return { ...DEFAULT_DEPS, ...(deps && typeof deps === 'object' ? deps : {}) };
}

// Mutates job in place. Returns { outcome } so the batch counter can attribute
// the tier without re-inspecting the job. Never throws (every external call is
// wrapped; tier 4 is the unconditional fallback).
export async function enrichJob(job, deps = undefined) {
  if (!job || typeof job !== 'object') return { outcome: OUTCOME.SKIPPED };
  const d = mergeDeps(deps);

  // Tier 1: already enriched
  if (!shouldEnrich(job)) {
    // Don't reset needs_manual_enrich here — the caller chose to skip an
    // already-long description. If the long description was a manually pasted
    // resolution, m4's PATCH endpoint clears the flag. We don't second-guess.
    return { outcome: OUTCOME.SKIPPED };
  }

  // Tier 2: ATS by URL — defensive try/catch around BOTH detect and refetch
  // so an unexpected throw in either (e.g. a partial-mock test seam) cannot
  // break the never-throws contract.
  let detection = null;
  try {
    detection = d.detectAtsType(job.url);
  } catch (e) {
    console.warn('[jdEnrich] detectAtsType threw:', String(e?.message ?? e).slice(0, 200));
  }
  if (detection) {
    let r;
    try {
      r = await d.refetchAtsContent(detection);
    } catch (e) {
      console.warn('[jdEnrich] ats refetch threw:', String(e?.message ?? e).slice(0, 200));
      r = { description: null };
    }
    if (r && !r.skip && typeof r.description === 'string' && r.description.length > 0) {
      job.description = r.description;
      job.needs_manual_enrich = false; // clear stale manual flag on success
      return { outcome: OUTCOME.ENRICHED_ATS };
    }
    // r.skip === true (workday) or null description → fall through to tier 3
  }

  // Tier 3: Playwright scrape
  if (typeof job.url === 'string' && job.url) {
    try {
      const text = await d.scrapeJdText(job.url);
      if (typeof text === 'string' && text.length > 0) {
        job.description = text;
        job.needs_manual_enrich = false; // clear stale manual flag on success
        return { outcome: OUTCOME.ENRICHED_SCRAPE };
      }
    } catch (e) {
      // EnrichTimeout / EnrichError / unexpected — tier 4 catches all
      console.warn(
        '[jdEnrich] scrape failed:',
        e?.name ?? 'Error',
        '-',
        String(e?.message ?? e).slice(0, 200)
      );
    }
  }

  // Tier 4: needs manual paste
  job.needs_manual_enrich = true;
  return { outcome: OUTCOME.NEEDS_MANUAL };
}

// Worker-pool over a shared index counter. N workers race to claim the next
// job. Each call to enrichJob is independent; failures are absorbed.
export async function enrichBatch(jobs, opts = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  const concurrency =
    typeof opts.concurrency === 'number' && opts.concurrency > 0
      ? Math.min(opts.concurrency, list.length || 1)
      : 3;
  const deps = mergeDeps(opts._deps);

  const counters = {
    skipped: 0,
    ats_hits: 0,
    scrape_hits: 0,
    needs_manual: 0,
  };

  if (list.length === 0) {
    return { ...counters, enriched: 0 };
  }

  let cursor = 0;
  async function worker() {
    while (cursor < list.length) {
      const idx = cursor++;
      const { outcome } = await enrichJob(list[idx], deps);
      switch (outcome) {
        case OUTCOME.SKIPPED:
          counters.skipped++;
          break;
        case OUTCOME.ENRICHED_ATS:
          counters.ats_hits++;
          break;
        case OUTCOME.ENRICHED_SCRAPE:
          counters.scrape_hits++;
          break;
        case OUTCOME.NEEDS_MANUAL:
          counters.needs_manual++;
          break;
        default:
          // Unknown outcome (future tier added without updating counters).
          // Tally as needs_manual so totals still sum to jobs.length and
          // the unaccounted job surfaces in the manual queue rather than
          // silently disappearing from counters.
          console.warn('[jdEnrich] unknown outcome:', outcome);
          counters.needs_manual++;
      }
    }
  }

  const n = Math.max(1, Math.min(concurrency, list.length));
  await Promise.all(Array(n).fill(0).map(() => worker()));

  return {
    ...counters,
    enriched: counters.ats_hits + counters.scrape_hits,
  };
}
