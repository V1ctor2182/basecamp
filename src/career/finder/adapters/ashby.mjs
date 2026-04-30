import { httpFetch } from '../httpFetch.mjs';
import {
  hashJobId,
  normalizeJob,
  parseLocation,
  stripHtml,
} from '../../lib/jobSchema.mjs';

function toIsoUtc(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function buildLocations(raw) {
  const acc = [];
  if (raw.location) acc.push(raw.location);
  if (Array.isArray(raw.secondaryLocations)) {
    for (const s of raw.secondaryLocations) {
      if (typeof s === 'string') acc.push(s);
      else if (s && typeof s.locationName === 'string') acc.push(s.locationName);
    }
  }
  return parseLocation(acc.join(';'));
}

function buildTags(raw) {
  const out = [];
  for (const k of ['department', 'team', 'employmentType', 'workplaceType']) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  }
  if (raw.isRemote) out.push('Remote');
  return out;
}

export const ashbyAdapter = {
  type: 'ashby',
  async fetch({ slug }) {
    if (!slug) throw new Error('ashby adapter: missing config.slug');
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`;
    const res = await httpFetch(url, { maxBytes: 20 * 1024 * 1024, timeout: 60_000 });
    const data = res.json();
    return Array.isArray(data?.jobs) ? data.jobs : [];
  },
  normalize(raw, source) {
    const sourceUrl = `https://jobs.ashbyhq.com/${source.config.slug}`;
    return normalizeJob({
      id: hashJobId(source.name, raw.title ?? '', 'ashby', String(raw.id ?? '')),
      source: { type: 'ashby', name: source.name, url: sourceUrl },
      company: source.name,
      role: raw.title ?? '(untitled)',
      location: buildLocations(raw),
      url: raw.applyUrl || raw.jobUrl,
      description: stripHtml(raw.descriptionHtml ?? null),
      posted_at: toIsoUtc(raw.publishedAt),
      comp_hint: null,
      tags: buildTags(raw),
      raw,
    });
  },
};
