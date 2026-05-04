// Stage A Haiku prompt builder + response parser.
//
// Stage A is the cheap funnel stage of the evaluator: 1-5 score + one-line
// reason per Job, ~$0.01 each via Haiku. Build prompts with a SINGLE
// cache_control mark on the system block so calls 2..N within a batch hit
// the cache (~90% input token savings on a stable CV + prefs).

const STAGE_A_INSTRUCTIONS = [
  'You are a career-fit evaluator screening job postings against a candidate.',
  '',
  'For the JD in the user message, output exactly one line of the form:',
  '  Score: <N>/5 — <one-sentence reason>',
  'where <N> is a single number from 1.0 to 5.0 with one decimal (e.g. 3.5, 4.0).',
  '',
  'Score guide:',
  '  1.0-2.4: clear mismatch (wrong seniority, wrong domain, wrong location, comp far below floor).',
  '  2.5-3.4: marginal — some fit but multiple soft misses.',
  '  3.5-4.4: solid match on core requirements.',
  '  4.5-5.0: strong target — high-priority recommendation.',
  '',
  'Be terse. The reason MUST cite the most decision-relevant signal',
  '(seniority gap, comp, tech stack overlap, location, etc.). Do not add',
  'preambles, JSON, markdown, or trailing whitespace.',
].join('\n');

// Trim a string to N chars with an ellipsis if truncated. Used to bound
// system block size — full JDs can be 10k+ chars and inflate input tokens.
function trim(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

// Build the cache-eligible system block. Same content for every Job in a
// batch → first call writes the cache, calls 2..N read it.
function buildSystemBlock(simplifiedCv, prefs) {
  const targets = Array.isArray(prefs?.targets) ? prefs.targets : [];
  const targetSummary = targets.length
    ? targets
        .map((t) => `- ${t.title ?? '(untitled)'} (${t.seniority ?? '?'}; ${t.function ?? 'any function'})`)
        .join('\n')
    : '- (no target roles configured)';

  const thresholds = prefs?.thresholds ?? {};
  const thresholdSummary =
    `strong=${thresholds.strong ?? '4.5'}, worth=${thresholds.worth ?? '4.0'}, ` +
    `consider=${thresholds.consider ?? '3.5'}, skip_below=${thresholds.skip_below ?? '3.0'}`;

  const compTarget = prefs?.comp_target ?? {};
  const compSummary =
    compTarget.base_min || compTarget.base_max
      ? `Base ${compTarget.base_min ?? '?'}–${compTarget.base_max ?? '?'} ${compTarget.currency ?? 'USD'}`
      : '(no comp target)';

  const text = [
    STAGE_A_INSTRUCTIONS,
    '',
    '## Candidate snapshot',
    trim(simplifiedCv, 1500) || '(no CV summary available)',
    '',
    '## Target roles',
    targetSummary,
    '',
    '## Compensation expectation',
    compSummary,
    '',
    '## Score thresholds (for context)',
    thresholdSummary,
  ].join('\n');

  return [
    {
      type: 'text',
      text,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

// Build the per-Job user message. Each call differs here, so this is NOT
// cache-eligible. JD body is the largest chunk; trim to keep input tokens
// bounded (~10k char ≈ 2.5k tokens).
function buildUserMessage(job) {
  const lines = [];
  lines.push(`Role: ${job?.role ?? '(untitled)'}`);
  lines.push(`Company: ${job?.company ?? '(unknown)'}`);
  if (Array.isArray(job?.location) && job.location.length > 0) {
    lines.push(`Location: ${job.location.join(' / ')}`);
  }
  if (job?.posted_at) lines.push(`Posted: ${job.posted_at}`);
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
      ? trim(job.description, 8000)
      : '(JD body unavailable — score conservatively)'
  );

  return { role: 'user', content: lines.join('\n') };
}

// Default Haiku model id. Pinned to the dated revision used in
// MODEL_PRICING (server.mjs:1969) so token-cost computations stay accurate
// across SDK version bumps.
export const STAGE_A_MODEL = 'claude-haiku-4-5-20251001';

// Returns the params blob ready to spread into client.messages.create.
// Caller adds max_tokens (we recommend 256 — Stage A output is one line).
export function buildStageAPrompt(job, prefs, simplifiedCv) {
  return {
    model: STAGE_A_MODEL,
    max_tokens: 256,
    system: buildSystemBlock(simplifiedCv, prefs),
    messages: [buildUserMessage(job)],
  };
}

export class ParseError extends Error {
  constructor(message, raw) {
    super(message);
    this.name = 'ParseError';
    this.raw = typeof raw === 'string' ? raw.slice(0, 500) : null;
  }
}

// Clamp + round to 1 decimal in [1.0, 5.0]. Coerces strings ("3.5" → 3.5)
// and rejects NaN/Infinity by throwing.
export function clampScore(n) {
  const v = typeof n === 'string' ? Number(n) : n;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ParseError(`score is not a finite number: ${n}`, String(n));
  }
  const clamped = Math.max(1, Math.min(5, v));
  return Math.round(clamped * 10) / 10;
}

// Extract { score, reason } from Claude's response text. Tolerant of:
//   0. Pure JSON: full JSON.parse the whole response (handles string-valued
//      score: {"score": "3.5"} via clampScore coercion)
//   1. Embedded JSON: {"score": 3.5, "reason": "..."} inside prose
//   2. Documented format: "Score: 3.5/5 — reason"
//   3. Numeric prefix anywhere on a line: "Output: 3.5 — reason" / "3.5: reason"
// Throws ParseError if no score extractable. Reason defaults to '' if the
// response is just a number.
export function parseStageAResponse(text) {
  if (typeof text !== 'string') {
    throw new ParseError(`response is not a string: ${typeof text}`, null);
  }
  const trimmed = text.trim();
  if (!trimmed) {
    throw new ParseError('response is empty', trimmed);
  }

  // Tier 0: pure JSON (the entire trimmed response is a JSON object)
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && 'score' in obj) {
        const score = clampScore(obj.score); // coerces string values too
        const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
        return { score, reason: reason.slice(0, 2000) };
      }
    } catch {
      // fall through
    }
  }

  // Tier 1: embedded JSON inside prose. Accept either numeric or quoted
  // string score values: `"score": 3.5` or `"score": "3.5"`.
  const jsonMatch = trimmed.match(/\{[^{}]*"score"\s*:\s*"?([0-9.]+)"?[^{}]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (typeof obj.score !== 'undefined') {
        const score = clampScore(obj.score);
        const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
        return { score, reason: reason.slice(0, 2000) };
      }
    } catch {
      // fall through
    }
  }

  // Tier 2: documented format "Score: 3.5/5 — reason"
  // Accepts multi-digit + multi-decimal scores (clampScore handles range).
  // /im allows the score line to be anywhere in a multi-line response.
  const docMatch = trimmed.match(
    /score\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*\/?\s*[0-9]*\s*[—\-:|]?\s*(.*)$/im
  );
  if (docMatch) {
    const score = clampScore(docMatch[1]);
    const reason = (docMatch[2] ?? '').trim();
    return { score, reason: reason.slice(0, 2000) };
  }

  // Tier 3: any numeric prefix on any line. Strips arbitrary text before
  // the digit (e.g. "Output: 3.5 — reason" → score 3.5, reason "reason").
  // /m so we match per-line; non-anchored regex finds the first number.
  const numMatch = trimmed.match(
    /(?:^|[^0-9])([0-9]+(?:\.[0-9]+)?)\s*\/?\s*[0-9]*\s*[—\-:|]?\s*(.*)$/m
  );
  if (numMatch) {
    const score = clampScore(numMatch[1]);
    const reason = (numMatch[2] ?? '').trim();
    return { score, reason: reason.slice(0, 2000) };
  }

  throw new ParseError(`no score extractable from response`, trimmed);
}
