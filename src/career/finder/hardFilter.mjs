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
// Aliases are matched as full canonical-name substrings (handled by the
// `locationContains(loc, country)` path) plus the region map (US states /
// CA provinces, word-bounded). We deliberately do NOT loop these aliases
// against `loc.includes(alias)` — short aliases like "us" would substring-
// match unrelated locations such as "Sydney, Australia" → false positive.
const COUNTRY_ALIASES = {
  'united states': 'United States',
  'usa': 'United States',
  'us': 'United States',
  'u.s.': 'United States',
  'u.s.a.': 'United States',
  'canada': 'Canada',
};

const SENIORITY_RE = /\b(Intern|Internship|Junior|Jr\.?|IC[1-7]|Senior|Sr\.?|Staff|Principal|Lead|Director|VP|Head)\b/gi;

// Canonical normalization for matched seniority tokens. Comparison against
// allowed lists is case-insensitive, but archive.jsonl shows matched_value
// verbatim, so we keep human-readable canonical forms (VP, IC4, Senior).
function canonicalizeSeniority(token) {
  if (/^Jr\.?$/i.test(token)) return 'Junior';
  if (/^Sr\.?$/i.test(token)) return 'Senior';
  if (/^IC[1-7]$/i.test(token)) return token.toUpperCase();
  if (/^VP$/i.test(token)) return 'VP';
  if (/^Internship$/i.test(token)) return 'Internship';
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

// Returns ALL seniority tokens found in `role`, canonicalized. Used by the
// seniority hard-rule to honor "Senior Staff Engineer" when allowed=[Staff]
// (any one match is enough — conservative drop semantics).
export function extractSeniorities(role) {
  if (typeof role !== 'string' || !role) return [];
  const out = [];
  for (const m of role.matchAll(SENIORITY_RE)) out.push(canonicalizeSeniority(m[1]));
  return out;
}

// Backward-compat single-token API — returns the FIRST canonical seniority
// or null. Kept because m2 smoke uses it; new code should use extractSeniorities.
export function extractSeniority(role) {
  const all = extractSeniorities(role);
  return all.length > 0 ? all[0] : null;
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

// Country match: canonical-name substring OR region map (word-bounded
// US states / CA provinces). Short aliases like "us" are intentionally NOT
// fed back as substring matches — they would falsely match "Sydney, Australia"
// (austria contains "us"). Users typing "US" land on the canonical via
// COUNTRY_ALIASES → canonical, then hit the region map for state codes.
function locationMatchesAnyAllowedCountry(jobLocations, allowedCountries) {
  for (const loc of jobLocations) {
    for (const country of allowedCountries) {
      const canonical = COUNTRY_ALIASES[country.toLowerCase()] ?? country;
      if (locationContains(loc, canonical)) return country;
      if (locationHasRegionInCountry(loc, canonical)) return country;
    }
  }
  return null;
}

function locationMatchesDisallowedCountry(jobLocations, disallowed) {
  for (const country of disallowed) {
    for (const loc of jobLocations) {
      const canonical = COUNTRY_ALIASES[country.toLowerCase()] ?? country;
      if (locationContains(loc, canonical)) return country;
      if (locationHasRegionInCountry(loc, canonical)) return country;
    }
  }
  return null;
}

// Coerce arbitrary input to an array — anything that isn't already an array
// becomes []. The preview endpoint hands us unsaved form drafts (any shape),
// so every list-typed field is run through this gate to avoid `.map` /
// `.length` crashes on string / number / null inputs.
function asArr(v) {
  return Array.isArray(v) ? v : [];
}

// Returns { kept: bool, rule_id, matched_value } for a single Job.
export function applyHardFilter(job, prefs) {
  const hf = prefs?.hard_filters ?? {};

  // 1. source_filter
  const blockedSources = asArr(hf.source_filter?.blocked_sources);
  if (blockedSources.length > 0 && job.source?.type) {
    const blockedLower = blockedSources.map((s) => String(s).toLowerCase());
    if (blockedLower.includes(String(job.source.type).toLowerCase())) {
      return { kept: false, rule_id: 'source_filter', matched_value: job.source.type };
    }
  }

  // 2. company_blocklist
  const companyBlock = compileMatcher(asArr(hf.company_blocklist), 'contains', false);
  {
    const m = companyBlock(job.company);
    if (m) return { kept: false, rule_id: 'company_blocklist', matched_value: m };
  }

  // 3. title_blocklist
  const titleBlock = compileMatcher(asArr(hf.title_blocklist), 'contains', false);
  {
    const m = titleBlock(job.role);
    if (m) return { kept: false, rule_id: 'title_blocklist', matched_value: m };
  }

  // 4. title_allowlist (drop if non-empty AND no match)
  const allowList = asArr(hf.title_allowlist);
  if (allowList.length > 0) {
    const allow = compileMatcher(allowList, 'contains', false);
    const m = allow(job.role);
    if (!m) return { kept: false, rule_id: 'title_allowlist', matched_value: null };
  }

  // 5. location
  const allowedCities = asArr(hf.location?.allowed_cities);
  const allowedCountries = asArr(hf.location?.allowed_countries);
  const disallowedCountries = asArr(hf.location?.disallowed_countries);
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

  // 6. seniority — accept the job if ANY extracted token is in `allowed`
  // ("Senior Staff Engineer" with allowed=[Staff] keeps; conservative).
  const allowedSeniority = Array.isArray(hf.seniority?.allowed) ? hf.seniority.allowed : [];
  if (allowedSeniority.length > 0) {
    const extracted = extractSeniorities(job.role);
    if (extracted.length > 0) {
      const allowedLower = new Set(allowedSeniority.map((s) => String(s).toLowerCase()));
      const anyAllowed = extracted.some((tok) => allowedLower.has(tok.toLowerCase()));
      if (!anyAllowed) {
        return { kept: false, rule_id: 'seniority', matched_value: extracted.join(', ') };
      }
    }
    // No tokens extracted → keep (conservative, unknown seniority).
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
  const jdBlock = compileMatcher(asArr(hf.jd_text_blocklist), 'contains', false);
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

// Append-only jsonl. Each archived job carries enough context to debug *why*
// it was dropped without re-loading anything. Each record is appended in its
// own fs.appendFile call to keep individual writes under PIPE_BUF (atomic on
// POSIX) — multi-MB single-call appends can be torn by crashes / concurrent
// readers. Per-record ts also makes "when was this dropped" precise.
export async function archiveDropped(droppedList, file = ARCHIVE_FILE) {
  if (!Array.isArray(droppedList) || droppedList.length === 0) return 0;
  const dir = path.dirname(file);
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }
  let written = 0;
  for (const { job, rule_id, matched_value } of droppedList) {
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        job: {
          id: job.id,
          company: job.company,
          role: job.role,
          source: { type: job.source?.type, name: job.source?.name },
          url: job.url,
          location: job.location,
          scraped_at: job.scraped_at ?? null,
        },
        rule_id,
        matched_value,
      }) + '\n';
    await fs.appendFile(file, line);
    written++;
  }
  return written;
}
