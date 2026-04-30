// Manual paste "adapter" — not a fetch-based source, but a single-job entry
// point. User pastes a URL (and optionally title/note). We try to extract the
// page <title> via cheerio when no title is given, and emit a Job with
// description=null (defer body extraction to 04-jd-enrich).

import * as cheerio from 'cheerio';

import { httpFetch } from '../httpFetch.mjs';
import {
  hashJobId,
  normalizeJob,
} from '../../lib/jobSchema.mjs';

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

async function fetchTitle(url) {
  try {
    const res = await httpFetch(url, { maxBytes: 1_048_576, timeout: 10_000 });
    const $ = cheerio.load(res.text);
    const t = $('title').first().text().trim();
    return t || null;
  } catch {
    return null;
  }
}

// Returns a Job-shaped object ready for pipeline.json append. Throws on
// invalid url. Optional `title` and `note` come from caller; if title not
// given we attempt extraction (best-effort, OK to fail).
export async function manualPaste({ url, title, note }) {
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('manualPaste: url required');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('manualPaste: invalid url');
  }
  const hostname = hostnameFromUrl(url);

  let resolvedTitle = (typeof title === 'string' && title.trim()) ? title.trim() : null;
  if (!resolvedTitle) {
    resolvedTitle = await fetchTitle(url);
  }
  const role = resolvedTitle && resolvedTitle.length > 0 ? resolvedTitle : '(untitled — manual paste)';
  const company = hostname || '(unknown)';

  return normalizeJob({
    id: hashJobId(company, role, 'manual', parsed.toString()),
    source: { type: 'manual', name: 'Manual paste', url: parsed.toString() },
    company,
    role,
    location: [],
    url: parsed.toString(),
    description: null,
    posted_at: null,
    comp_hint: null,
    tags: ['enriched_via:manual_pending'],
    raw: { url, title: title ?? null, note: note ?? null, hostname },
  });
}
