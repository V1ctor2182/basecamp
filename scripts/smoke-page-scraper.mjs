#!/usr/bin/env node
// Smoke for pageScraper. Uses chromium directly via setContent — NO real
// network — so behavior on real ATS pages is verified by m3 integration
// instead of duplicated here.

import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { shutdownBrowser } from '../src/career/lib/playwrightPool.mjs';
import {
  scrapeJdText,
  EnrichTimeout,
  EnrichError,
} from '../src/career/lib/pageScraper.mjs';

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

// Spin up a tiny in-process http server that returns whatever HTML body we
// give it for a given path. setContent doesn't work because page.goto needs
// a real navigable URL; data: URLs trigger Playwright's navigation handler
// inconsistently across versions. A loopback HTTP server is the simplest and
// most accurate fixture.
import { createServer } from 'node:http';
import { once } from 'node:events';

const ROUTES = new Map(); // path → html
const server = createServer((req, res) => {
  if (req.url === '/__hang') {
    // Write headers but NEVER end the body. With waitUntil:'domcontentloaded'
    // Playwright keeps the navigation pending until DOMContentLoaded fires —
    // which never happens on an unterminated stream. This produces a
    // deterministic TimeoutError across Chromium versions, vs. a bare
    // `return` which can surface as net::ERR_EMPTY_RESPONSE on some builds.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return;
  }
  const html = ROUTES.get(req.url) ?? '<html><body></body></html>';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});
server.listen(0);
await once(server, 'listening');
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

function setRoute(path, html) {
  ROUTES.set(path, html);
}

// ── Selector priority ────────────────────────────────────────────────────
await test('article tag wins over main + body', async () => {
  setRoute(
    '/article',
    `<html><body>
      <nav>NAV NOISE</nav>
      <article>Article body wins</article>
      <main>Main body loses</main>
      <footer>FOOT NOISE</footer>
    </body></html>`
  );
  const text = await scrapeJdText(`${BASE}/article`);
  assert.match(text, /Article body wins/);
  assert.doesNotMatch(text, /NAV NOISE/);
  assert.doesNotMatch(text, /FOOT NOISE/);
  assert.doesNotMatch(text, /Main body loses/);
});

await test('main fallback when no article', async () => {
  setRoute(
    '/main',
    '<html><body><main>Main body content here</main><footer>FOOT</footer></body></html>'
  );
  const text = await scrapeJdText(`${BASE}/main`);
  assert.match(text, /Main body content/);
  assert.doesNotMatch(text, /FOOT/);
});

await test('body fallback when no semantic tags', async () => {
  setRoute(
    '/body',
    '<html><body><div>Just a div with content</div><script>console.log("noise")</script></body></html>'
  );
  const text = await scrapeJdText(`${BASE}/body`);
  assert.match(text, /Just a div with content/);
  // script tag stripped — no JS source leakage
  assert.doesNotMatch(text, /console\.log/);
});

// ── Boilerplate stripping ────────────────────────────────────────────────
await test('nav/footer/script/style removed at DOM level', async () => {
  setRoute(
    '/strip',
    `<html><head><style>body { color: red }</style></head>
      <body>
        <nav>top nav</nav>
        <article>Real JD body here</article>
        <noscript>NOSCRIPT</noscript>
        <footer>bottom footer</footer>
      </body></html>`
  );
  const text = await scrapeJdText(`${BASE}/strip`);
  assert.match(text, /Real JD body/);
  assert.doesNotMatch(text, /top nav/);
  assert.doesNotMatch(text, /bottom footer/);
  assert.doesNotMatch(text, /NOSCRIPT/);
  assert.doesNotMatch(text, /color: red/);
});

// ── Whitespace + unicode ─────────────────────────────────────────────────
await test('whitespace collapsed; unicode (CJK + emoji) preserved', async () => {
  setRoute(
    '/unicode',
    '<html><body><article>Build  AI safely 🚀\n\n   构建 AI</article></body></html>'
  );
  const text = await scrapeJdText(`${BASE}/unicode`);
  assert.match(text, /🚀/);
  assert.match(text, /构建 AI/);
  assert.doesNotMatch(text, /\s{2,}/); // no runs of 2+ whitespace chars (covers tabs+spaces too)
});

// ── Empty body throws EnrichError ────────────────────────────────────────
await test('empty body throws EnrichError', async () => {
  setRoute('/empty', '<html><body></body></html>');
  await assert.rejects(
    () => scrapeJdText(`${BASE}/empty`),
    (e) => e instanceof EnrichError && /no main content/.test(e.message)
  );
});

// ── Bad input ────────────────────────────────────────────────────────────
await test('null/empty url throws EnrichError without launching browser', async () => {
  await assert.rejects(() => scrapeJdText(''), EnrichError);
  await assert.rejects(() => scrapeJdText(null), EnrichError);
});

// ── Timeout ──────────────────────────────────────────────────────────────
await test('timeout throws EnrichTimeout (not EnrichError)', async () => {
  await assert.rejects(
    () => scrapeJdText(`${BASE}/__hang`, { timeout: 500 }),
    (e) => {
      assert.ok(e instanceof EnrichTimeout, `expected EnrichTimeout, got ${e?.name}`);
      assert.equal(e.timeout_ms, 500);
      return true;
    }
  );
});

// ── Cleanup ──────────────────────────────────────────────────────────────
server.close();
await shutdownBrowser();

console.log(`\n✅ All ${passed} smoke tests passed.`);
