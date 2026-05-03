// Shared headless Chromium pool for the career system.
//
// Lifecycle: a single browser is launched lazily on the first call from any
// consumer (htmlToPdf, pageScraper, …) and reused. After 30s of no use the
// browser closes, which keeps short renders cheap (~50ms instead of ~1.5s
// relaunch) without leaving a zombie chromium process across long idle
// periods. SIGTERM/SIGINT handlers in server.mjs call shutdownBrowser() so
// nodemon / docker stop / Ctrl+C exits cleanly.
//
// One Page per render: cheap to create and avoids leaking state between
// callers. The browser is the expensive object, not the page. Callers MUST
// `await page.close()` in a finally block, then call scheduleIdleClose() so
// the idle timer resets after their own work (busy consumers keep it warm).

import { chromium } from 'playwright';

const IDLE_MS = 30_000;

let _browser = null;
let _idleTimer = null;
let _launching = null;

export async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  // Coalesce concurrent first-callers onto the same launch promise.
  if (_launching) return _launching;
  _launching = chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage'],
  }).then((b) => {
    _browser = b;
    _launching = null;
    // If chromium dies unexpectedly (crash, OOM kill), drop the cached handle
    // so the next call relaunches instead of trying a dead browser.
    b.on('disconnected', () => {
      if (_browser === b) _browser = null;
    });
    return b;
  }).catch((e) => {
    _launching = null;
    throw e;
  });
  return _launching;
}

export function scheduleIdleClose() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    _idleTimer = null;
    closeBrowser().catch(() => {});
  }, IDLE_MS);
  // unref so a pending idle timer never blocks process exit. SIGTERM after
  // a render finishes shouldn't wait 30s for the timer to fire.
  if (typeof _idleTimer.unref === 'function') _idleTimer.unref();
}

async function closeBrowser() {
  const b = _browser;
  _browser = null;
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }
  if (b) {
    try { await b.close(); } catch { /* already gone */ }
  }
}

export async function shutdownBrowser() {
  await closeBrowser();
}
