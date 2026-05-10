// Mode 1 draft prompt builder + parser. Single Sonnet call that consumes
// the JD + Stage B Block A/E + qa-bank inputs and emits a structured field
// list per draftsStore.mjs DraftSchema.
//
// Locked from plan: SINGLE Sonnet call (not 2-pass extract-then-fill —
// Block E already does the personalization heavy lifting). 4-class
// taxonomy hardcoded in instructions: hard / legal / open / file.
//
// System block carries qa-bank inputs + Block E + identity + history.jsonl
// few-shot — all marked cache_control:ephemeral on a SINGLE text block
// (matches Stage A m1 + Stage B m1 single-cache-block pattern).

import { FIELD_CLASSES, CONFIDENCE_TIERS, DraftFieldSchema } from './draftsStore.mjs';

export const APPLIER_MODEL = 'claude-sonnet-4-6';

// Canonical 8-10 ATS open-ended questions. The runner asks Sonnet to emit
// these PLUS any JD-specific bonus questions. Order matters for stable
// snapshot tests — Sonnet may reorder, so the parser is order-tolerant.
export const CANONICAL_QUESTIONS = Object.freeze([
  // hard / identity-driven (will be classified 'hard' or 'legal' by Sonnet)
  'Full name',
  'Email',
  'Phone',
  'Authorized to work in the United States?',
  'Will you require visa sponsorship now or in the future?',
  'Years of relevant experience',
  // open-ended (LLM-drafted using Block E + templates)
  'Why are you interested in this company?',
  'Why this role?',
  'Tell me about a time you solved a hard problem.',
  'Expected salary / compensation expectations',
  // file
  'Resume / CV upload',
]);

// 4-class taxonomy + confidence rubric. Inlined into the system prompt so
// Sonnet knows exactly what each value means.
const TAXONOMY_DOC = [
  'OUTPUT FIELDS — each has 5 keys: { "label", "class", "suggested_value", "confidence", "source_ref" }',
  '',
  'CLASSES (pick one per field):',
  '  hard   — factual, sourced from the candidate identity (name/email/phone/years).',
  '           confidence: high if identity.yml provides it; low if absent.',
  '  legal  — visa, EEO, comp expectations. ALWAYS sourced VERBATIM from qa-bank/legal.yml.',
  '           confidence: high. source_ref MUST be "qa-bank/legal.yml#<key>".',
  '  open   — Why us / Why role / STAR / cover letter — LLM-drafted from Block E + templates.md.',
  '           confidence: high if Block E or templates have a strong match; medium if generic; low if Block E missing.',
  '  file   — resume PDF upload reference. ALWAYS one entry pointing to the tailored PDF path.',
  '           confidence: high. source_ref MUST be "data/career/output/{jobId}-{resumeId}.pdf" (caller fills resumeId).',
  '',
  'CONFIDENCE: pick exactly one of "high" / "medium" / "low".',
  '  high   — value comes from a deterministic source (identity.yml / legal.yml / output PDF) OR the LLM has direct evidence in Block E.',
  '  medium — LLM had partial evidence (templates filled, some variables guessed).',
  '  low    — LLM had little/no evidence; user MUST review.',
  '',
  'OUTPUT FORMAT — emit ONE JSON object on its own (no markdown code fence):',
  '  { "fields": [{ "label": "...", "class": "...", "suggested_value": "...", "confidence": "...", "source_ref": "..." }, ...] }',
  'Field order can be: hard fields first, then legal, then open, then file. The caller is order-tolerant.',
].join('\n');

const DRAFT_INSTRUCTIONS_HEAD = [
  'You are an applier-draft assistant. The candidate has shortlisted a job',
  'and wants you to pre-fill the typical ATS form fields so they can copy/',
  'paste into the browser. You DO NOT submit anything — your job is purely',
  'to draft suggested values that the user will edit + paste manually.',
  '',
  TAXONOMY_DOC,
  '',
  'GUIDELINES:',
  '- Be specific. Cite Block E and the JD by paraphrase, not generic platitudes.',
  '- For "Why us" / "Why role": ground in 1-2 concrete details from the JD',
  '  AND the candidate\'s narrative.md / proof-points.md identified in Block E.',
  '- For STAR-type questions: pick one proof-point that maps to the JD\'s',
  '  most-emphasized requirement; structure the answer as Situation/Task/',
  '  Action/Result/Reflection in 80-120 words.',
  '- Salary expectations: read qa-bank/legal.yml#salary_expectations VERBATIM.',
  '  If the YAML field is missing or empty, output suggested_value="" and',
  '  confidence="low" with source_ref="qa-bank/legal.yml#salary_expectations".',
  '- Visa/auth questions: read legal.yml#work_authorization VERBATIM. If a',
  '  field within the section is unset (e.g. "FILL_IN" placeholder), still',
  '  emit the field with confidence="low" so the user knows to fix it.',
  '- Resume upload: emit ONE field {label:"Resume / CV upload", class:"file",',
  '  suggested_value:"<pdfPath>", confidence:"high", source_ref:"<pdfPath>"}.',
  '  The pdfPath is provided in the user message header.',
  '- Do NOT invent contact info, school dates, or anything not in identity.yml.',
  '  Mark missing-identity fields with confidence="low" and an empty',
  '  suggested_value rather than guessing.',
  '- Output JSON only — no preamble, no code fence, no trailing commentary.',
].join('\n');

// Trim long text with an ellipsis so the cached system block stays bounded.
// Pattern matches stageBPrompt.mjs.
function trim(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

// Format a recent qa-bank/history.jsonl entry for few-shot context.
// Schema: { ts, jobId, label, final_answer, class } (per applier m4 append
// shape). Older Stage B-style {question, answer} entries also tolerated.
function formatHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  // Applier-shape entries (post-m4)
  if (typeof entry.label === 'string' && typeof entry.final_answer === 'string') {
    const cls = typeof entry.class === 'string' ? ` [${entry.class}]` : '';
    return `**${trim(entry.label, 200)}**${cls}\n${trim(entry.final_answer, 600)}`;
  }
  // Legacy QA-shape entries
  const q = entry?.question ?? '';
  const a = entry?.answer ?? '';
  if (!q && !a) return null;
  return `**Q:** ${trim(String(q).trim(), 300)}\n**A:** ${trim(String(a).trim(), 600)}`;
}

function renderHistoryFewShot(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return '(qa-bank/history.jsonl is empty — no submitted-answer examples available)';
  }
  const lines = history
    .slice(0, 5) // cap at 5 most recent
    .map(formatHistoryEntry)
    .filter((s) => s !== null);
  if (lines.length === 0) return '(history.jsonl entries malformed — skipped)';
  return lines.join('\n\n---\n\n');
}

// Render legal.yml as a flat key-path list for the prompt. The store reads
// the YAML and passes it parsed; we serialize back to a key:value layout
// Sonnet can grep. Keys are dot-separated for the source_ref convention
// "qa-bank/legal.yml#<key>".
function flattenLegal(legalObj, prefix = '') {
  const out = [];
  if (!legalObj || typeof legalObj !== 'object') return out;
  for (const [k, v] of Object.entries(legalObj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenLegal(v, path));
    } else {
      out.push(`${path}: ${JSON.stringify(v)}`);
    }
  }
  return out;
}

function renderLegalSection(legalObj) {
  const flat = flattenLegal(legalObj);
  if (flat.length === 0) return '(qa-bank/legal.yml is empty — emit "low" confidence for legal fields)';
  return flat.join('\n');
}

// Build the cache-eligible system block. SINGLE text block per locked
// design (matches Stage A m1 + Stage B m1 pattern).
//
// bundle = {
//   reportText:   markdown report from data/career/reports/{jobId}.md
//                 (used for Block A/E inference)
//   legalYml:     parsed qa-bank/legal.yml object
//   templatesText: raw qa-bank/templates.md content
//   identityYml:  parsed identity.yml object
//   qaHistory:    array of recent qa-bank/history.jsonl entries
// }
//
// CONTRACT: qaHistory MUST be ordered newest-first. We slice(0, 5) to cap
// at the 5 most-recent entries, so the caller (m4 endpoint) is responsible
// for reading + reversing history.jsonl (which is appended chronologically).
export function buildSystemBlock(bundle) {
  const reportText = trim(bundle?.reportText ?? '', 8000);
  const templatesText = trim(bundle?.templatesText ?? '', 4000);
  const legalSection = renderLegalSection(bundle?.legalYml);
  const identitySection = trim(
    typeof bundle?.identityYml === 'object' && bundle.identityYml !== null
      ? JSON.stringify(bundle.identityYml, null, 2)
      : '',
    2000
  );
  const historySection = renderHistoryFewShot(bundle?.qaHistory);

  const text = [
    DRAFT_INSTRUCTIONS_HEAD,
    '',
    'CANONICAL QUESTIONS (emit a field for each that applies; add JD-specific bonus questions if the JD demands them):',
    CANONICAL_QUESTIONS.map((q, i) => `  ${i + 1}. ${q}`).join('\n'),
    '',
    '## Stage B Report (Block A/E especially — use Block E for personalization seed)',
    reportText || '(report unavailable — emit best-effort with low confidence)',
    '',
    '## qa-bank/legal.yml (verbatim source for class="legal" fields; key = source_ref suffix)',
    legalSection,
    '',
    '## qa-bank/templates.md (variable templates for class="open" fields)',
    templatesText || '(templates unavailable — fall back to direct Block E paraphrase)',
    '',
    '## Candidate Identity (identity.yml — verbatim source for class="hard" fields)',
    identitySection || '(identity unavailable — emit hard fields with low confidence + empty suggested_value)',
    '',
    '## Recent Submitted-Answer History (qa-bank/history.jsonl, last 5 — use for tone calibration)',
    historySection,
  ].join('\n');

  return [
    {
      type: 'text',
      text,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

// Build the per-Job user message. JD only — CV/legal/identity are in cached
// system. Trim to 12k chars (matches Stage B m1 trim).
export function buildUserMessage(job, opts = {}) {
  const lines = [];
  lines.push(`Role: ${job?.role ?? '(untitled)'}`);
  lines.push(`Company: ${job?.company ?? '(unknown)'}`);
  if (Array.isArray(job?.location) && job.location.length > 0) {
    lines.push(`Location: ${job.location.join(' / ')}`);
  }
  if (job?.posted_at) lines.push(`Posted: ${job.posted_at}`);
  if (job?.url) lines.push(`URL: ${job.url}`);
  if (typeof opts.pdfPath === 'string' && opts.pdfPath) {
    lines.push(`Tailored CV PDF: ${opts.pdfPath}`);
  } else {
    lines.push('Tailored CV PDF: (not yet generated — emit class="file" with low confidence)');
  }
  if (job?.comp_hint && (typeof job.comp_hint.min === 'number' || typeof job.comp_hint.max === 'number')) {
    const ch = job.comp_hint;
    const min = ch.min ?? '?';
    const max = ch.max ?? '?';
    const cur = ch.currency ?? '';
    const per = ch.period ? `/${ch.period}` : '';
    lines.push(`Comp hint: ${min}–${max} ${cur}${per}`.trim());
  }
  lines.push('');
  lines.push('## Job description');
  lines.push(
    typeof job?.description === 'string' && job.description.trim()
      ? trim(job.description, 12000)
      : '(JD body unavailable — emit best-effort with low confidence)'
  );
  lines.push('');
  lines.push('Emit the JSON object now. No preamble. No code fence. No commentary.');
  return { role: 'user', content: lines.join('\n') };
}

// Assemble the full Anthropic-API params object. max_tokens=4096 is enough
// for ~10-15 fields × 200 tokens each plus JSON overhead.
export function buildDraftPrompt(job, bundle, opts = {}) {
  const system = buildSystemBlock(bundle);
  const user = buildUserMessage(job, opts);
  return {
    model: APPLIER_MODEL,
    max_tokens: 4096,
    system,
    messages: [user],
  };
}

// ── Parser ──────────────────────────────────────────────────────────────

export class ParseError extends Error {
  constructor(message, raw) {
    super(message);
    this.name = 'ParseError';
    this.raw = typeof raw === 'string' ? raw.slice(0, 500) : null;
  }
}

// Concat text-type content blocks. Anthropic API can return multiple; we
// stitch them together for parsing. tool_use blocks are skipped (m1 has
// no tools — defensive in case Sonnet ever emits structured artifacts).
export function concatTextBlocks(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

// Extract the first balanced JSON object from a string. Sonnet sometimes
// wraps in ```json ... ``` despite explicit instructions; this regex-tolerant
// extractor finds the outermost {...} via brace-counting.
function extractJsonObject(text) {
  if (typeof text !== 'string') return null;
  // Try markdown code fence first (```json ... ```). If the captured content
  // doesn't actually contain `{`, fall through to the raw text — defends
  // against degenerate cases where Sonnet emits ```text\n...\n``` followed
  // by the real JSON outside any fence (review fix M1).
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate =
    fenceMatch && fenceMatch[1].includes('{') ? fenceMatch[1] : text;

  // Brace-balanced extraction. Tolerates leading/trailing non-JSON text.
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < candidate.length; i++) {
    const c = candidate[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        return candidate.slice(start, i + 1);
      }
    }
  }
  return null;
}

// Parse Sonnet's content[] array into a validated array of DraftField items.
// Returns the fields array. Throws ParseError on empty / non-JSON / malformed.
export function parseDraftResponse(content) {
  const text = concatTextBlocks(content);
  if (!text || !text.trim()) {
    throw new ParseError('empty content from Anthropic API', text);
  }
  const jsonStr = extractJsonObject(text);
  if (!jsonStr) {
    throw new ParseError('no JSON object found in response', text);
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new ParseError(`JSON.parse failed: ${e.message}`, jsonStr);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.fields)) {
    throw new ParseError('parsed object has no .fields array', jsonStr);
  }
  // Validate each field via Zod. Wrap with field index so the runner's
  // truncated error message points to the offending row (review fix M2).
  return parsed.fields.map((f, i) => {
    try {
      return DraftFieldSchema.parse(f);
    } catch (e) {
      const detail = e?.message ?? String(e);
      throw new Error(`field[${i}]: ${detail}`);
    }
  });
}

// Re-export FIELD_CLASSES + CONFIDENCE_TIERS so consumers can pull them
// from this module without importing both files.
export { FIELD_CLASSES, CONFIDENCE_TIERS };
