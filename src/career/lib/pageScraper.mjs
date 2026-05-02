// Headless-Chromium JD text extractor — tier 3 of the 04-jd-enrich fallback.
// Backed by the shared playwrightPool so we share the same browser process
// with htmlToPdf and any future career-system consumers.
//
// `scrapeJdText(url)` navigates, strips boilerplate (nav/footer/script/style)
// at the DOM level, runs heuristic main-content selectors in priority order,
// and returns clean text. Throws EnrichTimeout / EnrichError on failure so the
// orchestrator (m3) can attribute the tier and decide the next step.

import { getBrowser, scheduleIdleClose } from './playwrightPool.mjs';

export class EnrichTimeout extends Error {
  constructor(url, ms) {
    super(`Enrich timeout after ${ms}ms: ${url}`);
    this.name = 'EnrichTimeout';
    this.url = url;
    this.timeout_ms = ms;
  }
}

export class EnrichError extends Error {
  constructor(url, cause) {
    super(`Enrich failed: ${url} — ${cause}`);
    this.name = 'EnrichError';
    this.url = url;
    this.cause_message = cause;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

// Selector priority — most-specific structural tags first, body as last resort.
// `main` and `[role="main"]` are the most reliable for modern job boards;
// `.posting-content` covers Lever-rendered pages; `.job-description` covers
// Greenhouse iframe embeds and many ATS templates.
const MAIN_SELECTORS = [
  'article',
  'main',
  '[role="main"]',
  '#content',
  '.job-description',
  '.posting-content',
  'body',
];

// Boilerplate selectors — removed from the DOM before innerText extraction so
// nav/footer text doesn't leak into the JD body.
const STRIP_SELECTORS = ['nav', 'footer', 'script', 'style', 'noscript'];

export async function scrapeJdText(url, opts = {}) {
  if (typeof url !== 'string' || !url) {
    throw new EnrichError('', 'missing url');
  }
  const timeout =
    typeof opts.timeout === 'number' && opts.timeout > 0 ? opts.timeout : DEFAULT_TIMEOUT_MS;

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    } catch (e) {
      // Playwright timeout exceptions have name === 'TimeoutError'.
      if (e?.name === 'TimeoutError') throw new EnrichTimeout(url, timeout);
      throw new EnrichError(url, String(e?.message ?? e).slice(0, 200));
    }

    let text;
    try {
      text = await page.evaluate(
        ({ stripSelectors, mainSelectors }) => {
          for (const sel of stripSelectors) {
            document.querySelectorAll(sel).forEach((n) => n.remove());
          }
          for (const sel of mainSelectors) {
            const el = document.querySelector(sel);
            if (el) {
              const t = el.innerText;
              if (typeof t === 'string' && t.trim()) return t;
            }
          }
          return null;
        },
        { stripSelectors: STRIP_SELECTORS, mainSelectors: MAIN_SELECTORS }
      );
    } catch (e) {
      throw new EnrichError(url, `evaluate failed: ${String(e?.message ?? e).slice(0, 200)}`);
    }

    if (typeof text !== 'string' || !text.trim()) {
      throw new EnrichError(url, 'no main content found');
    }

    // Normalize whitespace but preserve unicode (CJK / emoji unaffected by \s).
    return text.replace(/\s+/g, ' ').trim();
  } finally {
    await page.close().catch(() => {});
    scheduleIdleClose();
  }
}
