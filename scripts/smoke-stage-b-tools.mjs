#!/usr/bin/env node
// Smoke for stageBTools — tool-use multi-turn loop, local handler, hosted
// web_search detection, max-rounds cap, usage aggregation, tool-failure
// fallback. DI-driven; no real Anthropic calls, no real Playwright.

import assert from 'node:assert/strict';
import {
  WEB_SEARCH_TOOL,
  VERIFY_JOB_POSTING_TOOL,
  STAGE_B_TOOLS,
  LOCAL_TOOL_HANDLERS,
  verifyJobPostingHandler,
  runToolUseLoop,
} from '../src/career/evaluator/stageBTools.mjs';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    process.exit(1);
  }
}

// ── Tool definitions ────────────────────────────────────────────────────
await test('WEB_SEARCH_TOOL has correct shape (web_search_20250305)', () => {
  assert.equal(WEB_SEARCH_TOOL.type, 'web_search_20250305');
  assert.equal(WEB_SEARCH_TOOL.name, 'web_search');
  assert.equal(WEB_SEARCH_TOOL.max_uses, 2);
});

await test('VERIFY_JOB_POSTING_TOOL has correct schema', () => {
  assert.equal(VERIFY_JOB_POSTING_TOOL.name, 'verify_job_posting');
  assert.match(VERIFY_JOB_POSTING_TOOL.description, /verify it is still active/);
  assert.equal(VERIFY_JOB_POSTING_TOOL.input_schema.type, 'object');
  assert.deepEqual(VERIFY_JOB_POSTING_TOOL.input_schema.required, ['url']);
  assert.equal(VERIFY_JOB_POSTING_TOOL.input_schema.properties.url.type, 'string');
});

await test('STAGE_B_TOOLS contains both tools in order', () => {
  assert.equal(STAGE_B_TOOLS.length, 2);
  assert.equal(STAGE_B_TOOLS[0], WEB_SEARCH_TOOL);
  assert.equal(STAGE_B_TOOLS[1], VERIFY_JOB_POSTING_TOOL);
});

await test('LOCAL_TOOL_HANDLERS only registers local tools (verify_job_posting)', () => {
  assert.equal(typeof LOCAL_TOOL_HANDLERS.verify_job_posting, 'function');
  // web_search is server-side — must NOT be in local registry.
  assert.equal(LOCAL_TOOL_HANDLERS.web_search, undefined);
});

// ── verifyJobPostingHandler ─────────────────────────────────────────────
await test('verifyJobPostingHandler: missing url → ok:false', async () => {
  const r1 = await verifyJobPostingHandler({});
  assert.equal(r1.ok, false);
  assert.match(r1.error, /missing url/);
  const r2 = await verifyJobPostingHandler({ url: '' });
  assert.equal(r2.ok, false);
  const r3 = await verifyJobPostingHandler(null);
  assert.equal(r3.ok, false);
});

// ── Mock Anthropic client with response queue ───────────────────────────
function makeQueuedClient(responses) {
  let i = 0;
  const calls = [];
  return {
    messages: {
      async create(params) {
        calls.push(params);
        if (i >= responses.length) {
          throw new Error(`mock client exhausted (call ${i + 1})`);
        }
        const r = responses[i++];
        return typeof r === 'function' ? r(params) : r;
      },
    },
    _calls: calls,
    _index: () => i,
  };
}

const SAMPLE_USAGE = {
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

const BASE_PARAMS = {
  model: 'claude-sonnet-4-6',
  max_tokens: 4096,
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: 'JD body' }],
  tools: STAGE_B_TOOLS,
};

// ── runToolUseLoop happy paths ──────────────────────────────────────────
await test('runToolUseLoop: end_turn round 1 → returns immediately, 1 API call', async () => {
  const client = makeQueuedClient([
    {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '## Block A — done' }],
      usage: SAMPLE_USAGE,
    },
  ]);
  const resp = await runToolUseLoop(client, BASE_PARAMS, {});
  assert.equal(client._calls.length, 1);
  assert.equal(resp.stop_reason, 'end_turn');
  assert.equal(resp._toolRoundsUsed, 1);
  assert.equal(resp._maxRoundsExceeded, false);
  // usage mutated to aggregate (single round → same as input)
  assert.equal(resp.usage.input_tokens, 1000);
  assert.equal(resp.usage.output_tokens, 200);
});

await test('runToolUseLoop: verify_job_posting round → handler runs → end_turn', async () => {
  let handlerCalls = 0;
  const client = makeQueuedClient([
    {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'verify_job_posting',
          input: { url: 'https://example.com/job' },
        },
      ],
      usage: SAMPLE_USAGE,
    },
    {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '## Block G — verified' }],
      usage: { ...SAMPLE_USAGE, input_tokens: 1500 }, // round 2 different
    },
  ]);
  const resp = await runToolUseLoop(client, BASE_PARAMS, {
    handlers: {
      verify_job_posting: async (input) => {
        handlerCalls++;
        assert.equal(input.url, 'https://example.com/job');
        return { ok: true, body_excerpt: 'Senior Engineer at Example' };
      },
    },
  });
  assert.equal(client._calls.length, 2);
  assert.equal(handlerCalls, 1);
  assert.equal(resp.stop_reason, 'end_turn');
  assert.equal(resp._toolRoundsUsed, 2);
  // Round 2 messages should include assistant + user(tool_result)
  const round2Msgs = client._calls[1].messages;
  assert.equal(round2Msgs.length, 3); // initial + assistant + tool_result user
  assert.equal(round2Msgs[1].role, 'assistant');
  assert.equal(round2Msgs[2].role, 'user');
  assert.equal(round2Msgs[2].content[0].type, 'tool_result');
  assert.equal(round2Msgs[2].content[0].tool_use_id, 'toolu_01');
  assert.equal(round2Msgs[2].content[0].is_error, false);
  // Aggregate usage = round 1 + round 2
  assert.equal(resp.usage.input_tokens, 1000 + 1500);
});

await test('runToolUseLoop: hosted web_search server-side → no handler, end_turn', async () => {
  let localHandlerCalls = 0;
  // Anthropic auto-handles server_tool_use; the response shows server_tool_use
  // + web_search_tool_result blocks alongside text and stops with end_turn.
  const client = makeQueuedClient([
    {
      stop_reason: 'end_turn',
      content: [
        { type: 'server_tool_use', id: 'srv_01', name: 'web_search', input: { query: 'salary L5' } },
        { type: 'web_search_tool_result', tool_use_id: 'srv_01', content: [] },
        { type: 'text', text: '## Block D — Comp data fetched' },
      ],
      usage: {
        ...SAMPLE_USAGE,
        server_tool_use: { web_search_requests: 1 },
      },
    },
  ]);
  const resp = await runToolUseLoop(client, BASE_PARAMS, {
    handlers: {
      verify_job_posting: async () => {
        localHandlerCalls++;
        return { ok: true };
      },
    },
  });
  assert.equal(client._calls.length, 1);
  assert.equal(localHandlerCalls, 0, 'local handler must NOT run for server-side tool');
  assert.equal(resp.stop_reason, 'end_turn');
  assert.equal(resp.usage.server_tool_use.web_search_requests, 1);
});

// ── Error / timeout / fallback paths ────────────────────────────────────
await test('runToolUseLoop: handler returns ok:false → tool_result is_error:true', async () => {
  const client = makeQueuedClient([
    {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_02',
          name: 'verify_job_posting',
          input: { url: 'https://dead.example.com/job' },
        },
      ],
      usage: SAMPLE_USAGE,
    },
    {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '## Block G — confidence: low' }],
      usage: SAMPLE_USAGE,
    },
  ]);
  const resp = await runToolUseLoop(client, BASE_PARAMS, {
    handlers: {
      verify_job_posting: async () => ({ ok: false, error: '404 Not Found' }),
    },
  });
  assert.equal(resp._toolRoundsUsed, 2);
  const toolResult = client._calls[1].messages[2].content[0];
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /404 Not Found/);
});

await test('runToolUseLoop: handler throws → loop continues with is_error:true', async () => {
  const client = makeQueuedClient([
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'toolu_03', name: 'verify_job_posting', input: { url: 'x' } },
      ],
      usage: SAMPLE_USAGE,
    },
    {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'recovered' }],
      usage: SAMPLE_USAGE,
    },
  ]);
  const resp = await runToolUseLoop(client, BASE_PARAMS, {
    handlers: {
      verify_job_posting: async () => {
        throw new Error('handler crash');
      },
    },
  });
  assert.equal(resp._toolRoundsUsed, 2);
  const toolResult = client._calls[1].messages[2].content[0];
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /handler crash/);
});

await test('runToolUseLoop: unknown tool name → tool_result error fallback', async () => {
  const client = makeQueuedClient([
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_04', name: 'mystery_tool', input: {} }],
      usage: SAMPLE_USAGE,
    },
    {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
      usage: SAMPLE_USAGE,
    },
  ]);
  const resp = await runToolUseLoop(client, BASE_PARAMS, {});
  const toolResult = client._calls[1].messages[2].content[0];
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /unknown tool: mystery_tool/);
});

// ── maxRounds cap ───────────────────────────────────────────────────────
await test('runToolUseLoop: maxRounds=2 caps runaway tool_use loop', async () => {
  // Mock that ALWAYS returns tool_use → loop must bail at maxRounds
  const alwaysToolUse = () => ({
    stop_reason: 'tool_use',
    content: [
      { type: 'tool_use', id: `toolu_${Math.random()}`, name: 'verify_job_posting', input: { url: 'x' } },
    ],
    usage: SAMPLE_USAGE,
  });
  const client = makeQueuedClient([alwaysToolUse, alwaysToolUse, alwaysToolUse]);
  const resp = await runToolUseLoop(client, BASE_PARAMS, {
    handlers: {
      verify_job_posting: async () => ({ ok: true, body_excerpt: 'live' }),
    },
    maxRounds: 2,
  });
  assert.equal(client._calls.length, 2);
  assert.equal(resp._toolRoundsUsed, 2);
  assert.equal(resp._maxRoundsExceeded, true);
  assert.equal(resp.stop_reason, 'tool_use');
});

// ── Usage aggregation across 3 rounds ───────────────────────────────────
await test('runToolUseLoop: usage summed across 3 rounds', async () => {
  const mkRound = (n, isToolUse) => ({
    stop_reason: isToolUse ? 'tool_use' : 'end_turn',
    content: isToolUse
      ? [{ type: 'tool_use', id: `t${n}`, name: 'verify_job_posting', input: { url: 'x' } }]
      : [{ type: 'text', text: 'final' }],
    usage: {
      input_tokens: n * 100,
      output_tokens: n * 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });
  const client = makeQueuedClient([mkRound(1, true), mkRound(2, true), mkRound(3, false)]);
  const resp = await runToolUseLoop(client, BASE_PARAMS, {
    handlers: { verify_job_posting: async () => ({ ok: true, body_excerpt: 'ok' }) },
  });
  assert.equal(resp._toolRoundsUsed, 3);
  assert.equal(resp.usage.input_tokens, 100 + 200 + 300);
  assert.equal(resp.usage.output_tokens, 20 + 40 + 60);
});

// ── Multi tool_use in same round ────────────────────────────────────────
await test('runToolUseLoop: multiple tool_use blocks in one round → all handlers run', async () => {
  let calls = 0;
  const client = makeQueuedClient([
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 't1', name: 'verify_job_posting', input: { url: 'a' } },
        { type: 'tool_use', id: 't2', name: 'verify_job_posting', input: { url: 'b' } },
        { type: 'text', text: 'thinking...' }, // text intermixed allowed
      ],
      usage: SAMPLE_USAGE,
    },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: SAMPLE_USAGE },
  ]);
  const resp = await runToolUseLoop(client, BASE_PARAMS, {
    handlers: {
      verify_job_posting: async () => {
        calls++;
        return { ok: true, body_excerpt: 'live' };
      },
    },
  });
  assert.equal(calls, 2);
  const round2Msgs = client._calls[1].messages;
  // Last user message should have 2 tool_result blocks
  const lastUserMsg = round2Msgs[round2Msgs.length - 1];
  assert.equal(lastUserMsg.role, 'user');
  assert.equal(lastUserMsg.content.length, 2);
  assert.equal(lastUserMsg.content[0].tool_use_id, 't1');
  assert.equal(lastUserMsg.content[1].tool_use_id, 't2');
});

// ── Review fix H2: web_search_tool_result blocks are sanitized out ─────
await test('runToolUseLoop: web_search_tool_result NOT echoed back to API', async () => {
  // Round 1: web_search server-side completes AND a local tool_use is requested
  // in the same response. Round 2 sends history back. The server-side
  // web_search_tool_result block must NOT appear in the assistant message
  // we re-submit (API rejects it). Only text + tool_use + server_tool_use
  // + thinking are valid in a re-submitted assistant turn.
  const client = makeQueuedClient([
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Searching...' },
        { type: 'server_tool_use', id: 'srv', name: 'web_search', input: { query: 'comp data' } },
        { type: 'web_search_tool_result', tool_use_id: 'srv', content: [{ type: 'web_search_result', url: 'x', title: 'y', encrypted_content: 'z' }] },
        { type: 'tool_use', id: 'toolu_X', name: 'verify_job_posting', input: { url: 'https://example.com/job' } },
      ],
      usage: SAMPLE_USAGE,
    },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: SAMPLE_USAGE },
  ]);
  await runToolUseLoop(client, BASE_PARAMS, {
    handlers: { verify_job_posting: async () => ({ ok: true, body_excerpt: 'live' }) },
  });
  const round2AssistantMsg = client._calls[1].messages[1];
  assert.equal(round2AssistantMsg.role, 'assistant');
  // Should keep text, server_tool_use, tool_use; drop web_search_tool_result
  const types = round2AssistantMsg.content.map((b) => b.type);
  assert.ok(types.includes('text'));
  assert.ok(types.includes('server_tool_use'));
  assert.ok(types.includes('tool_use'));
  assert.ok(
    !types.includes('web_search_tool_result'),
    `web_search_tool_result must be sanitized; got types: ${JSON.stringify(types)}`
  );
});

// ── Review fix H1: pause_turn continues the loop ────────────────────────
await test('runToolUseLoop: pause_turn with local tool_use → loop continues', async () => {
  let handlerCalls = 0;
  const client = makeQueuedClient([
    {
      stop_reason: 'pause_turn',
      content: [
        { type: 'tool_use', id: 'toolu_pp', name: 'verify_job_posting', input: { url: 'https://example.com' } },
      ],
      usage: SAMPLE_USAGE,
    },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: SAMPLE_USAGE },
  ]);
  const resp = await runToolUseLoop(client, BASE_PARAMS, {
    handlers: { verify_job_posting: async () => { handlerCalls++; return { ok: true, body_excerpt: 'live' }; } },
  });
  assert.equal(handlerCalls, 1, 'pause_turn must trigger handler execution');
  assert.equal(resp._toolRoundsUsed, 2);
  assert.equal(resp.stop_reason, 'end_turn');
});

// ── Review fix H3: malformed handler return → is_error defaults to true ─
await test('runToolUseLoop: handler returns null/undefined/missing-ok → is_error:true', async () => {
  const variants = [null, undefined, {}, { foo: 'bar' }, 'just-a-string'];
  for (const handlerReturn of variants) {
    const client = makeQueuedClient([
      {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tx', name: 'verify_job_posting', input: { url: 'x' } }],
        usage: SAMPLE_USAGE,
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: SAMPLE_USAGE },
    ]);
    await runToolUseLoop(client, BASE_PARAMS, {
      handlers: { verify_job_posting: async () => handlerReturn },
    });
    const toolResult = client._calls[1].messages[2].content[0];
    assert.equal(
      toolResult.is_error,
      true,
      `handler return ${JSON.stringify(handlerReturn)} should map to is_error:true`
    );
    // content must be a string (JSON.stringify of safeResult)
    assert.equal(typeof toolResult.content, 'string');
  }
});

// ── Review fix H4: tool_use block missing id → filtered out ─────────────
await test('runToolUseLoop: tool_use block with missing id → filtered, no infinite loop', async () => {
  const client = makeQueuedClient([
    {
      stop_reason: 'tool_use',
      content: [
        // Malformed: no id
        { type: 'tool_use', name: 'verify_job_posting', input: { url: 'x' } },
        // Malformed: empty id
        { type: 'tool_use', id: '', name: 'verify_job_posting', input: { url: 'x' } },
      ],
      usage: SAMPLE_USAGE,
    },
  ]);
  const resp = await runToolUseLoop(client, BASE_PARAMS, {
    handlers: { verify_job_posting: async () => ({ ok: true }) },
  });
  // Both blocks invalid → filter empty → defensive bail
  assert.equal(client._calls.length, 1);
  assert.equal(resp._toolRoundsUsed, 1);
});

// ── tool_use stop_reason but no local tool_use blocks (defensive bail) ─
await test('runToolUseLoop: tool_use stop_reason but no tool_use blocks → bail', async () => {
  // E.g. all tool_use blocks were server-side already auto-handled by
  // Anthropic, so no local execution needed; but stop_reason is still tool_use.
  // Should bail to avoid infinite loop.
  const client = makeQueuedClient([
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'server_tool_use', id: 'srv', name: 'web_search', input: {} },
        { type: 'web_search_tool_result', tool_use_id: 'srv', content: [] },
      ],
      usage: SAMPLE_USAGE,
    },
  ]);
  const resp = await runToolUseLoop(client, BASE_PARAMS, {});
  assert.equal(client._calls.length, 1);
  assert.equal(resp._toolRoundsUsed, 1);
});

console.log(`\n✅ All ${passed} smoke tests passed.`);
