// Open-class LLM filler — drafts answers for free-form ATS questions via
// Sonnet, with qa-bank cache short-circuit + 04-budget-gate integration.
//
// 07-applier/03-field-classifier m2.
//
// Locked OQs from planning:
//   Q3: NEW Mode-2 prompt (not draftPrompt reuse — Mode 2 has snapshot
//       context, prompt shape differs)
//   Q4: fuzzy match qa-bank by (role, name); weight ≥ medium → short-
//       circuit LLM (0 token cost)
//   Q5: confidence tiers (high if cache hit, medium if LLM success,
//       manual if budget-blocked / LLM error)
//   Q6: budget gate via injected checkBudget() — 402 → confidence='manual'
//
// All external dependencies are INJECTED via ctx (client / computeCostUsd
// / recordCost / checkBudget) so the smoke can mock without disk/network
// and m3 can wire real implementations.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const HISTORY_PATH = path.resolve('data', 'career', 'qa-bank', 'history.jsonl');
const OPEN_FILLER_MODEL = 'claude-sonnet-4-6';
const OPEN_FILLER_CALLER = 'applier:classifier-open';

let _historyCachePromise = null;

/**
 * Load + cache qa-bank/history.jsonl. Each line is a JSON record:
 *   { ts, jobId, refId?, field_label, subclass?, role?, a_draft, a_final, weight }
 *
 * Missing file → returns []. Malformed lines silently skipped.
 */
export async function loadQaBankHistory(opts = {}) {
  const filepath = opts.path || HISTORY_PATH;
  // Allow callers to bypass cache by passing path explicitly
  if (opts.path) {
    return readHistoryFile(filepath);
  }
  if (_historyCachePromise) return _historyCachePromise;
  // C2 fix from review: if the read fails, clear the cache so a retry
  // can succeed. Otherwise the rejection is memoized forever and every
  // subsequent fillOpenField crashes on a transient FS error.
  _historyCachePromise = readHistoryFile(filepath).catch((err) => {
    _historyCachePromise = null;
    throw err;
  });
  return _historyCachePromise;
}

async function readHistoryFile(filepath) {
  try {
    const raw = await fs.readFile(filepath, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export function _resetCache() {
  _historyCachePromise = null;
}

/**
 * Fuzzy match historical answers against (role, name, subclass). Score:
 *   - same subclass:   +0.5
 *   - same role:       +0.2
 *   - exact name:      +0.3   (case-insensitive, trimmed)
 *   - substring name:  +0.1   (one side contained in the other)
 *
 * Returns { entry, score } for the BEST match meeting threshold, or null.
 * Threshold ≥ 0.6 = 'medium' weight; ≥ 0.8 = 'high'.
 */
export function findCachedAnswer(history, role, name, subclass, weightThreshold = 'medium') {
  if (!history || !history.length) return null;
  if (!name) return null;
  const targetName = name.toLowerCase().trim();
  // M6 fix from review: empty target name post-trim → no fuzzy match
  if (!targetName) return null;
  let bestMatch = null;
  let bestScore = 0;
  for (const entry of history) {
    if (!entry || !entry.field_label || !entry.a_final) continue;
    const entryName = String(entry.field_label).toLowerCase().trim();
    // M6 fix from review: skip whitespace-only field_label entries
    if (!entryName) continue;
    let score = 0;
    if (entry.subclass && subclass && entry.subclass === subclass) score += 0.5;
    if (entry.role && role && entry.role === role) score += 0.2;
    if (entryName === targetName) score += 0.3;
    else if (entryName.includes(targetName) || targetName.includes(entryName)) score += 0.1;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry;
    }
  }
  const threshold = weightThreshold === 'high' ? 0.8 : weightThreshold === 'medium' ? 0.6 : 0.4;
  if (bestScore >= threshold) return { entry: bestMatch, score: bestScore };
  return null;
}

/** Map a fuzzy match score to a Mode 2 confidence tier. */
export function weightFromScore(score) {
  if (score >= 0.8) return 'high';
  if (score >= 0.6) return 'medium';
  if (score >= 0.4) return 'low';
  return null;
}

// Per-subclass instruction snippets. Kept short — total prompt size is
// dominated by JD summary + narrative voice context.
const SUBCLASS_INSTRUCTIONS = Object.freeze({
  'why-company': 'Answer in 2-3 sentences. Focus on SPECIFIC aspects of this company drawn from the JD summary. Avoid generic "your mission resonates" filler.',
  'why-role': 'Answer in 2-3 sentences. Connect the candidate\'s experience to specific role requirements.',
  'tell-me-about': 'Answer in 3-4 sentences. Use the narrative voice notes to stay authentic; not a resume restate.',
  'weakness': 'Answer in 2-3 sentences. Pick a real weakness with a concrete improvement story; avoid clichés like "I\'m a perfectionist".',
  'strength': 'Answer in 2-3 sentences. Tie strength to a concrete past result.',
  'salary-expectation': 'Answer with a range (USD, e.g. "$130k-$160k") or "Open to discussion based on the full offer".',
  'start-date': 'Answer with a specific date approximately 2 weeks from today, or "Immediately available" if appropriate.',
  'notice-period': 'Answer "2 weeks" unless context suggests longer notice. One line.',
  'reason-for-leaving': 'Answer in 1-2 sentences. Positive framing — "seeking new challenges" / "team restructuring". Never negative.',
  'cover-letter-text': 'Write a 100-150 word cover letter paragraph for this role. Use specific JD details. First-person.',
  'unknown-open': 'Answer in 1-3 sentences appropriate to the context.',
});

/**
 * Build a Sonnet API call params object for an Open-class field. NEW
 * Mode 2 prompt — does NOT reuse Mode 1 draftPrompt (different context).
 *
 * @param {string} subclass
 * @param {{ role: string, name: string }} snapshotEntry
 * @param {{ jdSummary?: string, narrativeVoice?: string, identity?: object }} [ctx]
 * @returns {{ model, max_tokens, system, messages }}
 */
export function buildOpenPrompt(subclass, snapshotEntry, ctx = {}) {
  const { jdSummary, narrativeVoice, identity = {} } = ctx;
  const userName = identity.name || 'the applicant';
  const instruction = SUBCLASS_INSTRUCTIONS[subclass] || SUBCLASS_INSTRUCTIONS['unknown-open'];

  const systemParts = [
    `You are drafting answers for ${userName}'s job application. Write in first-person, professional but warm tone.`,
  ];
  // M3 fix from review: trim + length-check guards. Empty / whitespace-only
  // strings shouldn't add an empty "Voice notes:\n" block to the prompt
  // (wastes input tokens and confuses the model).
  if (narrativeVoice && String(narrativeVoice).trim()) {
    systemParts.push(`Voice notes:\n${String(narrativeVoice).trim()}`);
  }
  if (jdSummary && String(jdSummary).trim()) {
    systemParts.push(`Job context:\n${String(jdSummary).trim()}`);
  }
  systemParts.push('Output ONLY the answer text. No preamble, no markdown, no quotation marks, no "Sure, here\'s..." filler.');

  const userBlock = `Field: ${snapshotEntry.name}\nSubclass: ${subclass}\n\n${instruction}`;

  return {
    model: OPEN_FILLER_MODEL,
    max_tokens: 500,
    system: systemParts.join('\n\n'),
    messages: [{ role: 'user', content: userBlock }],
  };
}

/**
 * H1 fix from review: strip markdown / quote wrappers Sonnet sometimes
 * emits despite the "no markdown, no quotation marks" instruction.
 * Conservative — only peels outer wrappers, doesn't touch interior
 * formatting (a list inside a paragraph stays intact).
 */
export function stripAnswerWrappers(raw) {
  let text = String(raw || '').trim();
  if (!text) return text;
  // Strip leading "Answer:" / "Here's..." / "Sure," preamble lines
  text = text.replace(/^(?:sure[,!.]?|here(?:'s| is)[^:\n]*:|answer\s*:)\s*/i, '').trim();
  // Strip outer fenced code block (```...```)
  const fenceMatch = text.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/);
  if (fenceMatch) text = fenceMatch[1].trim();
  // Strip surrounding matched quotes (straight or curly)
  while (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    const pairs = [
      ['"', '"'],
      ["'", "'"],
      ['\u201c', '\u201d'],
      ['\u2018', '\u2019'],
      ['`', '`'],
    ];
    const matched = pairs.some(([a, b]) => first === a && last === b);
    if (!matched) break;
    text = text.slice(1, -1).trim();
  }
  return text;
}

/**
 * Invoke the Anthropic Sonnet API. Returns { text, usage, costUsd } or
 * throws on error (caller wraps in try/catch).
 *
 * Dependency injection: deps.client is the Anthropic client (or mock);
 * deps.computeCostUsd is the pricing helper. Both optional for the smoke
 * cache-hit path which never reaches here.
 */
export async function callSonnetForOpen(params, deps = {}) {
  const { client, computeCostUsd: computeCost } = deps;
  if (!client) throw new Error('callSonnetForOpen: client not injected');
  const response = await client.messages.create(params);
  const content = response?.content?.[0];
  const rawText = content?.text || '';
  const text = stripAnswerWrappers(rawText);
  const usage = response?.usage || {};
  const costUsd = computeCost
    ? computeCost({
        model: params.model,
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
      })
    : 0;
  return { text, usage, costUsd };
}

/**
 * Main orchestrator for an Open-class field. Tries qa-bank cache first
 * (0 cost), falls back to budget-gated LLM call.
 *
 * @param {{ role: string, name: string }} snapshotEntry
 * @param {{ subclass: string }} classification — from classifyField
 * @param {object} ctx — injected dependencies + context:
 *   - history: pre-loaded qa-bank history (or auto-load if omitted)
 *   - checkBudget: () => Promise<{ paused: boolean }>
 *   - client: Anthropic client
 *   - computeCostUsd: pricing fn
 *   - recordCost: (record) => Promise (cost ledger append)
 *   - jdSummary, narrativeVoice, identity: prompt context
 * @returns {Promise<{
 *   suggested_value: string | null,
 *   confidence: 'high' | 'medium' | 'low' | 'manual',
 *   source: object,
 *   cost_usd: number,
 *   used: 'cache' | 'llm' | 'budget-blocked' | 'error',
 * }>}
 */
export async function fillOpenField(snapshotEntry, classification, ctx = {}) {
  const subclass = classification.subclass || 'unknown-open';
  const {
    history,
    checkBudget,
    client,
    computeCostUsd: computeCost,
    recordCost,
    jdSummary,
    narrativeVoice,
    identity,
  } = ctx;

  // 1) qa-bank cache short-circuit (Q4)
  // If history not pre-injected, try to auto-load (production path).
  // C3 fix from review: history load failure must not crash the whole
  // fill — treat as empty history (skip cache, fall through to LLM).
  let effectiveHistory = history;
  if (effectiveHistory === undefined) {
    try {
      effectiveHistory = await loadQaBankHistory();
    } catch {
      effectiveHistory = [];
    }
  }
  const cached = findCachedAnswer(
    effectiveHistory,
    snapshotEntry.role,
    snapshotEntry.name,
    subclass,
    'medium',
  );
  if (cached) {
    const tier = weightFromScore(cached.score);
    return {
      suggested_value: cached.entry.a_final,
      confidence: tier === 'high' ? 'high' : 'medium',
      source: {
        kind: 'qa-bank',
        subclass,
        status: 'found',
        cached_score: Math.round(cached.score * 100) / 100,
      },
      cost_usd: 0,
      used: 'cache',
    };
  }

  // 2) Budget gate (Q6)
  if (checkBudget) {
    let gate;
    try {
      gate = await checkBudget();
    } catch (err) {
      // Budget check itself failed — fail safe (treat as paused)
      return {
        suggested_value: null,
        confidence: 'manual',
        source: { kind: 'llm', subclass, status: 'budget-check-failed' },
        cost_usd: 0,
        used: 'budget-blocked',
      };
    }
    if (gate && gate.paused) {
      return {
        suggested_value: null,
        confidence: 'manual',
        source: { kind: 'llm', subclass, status: 'budget-blocked' },
        cost_usd: 0,
        used: 'budget-blocked',
      };
    }
  }

  // 3) LLM call (Sonnet via injected client)
  if (!client) {
    return {
      suggested_value: null,
      confidence: 'manual',
      source: { kind: 'llm', subclass, status: 'no-client' },
      cost_usd: 0,
      used: 'error',
    };
  }
  const params = buildOpenPrompt(subclass, snapshotEntry, {
    jdSummary,
    narrativeVoice,
    identity,
  });
  // H6 fix from review: capture costUsd in outer scope BEFORE we can
  // throw post-call. If recordCost or downstream processing throws,
  // the cost was still incurred — return it instead of dropping to 0.
  let costUsd = 0;
  let text = '';
  try {
    const result = await callSonnetForOpen(params, {
      client,
      computeCostUsd: computeCost,
    });
    costUsd = result.costUsd || 0;
    text = result.text;
  } catch (err) {
    return {
      suggested_value: null,
      confidence: 'manual',
      source: { kind: 'llm', subclass, status: 'error', error: err.message },
      cost_usd: 0,
      used: 'error',
    };
  }

  // H5 fix from review: fire-and-forget recordCost so a slow/hung ledger
  // can't stall the whole field fill. We swallow rejection (already wrapped
  // in try/catch downstream, but defensive belt) and don't await.
  if (recordCost) {
    Promise.resolve()
      .then(() =>
        recordCost({
          caller: OPEN_FILLER_CALLER,
          model: params.model,
          cost_usd: costUsd,
        }),
      )
      .catch(() => {
        // Cost recording failure shouldn't fail the whole field fill
      });
  }

  if (!text) {
    return {
      suggested_value: null,
      confidence: 'manual',
      source: { kind: 'llm', subclass, status: 'empty-response' },
      cost_usd: costUsd,
      used: 'error',
    };
  }
  return {
    suggested_value: text,
    confidence: 'medium',
    source: { kind: 'llm', subclass, status: 'found' },
    cost_usd: costUsd,
    used: 'llm',
  };
}

// Re-export for caller convenience
export { OPEN_FILLER_MODEL, OPEN_FILLER_CALLER };
