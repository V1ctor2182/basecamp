// Capture helpers for new eval fixtures.
//
// 07-applier/self-iteration/01-code-calibration m1.
//
// Two pieces:
//   1. scaffoldGroundTruthTemplate(...)  — pure function emitting a YAML
//      template string for a freshly captured fixture. Smoke-testable.
//   2. captureFromUrl(...)               — opens the URL via the shared
//      Playwright singleton (browser.mjs `getPage`), waits for DOM
//      content, dumps outer HTML + screenshot, scaffolds a stub truth.yml.
//      Interactive / one-shot — NOT exercised in smoke (avoid Chromium
//      launch in CI).
//
// EH4 reminder: this CAPTURE flow runs at human-driven authoring time
// only. The runtime eval flow (m2) consumes the offline HTML on disk —
// it never re-fetches the live URL.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { DEFAULT_FIXTURES_DIR, HTML_EXT, TRUTH_EXT } from './loader.mjs';

const TEMPLATE_HEADER = '# Ground-truth annotation — fill in manually (EH3).\n# Schema: src/career/eval/fixtures/schema.mjs GroundTruthSchema.\n';

/**
 * Emit a YAML string for an empty truth.yml template. Caller writes it
 * to disk. The output validates as schema-broken on purpose (empty
 * must_detect) — that's the signal to the annotator that work remains.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.vendor
 * @param {string} [opts.page_type]
 * @param {string} [opts.captured_at] — defaults to today's YYYY-MM-DD
 * @returns {string}
 */
export function scaffoldGroundTruthTemplate(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('scaffoldGroundTruthTemplate: opts required');
  }
  const { url, vendor, page_type, captured_at } = opts;
  if (typeof url !== 'string' || !url.length) {
    throw new TypeError('scaffoldGroundTruthTemplate: opts.url required');
  }
  if (typeof vendor !== 'string' || !vendor.length) {
    throw new TypeError('scaffoldGroundTruthTemplate: opts.vendor required');
  }
  const today = captured_at || new Date().toISOString().slice(0, 10);
  // Hand-rolled YAML so we control comments + ordering — js-yaml's dump
  // strips comments and reorders keys, which makes the template much less
  // helpful as an annotation guide.
  const lines = [
    TEMPLATE_HEADER,
    `url: ${JSON.stringify(url)}`,
    `captured_at: ${today}`,
    `vendor: ${vendor}`,
  ];
  if (page_type) lines.push(`page_type: ${page_type}`);
  lines.push(
    '',
    '# Fields the snapshot MUST surface. Required: role + name.',
    '# Optional: required (bool), optional (bool), states (string[]).',
    'must_detect:',
    '  - { role: textbox, name: "First Name", required: true }',
    '  - { role: textbox, name: "Email" }',
    '  - { role: button, name: "Submit" }',
    '',
    '# Labels/strings the snapshot MUST filter out. reason is required.',
    'must_not_detect:',
    '  - { name: "Privacy Policy", reason: "footer nav noise" }',
    '',
  );
  return lines.join('\n');
}

// REVIEW C1 (adv) fix: URL protocol allowlist. file:// reads local files
// into the captured HTML; javascript: / chrome:// / data: are equally
// hostile. Defense-in-depth alongside GroundTruthSchema's http(s)
// refinement — capture writes the URL into both disk paths, so blocking
// it here prevents the bad URL from ever being recorded.
const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:']);

const KEBAB_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Capture a fixture from a live URL — writes HTML + scaffolds truth.yml.
 *
 * Lazy-imports browser.mjs so the loader smoke (which never calls this)
 * doesn't pay the Playwright module-graph cost.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.vendor
 * @param {string} opts.slug              — e.g. 'anthropic' → 'greenhouse-anthropic'
 * @param {string} [opts.page_type]
 * @param {string} [opts.dir=DEFAULT_FIXTURES_DIR]
 * @param {boolean} [opts.overwrite=false] — refuse to clobber existing pair
 * @param {boolean} [opts.keepBrowserAlive=false] — library callers that batch
 *   multiple captures pass true to skip the per-call browser teardown.
 *   Single-shot CLI use leaves it false so the process can exit cleanly.
 * @returns {Promise<{ id: string, htmlPath: string, truthPath: string, truthCreated: boolean }>}
 */
export async function captureFromUrl(opts) {
  const {
    url,
    vendor,
    slug,
    page_type,
    dir = DEFAULT_FIXTURES_DIR,
    overwrite = false,
    keepBrowserAlive = false,
  } = opts;
  if (!KEBAB_RE.test(vendor)) {
    throw new TypeError(`captureFromUrl: vendor ${JSON.stringify(vendor)} must be kebab-case`);
  }
  if (!KEBAB_RE.test(slug)) {
    throw new TypeError(`captureFromUrl: slug ${JSON.stringify(slug)} must be kebab-case`);
  }
  // REVIEW C2 (adv) fix: page_type also flows into the YAML template;
  // unsanitized input lets `--page-type "x\nrm:" rf"` inject newlines
  // and break/reshape the scaffold output.
  if (page_type !== undefined && !KEBAB_RE.test(page_type)) {
    throw new TypeError(`captureFromUrl: page_type ${JSON.stringify(page_type)} must be kebab-case`);
  }
  // REVIEW C1 (adv) fix: parse + protocol allowlist.
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new TypeError(`captureFromUrl: url ${JSON.stringify(url)} is not a valid URL`);
  }
  if (!ALLOWED_URL_PROTOCOLS.has(parsedUrl.protocol)) {
    throw new TypeError(
      `captureFromUrl: url protocol ${parsedUrl.protocol} not allowed; use http(s) only`,
    );
  }

  const { getPage } = await import('../../applier/runtime/browser.mjs');
  await fs.mkdir(dir, { recursive: true });

  const id = `${vendor}-${slug}`;
  const htmlPath = path.join(dir, id + HTML_EXT);
  const truthPath = path.join(dir, id + TRUTH_EXT);

  // REVIEW H3 (Plan) + M1 (Plan) fix: refuse to clobber EITHER file.
  // Pre-fix the guard only checked truth.yml; an in-flight m2 baseline
  // run holding a captured HTML could be silently rewritten when an
  // annotator re-ran capture-fixture without --overwrite.
  const truthExists = await _exists(truthPath);
  const htmlExists = await _exists(htmlPath);
  if ((truthExists || htmlExists) && !overwrite) {
    const existing = [truthExists && truthPath, htmlExists && htmlPath].filter(Boolean).join(', ');
    throw new Error(
      `captureFromUrl: ${existing} already exists. Pass { overwrite: true } to replace.`,
    );
  }

  const page = await getPage();
  let htmlWritten = false;
  let truthWritten = false;
  try {
    // REVIEW H5 (Plan) fix: drop the redundant waitForLoadState — goto
    // with waitUntil:'domcontentloaded' already settled past DCL. The
    // call was a no-op, not the "hydration grace" the comment claimed.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const html = await page.content();
    await fs.writeFile(htmlPath, html, 'utf8');
    htmlWritten = true;
    await fs.writeFile(
      truthPath,
      scaffoldGroundTruthTemplate({ url, vendor, page_type }),
      'utf8',
    );
    truthWritten = true;
  } catch (err) {
    // Cleanup-on-failure: a crash between writes would leave an orphan
    // that breaks every subsequent loadFixtures(). Roll back what we
    // wrote during THIS call (best-effort — don't mask the real error).
    if (htmlWritten && !truthWritten) {
      await fs.unlink(htmlPath).catch(() => {});
    }
    throw err;
  } finally {
    await page.close().catch(() => {});
    if (!keepBrowserAlive) {
      // REVIEW M5 (adv) fix: library/CLI policy split was previously
      // implicit (CLI closed browser, lib left it warm). Make it an
      // explicit flag so batch callers (m2 dev tools) can opt in.
      try {
        const { closeBrowser } = await import('../../applier/runtime/browser.mjs');
        await closeBrowser();
      } catch {
        /* best-effort */
      }
    }
  }

  return {
    id,
    htmlPath,
    truthPath,
    truthCreated: true,
  };
}

async function _exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
