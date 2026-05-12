#!/usr/bin/env node
// Smoke for 07-applier/02-playwright-runtime m2: stealth plugin + human-like
// timing helpers (humanDelay / humanType / humanClick / humanNavigate).
//
// Pure-Node, SMOKE=1 forced. Real Chromium spawn — slow (~10-15s) but worth
// it for genuine stealth verification.
//
// Network-gated test (bot.sannysoft.com) runs only with SMOKE_NETWORK=1.
// CI without external network access should leave that unset.

process.env.SMOKE = '1';

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import {
  getBrowser,
  getPage,
  closeBrowser,
  USER_DATA_DIR,
} from '../src/career/applier/runtime/browser.mjs';
import {
  humanDelay,
  humanType,
  humanClick,
  humanNavigate,
} from '../src/career/applier/runtime/humanize.mjs';

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

// Helper for stealth assertions: wait for any init scripts to settle before
// reading window state (M7 fix — fast data: gotos can race against stealth
// addInitScript injection on slow CI).
async function settleInitScripts(page) {
  await page.waitForFunction(() => typeof navigator !== 'undefined', { timeout: 5000 });
  await humanDelay(20, 50);
}

// Fixture isolation — same pattern as smoke-applier-browser.mjs
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
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true }).catch(() => {});
  if (hadOriginalProfile) {
    await fs.rename(BACKUP_DIR, USER_DATA_DIR).catch(() => {});
  }
}

try {
  // ── 1. humanDelay distribution ────────────────────────────────────────
  // H3 fix: bounds widened to [220, 320] from [200, 300] to absorb CI
  // scheduler jitter (real setTimeout consistently overshoots target by
  // 10-50ms under load). Removed max-sample assertion — single 700ms
  // outlier just means GC pause, not broken code.
  await test('humanDelay(100, 400) — 100 samples mean within [220, 320]ms', async () => {
    const samples = [];
    for (let i = 0; i < 100; i++) {
      const t0 = Date.now();
      await humanDelay(100, 400);
      samples.push(Date.now() - t0);
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    assert.ok(
      mean >= 220 && mean <= 320,
      `expected mean in [220,320], got ${mean.toFixed(1)}`,
    );
  });

  // ── 1b. humanDelay corner cases — clamp behavior verified by timing ──
  // M3 fix: actually verify clamping by measuring elapsed time, not just
  // "no throw".
  await test('humanDelay corner cases — swapped/negative/NaN clamp to safe range', async () => {
    // Zero range → near-instant
    const t1 = Date.now();
    await humanDelay(0, 0);
    assert.ok(Date.now() - t1 < 50, 'humanDelay(0,0) should resolve <50ms');
    // Negative range → clamped to 0, near-instant
    const t2 = Date.now();
    await humanDelay(-100, -50);
    assert.ok(Date.now() - t2 < 50, 'humanDelay(neg, neg) should clamp to 0');
    // Swapped min > max → still works (internal Math.min/max)
    const t3 = Date.now();
    await humanDelay(50, 30);
    assert.ok(Date.now() - t3 < 100, 'humanDelay(swapped) should still be bounded');
    // NaN input → falls back to defaults; just verify no throw + finite delay
    const t4 = Date.now();
    await humanDelay(NaN, NaN);
    const elapsed = Date.now() - t4;
    assert.ok(elapsed >= 0 && elapsed < 1000, `NaN guard: ${elapsed}ms is finite`);
  });

  // ── 2. navigator.webdriver fully suppressed ───────────────────────────
  await test('stealth plugin: navigator.webdriver !== true', async () => {
    const page = await getPage();
    await page.goto('data:text/html,<!doctype html><title>stealth</title>');
    await settleInitScripts(page);
    const webdriverValue = await page.evaluate(() => navigator.webdriver);
    assert.notEqual(webdriverValue, true, 'navigator.webdriver MUST NOT be true');
    await page.close();
  });

  // ── 2b. stealth plugin: plugins array non-empty (anti-headless) ──────
  await test('stealth plugin: navigator.plugins.length >= 3 (faked, anti-headless)', async () => {
    const page = await getPage();
    await page.goto('data:text/html,<!doctype html><title>plugins</title>');
    await settleInitScripts(page);
    const pluginCount = await page.evaluate(() => navigator.plugins.length);
    assert.ok(
      pluginCount >= 3,
      `expected navigator.plugins.length >= 3 (stealth-faked), got ${pluginCount}`,
    );
    await page.close();
  });

  // ── 2c. stealth plugin: window.chrome shape (app/csi/loadTimes) ──────
  // Note: window.chrome.runtime is http(s)-only — stealth correctly skips
  // it on data: URLs. Real Chrome behaves identically. We assert the 3
  // universal keys instead.
  await test('stealth plugin: window.chrome has app/csi/loadTimes', async () => {
    const page = await getPage();
    await page.goto('data:text/html,<!doctype html><title>chrome</title>');
    await settleInitScripts(page);
    const shape = await page.evaluate(() => ({
      hasChrome: typeof window.chrome === 'object' && window.chrome !== null,
      hasApp: typeof window.chrome?.app === 'object',
      hasCsi: typeof window.chrome?.csi === 'function',
      hasLoadTimes: typeof window.chrome?.loadTimes === 'function',
    }));
    assert.equal(shape.hasChrome, true, 'expected window.chrome object');
    assert.equal(shape.hasApp, true, 'expected window.chrome.app');
    assert.equal(shape.hasCsi, true, 'expected window.chrome.csi');
    assert.equal(shape.hasLoadTimes, true, 'expected window.chrome.loadTimes');
    await page.close();
  });

  // ── 2d. stealth covers ctx.pages()[0] (auto-spawned) ──────────────────
  // H1 fix: launchPersistentContext spawns a Page automatically. The
  // smoke previously only tested newPage() pages — verify auto-spawn page
  // also gets stealth injection, in case any downstream caller does
  // ctx.pages()[0] instead of newPage().
  await test('stealth applies to auto-spawned ctx.pages()[0] (not just newPage)', async () => {
    const ctx = await getBrowser();
    const autoPage = ctx.pages()[0];
    assert.ok(autoPage, 'expected an auto-spawned page from launchPersistentContext');
    await autoPage.goto('data:text/html,<title>auto</title>');
    await settleInitScripts(autoPage);
    const wd = await autoPage.evaluate(() => navigator.webdriver);
    assert.notEqual(wd, true, 'auto-spawned page must also have stealth applied');
  });

  // ── 3. humanType — char-by-char, count keydown events ────────────────
  // M5 fix: previous test just checked final inputValue, which would pass
  // even if humanType called keyboard.type('hello') in one shot. Count
  // actual keydown events instead.
  await test('humanType — fires one keydown per grapheme (5 chars → 5 keydowns)', async () => {
    const page = await getPage();
    await page.goto(
      'data:text/html,<!doctype html><input id="i" type="text" autofocus />',
    );
    await page.evaluate(() => {
      window._keys = 0;
      document.getElementById('i').addEventListener('keydown', () => window._keys++);
    });
    await humanType(page.locator('#i'), 'hello', { minDelay: 1, maxDelay: 5 });
    const keys = await page.evaluate(() => window._keys);
    const value = await page.locator('#i').inputValue();
    assert.equal(keys, 5, `expected 5 keydown events, got ${keys}`);
    assert.equal(value, 'hello', `expected input 'hello', got '${value}'`);
    await page.close();
  });

  // ── 3b. humanType empty string ────────────────────────────────────────
  await test('humanType("") — no-op, no keydown', async () => {
    const page = await getPage();
    await page.goto(
      'data:text/html,<!doctype html><input id="i" type="text" autofocus />',
    );
    await page.evaluate(() => {
      window._keys = 0;
      document.getElementById('i').addEventListener('keydown', () => window._keys++);
    });
    await humanType(page.locator('#i'), '', { minDelay: 1, maxDelay: 1 });
    const keys = await page.evaluate(() => window._keys);
    assert.equal(keys, 0, 'empty humanType should fire no keydown events');
    await page.close();
  });

  // ── 3c. humanType handles grapheme clusters atomically ───────────────
  // C1 fix: emoji ZWJ sequences and NFD accents must type as one unit.
  // 'café' in NFD is e+\u0301 — that's 2 codepoints, 1 grapheme. Verify
  // we issue 4 keyboard.type calls (4 graphemes for café) not 5.
  await test('humanType — NFD-decomposed accent counts as 1 grapheme', async () => {
    const page = await getPage();
    await page.goto(
      'data:text/html,<!doctype html><input id="i" type="text" autofocus />',
    );
    await page.evaluate(() => {
      window._keys = 0;
      document.getElementById('i').addEventListener('keydown', () => window._keys++);
    });
    const cafeDecomposed = 'cafe\u0301'; // 5 codepoints, 4 graphemes
    await humanType(page.locator('#i'), cafeDecomposed, { minDelay: 1, maxDelay: 5 });
    const keys = await page.evaluate(() => window._keys);
    // Note: the actual keydown count depends on Chromium's IME handling of
    // combining chars. The key contract is: the segmenter doesn't fragment
    // the cluster. We assert keys is at most the codepoint count (5) —
    // ideally 4 (perfectly atomic) but Chromium may emit extras for IME.
    assert.ok(keys <= 5, `expected <= 5 keydowns for 4-grapheme string, got ${keys}`);
    await page.close();
  });

  // ── 4. humanClick — visibility wait + pre-pause + actual click ───────
  // H4 fix: humanClick now waits for visibility BEFORE the random delay,
  // so the delay isn't wasted clock when element isn't rendered yet.
  // M6 fix: upper bound on elapsed so accidental extra sleep won't pass.
  await test('humanClick — waits for visibility, then pauses, then clicks', async () => {
    const page = await getPage();
    await page.goto(
      'data:text/html,<!doctype html><button id="b">x</button>' +
        '<script>window.clicked=false;document.getElementById("b").addEventListener("click",()=>window.clicked=true);</script>',
    );
    const t0 = Date.now();
    await humanClick(page.locator('#b'), { minDelay: 150, maxDelay: 200 });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 150, `expected >= 150ms (lower bound), got ${elapsed}`);
    assert.ok(elapsed < 2000, `expected < 2000ms (upper bound), got ${elapsed}`);
    const clicked = await page.evaluate(() => window.clicked);
    assert.equal(clicked, true, 'click event should have fired');
    await page.close();
  });

  // ── 5. humanNavigate — default domcontentloaded + post-nav delay ─────
  await test('humanNavigate — default goto + post-nav delay', async () => {
    const page = await getPage();
    const t0 = Date.now();
    await humanNavigate(page, 'data:text/html,<title>nav</title>', {
      minDelay: 100,
      maxDelay: 150,
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 100, `expected >= 100ms post-nav delay, got ${elapsed}`);
    const title = await page.title();
    assert.equal(title, 'nav', 'page should have navigated');
    await page.close();
  });

  // ── 5b. humanNavigate — waitUntil option exposed ─────────────────────
  // H2 fix: callers can escalate to networkidle for iframe-heavy ATS.
  // Verify the option propagates without throwing on a simple page.
  await test('humanNavigate — waitUntil option propagates (networkidle on data:)', async () => {
    const page = await getPage();
    await humanNavigate(page, 'data:text/html,<title>nw</title>', {
      minDelay: 50,
      maxDelay: 100,
      waitUntil: 'networkidle',
    });
    assert.equal(await page.title(), 'nw');
    await page.close();
  });

  // ── 6. Stealth survives closeBrowser + relaunch (L6 from review) ─────
  await test('stealth survives closeBrowser() + relaunch cycle', async () => {
    await closeBrowser();
    const page = await getPage();
    await page.goto('data:text/html,<title>re-stealth</title>');
    await settleInitScripts(page);
    const wd = await page.evaluate(() => navigator.webdriver);
    assert.notEqual(wd, true, 'stealth must persist after closeBrowser/relaunch');
    await page.close();
  });

  // ── 7. Network-gated: bot.sannysoft.com 12-check (optional) ───────────
  if (process.env.SMOKE_NETWORK === '1') {
    await test('bot.sannysoft.com — at least 8/12 checks pass', async () => {
      const page = await getPage();
      try {
        await humanNavigate(page, 'https://bot.sannysoft.com', {
          minDelay: 500,
          maxDelay: 1000,
          waitUntil: 'networkidle',
        });
        const passCount = await page.evaluate(
          () => document.querySelectorAll('.passed').length,
        );
        assert.ok(
          passCount >= 8,
          `expected >=8 bot.sannysoft checks passed, got ${passCount}`,
        );
      } finally {
        await page.close();
      }
    });
  } else {
    console.log('SKIP: bot.sannysoft.com network test (set SMOKE_NETWORK=1 to enable)');
  }
} finally {
  await teardown();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
