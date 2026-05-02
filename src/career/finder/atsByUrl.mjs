// ATS-by-URL refetch — given a Job.url, detect which ATS hosts the posting
// and call its content endpoint to retrieve the full description.
//
// 6 supported ATS providers:
//   greenhouse, ashby, lever, recruitee, smartrecruiters — full fetch path
//   workday — DETECT-ONLY (token auth too fragile for a generic fetcher);
//             returns { skip: true } so the orchestrator (m3) falls through
//             to the Playwright scraper instead.
//
// Every fetcher is "best effort": HTTP error, robots block, malformed body, or
// missing description field → return null (with optional `error` string for
// logging). Never throws. The orchestrator decides the next tier on null.
//
// Server-only (uses node:fetch via httpFetch). Do NOT import from browser code.

import { httpFetch } from './httpFetch.mjs';
import { stripHtml } from '../lib/jobSchema.mjs';

// ── URL detection ────────────────────────────────────────────────────────
// Each pattern captures the slug + native job id from the URL. Patterns are
// intentionally permissive about trailing slashes / query strings / fragments
// (URL parsing handles those before regex match).

const PATTERNS = [
  {
    type: 'greenhouse',
    // boards.greenhouse.io/<slug>/jobs/<id>
    // job-boards.greenhouse.io/<slug>/jobs/<id>
    // <slug>.boards.greenhouse.io/jobs/<id>
    test: (u) =>
      /(?:^|\.)(?:job-)?boards\.greenhouse\.io$/.test(u.host) ||
      /^boards\.greenhouse\.io$/.test(u.host),
    parse: (u) => {
      // Subdomain form: <slug>.boards.greenhouse.io/jobs/<id>
      const subM = u.host.match(/^([^.]+)\.boards\.greenhouse\.io$/);
      if (subM) {
        const idM = u.pathname.match(/^\/jobs\/([^/]+)/);
        return idM ? { slug: subM[1], id: idM[1] } : null;
      }
      // Path form: /<slug>/jobs/<id>
      const m = u.pathname.match(/^\/([^/]+)\/jobs\/([^/]+)/);
      return m ? { slug: m[1], id: m[2] } : null;
    },
  },
  {
    type: 'ashby',
    // jobs.ashbyhq.com/<slug>/<uuid>[/application]
    test: (u) => u.host === 'jobs.ashbyhq.com',
    parse: (u) => {
      const m = u.pathname.match(/^\/([^/]+)\/([a-f0-9-]{8,})/i);
      return m ? { slug: m[1], id: m[2] } : null;
    },
  },
  {
    type: 'lever',
    // jobs.lever.co/<slug>/<uuid>[/apply]
    test: (u) => u.host === 'jobs.lever.co',
    parse: (u) => {
      const m = u.pathname.match(/^\/([^/]+)\/([a-f0-9-]{8,})/i);
      return m ? { slug: m[1], id: m[2] } : null;
    },
  },
  {
    type: 'recruitee',
    // <slug>.recruitee.com/o/<offer-slug>
    test: (u) => /\.recruitee\.com$/.test(u.host),
    parse: (u) => {
      const subM = u.host.match(/^([^.]+)\.recruitee\.com$/);
      if (!subM) return null;
      const m = u.pathname.match(/^\/o\/([^/]+)/);
      return m ? { slug: subM[1], id: m[1] } : null;
    },
  },
  {
    type: 'smartrecruiters',
    // jobs.smartrecruiters.com/<company>/<postingId>[-<seo-slug>]
    test: (u) => u.host === 'jobs.smartrecruiters.com',
    parse: (u) => {
      // postingId is numeric, may be followed by `-<seo-slug>`. Capture digits.
      const m = u.pathname.match(/^\/([^/]+)\/(\d+)(?:-[^/]*)?/);
      return m ? { slug: m[1], id: m[2] } : null;
    },
  },
  {
    type: 'workday',
    // <tenant>.<region>.myworkdayjobs.com/...
    // Workday public API requires session-bound tokens per tenant — far too
    // fragile to build into a generic fetcher. Detect for telemetry, but
    // signal `skip` so the orchestrator goes straight to Playwright.
    test: (u) => /\.myworkdayjobs\.com$/.test(u.host),
    parse: (u) => {
      const subM = u.host.match(/^([^.]+)\..+\.myworkdayjobs\.com$/);
      // We don't need slug/id since we won't fetch — but capturing tenant
      // helps debug logs.
      return subM ? { slug: subM[1], id: u.pathname } : null;
    },
  },
];

// Returns { type, slug, id } or null. Never throws.
export function detectAtsType(url) {
  if (typeof url !== 'string' || !url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  for (const p of PATTERNS) {
    if (!p.test(u)) continue;
    const parsed = p.parse(u);
    if (parsed && parsed.slug && parsed.id) {
      return { type: p.type, slug: parsed.slug, id: parsed.id };
    }
    // Hostname matched but URL shape didn't — return null (orchestrator
    // falls back to Playwright on the original URL).
    return null;
  }
  return null;
}

// ── Per-ATS content fetchers ─────────────────────────────────────────────
// Each fetcher: ({ slug, id }) → { description: string|null, error?: string }.
// Never throws. Hard timeout 15s (constraint-jd-enrich-001).

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BYTES = 10 * 1024 * 1024;

async function fetchGreenhouseContent({ slug, id }) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(id)}?questions=true`;
  try {
    const res = await httpFetch(url, { timeout: FETCH_TIMEOUT_MS, maxBytes: FETCH_MAX_BYTES });
    const data = res.json();
    const description = stripHtml(data?.content ?? null);
    return { description: description || null };
  } catch (e) {
    return { description: null, error: String(e?.message ?? e).slice(0, 200) };
  }
}

async function fetchAshbyContent({ slug, id }) {
  // Ashby's posting-api returns the entire board; filter by id locally.
  // Less efficient than a per-job endpoint, but Ashby doesn't expose one
  // publicly. Boards are cached by Ashby's CDN, so cost is acceptable.
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`;
  try {
    const res = await httpFetch(url, { timeout: FETCH_TIMEOUT_MS, maxBytes: FETCH_MAX_BYTES });
    const data = res.json();
    const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
    const match = jobs.find((j) => String(j?.id ?? '') === String(id));
    if (!match) return { description: null, error: 'job-id not found in board' };
    const description = stripHtml(match.descriptionHtml ?? null);
    return { description: description || null };
  } catch (e) {
    return { description: null, error: String(e?.message ?? e).slice(0, 200) };
  }
}

async function fetchLeverContent({ slug, id }) {
  // Single-posting endpoint exists — much cheaper than refetching board.
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}/${encodeURIComponent(id)}?mode=json`;
  try {
    const res = await httpFetch(url, { timeout: FETCH_TIMEOUT_MS, maxBytes: FETCH_MAX_BYTES });
    const data = res.json();
    const plain =
      typeof data?.descriptionPlain === 'string' && data.descriptionPlain.trim()
        ? data.descriptionPlain.trim()
        : null;
    if (plain) return { description: plain };
    const html = stripHtml(data?.description ?? null);
    return { description: html || null };
  } catch (e) {
    return { description: null, error: String(e?.message ?? e).slice(0, 200) };
  }
}

async function fetchRecruiteeContent({ slug, id }) {
  // Public single-offer endpoint; offer-slug works as id.
  const url = `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/${encodeURIComponent(id)}`;
  try {
    const res = await httpFetch(url, { timeout: FETCH_TIMEOUT_MS, maxBytes: FETCH_MAX_BYTES });
    const data = res.json();
    const offer = data?.offer ?? data;
    const description = stripHtml(offer?.description ?? null);
    return { description: description || null };
  } catch (e) {
    return { description: null, error: String(e?.message ?? e).slice(0, 200) };
  }
}

async function fetchSmartRecruitersContent({ slug, id }) {
  // Public posting endpoint. Description is in jobAd.sections.{jobDescription,
  // qualifications, additionalInformation}.text — concat for a fuller JD.
  const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings/${encodeURIComponent(id)}`;
  try {
    const res = await httpFetch(url, { timeout: FETCH_TIMEOUT_MS, maxBytes: FETCH_MAX_BYTES });
    const data = res.json();
    const sections = data?.jobAd?.sections ?? {};
    const parts = [];
    for (const k of ['jobDescription', 'qualifications', 'additionalInformation']) {
      const t = sections?.[k]?.text;
      if (typeof t === 'string' && t.trim()) parts.push(t.trim());
    }
    const description = parts.length > 0 ? stripHtml(parts.join('\n\n')) : null;
    return { description: description || null };
  } catch (e) {
    return { description: null, error: String(e?.message ?? e).slice(0, 200) };
  }
}

const FETCHERS = {
  greenhouse: fetchGreenhouseContent,
  ashby: fetchAshbyContent,
  lever: fetchLeverContent,
  recruitee: fetchRecruiteeContent,
  smartrecruiters: fetchSmartRecruitersContent,
};

// Public orchestrator — given a detection result, fetch the content. Returns
// { description: string|null, error?: string } or { skip: true } for Workday.
export async function refetchAtsContent(detection) {
  if (!detection || typeof detection !== 'object') {
    return { description: null, error: 'no detection' };
  }
  if (detection.type === 'workday') return { skip: true };
  const fetcher = FETCHERS[detection.type];
  if (!fetcher) return { description: null, error: `unsupported type: ${detection.type}` };
  return fetcher({ slug: detection.slug, id: detection.id });
}

// True if the job already has enough description that we should skip enrich.
// 500-char threshold matches the locked design from spec.md.
export function shouldEnrich(job) {
  if (!job || typeof job !== 'object') return false;
  const d = job.description;
  if (typeof d === 'string' && d.length > 500) return false;
  return true;
}
