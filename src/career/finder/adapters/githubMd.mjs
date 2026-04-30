// SimplifyJobs / speedyapply / similar GitHub repos publish job listings
// inside README.md as HTML <table>. Each <tr> is one job; col layout:
//   1. Company (<strong><a>...</a></strong>) — '↳' means "same as prev row"
//   2. Role text — may include flags / emoji markers (🔒 closed, 🔥 FAANG+ etc.)
//   3. Location plain text
//   4. Application — multiple <a>; first non-simplify.jobs link is the canonical apply URL
//   5. Age relative ("0d" "5d" "2h") — converted to ISO via posted-at = now - age

import * as cheerio from 'cheerio';

import { httpFetch } from '../httpFetch.mjs';
import {
  hashJobId,
  normalizeJob,
  parseLocation,
} from '../../lib/jobSchema.mjs';

const CONTINUATION_MARKER = '↳';
const CLOSED_MARKERS = ['🔒'];
// Emoji clutter we strip from role / company text. Substring removal — anything
// not in this list passes through unchanged.
const STRIP_MARKERS = ['🔥', '🎓', '🔒', '🇺🇸', '🇨🇦', '🇬🇧', '🇲🇽'];

function cleanText(s) {
  if (typeof s !== 'string') return '';
  let out = s;
  for (const m of STRIP_MARKERS) out = out.split(m).join('');
  return out.replace(/\s+/g, ' ').trim();
}

function isClosedRole(roleText) {
  return CLOSED_MARKERS.some((m) => roleText.includes(m));
}

function pickApplyUrl($, cellEl) {
  const links = $(cellEl).find('a[href]');
  let firstHref = null;
  let nonSimplify = null;
  links.each((_i, a) => {
    const href = $(a).attr('href');
    if (!href) return;
    if (!firstHref) firstHref = href;
    if (!nonSimplify && !/simplify\.jobs/i.test(href)) nonSimplify = href;
  });
  return nonSimplify || firstHref;
}

function parseAgeToIsoUtc(ageText, nowMs) {
  if (!ageText) return null;
  const m = ageText.trim().match(/^(\d+)\s*([dhmw])/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const ms =
    unit === 'h' ? n * 3_600_000 :
    unit === 'd' ? n * 86_400_000 :
    unit === 'w' ? n * 604_800_000 :
    unit === 'm' ? n * 30 * 86_400_000 :
    0;
  return new Date(nowMs - ms).toISOString();
}

// Extracts rows from any <table> inside the markdown file. Returns array of
// { companyRaw, role, location, applyUrl, age } before we drop closed / inherit
// continuations. Exported for unit testing.
export function parseGithubMdTable(md) {
  const htmlRows = parseHtmlTable(md);
  if (htmlRows.length > 0) return htmlRows;
  return parseMarkdownPipeTable(md);
}

function parseHtmlTable(md) {
  const $ = cheerio.load(md);
  const rows = [];
  $('table tr').each((_i, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 4) return;
    const companyRaw = cleanText(cells.eq(0).text());
    const role = cleanText(cells.eq(1).text());
    const location = cleanText(cells.eq(2).text());
    const applyUrl = pickApplyUrl($, cells.eq(3));
    const age = cells.length > 4 ? cleanText(cells.eq(4).text()) : '';
    rows.push({
      companyRaw,
      role,
      location,
      applyUrl,
      age,
      _roleHasLock: isClosedRole(cells.eq(1).text()),
    });
  });
  return rows;
}

// Parses markdown pipe tables (| col1 | col2 | ... |). Cell contents may
// contain inline HTML; we wrap each cell in cheerio to extract text + hrefs.
// Column layout assumption: col 1 = company, col 2 = role, col 3 = location,
// LAST col = age, and the apply URL lives in some cell with <a href> that's
// not the company link. We pick the apply cell as the cell containing the
// most recent <a> before the age column (typically col 4 or 5).
function parseMarkdownPipeTable(md) {
  const lines = md.split(/\r?\n/);
  const rows = [];
  let headerSeen = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
      // outside any table; reset header flag if we leave a table block
      if (headerSeen && trimmed === '') headerSeen = false;
      continue;
    }
    // Separator line: | --- | --- | ...
    if (/^\|\s*[-:]+\s*(\|\s*[-:]+\s*)+\|$/.test(trimmed)) {
      headerSeen = true;
      continue;
    }
    // Skip header-like row before separator (we don't want it in data set).
    if (!headerSeen) continue;

    const cells = trimmed.slice(1, -1).split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    const companyCell = cells[0];
    const roleCell = cells[1];
    const locationCell = cells[2];
    const ageCell = cells[cells.length - 1];
    // Apply cell: the cell between location and age that contains an <a href>.
    let applyCell = '';
    for (let i = cells.length - 2; i >= 3; i--) {
      if (/<a\s+[^>]*href=/i.test(cells[i])) {
        applyCell = cells[i];
        break;
      }
    }

    const companyRaw = cleanText(textFromCell(companyCell));
    const role = cleanText(textFromCell(roleCell));
    const location = cleanText(textFromCell(locationCell));
    const age = cleanText(textFromCell(ageCell));
    const applyUrl = pickFirstNonSimplifyHref(applyCell || cells[1]);
    rows.push({
      companyRaw,
      role,
      location,
      applyUrl,
      age,
      _roleHasLock: isClosedRole(roleCell),
    });
  }
  return rows;
}

function textFromCell(cellHtml) {
  // Strip tags but preserve text. Cheerio is heavy for one cell; use regex.
  return cellHtml.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
}

function pickFirstNonSimplifyHref(cellHtml) {
  if (!cellHtml) return null;
  const matches = [...cellHtml.matchAll(/<a\s+[^>]*href="([^"]+)"/gi)];
  let firstHref = null;
  for (const m of matches) {
    const href = m[1];
    if (!firstHref) firstHref = href;
    if (!/simplify\.jobs/i.test(href)) return href;
  }
  return firstHref;
}

export const githubMdAdapter = {
  type: 'github-md',
  async fetch({ owner, repo, path = 'README.md', branch = 'main' }) {
    if (!owner || !repo) throw new Error('github-md adapter: missing config.owner or config.repo');
    // Try the configured branch first, then fall back to common defaults.
    const branches = Array.from(new Set([branch, 'dev', 'main', 'master']));
    let lastErr = null;
    for (const b of branches) {
      const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(b)}/${path}`;
      try {
        const res = await httpFetch(url, { maxBytes: 5 * 1024 * 1024, timeout: 30_000 });
        return parseGithubMdTable(res.text).map((r) => ({ ...r, _branch: b }));
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error('github-md adapter: no branch worked');
  },
  normalize(raw, source) {
    // Continuation: '↳' company → inherit from previous. Adapter callers do
    // not see continuations because we resolve here using a closure inside
    // fetch... but each raw is independent at normalize time. Resolution
    // happens in the wrapper below at fetch call time.
    const company = raw.company ?? raw.companyRaw;
    if (!company || raw._closed) {
      throw new Error('github-md: row should have been filtered (closed or no company)');
    }
    if (!raw.applyUrl) {
      throw new Error('github-md: row missing applyUrl');
    }
    const sourceUrl = `https://github.com/${source.config.owner}/${source.config.repo}`;
    const role = raw.role || '(untitled)';
    return normalizeJob({
      id: hashJobId(company, role, 'github-md', `${source.config.repo}::${raw.applyUrl}`),
      source: { type: 'github-md', name: source.name, url: sourceUrl },
      company,
      role,
      location: parseLocation(raw.location ?? ''),
      url: raw.applyUrl,
      description: null,                              // defer to 04-jd-enrich
      posted_at: parseAgeToIsoUtc(raw.age, Date.now()),
      comp_hint: null,
      tags: [],
      raw,
    });
  },
};

// Wrap fetch to resolve continuation rows + drop closed/incomplete entries
// before they hit normalize. We replace the adapter's fetch with a version
// that does this post-processing, so the scanRunner's per-raw normalize
// never sees half-baked rows.
const innerFetch = githubMdAdapter.fetch;
githubMdAdapter.fetch = async function (config) {
  const rows = await innerFetch.call(this, config);
  const out = [];
  let prevCompany = null;
  for (const row of rows) {
    let company = row.companyRaw;
    if (company === CONTINUATION_MARKER) {
      company = prevCompany;
    } else {
      prevCompany = company;
    }
    if (row._roleHasLock) continue;       // closed role → skip
    if (!company) continue;               // no inherited company yet → skip
    if (!row.applyUrl) continue;          // no apply link → skip
    out.push({ ...row, company });
  }
  return out;
};
