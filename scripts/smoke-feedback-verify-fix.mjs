#!/usr/bin/env node
// Smoke for the M4 verification-failure flywheel:
//   - VerifyFailureSchema (verify-failures.jsonl record validation)
//   - induceVerifyFix (classifier-rule induction from not_seen clusters)
// Pure-Node, mocks the Anthropic client. ~instant.

import assert from 'node:assert/strict';
import { VerifyFailureSchema } from '../src/career/feedback/schemas.mjs';
import { buildPrompt, induce } from '../src/career/feedback/induceVerifyFix.mjs';

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

const okRecord = {
  ts: '2026-05-22T00:00:00.000Z',
  jobId: '0138ed7db46b',
  site: 'greenhouse',
  field_label: 'Why this role?',
  refId: '__notseen_0',
  role: 'textbox',
  verify_status: 'not_seen',
  suggested_value: '',
  detail: 'on the form but the machine did not capture it',
};

// ── VerifyFailureSchema ────────────────────────────────────────────────

await test('VerifyFailureSchema: valid record parses', () => {
  assert.deepEqual(VerifyFailureSchema.parse(okRecord), okRecord);
});

await test('VerifyFailureSchema: bad verify_status rejected', () => {
  assert.throws(() => VerifyFailureSchema.parse({ ...okRecord, verify_status: 'verified' }));
});

await test('VerifyFailureSchema: bad jobId rejected', () => {
  assert.throws(() => VerifyFailureSchema.parse({ ...okRecord, jobId: 'NOT-HEX' }));
});

await test('VerifyFailureSchema: extra key rejected (strict)', () => {
  assert.throws(() => VerifyFailureSchema.parse({ ...okRecord, extra: 1 }));
});

// ── induceVerifyFix.buildPrompt ────────────────────────────────────────

await test('buildPrompt: labels appear, untrusted content delimited', () => {
  const { system, user } = buildPrompt('greenhouse', [
    { field_label: 'Why us?' },
    { field_label: 'AI Policy for Application' },
  ]);
  assert.match(user, /Why us\?/);
  assert.match(user, /AI Policy for Application/);
  assert.match(user, /BEGIN UNTRUSTED USER CONTENT/);
  assert.match(system, /untrusted/i);
});

// ── induceVerifyFix.induce ─────────────────────────────────────────────

function mockClient(text) {
  return {
    messages: {
      async create() {
        return {
          content: [{ type: 'text', text }],
          usage: { input_tokens: 200, output_tokens: 60 },
        };
      },
    },
  };
}

const notSeen3 = [
  { verify_status: 'not_seen', field_label: 'Why us?' },
  { verify_status: 'not_seen', field_label: 'Why this role?' },
  { verify_status: 'not_seen', field_label: 'Why now?' },
];

await test('induce: fewer than 2 not_seen → null (nothing rule-worthy)', async () => {
  const r = await induce('greenhouse', [notSeen3[0]], { client: mockClient('{}') });
  assert.equal(r, null);
});

await test('induce: only mismatch/fill_error records → null (0 not_seen)', async () => {
  const recs = [
    { verify_status: 'mismatch', field_label: 'Gender' },
    { verify_status: 'fill_error', field_label: 'Address' },
  ];
  const r = await induce('greenhouse', recs, { client: mockClient('{}') });
  assert.equal(r, null);
});

await test('induce: valid proposal from a not_seen cluster', async () => {
  const proposal = JSON.stringify({
    regex: '^why\\b',
    class: 'open',
    maps_to: 'why-company',
    confidence: 'medium',
    rationale: 'all three are "why" free-text questions',
  });
  const r = await induce('greenhouse', notSeen3, { client: mockClient(proposal) });
  assert.ok(r, 'expected a result');
  assert.equal(r.proposal.class, 'open');
  assert.equal(r.proposal.regex, '^why\\b');
  assert.ok(r.cost_usd > 0, 'cost recorded');
});

await test('induce: regex matches none of the labels → null (relevance gate)', async () => {
  const irrelevant = JSON.stringify({
    regex: '^zzz-nonsense$',
    class: 'open',
    maps_to: 'why-company',
    confidence: 'medium',
    rationale: 'compiles fine but matches nothing',
  });
  const r = await induce('greenhouse', notSeen3, { client: mockClient(irrelevant) });
  assert.equal(r, null);
});

await test('induce: garbage model output → null', async () => {
  const r = await induce('greenhouse', notSeen3, { client: mockClient('sorry, no idea') });
  assert.equal(r, null);
});

await test('induce: proposal with an uncompilable regex → null', async () => {
  const bad = JSON.stringify({
    regex: '(unclosed',
    class: 'open',
    maps_to: '',
    confidence: 'medium',
    rationale: 'x',
  });
  const r = await induce('greenhouse', notSeen3, { client: mockClient(bad) });
  assert.equal(r, null);
});

await test('induce: recordCost dep is called', async () => {
  let costSeen = null;
  await induce('greenhouse', notSeen3, {
    client: mockClient('not json'),
    recordCost: (rec) => {
      costSeen = rec;
    },
  });
  assert.ok(costSeen, 'recordCost was called');
  assert.equal(costSeen.caller, 'feedback:induceVerifyFix');
  assert.equal(costSeen.success, false);
});

console.log(`\n✅ All ${passed} verify-fix smoke tests passed.`);
