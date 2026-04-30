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

function extractTags(metadata) {
  if (!Array.isArray(metadata)) return [];
  const out = [];
  for (const m of metadata) {
    if (!m) continue;
    const v = m.value;
    if (typeof v === 'string' && v.trim()) {
      out.push(v.trim());
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string' && item.trim()) out.push(item.trim());
      }
    }
  }
  return out;
}

export const greenhouseAdapter = {
  type: 'greenhouse',
  async fetch({ slug }) {
    if (!slug) throw new Error('greenhouse adapter: missing config.slug');
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
    // ATS payloads can be large (Anthropic ~1MB, larger boards push 5MB+).
    const res = await httpFetch(url, { maxBytes: 20 * 1024 * 1024, timeout: 30_000 });
    const data = res.json();
    return Array.isArray(data?.jobs) ? data.jobs : [];
  },
  normalize(raw, source) {
    const sourceUrl = `https://boards.greenhouse.io/${source.config.slug}`;
    const description = stripHtml(raw.content ?? null);
    return normalizeJob({
      id: hashJobId(source.name, raw.title ?? '', 'greenhouse', String(raw.id ?? '')),
      source: { type: 'greenhouse', name: source.name, url: sourceUrl },
      company: source.name,
      role: raw.title ?? '(untitled)',
      location: parseLocation(raw.location?.name ?? ''),
      url: raw.absolute_url,
      description,
      posted_at: toIsoUtc(raw.first_published ?? raw.updated_at),
      comp_hint: null,
      tags: extractTags(raw.metadata),
      raw,
    });
  },
};
