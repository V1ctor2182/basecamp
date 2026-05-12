#!/usr/bin/env node
// Smoke for 07-applier/02-playwright-runtime m3: screenshot capture +
// crash recovery + integration end-to-end. Closes the Room.
//
// Pure-Node, SMOKE=1 forced. Real Chromium spawn (~15-20s).
//
// Verifies the FULL m1+m2+m3 stack composed: launch browser → newPage →
// humanNavigate → captureStep × N → listScreenshots → clearScreenshots →
// crash recovery (manual ctx.close → next getBrowser launches fresh).

process.env.SMOKE = '1';

import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import {
  getBrowser,
  getPage,
  closeBrowser,
  _hasWarmContext,
  USER_DATA_DIR,
  SCREENSHOTS_DIR,
} from '../src/career/applier/runtime/browser.mjs';
import { humanNavigate } from '../src/career/applier/runtime/humanize.mjs';
import {
  captureStep,
  listScreenshots,
  clearScreenshots,
} from '../src/career/applier/runtime/screenshot.mjs';

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

// JPEG magic bytes — every JPEG starts with FF D8 FF
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

// Fixture isolation — same pattern as m1/m2 smokes
const BACKUP_DIR = USER_DATA_DIR + `.smoke-backup.${process.pid}`;
const SS_BACKUP = SCREENSHOTS_DIR + `.smoke-backup.${process.pid}`;
let hadOriginalProfile = false;
let hadOriginalScreenshots = false;

if (existsSync(USER_DATA_DIR)) {
  await fs.rename(USER_DATA_DIR, BACKUP_DIR);
  hadOriginalProfile = true;
}
if (existsSync(SCREENSHOTS_DIR)) {
  await fs.rename(SCREENSHOTS_DIR, SS_BACKUP);
  hadOriginalScreenshots = true;
}

async function teardown() {
  try {
    await closeBrowser();
  } catch {}
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.rm(SCREENSHOTS_DIR, { recursive: true, force: true }).catch(() => {});
  if (hadOriginalProfile) {
    await fs.rename(BACKUP_DIR, USER_DATA_DIR).catch(() => {});
  }
  if (hadOriginalScreenshots) {
    await fs.rename(SS_BACKUP, SCREENSHOTS_DIR).catch(() => {});
  }
}

const FIXTURE_JOB_A = 'aaaaaaaaaaaa';
const FIXTURE_JOB_B = 'bbbbbbbbbbbb';

try {
  // ── 1. captureStep — writes JPEG with correct magic bytes ─────────────
  await test('captureStep — writes JPEG to per-jobId dir with correct path', async () => {
    const page = await getPage(FIXTURE_JOB_A);
    await humanNavigate(page, 'data:text/html,<title>capture-test</title>', {
      minDelay: 50,
      maxDelay: 100,
    });
    const filepath = await captureStep(page, FIXTURE_JOB_A, 1, 'landing');
    // Path correctness
    assert.equal(
      filepath,
      path.join(SCREENSHOTS_DIR, FIXTURE_JOB_A, '001-landing.jpg'),
      `unexpected path: ${filepath}`,
    );
    // File exists + valid JPEG
    const stat = await fs.stat(filepath);
    assert.ok(stat.size > 0, 'screenshot file should be non-empty');
    const head = await fs.readFile(filepath).then((b) => b.subarray(0, 3));
    assert.deepEqual(head, JPEG_MAGIC, `expected JPEG magic, got ${head.toString('hex')}`);
    await page.close();
  });

  // ── 2. captureStep — idempotent on (jobId, stepN, label) ──────────────
  // H3 fix: assert by mtime, not size — JPEG quantization on two trivial
  // pages could produce identical byte counts and falsely fail the test.
  await test('captureStep — overwrites on duplicate (jobId, stepN, label)', async () => {
    const page = await getPage(FIXTURE_JOB_A);
    await page.goto('data:text/html,<title>overwrite-test</title>');
    const fp1 = await captureStep(page, FIXTURE_JOB_A, 2, 'form');
    const mtime1 = (await fs.stat(fp1)).mtimeMs;
    // Ensure clock advances at least 1ms before second write
    await new Promise((r) => setTimeout(r, 10));
    await page.goto(
      'data:text/html,<body style="background:red;height:1000px"><title>x</title></body>',
    );
    const fp2 = await captureStep(page, FIXTURE_JOB_A, 2, 'form');
    const mtime2 = (await fs.stat(fp2)).mtimeMs;
    assert.equal(fp1, fp2, 'idempotent path: same args → same file');
    assert.ok(
      mtime2 > mtime1,
      `mtime should increase on overwrite: ${mtime1} → ${mtime2}`,
    );
    await page.close();
  });

  // ── 3. listScreenshots — returns sorted-by-stepN ──────────────────────
  await test('listScreenshots — returns names sorted by stepN (003 after 002 after 001)', async () => {
    const page = await getPage(FIXTURE_JOB_A);
    await page.goto('data:text/html,<title>list-test</title>');
    // Write out-of-order so we know sort actually fires
    await captureStep(page, FIXTURE_JOB_A, 5, 'submit');
    await captureStep(page, FIXTURE_JOB_A, 3, 'review');
    // 001 + 002 from earlier tests in this run
    const names = await listScreenshots(FIXTURE_JOB_A);
    // Extract stepNs and verify monotonically increasing
    const stepNs = names.map((n) => Number(n.match(/^(\d{3})-/)[1]));
    for (let i = 1; i < stepNs.length; i++) {
      assert.ok(
        stepNs[i] >= stepNs[i - 1],
        `not sorted: ${stepNs[i - 1]} → ${stepNs[i]}`,
      );
    }
    // Should contain at minimum 001, 002, 003, 005 from this test + prior
    assert.ok(stepNs.includes(1) && stepNs.includes(3) && stepNs.includes(5));
    await page.close();
  });

  // ── 4. clearScreenshots — removes the per-jobId dir ───────────────────
  await test('clearScreenshots — removes dir; idempotent on missing dir', async () => {
    const page = await getPage(FIXTURE_JOB_B);
    await page.goto('data:text/html,<title>clear-test</title>');
    await captureStep(page, FIXTURE_JOB_B, 1, 'first');
    const dir = path.join(SCREENSHOTS_DIR, FIXTURE_JOB_B);
    assert.ok(existsSync(dir), 'pre-condition: dir created');
    await clearScreenshots(FIXTURE_JOB_B);
    assert.ok(!existsSync(dir), 'dir should be removed');
    // Idempotent — second call doesn't throw
    await clearScreenshots(FIXTURE_JOB_B);
    await clearScreenshots('cccccccccccc'); // never created — ENOENT silent
    await page.close();
  });

  // ── 5. captureStep — bad jobId / bad label / stepN=0 rejected ─────────
  // M1 fix: stepN=0 now rejected (1-indexed policy)
  // M6 fix: try/finally page hygiene
  await test('captureStep — invalid inputs throw with helpful errors', async () => {
    const page = await getPage();
    try {
      await page.goto('data:text/html,<title>bad</title>');
      await assert.rejects(
        () => captureStep(page, 'bad-id', 1, 'label'),
        /jobId must match 12-hex/,
      );
      await assert.rejects(
        () => captureStep(page, FIXTURE_JOB_A, 0, 'label'),
        /stepN must be integer in \[1, 999\]/,
      );
      await assert.rejects(
        () => captureStep(page, FIXTURE_JOB_A, -1, 'label'),
        /stepN/,
      );
      await assert.rejects(
        () => captureStep(page, FIXTURE_JOB_A, 1, '../etc/passwd'),
        /label must match/,
      );
    } finally {
      await page.close();
    }
  });

  // ── 5b. captureStep — closed page error wrapped with jobId/stepN ─────
  // H4 fix: raw Playwright "Target closed" errors are now wrapped with
  // run context so the dashboard / log readers know which job/step failed.
  await test('captureStep — closed page produces wrapped error with context', async () => {
    const page = await getPage();
    await page.close();
    await assert.rejects(
      () => captureStep(page, FIXTURE_JOB_A, 1, 'closed'),
      /captureStep failed for job=aaaaaaaaaaaa step=001 label=closed/,
      'expected error message to include jobId/step/label context',
    );
  });

  // ── 6. Crash recovery — external ctx.close (graceful API) ────────────
  // H1/H2 fix: be honest about what this tests. ctx.close() is the
  // graceful Playwright API; real Chromium crash fires 'disconnected' on
  // Browser before/instead of 'close' on Context. The handler binds to
  // both events (with dedupe), so this test verifies the 'close' arm.
  // Deterministic synchronization via poll (was setTimeout(50) which
  // could flake on loaded CI).
  await test('crash recovery — external ctx.close marks singleton dirty + relaunch', async () => {
    const ctx1 = await getBrowser();
    assert.ok(_hasWarmContext(), 'pre-condition: warm');

    // Silence the expected warn so smoke output stays clean (M5).
    const realWarn = console.warn;
    let warnCalls = 0;
    console.warn = (...args) => {
      warnCalls++;
    };

    try {
      // ctx.close() bypasses closeBrowser() → handler fires the "unexpected"
      // path (state.expectingClose stays false).
      await ctx1.close();

      // H2 fix: poll instead of setTimeout. Handler fires asynchronously
      // after ctx.close() resolves on some Playwright versions.
      const deadline = Date.now() + 3000;
      while (_hasWarmContext() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(
        !_hasWarmContext(),
        'singleton should be marked dirty after external close (timed out waiting)',
      );

      // Next getBrowser must launch a fresh context (NOT throw)
      const ctx2 = await getBrowser();
      assert.ok(ctx2, 'fresh BrowserContext after crash recovery');
      assert.notStrictEqual(ctx1, ctx2, 'expected DIFFERENT context instance');
      assert.ok(_hasWarmContext(), 'singleton warm again');

      // C3 verification: handler fires AT MOST once even though both
      // 'close' and 'disconnected' may emit. Allow 1-2 warns (Playwright
      // version dependent on whether disconnected fires for graceful close).
      assert.ok(
        warnCalls >= 1 && warnCalls <= 1,
        `expected exactly 1 warn (close+disconnected dedupe), got ${warnCalls}`,
      );

      await closeBrowser();
    } finally {
      console.warn = realWarn;
    }
  });

  // ── 6b. Graceful closeBrowser does NOT log "unexpected" warn ─────────
  // C1 verification: per-context state correctly distinguishes graceful
  // closeBrowser from external close.
  await test('graceful closeBrowser — no "unexpected" warn emitted', async () => {
    await getBrowser();
    const realWarn = console.warn;
    let warnCalls = 0;
    console.warn = () => {
      warnCalls++;
    };
    try {
      await closeBrowser();
      // Give time for any late handler to fire
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(
        warnCalls,
        0,
        'graceful closeBrowser must NOT fire the "unexpected close" warn',
      );
    } finally {
      console.warn = realWarn;
    }
  });

  // ── 7. Multi-jobId concurrent captureStep — no mkdir race ────────────
  await test('captureStep — concurrent across different jobIds (no mkdir race)', async () => {
    const page1 = await getPage('111111111111');
    const page2 = await getPage('222222222222');
    await page1.goto('data:text/html,<title>p1</title>');
    await page2.goto('data:text/html,<title>p2</title>');
    const results = await Promise.all([
      captureStep(page1, '111111111111', 1, 'a'),
      captureStep(page2, '222222222222', 1, 'b'),
    ]);
    assert.equal(results.length, 2, 'both captures completed');
    assert.ok(existsSync(results[0]), 'job 1 screenshot exists');
    assert.ok(existsSync(results[1]), 'job 2 screenshot exists');
    await page1.close();
    await page2.close();
  });

  // ── 8. End-to-end integration — full m1+m2+m3 stack ──────────────────
  await test('end-to-end: launch → newPage → navigate → captureStep × 3 → list', async () => {
    const e2eJob = 'efefefefefef';
    const page = await getPage(e2eJob);
    await humanNavigate(page, 'data:text/html,<title>e2e-1</title>', {
      minDelay: 50,
      maxDelay: 100,
    });
    await captureStep(page, e2eJob, 1, 'open');
    await page.goto('data:text/html,<title>e2e-2</title>');
    await captureStep(page, e2eJob, 2, 'form-filled');
    await page.goto('data:text/html,<title>e2e-3</title>');
    await captureStep(page, e2eJob, 3, 'submit-ready');
    const names = await listScreenshots(e2eJob);
    assert.deepEqual(
      names,
      ['001-open.jpg', '002-form-filled.jpg', '003-submit-ready.jpg'],
      'screenshots should be in step order with correct labels',
    );
    await page.close();
  });

  // ── 9. .gitignore covers .playwright/ — meta verification ────────────
  await test('.gitignore — data/career/.playwright/ is gitignored', async () => {
    const gitignore = await fs.readFile('.gitignore', 'utf8');
    assert.ok(
      gitignore.includes('data/career/.playwright/'),
      '.gitignore should contain data/career/.playwright/ (to keep Chromium profile + screenshots out of git)',
    );
  });
} finally {
  await teardown();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
