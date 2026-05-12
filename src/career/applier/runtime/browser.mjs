// Playwright browser singleton — module-scoped daemon for 07-applier Mode 2.
//
// 07-applier/02-playwright-runtime m1 + m2.
//
// First use of Playwright in this project. Other Rooms (08-snapshot-refs-
// layer, self-iteration/01-code-calibration, etc.) will import getBrowser /
// getPage from here. The module owns the singleton Chromium lifecycle:
//
//   - lazy init on first getBrowser() call (~1s)
//   - subsequent calls return the warm context (~0ms)
//   - per-apply newPage() for state isolation (跟 agent-browser session-
//     per-task 一致)
//   - persistent userDataDir at data/career/.playwright/profile/ so
//     cookies / localStorage / IndexedDB survive across server restarts
//     (累积 "人类指纹" 应对 Cloudflare / reCAPTCHA per Room intent)
//   - SIGTERM / SIGINT cleanup so we don't leak Chromium zombies
//   - race guard around getBrowser() — concurrent first-callers share one
//     launch Promise instead of spawning duplicate Chromium processes
//   - m2: stealth plugin via playwright-extra — suppresses navigator.webdriver,
//     fakes plugins/languages/permissions, hides automation flags
//
// 设计哲学: 单例 = agent-browser daemon warmth 模式. m3 will add crash
// detection + per-step screenshot helper.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// m2: install stealth at module load. Guard is necessary because test
// runners (Vitest / Jest with module reset) re-evaluate this module while
// `chromiumExtra` itself stays in the underlying require cache — without
// the guard, `.use(StealthPlugin())` would append to the plugin array
// every reset, causing each evasion's `Object.defineProperty` calls to
// re-fire on a non-configurable target and throw. (C2 fix from review.)
const STEALTH_INSTALLED = Symbol.for('learn.applier.stealthInstalled');
if (!chromiumExtra[STEALTH_INSTALLED]) {
  chromiumExtra.use(StealthPlugin());
  chromiumExtra[STEALTH_INSTALLED] = true;
}

// ── Constants ────────────────────────────────────────────────────────────

export const PLAYWRIGHT_DIR = path.resolve('data', 'career', '.playwright');
export const USER_DATA_DIR = path.join(PLAYWRIGHT_DIR, 'profile');
export const SCREENSHOTS_DIR = path.join(PLAYWRIGHT_DIR, 'screenshots');
export const BROWSER_LAUNCH_TIMEOUT_MS = 30_000;

// SMOKE=1 → headless (CI / smoke tests). Default headful per Room
// constraint C1 (用户日常 dev/prod 必须 headful — 反 bot detection 宽容度高
// + 失败能立刻看到).
const HEADLESS = process.env.SMOKE === '1';

// ── Module-scoped singleton state ────────────────────────────────────────

/** @type {import('playwright').BrowserContext | null} */
let _context = null;

/** @type {Promise<import('playwright').BrowserContext> | null} */
let _starting = null;

/** @type {Promise<void> | null} */
let _closing = null;  // race guard (C1 fix): pending closeBrowser blocks new getBrowser

let _signalHandlersRegistered = false;

// Per-page jobId mapping — WeakMap so closed Pages get GC'd naturally
// (M1 fix: prefer WeakMap over Object.defineProperty on Playwright internals)
/** @type {WeakMap<import('playwright').Page, string>} */
const _pageJobIds = new WeakMap();

// Hard ceiling on ctx.close() — Playwright has hung in the wild on Linux
// when underlying Chromium gets kill -9'd but parent still tracks it.
const CLOSE_TIMEOUT_MS = 5_000;

// Per-context teardown state — C1 fix from m3 review. A previous module-
// level _expectingClose flag had races: timeout-swallowed close races with
// late-firing 'close' event, and unrelated crashes during a closeBrowser
// on a stale handle would be wrongly suppressed. WeakMap keys by context
// so each launch gets its own flag pair, GC'd when the context is.
/** @type {WeakMap<import('playwright').BrowserContext, { expectingClose: boolean, handlerFired: boolean }>} */
const _ctxState = new WeakMap();

// ── Internal launch ──────────────────────────────────────────────────────

async function launch() {
  await fs.mkdir(USER_DATA_DIR, { recursive: true });

  const ctx = await chromiumExtra.launchPersistentContext(USER_DATA_DIR, {
    headless: HEADLESS,
    viewport: { width: 1440, height: 900 },
    args: [
      '--no-first-run',
      // Belt-and-suspenders: stealth plugin handles webdriver via JS
      // injection; this flag also disables the underlying Chromium feature
      // that exposes it. Removing either path is fine; keeping both is
      // defense-in-depth for older Chromium versions.
      '--disable-blink-features=AutomationControlled',
    ],
    timeout: BROWSER_LAUNCH_TIMEOUT_MS,
  });

  // m3 crash recovery: when the context closes unexpectedly (Chromium
  // crashed, user force-quit, OOM kill), mark the singleton dirty so the
  // next getBrowser() launches fresh. Per-context state via WeakMap (C1
  // fix); closure-local `handlerFired` dedupes the case where both
  // ctx.on('close') and browser.on('disconnected') fire (C3 fix).
  const state = { expectingClose: false, handlerFired: false };
  _ctxState.set(ctx, state);
  const handleContextClose = () => {
    if (state.handlerFired) return; // C3: dedupe close + disconnected double-fire
    state.handlerFired = true;
    if (state.expectingClose) return; // graceful — no warn
    console.warn(
      '[applier/runtime] Chromium context closed unexpectedly — marking ' +
        'singleton dirty; next getBrowser() will launch a fresh instance.',
    );
    if (_context === ctx) _context = null;
  };
  ctx.on('close', handleContextClose);
  // Browser.disconnected fires if the underlying browser process died
  // (kill -9, OOM, etc). Same handler.
  const browser = ctx.browser();
  if (browser) {
    browser.on('disconnected', handleContextClose);
  }

  return ctx;
}

function registerSignalHandlersOnce() {
  if (_signalHandlersRegistered) return;
  _signalHandlersRegistered = true;
  // C2 fix: await closeBrowser before exit so Chromium teardown actually
  // completes. `process.once` so SIGTERM during cleanup doesn't reentrant-
  // double-close. The fallback timer guarantees we exit even if ctx.close()
  // hangs beyond CLOSE_TIMEOUT_MS (H3 fix).
  const handler = (signal) => {
    const fallback = setTimeout(() => process.exit(128 + (signal === 'SIGINT' ? 2 : 15)), CLOSE_TIMEOUT_MS + 1000);
    closeBrowser()
      .catch(() => {})
      .finally(() => {
        clearTimeout(fallback);
        process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
      });
  };
  process.once('SIGTERM', () => handler('SIGTERM'));
  process.once('SIGINT', () => handler('SIGINT'));
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Get the singleton BrowserContext. Lazy-launches on first call; subsequent
 * calls return the warm instance. Concurrent first-calls share one launch
 * Promise (race guard). C1 fix: waits for any in-flight close before
 * launching a replacement.
 */
export async function getBrowser() {
  // C1 fix: wait for any in-flight close to settle before considering re-launch
  if (_closing) {
    await _closing;
  }

  // Fast path — already warm
  if (_context) return _context;

  // Already launching — join the in-flight promise
  if (_starting) return _starting;

  // Cold start — register signal handlers + launch
  registerSignalHandlersOnce();
  _starting = launch();
  try {
    const ctx = await _starting;
    _context = ctx;
    return ctx;
  } finally {
    _starting = null;
  }
}

/**
 * Get a fresh Page for an apply run. Per-apply newPage (跟 agent-browser
 * session-per-task 一致) — guarantees clean DOM/cookies/sessionStorage
 * isolation between applies even though they share the BrowserContext (and
 * thus the cumulative "human fingerprint" cookie pool that Cloudflare /
 * reCAPTCHA care about).
 *
 * @param {string} [jobId] — attached to the Page as a private tag (used
 *   later by m3's screenshot helper to route per-step JPEGs to the right
 *   data/career/.playwright/screenshots/{jobId}/ directory). Not used here.
 */
export async function getPage(jobId) {
  const ctx = await getBrowser();
  const page = await ctx.newPage();
  if (jobId) {
    // M1 fix: WeakMap instead of Object.defineProperty — survives Playwright
    // internal Page wrapping/proxying; auto-GC when Page closes
    _pageJobIds.set(page, jobId);
  }
  return page;
}

/**
 * Retrieve the jobId previously tagged via getPage(jobId). Returns
 * `undefined` if the Page was created without a jobId or has been GC'd.
 */
export function getJobId(page) {
  return _pageJobIds.get(page);
}

/**
 * Graceful cleanup — close all pages + the context. Idempotent: callable
 * multiple times without throwing. SIGTERM / SIGINT auto-invokes this.
 *
 * After close, the next getBrowser() call launches a fresh context (so
 * recovery flow downstream Rooms can trigger via "just close + retry").
 */
export async function closeBrowser() {
  // C1 fix: if a close is already in flight, join it (don't double-close)
  if (_closing) return _closing;

  // Build the close-in-progress promise atomically so concurrent getBrowser()
  // callers see _closing set before they evaluate fast paths
  _closing = (async () => {
    if (_starting) {
      // Someone is mid-launch. Wait for it to settle, then close that.
      try {
        await _starting;
      } catch {
        // launch failed — nothing to close
        _starting = null;
        _context = null;
        return;
      }
    }
    const ctx = _context;
    _context = null; // clear singleton first so concurrent callers re-launch
    if (!ctx) return;
    // C1 fix: flag THIS context (not module-level) as graceful, so concurrent
    // closes on stale handles + late-firing close events on the OTHER context
    // are correctly classified.
    const state = _ctxState.get(ctx);
    if (state) state.expectingClose = true;
    // M5 fix: close pages explicitly first to avoid mid-nav stderr noise
    try {
      await Promise.all(ctx.pages().map((p) => p.close().catch(() => {})));
    } catch {
      // best-effort
    }
    // H3 fix: race ctx.close() against a timeout — Playwright has hung
    try {
      await Promise.race([
        ctx.close(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('ctx.close() timed out')), CLOSE_TIMEOUT_MS),
        ),
      ]);
    } catch {
      // Best-effort cleanup; Playwright sometimes throws on already-closed
      // contexts or hangs on Linux. Swallow — singleton is already cleared.
    }
  })();

  try {
    await _closing;
  } finally {
    _closing = null;
  }
}

/**
 * Test helper — synchronous check whether a context is currently alive.
 * Used by smoke tests. Not for production code (use getBrowser() instead).
 */
export function _hasWarmContext() {
  return _context !== null;
}
