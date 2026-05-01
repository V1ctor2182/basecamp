import { z } from 'zod';
import { createHash } from 'node:crypto';

export const SOURCE_TYPES = [
  'greenhouse',
  'ashby',
  'lever',
  'github-md',
  'scrape',
  'rss',
  'manual',
];

export const JobSourceSchema = z.object({
  type: z.enum(SOURCE_TYPES),
  name: z.string().max(200),
  url: z.string().url().nullable(),
});

export const JobCompHintSchema = z
  .object({
    min: z.number().nonnegative().optional(),
    max: z.number().nonnegative().optional(),
    currency: z.string().length(3).optional(),
    period: z.enum(['yr', 'mo', 'hr', 'wk']).optional(),
    raw: z.string().max(500).optional(),
  })
  .nullable();

export const JobSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{12}$/),
  source: JobSourceSchema,
  company: z.string().min(1).max(200),
  role: z.string().min(1).max(300),
  location: z.array(z.string().min(1)),
  url: z.string().url(),
  description: z.string().nullable(),
  posted_at: z.string().datetime().nullable(),
  scraped_at: z.string().datetime(),
  comp_hint: JobCompHintSchema,
  tags: z.array(z.string()),
  raw: z.unknown(),
  schema_version: z.literal(1),
  // Set true when 04-jd-enrich's 4-tier fallback fails to fill `description`
  // (no ATS API match, Playwright scrape failed/timed out). UI surfaces these
  // jobs in /career/shortlist/needs-manual for the user to paste JD manually.
  needs_manual_enrich: z.boolean().default(false),
});

export function slugify(s) {
  if (typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Server-only (uses node:crypto). Frontend should receive Job objects with id
// already filled by adapter; do not call from browser code.
export function hashJobId(company, role, sourceType, sourceNativeId) {
  const key = `${slugify(company)}::${slugify(role)}::${sourceType}::${sourceNativeId}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

const HTML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

export function stripHtml(html) {
  if (html == null) return null;
  if (typeof html !== 'string') return null;
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => HTML_ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseLocation(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const seen = new Map();
  for (const part of raw.split(/[;,/|]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  }
  return Array.from(seen.values());
}

export function normalizeJob(partial) {
  const filled = {
    tags: [],
    schema_version: 1,
    scraped_at: new Date().toISOString(),
    ...partial,
  };
  return JobSchema.parse(filled);
}
