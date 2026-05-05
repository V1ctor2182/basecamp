// Stage B Tools API integration. First project use of the Anthropic Tools API.
// Two tools:
//   - web_search_20250305 (Anthropic-hosted server-side, Block D Comp & Demand)
//     · Cost ~$0.025/search (priced separately from token usage; deferred to
//       04-budget-gate). Tracked here as `web_search_requests` count.
//   - verify_job_posting (local handler backed by pageScraper.mjs, Block G
//     Posting Legitimacy)
//
// Multi-turn loop semantics: client.messages.create returns stop_reason='tool_use'
// when Sonnet wants to call a tool. Local tools require the runner to execute
// the handler and inject a tool_result block in the next user message. Hosted
// (server-side) tools auto-execute on Anthropic's side — the response just
// includes server_tool_use + web_search_tool_result blocks and stop_reason
// proceeds normally; we DO NOT inject tool_result for them.
//
// Cache invariant: params.system (cache_control:ephemeral text block) is
// byte-identical across rounds → rounds 2..N hit the prompt cache. Don't
// mutate `system` between rounds.
//
// Retry policy: outer callWithRetry (in stageBRunner) wraps the whole loop —
// a transient 5xx mid-loop restarts from round 1 with a fresh messages array.
// Cache hits keep the restart cheap. Per-round retry is a defensible upgrade
// once telemetry shows mid-loop transients are common; deferred.

import { scrapeJdText } from '../lib/pageScraper.mjs';

// ── Tool definitions ────────────────────────────────────────────────────

// Anthropic-hosted web search. max_uses=2 caps per-job spend at ~$0.05 worst
// case. allowed_domains/blocked_domains intentionally omitted — Block D
// (Comp & Demand) wants Levels.fyi / Glassdoor / company sites, no need
// to whitelist upfront.
export const WEB_SEARCH_TOOL = Object.freeze({
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 2,
});

// Local handler. Sonnet calls with { url } → we scrape and return excerpt.
// Used by Block G to verify the JD URL is still active (Posting Legitimacy).
export const VERIFY_JOB_POSTING_TOOL = Object.freeze({
  name: 'verify_job_posting',
  description:
    'Fetch and inspect the job posting URL to verify it is still active. ' +
    'Returns { ok: true, body_excerpt } if the page loads and has main content; ' +
    '{ ok: false, error } otherwise (404, timeout, no main content found).',
  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The job posting URL to verify (https://...)',
      },
    },
    required: ['url'],
  },
});

export const STAGE_B_TOOLS = Object.freeze([WEB_SEARCH_TOOL, VERIFY_JOB_POSTING_TOOL]);

// Locked constraint #3: per-tool 30s ceiling. pageScraper has its own
// 15s default; we pass 30s through so the constraint is upper-bound.
const PER_TOOL_TIMEOUT_MS = 30_000;

// Trim body_excerpt to keep tool_result payloads small. Sonnet doesn't need
// full JD bodies — just enough to confirm liveness + maybe a snippet.
const BODY_EXCERPT_LIMIT = 2000;

// Default cap on tool-use rounds per job. Defensive against runaway loops
// (Sonnet asking the same question repeatedly). 5 = 1 web_search + 1
// verify_job_posting + 3 follow-ups, plenty of headroom.
const DEFAULT_MAX_ROUNDS = 5;

// ── Local handler ───────────────────────────────────────────────────────

// Returns { ok: true, body_excerpt } on success; { ok: false, error } otherwise.
// NEVER throws — failures land as ok:false so the loop can build a proper
// tool_result with is_error:true and Sonnet can fall back to confidence:low
// per m1 system instructions.
export async function verifyJobPostingHandler(input, opts = {}) {
  const url = input?.url;
  if (typeof url !== 'string' || !url.trim()) {
    return { ok: false, error: 'missing url' };
  }
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
      ? opts.timeoutMs
      : PER_TOOL_TIMEOUT_MS;

  // Race scrapeJdText (which itself has an internal Playwright timeout) against
  // a hard ceiling — defense in depth against pageScraper hanging on something
  // weird (page event loop deadlock, ws frame stall, etc).
  let timeoutHandle;
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(
      () => resolve({ __timeout: true }),
      timeoutMs
    );
  });

  try {
    const result = await Promise.race([
      scrapeJdText(url, { timeout: timeoutMs }).then(
        (text) => ({ __ok: true, text }),
        (err) => ({ __err: err })
      ),
      timeoutPromise,
    ]);
    if (result.__timeout) {
      return { ok: false, error: `verify_job_posting timeout (${timeoutMs}ms)` };
    }
    if (result.__err) {
      return {
        ok: false,
        error: String(result.__err?.message ?? result.__err).slice(0, 200),
      };
    }
    return {
      ok: true,
      body_excerpt: String(result.text).slice(0, BODY_EXCERPT_LIMIT),
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

// Local-tool registry. Maps tool name → handler. Server-side tools (web_search)
// are NOT in this map — Anthropic auto-executes them and we ignore them in
// the content[] walk by checking block.type === 'tool_use' (server-side blocks
// have type 'server_tool_use').
export const LOCAL_TOOL_HANDLERS = Object.freeze({
  verify_job_posting: verifyJobPostingHandler,
});

// ── Loop ────────────────────────────────────────────────────────────────

// When echoing the assistant's content[] back as message history for the next
// round, the API rejects server-side RESULT blocks (the model didn't emit
// them — Anthropic did) and certain other ephemeral types. Whitelist the
// shapes that ARE valid in an assistant MessageParam content array. See
// SDK MessageParam content union.
const ECHO_BACK_BLOCK_TYPES = new Set([
  'text',
  'tool_use',
  'server_tool_use',
  'thinking',
  'redacted_thinking',
]);

function sanitizeAssistantContent(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && ECHO_BACK_BLOCK_TYPES.has(b.type));
}

// Sum a usage object into an aggregate, treating null/missing as 0.
function addUsage(agg, u) {
  if (!u || typeof u !== 'object') return;
  agg.input_tokens += Number(u.input_tokens) || 0;
  agg.output_tokens += Number(u.output_tokens) || 0;
  agg.cache_read_input_tokens += Number(u.cache_read_input_tokens) || 0;
  agg.cache_creation_input_tokens += Number(u.cache_creation_input_tokens) || 0;
  const sw = u.server_tool_use?.web_search_requests;
  if (typeof sw === 'number' && sw > 0) {
    agg.server_tool_use.web_search_requests += sw;
  }
}

// Multi-turn tool-use loop. Calls client.messages.create up to `maxRounds`
// times; on each tool_use stop_reason, executes local handlers and re-calls
// with appended tool_result. Returns the final response with `usage` mutated
// in place to be the cross-round aggregate (so the caller's cost path is
// unchanged), plus `_toolRoundsUsed` and `_maxRoundsExceeded` flags for
// observability.
//
// deps: { handlers=LOCAL_TOOL_HANDLERS, maxRounds=5, perToolTimeoutMs=30000 }
export async function runToolUseLoop(client, params, deps = {}) {
  const handlers = deps.handlers ?? LOCAL_TOOL_HANDLERS;
  const maxRounds =
    typeof deps.maxRounds === 'number' && deps.maxRounds > 0
      ? deps.maxRounds
      : DEFAULT_MAX_ROUNDS;
  const perToolTimeoutMs =
    typeof deps.perToolTimeoutMs === 'number' && deps.perToolTimeoutMs > 0
      ? deps.perToolTimeoutMs
      : PER_TOOL_TIMEOUT_MS;

  const messages = Array.isArray(params.messages) ? [...params.messages] : [];
  const aggregateUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    server_tool_use: { web_search_requests: 0 },
  };

  let resp;
  let round = 0;

  while (round < maxRounds) {
    round++;
    resp = await client.messages.create({ ...params, messages });
    addUsage(aggregateUsage, resp?.usage);

    // Continue the loop on tool_use OR pause_turn (Anthropic protocol: paused
    // turn must be re-sent to make progress; may carry tool_use blocks). Any
    // other stop_reason (end_turn / max_tokens / stop_sequence / refusal /
    // model_context_window_exceeded) is terminal.
    const stop = resp?.stop_reason;
    if (stop !== 'tool_use' && stop !== 'pause_turn') break;

    // Walk content[] for LOCAL tool_use blocks. server_tool_use (web_search)
    // is auto-handled by Anthropic — we just see the result blocks and skip.
    // Validate id is a non-empty string so a malformed block doesn't produce
    // a tool_result with tool_use_id:undefined (which the API rejects).
    const toolUseBlocks = Array.isArray(resp.content)
      ? resp.content.filter(
          (b) => b && b.type === 'tool_use' && typeof b.id === 'string' && b.id.length > 0
        )
      : [];

    // Sanitize the assistant content BEFORE we echo it back as message history.
    // The API rejects server-side RESULT blocks (web_search_tool_result etc.)
    // in client-submitted assistant turns. Keep only shapes valid in an
    // assistant MessageParam.
    const echoableContent = sanitizeAssistantContent(resp.content);

    if (toolUseBlocks.length === 0) {
      // stop_reason was tool_use/pause_turn but no LOCAL blocks need executing.
      // For pause_turn we'd want to re-send, but with nothing to add we'd
      // infinite-loop, so bail. For tool_use this means everything was
      // server-side and Anthropic should already have transitioned — bail
      // defensively here too.
      break;
    }

    // Execute every local tool_use block in parallel; build tool_result blocks.
    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const handler = handlers[block.name];
        if (!handler) {
          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({ ok: false, error: `unknown tool: ${block.name}` }),
            is_error: true,
          };
        }
        let result;
        try {
          result = await handler(block.input ?? {}, { timeoutMs: perToolTimeoutMs });
        } catch (e) {
          // Handlers should NEVER throw (verifyJobPostingHandler doesn't), but
          // guard anyway — a thrown handler must not break the loop.
          result = { ok: false, error: String(e?.message ?? e).slice(0, 200) };
        }
        // Guard non-conformant handler returns (null/undefined/missing ok).
        // is_error defaults to TRUE unless result.ok === true; this prevents
        // a forgot-to-return handler from feeding undefined content to Sonnet
        // as a fake success.
        const safeResult =
          result && typeof result === 'object' ? result : { ok: false, error: 'handler returned non-object' };
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(safeResult),
          is_error: safeResult.ok !== true,
        };
      })
    );

    messages.push({ role: 'assistant', content: echoableContent });
    messages.push({ role: 'user', content: toolResults });
  }

  // Mutate the final response's usage to the aggregate so the caller's
  // computeCostUsd sees cross-round totals.
  if (resp && typeof resp === 'object') {
    resp.usage = aggregateUsage;
    resp._toolRoundsUsed = round;
    const stop = resp.stop_reason;
    resp._maxRoundsExceeded = round >= maxRounds && (stop === 'tool_use' || stop === 'pause_turn');
  }
  return resp;
}
