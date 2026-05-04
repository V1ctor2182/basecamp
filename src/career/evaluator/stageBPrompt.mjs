// Stage B Sonnet prompt builder + tool-use-aware parser.
//
// Stage B is the deep-eval tier of the evaluator funnel: ~$0.15-0.30/job
// via Sonnet. Output is a 7-block A-G markdown report saved to
// data/career/reports/{jobId}.md. m3 plumbs Anthropic Tools API for Block D
// (WebSearch) and Block G (verify_job_posting via Playwright); this m1
// builds the prompt + parser that's tool-use-aware from day one.
//
// System block carries 4 cached files (cv.md + narrative.md + proof-points.md
// + identity.yml) + up to 5 qa-bank/history.jsonl entries as few-shot for
// Block F (Interview Plan). All marked cache_control:ephemeral on a SINGLE
// text block — same single-cache-block strategy as Stage A m1 (avoids
// over-fragmenting the cache).

export const STAGE_B_MODEL = 'claude-sonnet-4-6';

// Block letter → human label. Used both in instructions (so Sonnet knows
// what to produce) and in the post-extraction projection. Pinned to 7
// uppercase single-letter keys per spec.
export const BLOCK_KEYS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
export const BLOCK_CONFIG = Object.freeze({
  A: 'Role Summary',
  B: 'CV Match',
  C: 'Level & Strategy',
  D: 'Comp & Demand',
  E: 'Personalization Plan',
  F: 'Interview Plan',
  G: 'Posting Legitimacy',
});

// Forced-on per spec constraint #1: Block B (CV Match) drives the total
// score; Block E (Personalization Plan) is the Tailor Engine input. Block A
// is always rendered (no toggle exists for it). Other blocks come from
// prefs.evaluator_strategy.stage_b.blocks.
const FORCED_ON_BLOCKS = ['A', 'B', 'E'];

const STAGE_B_INSTRUCTIONS_HEAD = [
  'You are a senior career evaluator producing a deep-fit analysis report',
  'for a job opportunity. The candidate context (CV, narrative, proof points,',
  'identity, recent QA-bank Q&A) is provided in the cached system block.',
  'The job description is in the user message.',
  '',
  'Produce the requested report blocks in markdown. Each block MUST start on',
  'its own line with this exact header format (no extra punctuation):',
  '',
  '  ## Block X — Title',
  '',
  'where X is the uppercase letter (A-G) and Title matches the canonical name.',
  '',
  'After the final block, on its own line, output the weighted total score:',
  '',
  '  **Total: X.X/5**',
  '',
  'where X.X is between 1.0 and 5.0 with one decimal. Compute the weighted',
  'score from the block insights using prefs.scoring_weights (described below).',
  '',
  'CANONICAL BLOCK STRUCTURE (output only the enabled subset; A/B/E are always',
  'enabled per Tailor Engine contract):',
  '',
  '  A — Role Summary       1-paragraph TL;DR of the role + why it matters.',
  '  B — CV Match           Per-requirement coverage table (req | candidate evidence | gap).',
  '  C — Level & Strategy   Suggested seniority pitch + strategy memo.',
  '  D — Comp & Demand      Salary range + market demand. Use web_search if available;',
  '                         on tool failure or non-availability output "*confidence: low.',
  '                         Web tool unavailable; based on JD inference.*"',
  '  E — Personalization    Concrete CV rewrite suggestions (consumed by Tailor Engine).',
  '                         Output as bullet list of {section, current, suggested} triples.',
  '  F — Interview Plan     6-10 STAR + Reflection stories pulled from proof-points and',
  '                         qa-bank examples. Each story: Situation/Task/Action/Result/Reflection.',
  '  G — Posting Legitimacy Use verify_job_posting tool if available to confirm the URL is',
  '                         live. Tool failure → "*confidence: low. Cannot verify posting',
  '                         currently active.*"',
  '',
  'GUIDELINES:',
  '- Be specific. Cite candidate experience by name from CV/narrative/proof.',
  '- Be terse where prose adds no signal; verbose where it does (Block B requirement matrix).',
  '- If a tool call fails or you lack data, mark "*confidence: low.*" and continue.',
  '  Do NOT skip a block — emit the header and a brief degraded analysis.',
  '- Block E suggestions MUST be actionable (specific edit, not "improve summary").',
].join('\n');

// Trim long text with an ellipsis. Cached system content is large but Sonnet
// charges cache write ONCE; subsequent calls in batch hit cache reads (~10x
// cheaper). Still bound it to keep first-call cost reasonable.
function trim(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

// Format a recent qa-bank/history entry for few-shot context. Each entry is
// expected to be { question, answer, tags?, ts? } per 02-profile/04-qa-bank.
// Defensive: missing fields → empty string; non-object → skipped at caller.
function formatQaEntry(entry) {
  const q = entry?.question ?? '';
  const a = entry?.answer ?? '';
  if (!q && !a) return null;
  return `**Q:** ${trim(String(q).trim(), 400)}\n**A:** ${trim(String(a).trim(), 800)}`;
}

// Compute the enabled block set for a given prefs object. Forced-on blocks
// (A/B/E) are always present even if user toggled them off in prefs (the
// Preferences UI also locks the toggles disabled — this is defense in depth).
export function resolveEnabledBlocks(prefs) {
  const userBlocks = prefs?.evaluator_strategy?.stage_b?.blocks ?? {};
  const enabled = new Set(FORCED_ON_BLOCKS);
  // Map preference keys (block_a, block_b, ...) to letters and merge.
  for (const letter of BLOCK_KEYS) {
    const key = 'block_' + letter.toLowerCase();
    if (userBlocks[key] === true) enabled.add(letter);
  }
  return BLOCK_KEYS.filter((k) => enabled.has(k));
}

// Render the toggle list section of the system instructions so Sonnet knows
// which blocks to emit. Always lists all 7 with an [enabled]/[skip] tag —
// this is more reliable than just listing enabled (Sonnet sometimes hallucinates
// missing blocks otherwise).
function renderEnabledBlockList(enabledLetters) {
  const enabled = new Set(enabledLetters);
  return BLOCK_KEYS.map((k) => {
    const tag = enabled.has(k) ? '[enabled]' : '[skip]';
    return `  ${k} ${tag} — ${BLOCK_CONFIG[k]}`;
  }).join('\n');
}

// Render scoring_weights in human-readable form so Sonnet can apply them
// when computing the total score. Missing weights → equal weighting.
function renderScoringWeights(prefs) {
  const w = prefs?.scoring_weights ?? {};
  const keys = ['tech_match', 'comp_match', 'location_match', 'company_match', 'growth_signal'];
  const have = keys.filter((k) => typeof w[k] === 'number');
  if (have.length === 0) return '(no scoring weights configured — weigh signals equally)';
  return have.map((k) => `  ${k}: ${w[k]}`).join('\n');
}

// Render the few-shot Q&A entries (up to 5 most recent). These come from
// data/career/qa-bank/history.jsonl per 02-profile/04-qa-bank.
function renderQaFewShot(qaFewShot) {
  if (!Array.isArray(qaFewShot) || qaFewShot.length === 0) {
    return '(qa-bank history.jsonl is empty — no few-shot Q&A available)';
  }
  const lines = qaFewShot
    .slice(0, 5)
    .map(formatQaEntry)
    .filter((s) => s !== null);
  if (lines.length === 0) return '(qa-bank entries malformed — skipped)';
  return lines.join('\n\n---\n\n');
}

// Build the cache-eligible system block. Single text block per locked design
// (Stage A m1 pattern) with cache_control:ephemeral. Order matters for
// readability but doesn't affect caching (the whole text is one cache key).
export function buildSystemBlock(bundle) {
  const cv = trim(bundle?.cv ?? '', 8000);
  const narrative = trim(bundle?.narrative ?? '', 4000);
  const proofPoints = trim(bundle?.proofPoints ?? '', 4000);
  const identity = trim(bundle?.identity ?? '', 1000);
  const enabledLetters = Array.isArray(bundle?.enabledBlocks) && bundle.enabledBlocks.length > 0
    ? bundle.enabledBlocks
    : FORCED_ON_BLOCKS;
  const qaSection = renderQaFewShot(bundle?.qaFewShot);
  const weightsSection = renderScoringWeights(bundle?.prefs);

  const text = [
    STAGE_B_INSTRUCTIONS_HEAD,
    '',
    'BLOCK TOGGLE LIST (enabled blocks — emit ONLY these; skip the rest):',
    renderEnabledBlockList(enabledLetters),
    '',
    'SCORING WEIGHTS for the total score (weighted average of block-derived signals):',
    weightsSection,
    '',
    '## Candidate Resume (cv.md)',
    cv || '(no CV available — score conservatively, flag in Block B)',
    '',
    '## Candidate Narrative (narrative.md)',
    narrative || '(no narrative available)',
    '',
    '## Candidate Proof Points (proof-points.md)',
    proofPoints || '(no proof points available)',
    '',
    '## Candidate Identity (identity.yml)',
    identity || '(no identity context available)',
    '',
    '## Recent Q&A History (qa-bank, up to 5 most recent — use for Block F STAR stories)',
    qaSection,
  ].join('\n');

  return [
    {
      type: 'text',
      text,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

// Build the per-Job user message. JD only — CV is in cached system. Trim to
// 12k chars (JD body usually 2-8k; safety margin for verbose postings).
export function buildUserMessage(job) {
  const lines = [];
  lines.push(`Role: ${job?.role ?? '(untitled)'}`);
  lines.push(`Company: ${job?.company ?? '(unknown)'}`);
  if (Array.isArray(job?.location) && job.location.length > 0) {
    lines.push(`Location: ${job.location.join(' / ')}`);
  }
  if (job?.posted_at) lines.push(`Posted: ${job.posted_at}`);
  if (job?.url) lines.push(`URL: ${job.url}`);
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
      : '(JD body unavailable — score conservatively in Block B)'
  );

  return { role: 'user', content: lines.join('\n') };
}

// Assemble the full Anthropic-API params object. m3 will add a `tools` array
// for WebSearch + Playwright; m1 leaves it absent (undefined → API ignores).
// max_tokens=4096 is enough for ~2-3.5k output tokens across 7 blocks +
// trims worst-case cost ceiling on output to ~$0.06.
export function buildStageBPrompt(job, prefs, cvBundle) {
  const enabledBlocks = resolveEnabledBlocks(prefs);
  const system = buildSystemBlock({
    ...cvBundle,
    enabledBlocks,
    prefs,
  });
  return {
    model: STAGE_B_MODEL,
    max_tokens: 4096,
    system,
    messages: [buildUserMessage(job)],
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

// Concatenate text-type blocks from an Anthropic API content[] array.
// tool_use blocks are intentionally skipped — m3's tool-use loop handles
// those separately. v1 only consumes the FINAL text response.
function concatenateText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

// Match `## Block X — Title` headers. Tolerant of:
//   * H2 or H3 (`##` or `###`) — Sonnet sometimes nests under another `##`
//   * bold wrapping the header (`## **Block A — Title**`, `**## Block A …**`)
//   * dash variants (—, –, -) AND colon (`Block A: Title`)
//   * trailing whitespace.
// Letter captured in group 1, title in group 2.
const BLOCK_HEADER_RE_G = /^\**#{2,3}\s*\**\s*Block\s+([A-G])\s*[—–\-:]\s*(.+?)\s*\**\s*$/gm;

// Tolerant total-score regex. Accepts:
//   **Total: 4.2/5** / **Total: 4.5/5.0** / Total: 4.2 / *Total = 4*
// Anchored to a full line (m flag) so an inline `Total: 3` in prose is NOT
// stripped as the score. Consumes optional /<denominator-with-decimals>
// and any trailing bold so no orphan ".0" or "**" leaks into the last block.
const TOTAL_SCORE_RE = /^\s*\**\s*Total\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)\s*(?:\/\s*[0-9]+(?:\.[0-9]+)?)?\s*\**\s*$/im;

function clampScore(n) {
  const v = typeof n === 'string' ? Number(n) : n;
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const clamped = Math.max(1, Math.min(5, v));
  return Math.round(clamped * 10) / 10;
}

// Split a markdown blob into per-block content + preamble + total_score.
// Returns { A,B,C,D,E,F,G: string, total_score: number|null, preamble: string }.
// Missing blocks → empty string (not throw). Missing total → null.
export function extractBlocks(text) {
  if (typeof text !== 'string') text = '';
  const blocks = { A: '', B: '', C: '', D: '', E: '', F: '', G: '' };
  let preamble = '';
  let total_score = null;

  // Total score line: extract first then strip from text so it doesn't bleed
  // into the last block's content.
  const totalMatch = text.match(TOTAL_SCORE_RE);
  if (totalMatch) {
    total_score = clampScore(totalMatch[1]);
    text = text.slice(0, totalMatch.index) + text.slice(totalMatch.index + totalMatch[0].length);
  }

  // Find all block header positions.
  const headers = [];
  let m;
  BLOCK_HEADER_RE_G.lastIndex = 0;
  while ((m = BLOCK_HEADER_RE_G.exec(text)) !== null) {
    headers.push({ letter: m[1], start: m.index, headerEnd: m.index + m[0].length });
  }

  if (headers.length === 0) {
    // No block headers found — entire text is preamble. Caller may treat as
    // parse failure if total_score also missing.
    preamble = text.trim();
    return { ...blocks, total_score, preamble };
  }

  // Preamble is everything before the first header.
  preamble = text.slice(0, headers[0].start).trim();

  // Each block's content is from the end of its header to the start of the
  // next header (or end of text for the last).
  for (let i = 0; i < headers.length; i++) {
    const cur = headers[i];
    const next = headers[i + 1];
    const content = text.slice(cur.headerEnd, next ? next.start : text.length).trim();
    // If a letter appears multiple times (rare), later occurrences clobber
    // earlier ones. Acceptable: Sonnet shouldn't emit duplicates.
    blocks[cur.letter] = content;
  }

  return { ...blocks, total_score, preamble };
}

// Top-level parser: takes Anthropic API content[] array, returns parsed
// blocks + score. Throws ParseError only when the response yields zero
// text content (degenerate API failure). Missing blocks within otherwise-
// valid text are NOT errors — graceful degradation per Stage B's tool-
// failure semantics.
export function parseStageBResponse(content) {
  const text = concatenateText(content);
  if (!text.trim()) {
    throw new ParseError('response yielded no text content', '');
  }
  return extractBlocks(text);
}
