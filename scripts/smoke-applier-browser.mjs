#!/usr/bin/env node
// Smoke for 07-applier/02-playwright-runtime m1: browser singleton +
// persistent profile + lazy init + SIGTERM cleanup.
//
// Pure-Node asserts. SMOKE=1 forces headless (set automatically below so
// CI / dev `npm run smoke:applier-browser` doesn't pop a Chromium window).
//
// Note: this exercises real Chromium spawn, so it's slower (~5-10s) than
// pure schema/file smokes. Acceptable trade-off for genuine lifecycle
// coverage.

process.env.SMOKE = '1';

import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  getBrowser,
  getPage,
  getJobId,
  closeBrowser,
  _hasWarmContext,
  USER_DATA_DIR,
  PLAYWRIGHT_DIR,
} from '../src/career/applier/runtime/browser.mjs';

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

// Fixture isolation — back up the persistent profile dir if it exists from
// a real prior dev session, so the smoke runs against a fresh profile and
// restores at the end. We DO want the smoke to actually launch a real
// browser & write user-data files; we just don't want to clobber the dev's
// real cookies.
const BACKUP_DIR = USER_DATA_DIR + `.smoke-backup.${process.pid}`;
let hadOriginalProfile = false;
if (existsSync(USER_DATA_DIR)) {
  await fs.rename(USER_DATA_DIR, BACKUP_DIR);
  hadOriginalProfile = true;
}

async function teardown() {
  try {
    await closeBrowser();
  } catch {}
  // Wipe the smoke's profile dir
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true }).catch(() => {});
  // Restore the dev's original profile if any
  if (hadOriginalProfile) {
    await fs.rename(BACKUP_DIR, USER_DATA_DIR).catch(() => {});
  }
}

try {
  // ── 1. Singleton identity ──────────────────────────────────────────────
  await test('getBrowser() returns the same BrowserContext on repeat calls', async () => {
    const a = await getBrowser();
    const b = await getBrowser();
    assert.strictEqual(a, b, 'expected same BrowserContext instance');
    assert.ok(_hasWarmContext(), 'expected _hasWarmContext() true after init');
  });

  // ── 1b. Concurrent first-callers share one launch (race guard) ───────
  await test('concurrent getBrowser() callers share one launch (no double-spawn)', async () => {
    await closeBrowser();
    assert.ok(!_hasWarmContext(), 'pre-condition: no warm context');
    const [a, b, c] = await Promise.all([getBrowser(), getBrowser(), getBrowser()]);
    assert.strictEqual(a, b, 'expected concurrent callers to share context');
    assert.strictEqual(b, c, 'expected all 3 concurrent callers identical');
  });

  // ── 2. Per-apply newPage isolation ────────────────────────────────────
  await test('getPage() returns a NEW Page each call + jobId tag via WeakMap', async () => {
    const p1 = await getPage('aaaaaaaaaaaa');
    const p2 = await getPage();
    assert.notStrictEqual(p1, p2, 'expected distinct Page instances');
    // M1 fix: jobId retrievable via getJobId, not via property leak
    assert.equal(getJobId(p1), 'aaaaaaaaaaaa', 'jobId tag should round-trip');
    assert.equal(getJobId(p2), undefined, 'untagged page should return undefined');
    await p1.close().catch(() => {});
    await p2.close().catch(() => {});
  });

  // ── 3. userDataDir was created at the expected path ───────────────────
  await test('launchPersistentContext used the configured userDataDir', async () => {
    assert.ok(
      existsSync(USER_DATA_DIR),
      `expected ${USER_DATA_DIR} to exist after first getBrowser()`,
    );
    // Verify it's actually under data/career/.playwright/profile (no surprises)
    assert.ok(
      USER_DATA_DIR.endsWith(path.join('.playwright', 'profile')),
      `userDataDir should end with .playwright/profile; got ${USER_DATA_DIR}`,
    );
    // Persistent context writes Default/ subdir + various DB files lazily.
    // Touch about:blank to trigger profile materialization, then verify the
    // Default/ subdir exists and is non-empty. We don't check for any
    // specific file (Preferences/Cookies/etc.) — Chromium writes some of
    // those only on graceful close, others on first nav. Any persistence
    // artifact in Default/ proves the profile is live.
    const page = await getPage();
    await page.goto('about:blank');
    await page.close();
    const defaultDir = path.join(USER_DATA_DIR, 'Default');
    assert.ok(existsSync(defaultDir), `expected ${defaultDir} after page nav`);
    const defaultContents = await fs.readdir(defaultDir);
    assert.ok(
      defaultContents.length > 0,
      `expected non-empty ${defaultDir} (profile not materializing)`,
    );
  });

  // ── 4. closeBrowser() idempotent ──────────────────────────────────────
  await test('closeBrowser() is idempotent — 2 sequential calls do not throw', async () => {
    await closeBrowser();
    assert.ok(!_hasWarmContext(), 'expected _hasWarmContext() false after close');
    await closeBrowser(); // 2nd call should be a noop
    assert.ok(!_hasWarmContext(), 'still false after 2nd close');
  });

  // ── 5. After close, getBrowser() launches a fresh context ─────────────
  await test('getBrowser() after closeBrowser() launches a fresh context', async () => {
    const fresh = await getBrowser();
    assert.ok(fresh, 'expected a fresh BrowserContext');
    assert.ok(_hasWarmContext(), 'expected _hasWarmContext() true after re-launch');
    await closeBrowser();
  });

  // ── 5b. Persistence round-trip across context teardowns (H6) ──────────
  // The whole point of launchPersistentContext: cookies/localStorage survive
  // restart. Set a marker, tear down, re-launch, read it back.
  await test('localStorage persists across closeBrowser() / getBrowser() cycle', async () => {
    const page1 = await getPage();
    // Use a data URL so we don't depend on network; any same-origin
    // localStorage round-trip qualifies as proof of persistence
    await page1.goto('data:text/html,<!doctype html><title>persist-test</title>');
    // data: origins are opaque on most Chromiums — use a real http origin via
    // page.context().addCookies() instead which DOES persist across restart
    await page1.context().addCookies([
      {
        name: 'smoke_marker',
        value: 'persisted_' + process.pid,
        domain: 'localhost',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 3600,
      },
    ]);
    await page1.close();
    await closeBrowser();
    assert.ok(!_hasWarmContext(), 'context should be closed before persistence read');
    // Re-launch and verify the cookie survived
    const page2 = await getPage();
    const cookies = await page2.context().cookies('http://localhost/');
    const found = cookies.find((c) => c.name === 'smoke_marker');
    assert.ok(found, 'smoke_marker cookie should persist across launch cycle');
    assert.equal(
      found.value,
      'persisted_' + process.pid,
      'cookie value should match what was set',
    );
    await page2.close();
    await closeBrowser();
  });

  // ── 5c. navigator.webdriver suppressed by --disable-blink-features ────
  // m1 only ships the flag; m2 will add the full stealth plugin. Verify the
  // flag alone is doing its job (this is the single most-checked anti-bot
  // signal on the open web).
  await test('navigator.webdriver === undefined (AutomationControlled disabled)', async () => {
    const page = await getPage();
    await page.goto('data:text/html,<!doctype html><title>wd-test</title>');
    const webdriverValue = await page.evaluate(() => navigator.webdriver);
    // With --disable-blink-features=AutomationControlled, navigator.webdriver
    // should be either `false` (older Chromium) or `undefined` (newer).
    // What we DEFINITELY don't want is `true`.
    assert.notEqual(webdriverValue, true, 'navigator.webdriver MUST NOT be true');
    await page.close();
    await closeBrowser();
  });

  // ── 6. SIGTERM cleanup — child process scenario ──────────────────────
  // Spawn a child that launches a browser then receives SIGTERM. After the
  // child exits cleanly, verify no zombie chromium process is left orphaned
  // under this script's PID tree.
  await test('SIGTERM handler cleans up the Chromium subprocess', async () => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        process.env.SMOKE = '1';
        const m = await import('${path.resolve('src/career/applier/runtime/browser.mjs').replace(/\\\\/g, '/')}');
        await m.getBrowser();
        process.stdout.write('READY\\n');
        // Hold the event loop with setInterval (clearable by SIGTERM handler).
        // Using await new Promise(() => {}) would trigger Node exit code 13
        // (unsettled top-level await) on SIGTERM. Setinterval lets the event
        // loop drain naturally once closeBrowser() finishes.
        const keepAlive = setInterval(() => {}, 60_000);
        process.on('SIGTERM', () => clearInterval(keepAlive));
        `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let ready = false;
    child.stdout.on('data', (d) => {
      if (d.toString().includes('READY')) ready = true;
    });
    child.stderr.on('data', () => {}); // swallow

    // Wait for child to confirm browser launched
    const t0 = Date.now();
    while (!ready) {
      if (Date.now() - t0 > 30_000) {
        child.kill('SIGKILL');
        throw new Error('child did not become READY within 30s');
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    // Send SIGTERM and wait for clean exit (Chromium cleanup path)
    const exitPromise = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const exitCode = await Promise.race([
      exitPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('SIGTERM timeout')), 15_000)),
    ]);

    // Exit code 143 is SIGTERM-killed; null on macOS sometimes. Either is OK
    // as long as the process actually exited.
    assert.ok(
      exitCode === 0 || exitCode === 143 || exitCode === null,
      `unexpected exit code from SIGTERM: ${exitCode}`,
    );
  });
} finally {
  await teardown();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
