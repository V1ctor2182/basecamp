// Pure dry-run preview for hard_filters. Given a candidate prefs object,
// the saved prefs, and the current pipeline jobs, return the counts and
// per-rule breakdown the Preferences UI shows after pressing "Preview".
//
// No I/O — caller is responsible for loading pipeline.json + saved prefs.
// This keeps the function trivially testable from a module-level smoke.

import { applyHardFilterBatch } from './hardFilter.mjs';

// Fixed order matches the 9 hard_filters short-circuit order in hardFilter.mjs.
// Every rule appears in `breakdown` even with 0 drops so the UI table is
// stable and order-deterministic across previews.
export const RULE_ORDER = [
  'source_filter',
  'company_blocklist',
  'title_blocklist',
  'title_allowlist',
  'location',
  'seniority',
  'posted_within_days',
  'comp_floor',
  'jd_text_blocklist',
];

function countByRule(dropped) {
  const counts = Object.fromEntries(RULE_ORDER.map((r) => [r, 0]));
  for (const d of dropped) {
    if (d?.rule_id && counts[d.rule_id] !== undefined) counts[d.rule_id]++;
  }
  return counts;
}

// Returns the shape the Preferences UI expects:
//   { total_jobs, would_drop, would_pass, new_drops, breakdown: [{rule, drops}] }
// `savedPrefs` may be null/undefined — in that case `new_drops` = `would_drop`
// (treat absent saved-prefs baseline as "no filter applied previously").
export function previewHardFilter(prefs, savedPrefs, jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const totalJobs = list.length;

  const { dropped: droppedCurrent } = applyHardFilterBatch(list, prefs ?? {});
  const wouldDrop = droppedCurrent.length;

  let newDrops;
  if (savedPrefs && typeof savedPrefs === 'object') {
    const { dropped: droppedSaved } = applyHardFilterBatch(list, savedPrefs);
    newDrops = Math.max(0, wouldDrop - droppedSaved.length);
  } else {
    newDrops = wouldDrop;
  }

  const counts = countByRule(droppedCurrent);
  const breakdown = RULE_ORDER.map((rule) => ({ rule, drops: counts[rule] }));

  return {
    total_jobs: totalJobs,
    would_drop: wouldDrop,
    would_pass: totalJobs - wouldDrop,
    new_drops: newDrops,
    breakdown,
  };
}
