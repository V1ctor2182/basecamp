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
import { execFileSync } from 'node:child_process';
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
// + 失败能立刻看到). APPLIER_HEADLESS=1 → headless for the unattended
// self-test harness — a dedicated flag, not entangled with SMOKE.
const HEADLESS =
  process.env.SMOKE === '1' || process.env.APPLIER_HEADLESS === '1';

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

// ── Zombie sweep ────────────────────────────────────────────────────────
//
// Finding #1 from integration-findings-2026-06-01.md: ctx.close() returns
// success but Playwright sometimes fails to terminate the underlying
// chromium child processes on macOS — especially with launchPersistentContext
// + headless. The orphaned processes hold the persistent profile lock,
// causing the next launchPersistentContext to hang past its 30s timeout.
//
// findZombieChromiumPids() uses pgrep to find any chromium / chrome-
// headless-shell process whose CLI args reference OUR user-data-dir.
// killZombieChromium() SIGTERMs them; called both before launch (clean
// any leftover) and after close (defensive). Cross-platform: no-op on
// non-POSIX (Windows uses different process management).

/** Escape a string for safe use as a literal in pgrep's -f regex.
 *  [review H1] macOS pgrep treats the pattern as an extended regex
 *  by default — `.` would match any character. A profile path like
 *  `data/career/.playwright/profile` would inadvertently match
 *  `data/career/Xplaywright/profile` (different worktree) and kill
 *  the wrong processes. Belt-and-suspenders against accidental
 *  collateral damage. */
function escapePgrepPattern(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Return an array of PIDs (numbers) whose CLI matches our profile path. */
function findZombieChromiumPids() {
  if (process.platform === 'win32') return [];
  try {
    const pattern = `user-data-dir=${escapePgrepPattern(USER_DATA_DIR)}`;
    const raw = execFileSync('pgrep', ['-f', pattern], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    return raw
      .trim()
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n !== process.pid);
  } catch {
    // pgrep exits 1 when no matches — treat as empty.
    return [];
  }
}

/** SIGTERM all zombie chromium processes for our profile. Returns the
 *  count that we attempted to kill. Up to 2s wait between TERM and KILL.
 *
 *  [review H2] DESTRUCTIVE: if a concurrent server (e.g. `npm run dev`)
 *  has a healthy chromium open on the same profile path, this kills it
 *  too. The persistent profile is single-tenant by design (Playwright
 *  cannot share `launchPersistentContext` between two processes), so
 *  two simultaneous servers ARE conflicting — but a healthy dev session
 *  isn't broken UNTIL we kill it. The trade-off is acceptable for the
 *  smoke environment; we warn before killing so the user sees what's
 *  happening if they're running a dev cockpit in parallel.
 *
 *  [review M2] async setTimeout instead of synchronous busy-spin —
 *  burning CPU between pgrep checks added no value beyond what the OS
 *  scheduler already provides. */
async function killZombieChromium() {
  if (process.platform === 'win32') return 0;
  const pids = findZombieChromiumPids();
  if (pids.length === 0) return 0;
  // [review H2] Warn loudly so a user with a dev session sees what
  // we're about to kill.
  console.warn(
    `[applier/runtime] About to SIGTERM ${pids.length} chromium process(es) ` +
      `holding the persistent profile lock (PIDs: ${pids.join(', ')}). ` +
      `If you have a separate dev server with an open browser, it will be ` +
      `disrupted — the profile is single-tenant.`,
  );
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); }
    catch { /* already gone */ }
  }
  // Async wait — give SIGTERM a chance before SIGKILL.
  const deadline = Date.now() + 2_000;
  let remaining = pids;
  while (remaining.length > 0 && Date.now() < deadline) {
    remaining = findZombieChromiumPids().filter((p) => pids.includes(p));
    if (remaining.length === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // Force-kill survivors.
  for (const pid of remaining) {
    try { process.kill(pid, 'SIGKILL'); }
    catch { /* already gone */ }
  }
  return pids.length;
}

/** Diagnostic — count of zombies tied to our profile. Exported so smoke
 *  tests can assert "no zombies after closeBrowser". */
export function _countZombieChromium() {
  return findZombieChromiumPids().length;
}

// ── Internal launch ──────────────────────────────────────────────────────

async function launch() {
  await fs.mkdir(USER_DATA_DIR, { recursive: true });

  // [integration-finding #1] Sweep any zombie chromium processes still
  // holding our persistent profile lock. Without this, launchPersistentContext
  // hangs past its 30s timeout if a prior process didn't clean up.
  await killZombieChromium();

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
 * m13 (Phase 6 wiring): accessExistingPage looks up the Page previously
 * tagged with the given jobId, WITHOUT creating a new one. Used by the
 * focusField/retryField endpoints to act on the live cockpit page —
 * `getPage` always opens a fresh blank tab, which would 404 every
 * operator click. Throws a coded error when no tagged page exists so
 * the endpoint can return a structured 409 with reason=no_live_page.
 *
 * @param {string} jobId
 * @returns {Promise<import('playwright').Page>}
 */
export async function accessExistingPage(jobId) {
  if (!jobId) {
    const err = new Error('accessExistingPage: jobId required');
    err.code = 'NO_JOB_ID';
    throw err;
  }
  if (!_context) {
    const err = new Error(`accessExistingPage: no applier browser open for jobId ${jobId}`);
    err.code = 'NO_BROWSER';
    throw err;
  }
  const pages = _context.pages();
  const tagged = pages.find((p) => _pageJobIds.get(p) === jobId);
  if (!tagged) {
    const err = new Error(`accessExistingPage: no tagged page for jobId ${jobId}`);
    err.code = 'NO_TAGGED_PAGE';
    throw err;
  }
  return tagged;
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
    // [integration-finding #1] ctx.close() returns success but the
    // underlying chromium child processes sometimes survive on macOS
    // (Playwright issue, particularly with headless persistent contexts).
    // Sweep any survivors so the NEXT launch doesn't hang on the lock.
    await killZombieChromium();
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

/**
 * Bring the applier browser's page to the foreground so the operator can
 * find the filled form (the headful window often ends up behind other
 * windows). Acts ONLY on an already-open browser — never launches one.
 * When `jobId` matches a tagged page that page is raised; otherwise the
 * most-recently-opened page.
 *
 * @param {string} [jobId]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function bringPageToFront(jobId) {
  if (!_context) return { ok: false, error: 'no applier browser is open' };
  const pages = _context.pages();
  if (!pages.length) return { ok: false, error: 'applier browser has no open page' };
  let page = jobId ? pages.find((p) => _pageJobIds.get(p) === jobId) : null;
  if (!page) page = pages[pages.length - 1];
  try {
    await page.bringToFront();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}
