#!/usr/bin/env node
// Smoke for 07-applier/01-mode1 m2: draftPrompt module + draftRunner.
// Pure-Node + injectable mock client (no real Anthropic calls).

import assert from 'node:assert/strict';
import {
  APPLIER_MODEL,
  CANONICAL_QUESTIONS,
  FIELD_CLASSES,
  CONFIDENCE_TIERS,
  buildSystemBlock,
  buildUserMessage,
  buildDraftPrompt,
  parseDraftResponse,
  concatTextBlocks,
  ParseError,
} from '../src/career/applier/draftPrompt.mjs';
import { generateDraft, STATUS } from '../src/career/applier/draftRunner.mjs';

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

const SAMPLE_BUNDLE = {
  reportText: '## Block A — Role Summary\nMock summary.\n\n## Block E — Personalization\n- section: summary, current: brief, suggested: tailor for backend',
  legalYml: {
    work_authorization: {
      status: 'F-1 OPT',
      requires_sponsorship_now: true,
      authorized_us_yes_no: true,
    },
    salary_expectations: { min: 180000, currency: 'USD' },
  },
  templatesText: '## Why {company}?\n\n### Template (80 words)\n\nI admire {key_product}.',
  identityYml: { full_name: 'Jane Doe', email: 'jane@example.com', phone: '555-0100' },
  qaHistory: [
    { ts: '2026-05-08T10:00:00Z', jobId: 'aaaaaaaaaaaa', label: 'Why us?', final_answer: 'Mission alignment.', class: 'open' },
  ],
  pdfPath: 'data/career/output/0123456789ab-default.pdf',
};

const SAMPLE_JOB = {
  id: '0123456789ab',
  role: 'Senior Backend Engineer',
  company: 'Anthropic',
  location: ['SF, CA'],
  url: 'https://example.com/jobs/abc',
  description: 'Build safe distributed AI systems.',
  posted_at: '2026-05-01T00:00:00Z',
};

// Mock client that returns a valid 5-field JSON response. Mirrors Sonnet's
// reliable JSON-emit behavior under explicit schema instructions.
function makeValidMockClient() {
  return {
    messages: {
      async create(params) {
        return {
          id: 'msg_mock_draft',
          type: 'message',
          role: 'assistant',
          model: params?.model ?? APPLIER_MODEL,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                fields: [
                  { label: 'Full name', class: 'hard', suggested_value: 'Jane Doe', confidence: 'high', source_ref: 'identity.yml#full_name' },
                  { label: 'Email', class: 'hard', suggested_value: 'jane@example.com', confidence: 'high', source_ref: 'identity.yml#email' },
                  { label: 'Authorized to work in US?', class: 'legal', suggested_value: 'Yes', confidence: 'high', source_ref: 'qa-bank/legal.yml#work_authorization.authorized_us_yes_no' },
                  { label: 'Why this company?', class: 'open', suggested_value: 'I admire the team building safe AI.', confidence: 'medium', source_ref: 'qa-bank/templates.md#why-company' },
                  { label: 'Resume / CV upload', class: 'file', suggested_value: 'data/career/output/0123456789ab-default.pdf', confidence: 'high', source_ref: 'data/career/output/0123456789ab-default.pdf' },
                ],
              }),
            },
          ],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 1500,
            output_tokens: 600,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        };
      },
    },
  };
}

// ── 1. Module exports + constants ──────────────────────────────────────
await test('Module exports the documented public API', () => {
  assert.equal(APPLIER_MODEL, 'claude-sonnet-4-6');
  assert.ok(Array.isArray(CANONICAL_QUESTIONS) && CANONICAL_QUESTIONS.length >= 8);
  assert.ok(Object.isFrozen(CANONICAL_QUESTIONS));
  assert.deepEqual([...FIELD_CLASSES], ['hard', 'legal', 'open', 'file']);
  assert.deepEqual([...CONFIDENCE_TIERS], ['high', 'medium', 'low']);
});

// ── 2. buildSystemBlock: ONE block with cache_control:ephemeral ────────
await test('buildSystemBlock: ONE text block w/ cache_control:ephemeral', () => {
  const sys = buildSystemBlock(SAMPLE_BUNDLE);
  assert.equal(sys.length, 1);
  assert.equal(sys[0].type, 'text');
  assert.deepEqual(sys[0].cache_control, { type: 'ephemeral' });
  assert.ok(sys[0].text.includes('CANONICAL QUESTIONS'));
  assert.ok(sys[0].text.includes('Block A — Role Summary'));
  assert.ok(sys[0].text.includes('work_authorization.status: "F-1 OPT"'));
  assert.ok(sys[0].text.includes('## Why {company}?'));
});

// ── 3. buildSystemBlock: graceful empties + history cap ────────────────
await test('buildSystemBlock: empty inputs produce graceful fallbacks', () => {
  const sys = buildSystemBlock({});
  const text = sys[0].text;
  assert.ok(text.includes('(report unavailable'));
  assert.ok(text.includes('(qa-bank/legal.yml is empty'));
  assert.ok(text.includes('(templates unavailable'));
  assert.ok(text.includes('(identity unavailable'));
  assert.ok(text.includes('(qa-bank/history.jsonl is empty'));
});

await test('buildSystemBlock: history capped at 5 entries', () => {
  const tenEntries = Array.from({ length: 10 }, (_, i) => ({
    ts: '2026-05-08T10:00:00Z',
    jobId: 'aaaaaaaaaaaa',
    label: `Q${i}`,
    final_answer: `A${i}`,
    class: 'open',
  }));
  const sys = buildSystemBlock({ ...SAMPLE_BUNDLE, qaHistory: tenEntries });
  const text = sys[0].text;
  assert.ok(text.includes('Q4'), 'first 5 entries (Q0-Q4) should appear');
  assert.ok(!text.includes('Q5'), 'entries beyond 5 should be excluded');
  assert.ok(!text.includes('Q9'));
});

// ── 4. buildUserMessage: JD + pdfPath + comp_hint ──────────────────────
await test('buildUserMessage: includes role/company/url/JD + pdfPath when given', () => {
  const msg = buildUserMessage(SAMPLE_JOB, { pdfPath: SAMPLE_BUNDLE.pdfPath });
  assert.equal(msg.role, 'user');
  assert.ok(msg.content.includes('Senior Backend Engineer'));
  assert.ok(msg.content.includes('Anthropic'));
  assert.ok(msg.content.includes('Build safe distributed AI'));
  assert.ok(msg.content.includes('Tailored CV PDF: data/career/output/0123456789ab-default.pdf'));
});

await test('buildUserMessage: missing pdfPath emits placeholder', () => {
  const msg = buildUserMessage(SAMPLE_JOB);
  assert.ok(msg.content.includes('Tailored CV PDF: (not yet generated'));
});

// ── 5. buildDraftPrompt shape ──────────────────────────────────────────
await test('buildDraftPrompt: model + max_tokens + system + messages', () => {
  const params = buildDraftPrompt(SAMPLE_JOB, SAMPLE_BUNDLE, { pdfPath: SAMPLE_BUNDLE.pdfPath });
  assert.equal(params.model, APPLIER_MODEL);
  assert.equal(params.max_tokens, 4096);
  assert.equal(params.system.length, 1);
  assert.equal(params.messages.length, 1);
  assert.equal(params.messages[0].role, 'user');
});

// ── 6. parseDraftResponse: tolerates ```json``` wrap ───────────────────
await test('parseDraftResponse: tolerates markdown ```json``` code fence', () => {
  const wrapped = '```json\n' + JSON.stringify({ fields: [
    { label: 'X', class: 'hard', suggested_value: 'v', confidence: 'high' },
  ]}) + '\n```';
  const fields = parseDraftResponse([{ type: 'text', text: wrapped }]);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].label, 'X');
});

// ── 7. parseDraftResponse: tolerates non-fence preamble ────────────────
await test('parseDraftResponse: extracts JSON from response with preamble text', () => {
  const text = 'Here is your draft:\n\n' + JSON.stringify({ fields: [
    { label: 'X', class: 'open', suggested_value: 'v', confidence: 'medium' },
  ]});
  const fields = parseDraftResponse([{ type: 'text', text }]);
  assert.equal(fields.length, 1);
});

// ── 8. parseDraftResponse: throws on empty / non-JSON ─────────────────
await test('parseDraftResponse: ParseError on empty content', () => {
  assert.throws(
    () => parseDraftResponse([{ type: 'text', text: '' }]),
    ParseError
  );
});

await test('parseDraftResponse: ParseError on garbage non-JSON', () => {
  assert.throws(
    () => parseDraftResponse([{ type: 'text', text: 'totally not json at all' }]),
    ParseError
  );
});

// ── 9. parseDraftResponse: ZodError on bad field schema ────────────────
await test('parseDraftResponse: rejects bad class via Zod', () => {
  const bad = JSON.stringify({ fields: [
    { label: 'X', class: 'unknown_class', suggested_value: 'v', confidence: 'high' },
  ]});
  assert.throws(() => parseDraftResponse([{ type: 'text', text: bad }]));
});

// ── 10. concatTextBlocks: stitches text-only, skips tool_use ──────────
await test('concatTextBlocks: stitches text blocks; skips non-text', () => {
  const content = [
    { type: 'text', text: 'first ' },
    { type: 'tool_use', id: 'x' },
    { type: 'text', text: 'second' },
    { type: 'text', text: '' },
  ];
  assert.equal(concatTextBlocks(content), 'first \nsecond\n');
});

// ── 11. generateDraft: success path with mock client ───────────────────
await test('generateDraft: success path returns drafted with fields + cost', async () => {
  const r = await generateDraft(SAMPLE_JOB, SAMPLE_BUNDLE, {
    _client: makeValidMockClient(),
    _recordCost: async () => {}, // suppress llm-costs.jsonl writes
  });
  assert.equal(r.status, STATUS.DRAFTED);
  assert.equal(r.jobId, '0123456789ab');
  assert.equal(r.model, APPLIER_MODEL);
  assert.ok(r.cost_usd > 0);
  assert.ok(Array.isArray(r.fields));
  assert.equal(r.fields.length, 5);
  assert.ok(typeof r.generated_at === 'string');
  // Field shape preserved through Zod
  const legalField = r.fields.find((f) => f.class === 'legal');
  assert.ok(legalField);
  assert.equal(legalField.confidence, 'high');
});

// ── 12. generateDraft: degenerate response → error result ──────────────
await test('generateDraft: degenerate response → status=error with parse: tag', async () => {
  const degenerateMock = {
    messages: {
      async create(params) {
        return {
          id: 'msg_degen',
          type: 'message',
          role: 'assistant',
          model: params?.model ?? APPLIER_MODEL,
          content: [{ type: 'text', text: 'Sorry, I cannot draft right now.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: null, cache_read_input_tokens: null },
        };
      },
    },
  };
  const r = await generateDraft(SAMPLE_JOB, SAMPLE_BUNDLE, {
    _client: degenerateMock,
    _recordCost: async () => {},
  });
  assert.equal(r.status, STATUS.ERROR);
  assert.match(r.error, /parse:/);
  // Cost still recorded for the API call we paid for
  assert.ok(r.cost_usd > 0);
});

// ── 13. generateDraft: API error → status=error with api: tag ──────────
await test('generateDraft: API error → status=error with api: tag', async () => {
  const failingMock = {
    messages: {
      async create() {
        const e = new Error('Internal Server Error');
        e.status = 500;
        // Will retry 2x; all 3 attempts fail
        throw e;
      },
    },
  };
  const r = await generateDraft(SAMPLE_JOB, SAMPLE_BUNDLE, {
    _client: failingMock,
    _recordCost: async () => {},
    _sleep: async () => {}, // skip retry delays
  });
  assert.equal(r.status, STATUS.ERROR);
  assert.match(r.error, /api:/);
  assert.equal(r.cost_usd, 0);
});

console.log(`\n✅ All ${passed} smoke tests passed.`);
