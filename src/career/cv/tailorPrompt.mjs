// Tailor prompt module. Single-turn Sonnet call:
//   INPUT: base.md (the source resume) + proof-points.md (additional fact
//          source) + metadata.yml.emphasize (per-resume hints) + JD body +
//          Block E (Personalization Plan from Stage B Sonnet's report) +
//          optional userHint (from Reject-and-Retry flow)
//   OUTPUT: tailored markdown (full resume body, same structure as base.md)
//
// HARD CONSTRAINT (constraint-tailor-engine-001 #1): Sonnet MUST NOT invent
// metrics or claims. The NO_FABRICATION_INSTRUCTION is verbatim per spec
// and sits as the first content of the cached system block so it dominates.
//
// CACHE INVARIANT: bundle pieces (base.md / proof-points / emphasize) are
// stable per (resumeId), so the system block is byte-identical across
// re-runs for the same resume — Anthropic prompt-cache hits on rounds 2..N
// when the user iterates with hints. JD + Block E + hint live in the user
// message (per-call uniqueness).
//
// Bundle scope: NO identity.yml — renderer consumes it for the PDF header;
// Sonnet generating tailored markdown body doesn't need it. Reduces tokens.

import { extractBlocks } from '../evaluator/stageBPrompt.mjs';

export const TAILOR_MODEL = 'claude-sonnet-4-6';

// Verbatim from constraint-tailor-engine-001 spec. Do NOT edit without a
// constraint-spec change.
export const NO_FABRICATION_INSTRUCTION =
  'If a metric or claim is not in the source base.md or proof-points.md, DO NOT invent it. Only reorganize or rephrase existing content.';

// Tailoring instructions. CONSTRAINT #1 (no fabrication) leads — it's the
// dominant rule and Sonnet must read it first. YOUR JOB describes the moves
// Sonnet may make, all subordinate to constraint #1.
const TAILOR_INSTRUCTIONS_HEAD = [
  'You are a resume-tailoring assistant.',
  '',
  'CONSTRAINT #1 (HARD — read this first, applies to everything below):',
  `  ${NO_FABRICATION_INSTRUCTION}`,
  '',
  'Given a candidate base resume, a job description (JD), and a Personalization',
  'Plan (Block E from a prior deep evaluation), produce a tailored version of',
  'the resume that better matches the JD WITHOUT inventing facts.',
  '',
  'YOUR JOB (each move subordinate to constraint #1):',
  '  1. Reorder bullet points within each role to surface the most JD-relevant',
  '     experience first.',
  '  2. Rewrite the Summary section to inject 2-3 of the JD\'s core keywords —',
  '     ONLY if those keywords describe work the candidate has actually done',
  '     per base.md or proof-points.md. If a JD keyword does not apply, omit it.',
  '  3. Rephrase bullet wording to use ATS-friendly keywords from the JD,',
  '     PRESERVING the underlying fact (e.g. "led migration" → "spearheaded',
  '     platform migration" only if the candidate did lead one).',
  '  4. Honor the emphasize hints (projects / skills / narrative) — these are',
  '     the candidate\'s explicit guidance about what to surface.',
  '  5. Apply Block E\'s Personalization Plan suggestions where they don\'t',
  '     conflict with constraint #1.',
  '',
  'OUTPUT FORMAT:',
  '  Return ONLY the tailored markdown — no preamble, no explanation, no',
  '  code fences. Keep the section structure of base.md (## headings,',
  '  - bullets). Same length ballpark as base.md.',
].join('\n');

// Char trim with single-character ellipsis. Returns the original string when
// already within `max`. Min visible cap of 0 — caller passes positive max.
function trim(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

// Render the emphasize section ({projects, skills, narrative}) as a markdown
// block for the system prompt. Tolerant of partial / missing fields.
function renderEmphasize(emphasize) {
  if (!emphasize || typeof emphasize !== 'object') {
    return '(no emphasize hints — use base.md ordering and JD signals only)';
  }
  const lines = [];
  const projects = Array.isArray(emphasize.projects) ? emphasize.projects : [];
  const skills = Array.isArray(emphasize.skills) ? emphasize.skills : [];
  const narrative = typeof emphasize.narrative === 'string' ? emphasize.narrative : '';
  // Use ' | ' separator (not ', ') so a project/skill name containing a
  // comma doesn't visually merge with neighbors in the prompt.
  if (projects.length > 0) {
    lines.push('Emphasize projects: ' + projects.map((p) => trim(String(p), 100)).join(' | '));
  }
  if (skills.length > 0) {
    lines.push('Emphasize skills: ' + skills.map((s) => trim(String(s), 100)).join(' | '));
  }
  if (narrative.trim()) {
    lines.push('Narrative emphasis: ' + trim(narrative, 1000));
  }
  if (lines.length === 0) {
    return '(emphasize present but empty — use base.md ordering and JD signals only)';
  }
  return lines.join('\n');
}

// Build the cached system block. ONE text block with cache_control:ephemeral.
// bundle = { baseMd, proofPoints, emphasize }. Identity intentionally absent
// (renderer's job, not Sonnet's).
export function buildSystemBlock(bundle) {
  const baseMd = trim(bundle?.baseMd ?? '', 8000);
  const proofPoints = trim(bundle?.proofPoints ?? '', 4000);
  const emphasizeSection = renderEmphasize(bundle?.emphasize);

  const text = [
    TAILOR_INSTRUCTIONS_HEAD,
    '',
    '## Source Resume (base.md) — the ground truth, do not invent beyond this',
    // Sentinel placeholder when caller forgot to load base.md. Tells Sonnet
    // to refuse rather than hallucinate. m2 runner SHOULD reject empty
    // baseMd before reaching this code; this is a defense-in-depth fallback.
    baseMd || '(NO base.md PROVIDED — refuse this request: return exactly the text "Error: missing source resume. Cannot tailor without base.md." with no other content.)',
    '',
    '## Source Proof Points (proof-points.md) — additional fact corpus',
    proofPoints || '(no proof-points.md available)',
    '',
    '## Resume Emphasize Hints (metadata.yml)',
    emphasizeSection,
  ].join('\n');

  return [
    {
      type: 'text',
      text,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

// Build the per-call user message. Carries JD + Block E + optional hint.
// jobMeta = { role, company, location, url, comp_hint?, description }.
export function buildUserMessage(jobMeta, blockEText, userHint) {
  const role = jobMeta?.role ?? '(unknown role)';
  const company = jobMeta?.company ?? '(unknown company)';
  const url = jobMeta?.url ?? '';
  const description = jobMeta?.description;
  const jd = trim(typeof description === 'string' ? description : '', 12000);
  const blockE = trim(typeof blockEText === 'string' ? blockEText : '', 4000);
  const hint = trim(typeof userHint === 'string' ? userHint : '', 2000);

  const lines = [
    `Tailor the source resume for this job:`,
    '',
    `Role: ${role}`,
    `Company: ${company}`,
    url ? `URL: ${url}` : null,
    '',
    '## Job Description',
    jd || '(no JD body available — tailor based on role+company only, conservatively)',
    '',
    '## Personalization Plan (Block E from prior deep evaluation)',
    blockE || '(no Block E available — apply general JD-keyword tailoring only)',
  ].filter((l) => l !== null);

  // Trim before truthy-check so whitespace-only hint ('   ' / '\n\n') doesn't
  // render an empty Hint section.
  if (hint && hint.trim()) {
    lines.push('', '## User Hint (from previous Reject — apply this guidance)', hint);
  }

  return { role: 'user', content: lines.join('\n') };
}

// Top-level prompt builder. Returns Anthropic Messages API params.
// Single-turn — no tools attached (Tailor doesn't need WebSearch or
// page-scrape; m2 makes a single client.messages.create call).
export function buildTailorPrompt(jobMeta, bundle, blockEText, userHint) {
  return {
    model: TAILOR_MODEL,
    max_tokens: 4096,
    system: buildSystemBlock(bundle),
    messages: [buildUserMessage(jobMeta, blockEText, userHint)],
  };
}

// Consumer convenience — pulls Block E text out of a Stage B report
// markdown blob. Reuses stageBPrompt.extractBlocks (single source of truth
// for block-header parsing). Returns '' if no Block E found.
export function extractBlockEFromReport(reportMarkdown) {
  if (typeof reportMarkdown !== 'string' || !reportMarkdown.trim()) return '';
  const parsed = extractBlocks(reportMarkdown);
  return typeof parsed?.E === 'string' ? parsed.E : '';
}

export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

// Concatenate text-type blocks from an Anthropic content[] for tailor.
// Differs from stageBPrompt.concatTextBlocks (which uses '\n') — tailor
// joins with '\n\n' so paragraph boundaries between adjacent text blocks
// don't collapse into a single line in the user-facing markdown.
// tool_use blocks are skipped (forward-compat for future tool-use loops).
function concatMarkdownBlocks(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n\n');
}

// Parse a Sonnet response's `content` array into the tailored markdown.
// Throws ParseError on empty/non-array.
export function parseTailorResponse(content) {
  const text = concatMarkdownBlocks(content);
  if (!text.trim()) {
    throw new ParseError('response yielded no text content');
  }
  return { markdown: text };
}
