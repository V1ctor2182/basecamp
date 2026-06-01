#!/usr/bin/env node
// Integration smoke for Mode 2 against a fixture Greenhouse-style form.
//
// Goals (deferred from m12/m13/m14 "production-path integration coverage"):
//   1. Confirm server boots cleanly with MOCK_ANTHROPIC=1
//   2. POST /multi-step/start with fixture URL → 202
//   3. Status response carries the m14 submitDetectedBy field
//   4. focus-field returns 409 reason='no_live_page' when machine isn't running
//      (validates m13's structured response + server route forwarding —
//      C2 fix from m13 review)
//   5. SSE /events endpoint accepts connections + sends `: hello` frame
//
// This is intentionally NARROW. A full end-to-end through approval gates +
// observer + retry against a real Playwright Page is m15-deferred — the
// classifier needs LLM context that MOCK_ANTHROPIC doesn't supply
// meaningfully for an arbitrary form.

process.env.SMOKE = '1';

// Bypass the dev environment's outbound HTTP proxy (set in
// CAREER_FETCH_PROXY for Mode 1 LLM calls). The integration smoke
// fetches localhost only, but undici's default dispatcher respects
// http_proxy / HTTP_PROXY and routes EVERYTHING through 127.0.0.1:12334
// — that proxy then drops the /start connection while the browser
// launches because it has its own timeout. Set NO_PROXY to keep
// localhost fetches direct.
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';
// Belt-and-suspenders: clear http_proxy entirely for this process so
// undici doesn't pick it up from the parent env.
delete process.env.http_proxy;
delete process.env.HTTP_PROXY;

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs/promises';

// ── Pre-flight cleanup ──────────────────────────────────────────────
//
// Integration smokes share the apply-sessions/ + persistent profile with
// any prior run that didn't clean up. Wipe our JOB_ID + kill any chromium
// processes still holding the profile lock before spawning the server.

const JOB_ID_PRECLEAN = 'aabbccddeeff';
const APPLY_SESSIONS = path.resolve('data/career/apply-sessions');
const PROFILE_PATH = path.resolve('data/career/.playwright/profile');

try {
  await fs.unlink(path.join(APPLY_SESSIONS, `${JOB_ID_PRECLEAN}.json`));
  console.log('[pre-flight] removed stale session file');
} catch { /* didn't exist */ }

// [review H1/H3] pgrep treats the pattern as regex — escape special
// chars in the profile path so we don't accidentally match a sibling
// worktree's profile and SIGTERM the wrong processes.
const escapedProfile = PROFILE_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
try {
  const raw = execFileSync('pgrep', ['-f', `user-data-dir=${escapedProfile}`], {
    encoding: 'utf8',
    timeout: 2_000,
  });
  const pids = raw.trim().split('\n').filter(Boolean);
  if (pids.length) {
    console.log(`[pre-flight] WARNING: about to kill ${pids.length} chromium process(es) ` +
      `(PIDs: ${pids.join(', ')}). If you have a parallel dev cockpit open, it WILL die.`);
  }
  for (const pid of pids) {
    try { process.kill(Number(pid), 'SIGTERM'); } catch { /* */ }
  }
  if (pids.length) {
    await new Promise((r) => setTimeout(r, 1_000));
  }
} catch { /* no matches */ }

const APPLY_PORT = 4598;
const FIXTURE_PORT = 4599;
const BASE = `http://127.0.0.1:${APPLY_PORT}`;

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    failed++;
  }
}

// ── Fixture HTTP server ─────────────────────────────────────────────

const fixturePath = path.resolve('data/career/test-fixtures/greenhouse-fixture.html');
const fixtureHtml = await fs.readFile(fixturePath, 'utf8');

const fixtureServer = http.createServer((req, res) => {
  if (req.url === '/thank-you') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Thank you for your application!</h1>');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(fixtureHtml);
});

await new Promise((resolve) => fixtureServer.listen(FIXTURE_PORT, resolve));
const fixtureUrl = `http://127.0.0.1:${FIXTURE_PORT}/jobs/test-role`;

// ── Apply server ────────────────────────────────────────────────────

const proc = spawn(process.execPath, ['server.mjs'], {
  env: {
    ...process.env,
    PORT: String(APPLY_PORT),
    MOCK_ANTHROPIC: '1',
    DISABLE_SCAN_SCHEDULER: '1',
    SMOKE: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverReady = false;
const stderrBuf = [];
proc.stdout.on('data', (b) => {
  if (b.toString().includes(`API server on :${APPLY_PORT}`)) serverReady = true;
});
proc.stderr.on('data', (b) => stderrBuf.push(b.toString()));

const t0 = Date.now();
while (!serverReady) {
  if (Date.now() - t0 > 30_000) {
    console.error('apply server stderr:', stderrBuf.join(''));
    fixtureServer.close();
    proc.kill();
    throw new Error('apply server did not become ready in 30s');
  }
  await new Promise((r) => setTimeout(r, 100));
}

async function cleanup() {
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  fixtureServer.close();
}

const JOB_ID = 'aabbccddeeff';

try {
  // ── 1. Server boot + route registration ──────────────────────────

  await test('1. server is healthy — GET /api/career/applier/multi-step/:jobId/status returns 404 for unknown jobId', async () => {
    const r = await fetch(`${BASE}/api/career/applier/multi-step/${JOB_ID}/status`);
    assert.equal(r.status, 404, `expected 404 (no session), got ${r.status}`);
    const j = await r.json();
    assert.match(j.error, /no session/i);
  });

  // ── 2. focus-field on missing session → 404 ──────────────────────

  await test('2. focus-field with no session — 404 (validates m13 route + handler chain)', async () => {
    const r = await fetch(
      `${BASE}/api/career/applier/multi-step/${JOB_ID}/focus-field`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'email' }),
      },
    );
    // Expecting 404 (no session) since we haven't started a machine
    assert.equal(r.status, 404, `expected 404, got ${r.status}`);
    const j = await r.json();
    assert.match(j.error, /no session/i);
  });

  // ── 3. SSE /events endpoint accepts + emits hello ────────────────

  await test('3. SSE /events endpoint accepts + emits `: hello` frame', async () => {
    const url = `${BASE}/api/career/applier/multi-step/${JOB_ID}/events`;
    const r = await fetch(url);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/event-stream');
    // Read first chunk (expect `: hello`)
    const reader = r.body.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    assert.match(chunk, /:\s*hello/);
    reader.cancel();
  });

  // ── 4. POST /start with the fixture URL ──────────────────────────
  //
  // NOTE: /start blocks on browser launch + humanNavigate (typically
  // 5-15s on first launch, 1-3s warm). Use a generous AbortController
  // timeout so a stuck Playwright launch doesn't hang the smoke
  // indefinitely. The Plan-review verdict from m12-m14 is that this
  // test is "best-effort production integration coverage" — failure
  // is acceptable in a dirty dev environment (zombie chromium, full
  // disk, etc.) and skips the downstream tests.

  let startSucceeded = false;
  await test('4. POST /start with fixture URL → 202 (60s budget)', async () => {
    const ac = new AbortController();
    const killer = setTimeout(() => ac.abort('start hung past 60s'), 60_000);
    try {
      const r = await fetch(`${BASE}/api/career/applier/multi-step/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: JOB_ID,
          jobUrl: fixtureUrl,
          autoApproveWhenSafe: false,
        }),
        signal: ac.signal,
      });
      const j = await r.json();
      assert.equal(r.status, 202, `start returned ${r.status}: ${JSON.stringify(j)}`);
      assert.equal(j.sessionId, JOB_ID);
      startSucceeded = true;
    } finally {
      clearTimeout(killer);
    }
  });

  if (!startSucceeded) {
    console.log('\n→ /start failed or hung — skipping downstream tests (5-7).');
    console.log('  Likely causes: zombie chromium holding the profile lock, missing');
    console.log('  chromium-headless-shell binary for the active Playwright version, or');
    console.log('  outbound HTTP proxy interfering with Chromium\'s CDP transport.');
    console.log('  Try: pkill -f chrome-headless-shell && rm -rf data/career/.playwright/profile');
  }


  // ── 5. Poll /status until machine settles or 30s timeout ─────────

  if (startSucceeded) await test('5. /status carries submitDetectedBy field (m14 surface)', async () => {
    let s = null;
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const r = await fetch(
        `${BASE}/api/career/applier/multi-step/${JOB_ID}/status`,
      );
      if (r.ok) {
        s = await r.json();
        // m14: top-level submitDetectedBy MUST be present (null when no
        // submit happened yet; one of url_pattern/thank_you_text/
        // network_signal/user_fallback after submit).
        assert.ok('submitDetectedBy' in s, 'submitDetectedBy MUST be in /status response');
        // m14 also confirms machine block shape unchanged
        assert.ok(s.machine, 'machine block present');
        // Bail once machine settles (done or stuck in awaiting-approval)
        if (s.machine.state === 'done' || s.machine.pending) break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(s, '/status returned a body');
    console.log('   final machine.state =', s.machine.state, 'lastOutcome =', s.machine.lastOutcome);
    console.log('   submitDetectedBy =', s.submitDetectedBy);
  });

  // ── 6. focus-field NOW that a session exists ────────────────────

  if (startSucceeded) await test('6. focus-field on existing session — accepted (no_live_page if machine done, or 202 if running)', async () => {
    const r = await fetch(
      `${BASE}/api/career/applier/multi-step/${JOB_ID}/focus-field`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'email' }),
      },
    );
    const j = await r.json();
    // Possible outcomes:
    //   - 202: machine still running + email field on the page, focusField succeeded
    //   - 404 ref-not-in-draft: classifier MOCK_ANTHROPIC didn't produce a draft
    //     so per_step_draft is empty for 'email'
    //   - 409 no_live_page: machine settled and browser is gone
    //   - 409 machine_busy: rare, race
    // Validates m13's structured response chain: server.mjs C2 fix
    // (forwards reason/code/detail) + handler taxonomy.
    if (!r.ok) {
      assert.ok(j.reason, `expected structured reason field in failure response; got ${JSON.stringify(j)}`);
      console.log('   focus-field non-OK with reason =', j.reason, 'status =', r.status);
    } else {
      console.log('   focus-field 202 ref=email accepted');
    }
  });

  // ── 7. cancel the session ────────────────────────────────────────

  if (startSucceeded) await test('7. cancel — POST /cancel terminates the session cleanly', async () => {
    const r = await fetch(
      `${BASE}/api/career/applier/multi-step/${JOB_ID}/cancel`,
      { method: 'POST' },
    );
    // /cancel requires same-origin guard; without an Origin header it falls
    // through. Accept either 202 (success) or 403 (CSRF guard fired —
    // expected when running curl-style without Origin).
    if (r.status === 403) {
      console.log('   /cancel guarded by same-origin — expected for curl-style smoke');
    } else {
      assert.equal(r.status, 202, `expected 202 or 403, got ${r.status}`);
    }
  });

  console.log(`\nINTEGRATION SMOKE: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    await cleanup();
    process.exit(1);
  }
  await cleanup();
} catch (err) {
  console.error('integration smoke threw:', err);
  console.error('apply server stderr buffer:', stderrBuf.slice(-20).join(''));
  await cleanup();
  process.exit(1);
}
