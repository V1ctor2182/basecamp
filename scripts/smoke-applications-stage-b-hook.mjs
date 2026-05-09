#!/usr/bin/env node
// Smoke for 08-human-gate-tracker/01-application-state m3: Stage B runner
// auto-insert hook into applications.json.
//
// Drives the Stage B runner directly with a custom mock client that returns
// a real 7-block response (the global MOCK_ANTHROPIC mock returns a degenerate
// Score: 4.0/5 string that fails the 7-block parser, so we can't use it for
// the EVALUATED-path verification this hook needs).
//
// Asserts:
//   1. Successful Stage B eval inserts an Evaluated application row
//   2. Re-running Stage B after a user transitions the row to Applied does
//      NOT reset the status (idempotency holds)
//   3. Re-running on the same row preserves company/role/url/etc

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { evaluateJobsStageB } from '../src/career/evaluator/stageBRunner.mjs';
import {
  readApplications,
  transitionStatus,
  APPLICATIONS_FILE,
  acquireApplicationsLock,
  releaseApplicationsLock,
} from '../src/career/applications/store.mjs';

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

// ── Fixture isolation: backup live applications.json + reports + llm-costs ─
const SUFFIX = `.smoke-backup.${process.pid}`;
const REPORTS_DIR = path.resolve('data', 'career', 'reports');
const LLM_COSTS = path.resolve('data', 'career', 'llm-costs.jsonl');

async function backup(file) {
  try { await fs.copyFile(file, file + SUFFIX); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
async function restore(file, hadOriginal) {
  if (hadOriginal) await fs.rename(file + SUFFIX, file).catch(() => {});
  else await fs.unlink(file).catch(() => {});
}

const applicationsBack = await backup(APPLICATIONS_FILE);
const llmCostsBack = await backup(LLM_COSTS);
await fs.unlink(APPLICATIONS_FILE).catch(() => {});

// Track reports we create so we can clean them up
const preExistingReports = new Set();
if (existsSync(REPORTS_DIR)) {
  for (const f of await fs.readdir(REPORTS_DIR)) preExistingReports.add(f);
}

// ── Custom mock client: produces a 7-block response Stage B parser accepts
function makeMockSevenBlockClient() {
  return {
    messages: {
      async create(params) {
        return {
          id: 'msg_mock7',
          type: 'message',
          role: 'assistant',
          model: params?.model ?? 'claude-sonnet-4-6',
          content: [
            {
              type: 'text',
              text: [
                '## Block A — Role Summary',
                'A concise mock summary of the role.',
                '',
                '## Block B — CV Match',
                '| Requirement | Evidence | Gap |',
                '| --- | --- | --- |',
                '| Backend skills | Strong | None |',
                '',
                '## Block C — Level & Strategy',
                'Mid-senior pitch.',
                '',
                '## Block D — Comp & Demand',
                '*confidence: low. Web tool unavailable; based on JD inference.*',
                'Mock comp band.',
                '',
                '## Block E — Personalization',
                '- section: summary, current: brief, suggested: tailor for backend',
                '',
                '## Block F — Interview Plan',
                'Six STAR stories (mock).',
                '',
                '## Block G — Posting Legitimacy',
                '*confidence: low. Cannot verify posting currently active.*',
                '',
                '**Total: 4.4/5**',
              ].join('\n'),
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

// Minimal prefs sufficient to drive the runner — most fields go through
// resolveEnabledBlocks / scoring_weights renderer.
const PREFS = {
  evaluator_strategy: {
    stage_b: {
      blocks: { block_b: true, block_c: false, block_d: false, block_e: true, block_f: false, block_g: false },
    },
  },
  scoring_weights: {
    tech_match: 0.2, comp_match: 0.2, location_match: 0.2, company_match: 0.2, growth_signal: 0.2,
  },
};

const TODAY_SUFFIX = (() => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
})();

function makeJob(id) {
  return {
    id,
    company: 'Anthropic',
    role: 'Senior Backend Engineer',
    url: 'https://example.com/jobs/abc',
    description: 'Build safe distributed AI.',
    location: ['SF, CA'],
    posted_at: null,
  };
}

async function cleanup() {
  await restore(APPLICATIONS_FILE, applicationsBack);
  await restore(LLM_COSTS, llmCostsBack);
  if (existsSync(REPORTS_DIR)) {
    for (const f of await fs.readdir(REPORTS_DIR)) {
      if (preExistingReports.has(f)) continue;
      await fs.unlink(path.join(REPORTS_DIR, f)).catch(() => {});
    }
  }
}

try {
  // ── 1. Successful eval inserts an Evaluated application row ─────────
  await test('Stage B success path inserts Evaluated row in applications.json', async () => {
    const jobId = 'aaaaaaaaaaaa';
    const expectedId = `${jobId}-${TODAY_SUFFIX}`;
    await fs.unlink(APPLICATIONS_FILE).catch(() => {});

    const result = await evaluateJobsStageB(
      [makeJob(jobId)],
      PREFS,
      {
        _client: makeMockSevenBlockClient(),
        _recordCost: async () => {}, // skip llm-costs.jsonl writes for isolation
        cvBundle: { cv: 'CV', narrative: 'N', proofPoints: 'P', identity: {}, qaFewShot: [] },
      }
    );

    assert.equal(result.evaluated, 1, `Stage B should evaluate 1 job; got ${JSON.stringify(result)}`);
    assert.equal(result.errors, 0);

    const apps = await readApplications();
    assert.equal(apps.length, 1);
    const row = apps[0];
    assert.equal(row.id, expectedId);
    assert.equal(row.status, 'Evaluated');
    assert.equal(row.company, 'Anthropic');
    assert.equal(row.role, 'Senior Backend Engineer');
    assert.equal(row.url, 'https://example.com/jobs/abc');
    assert.equal(row.score, 4.4);
    assert.equal(row.legitimacy, 'Unknown');
    assert.equal(row.reportPath, `data/career/reports/${jobId}.md`);
    assert.equal(row.pdfPath, null);
    assert.equal(row.resumeId, null);
    assert.equal(row.timeline.length, 1);
    assert.equal(row.timeline[0].event, 'created');
    assert.equal(row.timeline[0].note, 'auto-inserted by Stage B');
  });

  // ── 2. Re-running Stage B does NOT reset user-set later status ─────
  await test('Stage B re-run preserves user-set Applied status (idempotency)', async () => {
    const jobId = 'bbbbbbbbbbbb';
    const expectedId = `${jobId}-${TODAY_SUFFIX}`;
    await fs.unlink(APPLICATIONS_FILE).catch(() => {});

    // First eval: creates Evaluated row
    await evaluateJobsStageB(
      [makeJob(jobId)],
      PREFS,
      {
        _client: makeMockSevenBlockClient(),
        _recordCost: async () => {},
        cvBundle: { cv: 'CV', narrative: 'N', proofPoints: 'P', identity: {}, qaFewShot: [] },
      }
    );
    let row = (await readApplications()).find((r) => r.id === expectedId);
    assert.equal(row.status, 'Evaluated');

    // User transitions to Applied via the m2 endpoint pathway (using the
    // store helper directly here — equivalent state)
    {
      const lock = acquireApplicationsLock();
      assert.ok(lock.ok);
      try {
        await transitionStatus(expectedId, 'Applied', 'submitted manually');
      } finally {
        releaseApplicationsLock();
      }
    }
    row = (await readApplications()).find((r) => r.id === expectedId);
    assert.equal(row.status, 'Applied');
    const timelineLengthAfterApply = row.timeline.length;

    // Re-run Stage B on same job — row should be untouched (idempotency)
    await evaluateJobsStageB(
      [
        // Stage B's shouldEvaluate skip-gate triggers only when the job has
        // a stage_b field. Since we're testing the runner directly with a
        // job that has no evaluation yet, the runner will re-evaluate; the
        // store-level idempotency is what protects the application row.
        makeJob(jobId),
      ],
      PREFS,
      {
        _client: makeMockSevenBlockClient(),
        _recordCost: async () => {},
        cvBundle: { cv: 'CV', narrative: 'N', proofPoints: 'P', identity: {}, qaFewShot: [] },
      }
    );
    row = (await readApplications()).find((r) => r.id === expectedId);
    assert.equal(row.status, 'Applied', 're-eval must NOT reset Applied → Evaluated');
    assert.equal(
      row.timeline.length,
      timelineLengthAfterApply,
      'no extra timeline events from idempotent upsert'
    );
  });

  // ── 3. Failed parse path does NOT touch applications.json ──────────
  await test('Stage B parse failure leaves applications.json untouched', async () => {
    const jobId = 'cccccccccccc';
    const expectedId = `${jobId}-${TODAY_SUFFIX}`;
    await fs.unlink(APPLICATIONS_FILE).catch(() => {});

    // Mock that produces a degenerate non-7-block response (mirrors the
    // global MOCK_ANTHROPIC behavior — Stage B parser will reject it as
    // missing forced blocks)
    const degenerateMock = {
      messages: {
        async create(params) {
          return {
            id: 'msg_degenerate',
            type: 'message',
            role: 'assistant',
            model: params?.model ?? 'claude-sonnet-4-6',
            content: [{ type: 'text', text: 'Score: 3.0/5 — degenerate mock.' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: null, cache_read_input_tokens: null },
          };
        },
      },
    };

    const result = await evaluateJobsStageB(
      [makeJob(jobId)],
      PREFS,
      {
        _client: degenerateMock,
        _recordCost: async () => {},
        cvBundle: { cv: 'CV', narrative: 'N', proofPoints: 'P', identity: {}, qaFewShot: [] },
      }
    );

    assert.equal(result.errors, 1, 'degenerate response should land as error');
    const apps = await readApplications();
    assert.equal(
      apps.find((r) => r.id === expectedId),
      undefined,
      'applications.json must NOT have a row for an errored Stage B run'
    );
  });
} finally {
  await cleanup();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
