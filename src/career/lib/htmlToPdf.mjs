// HTML → PDF helper, backed by Playwright headless Chromium.
//
// Lifecycle: a single browser is launched lazily on the first call and reused.
// After 30s of no use the browser closes, which keeps short renders cheap
// (~50ms instead of ~1.5s relaunch) without leaving a zombie chromium process
// across long idle periods. SIGTERM/SIGINT handlers in server.mjs call
// shutdownBrowser() so nodemon / docker stop / Ctrl+C exits cleanly.
//
// One Page per render: cheap to create and avoids leaking state between
// callers. The browser is the expensive object, not the page.

import { chromium } from 'playwright'

const IDLE_MS = 30_000

let _browser = null
let _idleTimer = null
let _launching = null

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser
  // Coalesce concurrent first-callers onto the same launch promise.
  if (_launching) return _launching
  _launching = chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage'],
  }).then(b => {
    _browser = b
    _launching = null
    // If chromium dies unexpectedly (crash, OOM kill), drop the cached handle
    // so the next call relaunches instead of trying a dead browser.
    b.on('disconnected', () => {
      if (_browser === b) _browser = null
    })
    return b
  }).catch(e => {
    _launching = null
    throw e
  })
  return _launching
}

function scheduleIdleClose() {
  if (_idleTimer) clearTimeout(_idleTimer)
  _idleTimer = setTimeout(() => {
    _idleTimer = null
    closeBrowser().catch(() => {})
  }, IDLE_MS)
}

async function closeBrowser() {
  const b = _browser
  _browser = null
  if (_idleTimer) {
    clearTimeout(_idleTimer)
    _idleTimer = null
  }
  if (b) {
    try { await b.close() } catch { /* already gone */ }
  }
}

export async function htmlToPdf(html, options = {}) {
  if (typeof html !== 'string') throw new TypeError('html must be a string')
  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
    await page.setContent(html, { waitUntil: 'networkidle' })
    const pdf = await page.pdf({
      format: options.format ?? 'Letter',
      margin: options.margin ?? { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
      printBackground: true,
    })
    return Buffer.from(pdf)
  } finally {
    await page.close().catch(() => {})
    scheduleIdleClose()
  }
}

export async function shutdownBrowser() {
  await closeBrowser()
}
