// HTML → PDF helper, backed by the shared Chromium pool in playwrightPool.mjs.
// See playwrightPool.mjs for the lazy-launch + 30s idle close lifecycle.

import { getBrowser, scheduleIdleClose, shutdownBrowser } from './playwrightPool.mjs'

// Re-exported for backward-compat: server.mjs imports shutdownBrowser from
// here and calls it on SIGTERM/SIGINT. Both paths now point at the pool.
export { shutdownBrowser }

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
