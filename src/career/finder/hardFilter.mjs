// Hard-filter engine. Runs 9 rules per Job in fixed short-circuit order.
// First rule that says "drop" wins; the rest are skipped. Returns the
// matched rule_id + matched_value for archive.jsonl debug.
//
// Rule order (cheap → expensive, fixed):
//   1. source_filter           Job.source.type ∈ blocked_sources
//   2. company_blocklist       contains-match Job.company
//   3. title_blocklist         contains-match Job.role
//   4. title_allowlist         non-empty AND no contains-match → drop
//   5. location                allowed_cities ∪ allowed_countries (Remote bypass; US/CA state map)
//   6. seniority               role-extracted seniority NOT in allowed
//   7. posted_within_days      now - posted_at > threshold
//   8. comp_floor              comp_hint < base_min (currency must match)
//   9. jd_text_blocklist       contains-match Job.description
//
// Drop philosophy: CONSERVATIVE. When info is missing or ambiguous, we
// KEEP the job. We never drop on "I'm not sure". The user can manually
// archive after seeing the job if they disagree.

import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { compileMatcher } from './matchUtils.mjs';

const DATA_DIR = path.resolve('data');
const CAREER_DIR = path.join(DATA_DIR, 'career');
export const ARCHIVE_FILE = path.join(CAREER_DIR, 'archive.jsonl');

// US states (50) + DC + 13 Canadian provinces — covers 95% of NA job
// locations. Strings are exact substrings expected to appear in
// Job.location entries (e.g. "San Francisco, CA"). We check for the
// 2-letter code on a word boundary.
const COUNTRY_BY_REGION = {
  'United States': new Set([
    'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA',
    'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM',
    'NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA',
    'WV','WI','WY','USA','U.S.','U.S.A.',
  ]),
  Canada: new Set(['ON','BC','QC','AB','MB','SK','NS','NB','NL','PE','YT','NT','NU','CAN']),
};

// Synonyms for country names users might type — lowercase comparison.
const COUNTRY_ALIASES = {
  'united states': 'United States',
  'usa': 'United States',
  'us': 'United States',
  'u.s.': 'United States',
  'u.s.a.': 'United States',
  'canada': 'Canada',
};

const SENIORITY_RE = /\b(Intern|Internship|Junior|Jr\.?|IC[1-7]|Senior|Sr\.?|Staff|Principal|Lead|Director|VP|Head)\b/i;

export function extractSeniority(role) {
  if (typeof role !== 'string' || !role) return null;
  const m = role.match(SENIORITY_RE);
  if (!m) return null;
  let v = m[1];
  // Normalize abbreviations.
  if (/^Jr\.?$/i.test(v)) v = 'Junior';
  else if (/^Sr\.?$/i.test(v)) v = 'Senior';
  // Title-case for canonical output.
  return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
}

function locationContains(loc, needle) {
  return loc.toLowerCase().includes(needle.toLowerCase());
}

function locationHasRegionInCountry(loc, country) {
  const regions = COUNTRY_BY_REGION[country];
  if (!regions) return false;
  // Word-boundary match on 2-3 letter codes / 'USA' / 'CAN'.
  for (const region of regions) {
    const re = new RegExp(`\\b${region.replace(/\./g, '\\.')}\\b`, 'i');
    if (re.test(loc)) return true;
  }
  return false;
}

function locationMatchesAnyAllowedCity(jobLocations, allowedCities) {
  for (const loc of jobLocations) {
    for (const city of allowedCities) {
      if (locationContains(loc, city)) return city;
    }
  }
  return null;
}

function locationMatchesAnyAllowedCountry(jobLocations, allowedCountries) {
  // canonical country name OR alias OR region map (US states / CA provinces).
  for (const loc of jobLocations) {
    for (const country of allowedCountries) {
      const canonical = COUNTRY_ALIASES[country.toLowerCase()] ?? country;
      // Direct substring (e.g. "London, UK" doesn't match "United States")
      if (locationContains(loc, country)) return country;
      // Country alias substring
      for (const [alias, canon] of Object.entries(COUNTRY_ALIASES)) {
        if (canon === canonical && locationContains(loc, alias)) return country;
      }
      // Region map (US states / CA provinces)
      if (locationHasRegionInCountry(loc, canonical)) return country;
    }
  }
  return null;
}

function locationMatchesDisallowedCountry(jobLocations, disallowed) {
  for (const country of disallowed) {
    for (const loc of jobLocations) {
      const canonical = COUNTRY_ALIASES[country.toLowerCase()] ?? country;
      if (locationContains(loc, country)) return country;
      for (const [alias, canon] of Object.entries(COUNTRY_ALIASES)) {
        if (canon === canonical && locationContains(loc, alias)) return country;
      }
      if (locationHasRegionInCountry(loc, canonical)) return country;
    }
  }
  return null;
}

// Returns { kept: bool, rule_id, matched_value } for a single Job.
export function applyHardFilter(job, prefs) {
  const hf = prefs?.hard_filters ?? {};

  // 1. source_filter
  const blockedSources = hf.source_filter?.blocked_sources ?? [];
  if (blockedSources.length > 0 && job.source?.type) {
    if (blockedSources.map((s) => s.toLowerCase()).includes(job.source.type.toLowerCase())) {
      return { kept: false, rule_id: 'source_filter', matched_value: job.source.type };
    }
  }

  // 2. company_blocklist
  const companyBlock = compileMatcher(hf.company_blocklist ?? [], 'contains', false);
  {
    const m = companyBlock(job.company);
    if (m) return { kept: false, rule_id: 'company_blocklist', matched_value: m };
  }

  // 3. title_blocklist
  const titleBlock = compileMatcher(hf.title_blocklist ?? [], 'contains', false);
  {
    const m = titleBlock(job.role);
    if (m) return { kept: false, rule_id: 'title_blocklist', matched_value: m };
  }

  // 4. title_allowlist (drop if non-empty AND no match)
  const allowList = hf.title_allowlist ?? [];
  if (allowList.length > 0) {
    const allow = compileMatcher(allowList, 'contains', false);
    const m = allow(job.role);
    if (!m) return { kept: false, rule_id: 'title_allowlist', matched_value: null };
  }

  // 5. location
  const allowedCities = hf.location?.allowed_cities ?? [];
  const allowedCountries = hf.location?.allowed_countries ?? [];
  const disallowedCountries = hf.location?.disallowed_countries ?? [];
  const locs = Array.isArray(job.location) ? job.location.filter((l) => typeof l === 'string') : [];

  if (allowedCities.length > 0 || allowedCountries.length > 0 || disallowedCountries.length > 0) {
    // Disallowed first (kills US-based jobs even if "Remote" is in array).
    const dis = locationMatchesDisallowedCountry(locs, disallowedCountries);
    if (dis) return { kept: false, rule_id: 'location', matched_value: `disallowed:${dis}` };

    // "Remote" bypasses the rest (location-independent role).
    const hasRemote = locs.some((l) => /\bremote\b/i.test(l));
    if (!hasRemote) {
      const onlyHasAllowList = allowedCities.length > 0 || allowedCountries.length > 0;
      if (onlyHasAllowList) {
        const cityHit = locationMatchesAnyAllowedCity(locs, allowedCities);
        const countryHit = locationMatchesAnyAllowedCountry(locs, allowedCountries);
        if (!cityHit && !countryHit) {
          // Conservative: if location array is empty, KEEP (no info → don't drop).
          if (locs.length === 0) {
            // fall through (keep)
          } else {
            return {
              kept: false,
              rule_id: 'location',
              matched_value: locs.join('; '),
            };
          }
        }
      }
    }
  }

  // 6. seniority
  const allowedSeniority = hf.seniority?.allowed ?? [];
  if (allowedSeniority.length > 0) {
    const extracted = extractSeniority(job.role);
    if (extracted) {
      const allowedLower = allowedSeniority.map((s) => s.toLowerCase());
      if (!allowedLower.includes(extracted.toLowerCase())) {
        return { kept: false, rule_id: 'seniority', matched_value: extracted };
      }
    }
    // extracted=null → keep (conservative, unknown seniority).
  }

  // 7. posted_within_days
  const within = hf.posted_within_days ?? 0;
  if (within > 0 && typeof job.posted_at === 'string') {
    const t = new Date(job.posted_at).getTime();
    if (!Number.isNaN(t)) {
      const ageDays = (Date.now() - t) / 86_400_000;
      if (ageDays > within) {
        return {
          kept: false,
          rule_id: 'posted_within_days',
          matched_value: `${ageDays.toFixed(0)}d > ${within}d`,
        };
      }
    }
  }

  // 8. comp_floor
  const cf = hf.comp_floor ?? {};
  if (typeof cf.base_min === 'number' && cf.base_min > 0 && job.comp_hint) {
    const ch = job.comp_hint;
    const currencyOk = !cf.currency || !ch.currency || cf.currency.toLowerCase() === ch.currency.toLowerCase();
    if (currencyOk) {
      const top = Math.max(ch.min ?? 0, ch.max ?? 0);
      if (top > 0 && top < cf.base_min) {
        return {
          kept: false,
          rule_id: 'comp_floor',
          matched_value: `${top} < ${cf.base_min} ${cf.currency || ''}`.trim(),
        };
      }
    }
    // Currency mismatch or no comp signal → keep (conservative).
  }

  // 9. jd_text_blocklist
  const jdBlock = compileMatcher(hf.jd_text_blocklist ?? [], 'contains', false);
  if (typeof job.description === 'string') {
    const m = jdBlock(job.description);
    if (m) return { kept: false, rule_id: 'jd_text_blocklist', matched_value: m };
  }

  return { kept: true, rule_id: null, matched_value: null };
}

export function applyHardFilterBatch(jobs, prefs) {
  const kept = [];
  const dropped = [];
  for (const job of jobs) {
    const r = applyHardFilter(job, prefs);
    if (r.kept) kept.push(job);
    else dropped.push({ job, rule_id: r.rule_id, matched_value: r.matched_value });
  }
  return { kept, dropped };
}

// Atomic enough — append-only jsonl. Each archived job carries enough context
// to debug *why* it was dropped without re-loading anything.
export async function archiveDropped(droppedList, file = ARCHIVE_FILE) {
  if (!Array.isArray(droppedList) || droppedList.length === 0) return 0;
  if (!existsSync(CAREER_DIR)) {
    await fs.mkdir(CAREER_DIR, { recursive: true });
  }
  const ts = new Date().toISOString();
  const lines = droppedList
    .map(({ job, rule_id, matched_value }) =>
      JSON.stringify({
        ts,
        job: {
          id: job.id,
          company: job.company,
          role: job.role,
          source: { type: job.source?.type, name: job.source?.name },
          url: job.url,
          location: job.location,
        },
        rule_id,
        matched_value,
      })
    )
    .join('\n') + '\n';
  await fs.appendFile(file, lines);
  return droppedList.length;
}
