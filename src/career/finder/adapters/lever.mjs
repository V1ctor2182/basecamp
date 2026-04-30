import { httpFetch } from '../httpFetch.mjs';
import {
  hashJobId,
  normalizeJob,
  parseLocation,
} from '../../lib/jobSchema.mjs';

function toIsoUtc(value) {
  if (value == null) return null;
  // Lever createdAt is a unix-ms number; can also be ISO string on other boards.
  const d = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function buildLocations(raw) {
  const cats = raw.categories ?? {};
  const acc = [];
  if (typeof cats.location === 'string') acc.push(cats.location);
  if (Array.isArray(cats.allLocations)) {
    for (const s of cats.allLocations) if (typeof s === 'string') acc.push(s);
  }
  return parseLocation(acc.join(';'));
}

function buildTags(raw) {
  const cats = raw.categories ?? {};
  const out = [];
  for (const k of ['commitment', 'department', 'team']) {
    const v = cats[k];
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  }
  if (typeof raw.workplaceType === 'string') out.push(raw.workplaceType);
  return out;
}

function buildCompHint(raw) {
  const sr = raw.salaryRange;
  if (!sr || typeof sr !== 'object') return null;
  const out = {};
  if (typeof sr.min === 'number') out.min = sr.min;
  if (typeof sr.max === 'number') out.max = sr.max;
  if (typeof sr.currency === 'string' && sr.currency.length === 3) out.currency = sr.currency;
  const interval = sr.interval ?? sr.period;
  if (typeof interval === 'string') {
    const i = interval.toLowerCase();
    if (i.startsWith('year')) out.period = 'yr';
    else if (i.startsWith('month')) out.period = 'mo';
    else if (i.startsWith('hour')) out.period = 'hr';
    else if (i.startsWith('week')) out.period = 'wk';
  }
  if (typeof raw.salaryDescriptionPlain === 'string') {
    const s = raw.salaryDescriptionPlain.trim();
    if (s) out.raw = s.slice(0, 500);
  }
  return Object.keys(out).length > 0 ? out : null;
}

export const leverAdapter = {
  type: 'lever',
  async fetch({ slug }) {
    if (!slug) throw new Error('lever adapter: missing config.slug');
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
    const res = await httpFetch(url, { maxBytes: 20 * 1024 * 1024, timeout: 60_000 });
    const data = res.json();
    return Array.isArray(data) ? data : [];
  },
  normalize(raw, source) {
    const sourceUrl = `https://jobs.lever.co/${source.config.slug}`;
    const description = (typeof raw.descriptionPlain === 'string' && raw.descriptionPlain.trim())
      ? raw.descriptionPlain.trim()
      : null;
    return normalizeJob({
      id: hashJobId(source.name, raw.text ?? '', 'lever', String(raw.id ?? '')),
      source: { type: 'lever', name: source.name, url: sourceUrl },
      company: source.name,
      role: raw.text ?? '(untitled)',
      location: buildLocations(raw),
      url: raw.applyUrl || raw.hostedUrl,
      description,
      posted_at: toIsoUtc(raw.createdAt),
      comp_hint: buildCompHint(raw),
      tags: buildTags(raw),
      raw,
    });
  },
};
