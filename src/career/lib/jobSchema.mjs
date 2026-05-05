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

// Stage A (Haiku) per-Job evaluation result. Written by 06-evaluator/01's
// POST /api/career/evaluate/stage-a endpoint. Status 'archived' means the
// score fell below prefs.thresholds.skip_below — the entry is preserved so
// the user can review LLM reasoning and "Force Sonnet" via the UI.
export const EvaluationStageASchema = z
  .object({
    score: z.number().min(1).max(5).nullable().optional(),
    reason: z.string().max(2000).nullable().optional(),
    model: z.string().max(100),
    evaluated_at: z.string().datetime(),
    cost_usd: z.number().nonnegative(),
    status: z.enum(['evaluated', 'archived', 'error']),
    error: z.string().max(500).optional(),
  })
  .nullable()
  .default(null);

// Stage B (Sonnet) per-Job evaluation result. Written by 06-evaluator/02's
// POST /api/career/evaluate/stage-b endpoint. Status enum has NO 'archived' —
// Stage B's threshold gate (only stage_a passers deserve a $0.30 deep eval)
// lives at the endpoint level, not in the runner.
//
// `report_path` is the relative path to the rendered markdown report
// (data/career/reports/{jobId}.md). Null on error rows.
// `web_search_requests` counts hosted web_search_20250305 calls (pricing
// deferred to 04-budget-gate; 0 today).
export const EvaluationStageBSchema = z
  .object({
    total_score: z.number().min(1).max(5).nullable(),
    report_path: z.string().nullable(),
    blocks_emitted: z.array(z.string()).default([]),
    model: z.string().max(100),
    evaluated_at: z.string().datetime(),
    cost_usd: z.number().nonnegative(),
    web_search_requests: z.number().int().nonnegative().default(0),
    tool_rounds_used: z.number().int().nonnegative().default(0),
    status: z.enum(['evaluated', 'error']),
    error: z.string().max(500).optional(),
  })
  .nullable()
  .default(null);

// Wraps stage_a + stage_b. Future stages add sibling fields here without
// touching the main JobSchema. Existing pipeline.json jobs without these
// fields coerce to null via the inner default.
export const EvaluationSchema = z
  .object({
    stage_a: EvaluationStageASchema,
    stage_b: EvaluationStageBSchema,
  })
  .nullable()
  .default(null);

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
  // Per-stage evaluation results. Existing pipeline.json jobs without this
  // field load as null (Zod default). Future stages add sibling fields
  // without touching the main JobSchema.
  evaluation: EvaluationSchema,
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
