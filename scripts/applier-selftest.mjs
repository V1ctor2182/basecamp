#!/usr/bin/env node
// Mode 2 applier self-test harness (07-applier verification layer, M3).
//
// Drives the multi-step machine against a fixture of real job URLs —
// headless, auto-approving EVERY step, NEVER submitting (the machine
// always stops at the Submit page). After each job it tallies the M1/M2
// post-fill verification statuses and prints + writes an aggregate
// report. This is the unattended "apply to a few jobs and see what
// happens" loop — it tells you, per job, how many fields actually
// landed vs silently failed.
//
// Usage:  node scripts/applier-selftest.mjs [fixture.json]
// Runs headless + ~2-4 min/job; the report is the deliverable.

// Headless — set before browser.mjs is (lazily) imported by the machine.
process.env.APPLIER_HEADLESS = '1';
// Pick up .env (CAREER_LLM_BACKEND=cli, etc.) — standalone scripts don't
// get server.mjs's loadEnvFile.
try {
  process.loadEnvFile();
} catch {
  /* no .env — rely on the shell environment */
}

import fs from 'node:fs';
import path from 'node:path';
import {
  startMachine,
  getStatus,
  approveStep,
  pauseMachine,
} from '../src/career/applier/multistep/endpoint.mjs';
import { readSession, deleteSession } from '../src/career/applier/multistep/applySessionsStore.mjs';
import { recordVerifyFailure } from '../src/career/feedback/stores.mjs';
import { maybeInduce } from '../src/career/feedback/induce.mjs';

const DEFAULT_FIXTURE = path.resolve('data', 'career', 'eval-fixtures', 'applier-selftest.json');
const REPORT_PATH = path.resolve('data', 'career', 'eval-fixtures', 'applier-selftest-report.json');
const PER_JOB_TIMEOUT_MS = 6 * 60 * 1000;
const POLL_MS = 2000;
const STATUS_KEYS = ['verified', 'mismatch', 'fill_error', 'unverifiable', 'not_seen', 'manual'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tally verify_status across every field in a session's per-step drafts.
function tallySession(session) {
  const counts = Object.fromEntries(STATUS_KEYS.map((k) => [k, 0]));
  if (!session || !session.per_step_draft) return counts;
  for (const step of Object.values(session.per_step_draft)) {
    for (const f of step.fields || []) {
      if (f && f.verify_status && f.verify_status in counts) counts[f.verify_status]++;
    }
  }
  return counts;
}

const FAILURE_STATUSES = new Set(['mismatch', 'fill_error', 'not_seen', 'unverifiable']);

// Record every verification failure in a job's session into the
// verify-failures flywheel store (Layer 3 feed). Per-record errors are
// swallowed with a warning — one bad row must not abort the harness.
async function recordFailures(jobId, session) {
  if (!session || !session.per_step_draft) return 0;
  const site = session.site_adapter || 'generic';
  let n = 0;
  for (const step of Object.values(session.per_step_draft)) {
    for (const f of step.fields || []) {
      if (!f || !FAILURE_STATUSES.has(f.verify_status)) continue;
      try {
        await recordVerifyFailure({
          ts: new Date().toISOString(),
          jobId,
          site,
          field_label: String(f.label || '(unlabeled)').slice(0, 400),
          refId: String(f.refId || 'unknown').slice(0, 64),
          role: String(f.role || '').slice(0, 40),
          verify_status: f.verify_status,
          suggested_value: String(f.suggested_value ?? '').slice(0, 2000),
          detail: String(f.verify_detail ?? '').slice(0, 400),
        });
        n += 1;
      } catch (e) {
        console.warn(`  (skipped a verify-failure record: ${e.message})`);
      }
    }
  }
  return n;
}

function fmtCounts(c) {
  const parts = [];
  if (c.verified) parts.push(`✓${c.verified} verified`);
  if (c.mismatch) parts.push(`✗${c.mismatch} mismatch`);
  if (c.fill_error) parts.push(`✗${c.fill_error} fill_error`);
  if (c.unverifiable) parts.push(`⚠${c.unverifiable} unverifiable`);
  if (c.not_seen) parts.push(`⊘${c.not_seen} not_seen`);
  if (c.manual) parts.push(`⚠${c.manual} manual`);
  return parts.length ? parts.join(' · ') : '(no fields)';
}

// Poll until the machine settles (state==='done') or `ms` elapses.
async function waitForSettle(jobId, ms) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    await sleep(POLL_MS);
    const st = await getStatus(jobId);
    if (!st.error && st.machine && st.machine.state === 'done') return true;
  }
  return false;
}

// Run one job: start → poll → auto-approve every gate → settle.
async function runJob(job) {
  const { jobId, url, label } = job;
  await deleteSession(jobId).catch(() => {});
  const started = await startMachine({ jobId, jobUrl: url }, { freshStart: true });
  if (started.error) {
    return { jobId, label, url, outcome: 'start-error', error: started.error };
  }
  const deadline = Date.now() + PER_JOB_TIMEOUT_MS;
  const approved = new Set();
  let lastError = null;
  // A 404 right after start is normal (INIT + navigation, ~5s); a long
  // streak means the machine never came up — bail rather than spin the
  // full per-job timeout reporting a misleading 'timeout'.
  let errStreak = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const st = await getStatus(jobId);
    if (st.error) {
      errStreak += 1;
      if (errStreak > 20) {
        return { jobId, label, url, outcome: 'no-session', error: st.error };
      }
      continue;
    }
    errStreak = 0;
    const m = st.machine || {};
    if (m.state === 'done') {
      return {
        jobId,
        label,
        url,
        outcome: m.lastOutcome || 'done',
        error: m.lastError || null,
        session: st.session,
      };
    }
    if (m.pending) {
      const key = `${m.pending.stepIdx}:${m.pending.requested_at}`;
      if (!approved.has(key)) {
        approved.add(key);
        const r = approveStep(jobId, { approved: true, edits: [] });
        if (r && r.error) lastError = `approve: ${r.error}`;
      }
    }
  }
  // Timed out — stop the machine and wait for it to actually settle
  // before returning, so a still-running fill can't collide with the
  // next job on the shared singleton browser.
  try {
    pauseMachine(jobId);
  } catch {
    /* best-effort */
  }
  await waitForSettle(jobId, 60_000);
  const session = await readSession(jobId).catch(() => null);
  return {
    jobId,
    label,
    url,
    outcome: 'timeout',
    error: lastError || `exceeded ${PER_JOB_TIMEOUT_MS}ms`,
    session,
  };
}

const JOB_ID_RE = /^[0-9a-f]{12}$/;

// Split fixture entries into runnable jobs + invalid ones (reported, not run).
function validateFixture(jobs) {
  const valid = [];
  const invalid = [];
  for (const job of jobs) {
    if (!job || !JOB_ID_RE.test(String(job.jobId ?? ''))) {
      invalid.push({
        jobId: job?.jobId ?? null,
        label: job?.label ?? '(unknown)',
        url: job?.url ?? null,
        outcome: 'invalid-fixture',
        error: 'jobId must be 12 lowercase hex',
      });
    } else if (typeof job.url !== 'string' || !/^https?:\/\//i.test(job.url)) {
      invalid.push({
        jobId: job.jobId,
        label: job.label ?? '(unknown)',
        url: job.url ?? null,
        outcome: 'invalid-fixture',
        error: 'missing or non-http url',
      });
    } else {
      valid.push(job);
    }
  }
  return { valid, invalid };
}

async function main() {
  const fixturePath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_FIXTURE;
  if (!fs.existsSync(fixturePath)) {
    console.error(`fixture not found: ${fixturePath}`);
    process.exit(1);
  }
  let fixture;
  try {
    fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  } catch (e) {
    console.error(`fixture unparseable: ${e.message}`);
    process.exit(1);
  }
  const rawJobs = Array.isArray(fixture.jobs) ? fixture.jobs : [];
  if (rawJobs.length === 0) {
    console.log('fixture has no jobs — nothing to test.');
    process.exit(0);
  }
  const { valid, invalid } = validateFixture(rawJobs);
  for (const bad of invalid) {
    console.log(`\n⚠ skipping ${bad.label} — ${bad.error}`);
  }

  console.log(`\n═══ Applier self-test — ${valid.length} job(s), headless ═══`);
  const results = [...invalid];
  for (let i = 0; i < valid.length; i++) {
    const job = valid[i];
    console.log(`\n▶ [${i + 1}/${valid.length}] ${job.label || job.jobId}`);
    let r;
    try {
      r = await runJob(job);
    } catch (e) {
      r = { jobId: job.jobId, label: job.label, url: job.url, outcome: 'error', error: String(e?.message ?? e) };
    }
    r.counts = tallySession(r.session);
    results.push(r);
    console.log(`  outcome=${r.outcome}  ${fmtCounts(r.counts)}${r.error ? `  err=${r.error}` : ''}`);
    const recorded = await recordFailures(r.jobId, r.session);
    if (recorded) console.log(`  recorded ${recorded} verify-failure(s) → flywheel`);
  }

  // ── Aggregate report ────────────────────────────────────────────────
  // Invalid-fixture rows were spread in without a tally — normalize.
  for (const r of results) {
    if (!r.counts) r.counts = tallySession(null);
  }
  const totals = Object.fromEntries(STATUS_KEYS.map((k) => [k, 0]));
  const byOutcome = {};
  for (const r of results) {
    for (const k of STATUS_KEYS) totals[k] += r.counts[k] || 0;
    byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;
  }
  console.log(`\n─── TOTAL ───`);
  console.log(
    `  jobs: ${results.length}  ·  ` +
      Object.entries(byOutcome).map(([o, n]) => `${o}: ${n}`).join('  '),
  );
  console.log(`  fields: ${fmtCounts(totals)}`);

  const report = {
    ran_at: new Date().toISOString(),
    fixture: fixturePath,
    jobs: results.map((r) => ({
      jobId: r.jobId,
      label: r.label,
      url: r.url,
      outcome: r.outcome,
      error: r.error || null,
      counts: r.counts,
    })),
    totals,
    by_outcome: byOutcome,
  };
  try {
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`\n  report → ${path.relative(process.cwd(), REPORT_PATH)}`);
  } catch (e) {
    console.error(`  report write failed: ${e.message}`);
  }

  // ── Layer 3 — feed the recorded failures into the flywheel ──────────
  console.log(`\n─── Flywheel induction ───`);
  try {
    const proposals = await maybeInduce('verify-failure');
    if (proposals.length > 0) {
      console.log(`  ${proposals.length} fix proposal(s) → data/career/feedback/suggested/  (review before applying)`);
      for (const p of proposals) {
        const pr = p.proposal || {};
        console.log(`    [${p.group_key}] class=${pr.class || '?'}  regex=/${pr.regex || ''}/`);
      }
    } else {
      console.log(
        '  no proposals — needs ≥5 verify-failures + ≥2 not_seen on a site ' +
          '(or the threshold was already inducted; or the model returned nothing)',
      );
    }
  } catch (e) {
    console.warn(`  induction failed: ${e.message}`);
  }

  // Chromium singleton stays open — exit hard so the harness terminates.
  process.exit(0);
}

main().catch((e) => {
  console.error('self-test crashed:', e);
  process.exit(1);
});
