#!/usr/bin/env node
// Smoke for 07-applier/02-playwright-runtime m5:
// submitForm + parseFormErrors + detectSubmitSuccess.
//
// Real Chromium via getBrowser() — fresh page per test for isolation.

process.env.SMOKE = '1';

import assert from 'node:assert/strict';

import {
  getBrowser,
  getPage,
  closeBrowser,
} from '../src/career/applier/runtime/browser.mjs';
import {
  submitForm,
  parseFormErrors,
  detectSubmitSuccess,
  attachSubmitNetworkSignal,
  inferErrorCode,
  SUBMIT_TIMEOUT_MS,
  DEFAULT_SUBMIT_NAME_HINTS,
  DEFAULT_ERROR_SELECTORS,
  DEFAULT_NEXT_STEP_SELECTORS,
} from '../src/career/applier/runtime/submitFlow.mjs';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    await closeBrowser().catch(() => {});
    process.exit(1);
  }
}

const browser = await getBrowser();
let _pageCounter = 0;
async function freshPage(html) {
  _pageCounter++;
  const jobId = `sf${String(_pageCounter).padStart(10, '0')}`;
  const page = await getPage(jobId);
  await page.setContent(html, { waitUntil: 'load' });
  return page;
}

// ── Exports + constants ──────────────────────────────────────────────

await test('exports: SUBMIT_TIMEOUT_MS = 90s + default lists frozen', () => {
  assert.equal(SUBMIT_TIMEOUT_MS, 90_000);
  assert.ok(Object.isFrozen(DEFAULT_SUBMIT_NAME_HINTS));
  assert.ok(Object.isFrozen(DEFAULT_ERROR_SELECTORS));
  assert.ok(Object.isFrozen(DEFAULT_NEXT_STEP_SELECTORS));
  assert.ok(DEFAULT_SUBMIT_NAME_HINTS.includes('Submit'));
  assert.ok(DEFAULT_SUBMIT_NAME_HINTS.includes('Apply'));
});

// ── inferErrorCode unit tests (5 patterns + custom) ──────────────────

await test('inferErrorCode: 5 patterns + custom fallback', () => {
  assert.equal(inferErrorCode('This field is required.'), 'required');
  assert.equal(inferErrorCode('Please fill out this field'), 'required');
  assert.equal(inferErrorCode('Invalid email format'), 'invalid_format');
  assert.equal(inferErrorCode('Must match the required pattern'), 'invalid_format');
  assert.equal(inferErrorCode('File too large (max 5 MB)'), 'too_large');
  assert.equal(inferErrorCode('Resume must be at most 10 MB'), 'too_large');
  assert.equal(inferErrorCode('Cover letter too short. Minimum 100 chars.'), 'too_short');
  assert.equal(inferErrorCode('Must be at least 8 characters'), 'too_short');
  assert.equal(inferErrorCode('Something unexpected happened'), 'custom');
  assert.equal(inferErrorCode(''), 'custom');
  // [review H3] "too long" alone is ambiguous — no longer auto-routed to too_large
  assert.equal(inferErrorCode('Cover letter is too long for our parser'), 'custom');
  // size with explicit unit still routes correctly
  assert.equal(inferErrorCode('Resume must be less than 2 MB'), 'too_large');
});

// ── submitForm: happy path (URL change → 'submitted') ────────────────

await test('submitForm: happy path → URL change → outcome=submitted', async () => {
  // Use location.hash for URL change — pushState is blocked on about:blank.
  const page = await freshPage(`
    <html><body>
      <form>
        <button type="button" id="b">Submit Application</button>
      </form>
      <script>
        document.getElementById('b').addEventListener('click', () => {
          setTimeout(() => { location.hash = '#thank-you'; }, 80);
        });
      </script>
    </body></html>
  `);
  const result = await submitForm(page, {}, { timeoutMs: 5_000 });
  assert.equal(result.outcome, 'submitted');
  assert.ok(result.url_after && /thank-you/.test(result.url_after),
    `expected url_after to include 'thank-you', got: ${result.url_after}`);
  assert.ok(result.elapsed_ms > 0 && result.elapsed_ms < 5_000);
});

// ── submitForm: inline error appears → 'has_errors' ──────────────────

await test('submitForm: inline error appears → outcome=has_errors', async () => {
  const page = await freshPage(`
    <html><body>
      <form>
        <div class="error" style="display:none">Email is required.</div>
        <button type="button" id="b">Submit</button>
      </form>
      <script>
        document.getElementById('b').addEventListener('click', () => {
          setTimeout(() => {
            document.querySelector('.error').style.display = 'block';
          }, 80);
        });
      </script>
    </body></html>
  `);
  const result = await submitForm(page, {}, { timeoutMs: 5_000 });
  assert.equal(result.outcome, 'has_errors');
});

// ── submitForm: next-step DOM appears → 'next_step' ──────────────────

await test('submitForm: next-step appears → outcome=next_step', async () => {
  const page = await freshPage(`
    <html><body>
      <form>
        <button type="button" id="b">Apply</button>
      </form>
      <div id="next" style="display:none" aria-current="step">Step 2 of 3</div>
      <script>
        document.getElementById('b').addEventListener('click', () => {
          setTimeout(() => {
            document.getElementById('next').style.display = 'block';
          }, 80);
        });
      </script>
    </body></html>
  `);
  const result = await submitForm(page, {}, { timeoutMs: 5_000 });
  assert.equal(result.outcome, 'next_step');
});

// [review C2] Pre-existing visible errors must NOT pre-resolve has_errors race
await test('submitForm: stale visible errors do NOT short-circuit has_errors', async () => {
  const page = await freshPage(`
    <html><body>
      <form>
        <div role="alert">Email is required.</div>  <!-- already visible -->
        <button type="button" id="b">Submit</button>
      </form>
      <script>
        document.getElementById('b').addEventListener('click', () => {
          setTimeout(() => { location.hash = '#submitted'; }, 80);
        });
      </script>
    </body></html>
  `);
  // The stale error should NOT cause has_errors to fire instantly. The click
  // navigates to #submitted, so submitted must win.
  const result = await submitForm(page, {}, { timeoutMs: 5_000 });
  assert.equal(result.outcome, 'submitted',
    `stale error pre-empted submitted outcome: ${JSON.stringify(result)}`);
});

// ── submitForm: nothing happens → 'timeout' ──────────────────────────

await test('submitForm: silent button → outcome=timeout', async () => {
  const page = await freshPage(`
    <html><body>
      <button type="button">Submit</button>
    </body></html>
  `);
  const start = Date.now();
  const result = await submitForm(page, {}, { timeoutMs: 800 });
  const elapsed = Date.now() - start;
  assert.equal(result.outcome, 'timeout');
  assert.ok(elapsed >= 800, `expected >= 800ms, got ${elapsed}`);
  assert.ok(elapsed < 5_000, `timeout fired too late: ${elapsed}`);
});

// ── submitForm: button not found → throw ─────────────────────────────

await test('submitForm: no submit button → throws', async () => {
  const page = await freshPage(`<html><body><div>No buttons here.</div></body></html>`);
  await assert.rejects(
    () => submitForm(page, {}, { timeoutMs: 1_000 }),
    /submit button not found/i,
  );
});

// ── parseFormErrors: generic [role=alert] extraction ─────────────────

await test('parseFormErrors: [role=alert] extracted with field resolution', async () => {
  const page = await freshPage(`
    <html><body>
      <div class="field">
        <label>Email</label>
        <input name="email" type="email" />
        <div role="alert">Invalid email format</div>
      </div>
    </body></html>
  `);
  const errs = await parseFormErrors(page);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].field, 'email');
  assert.equal(errs[0].error_code, 'invalid_format');
  assert.match(errs[0].error_msg, /invalid email format/i);
});

// ── parseFormErrors: aria-describedby chain ──────────────────────────

await test('parseFormErrors: aria-describedby chain extracted', async () => {
  const page = await freshPage(`
    <html><body>
      <input name="phone" aria-invalid="true" aria-describedby="phone-err phone-hint" />
      <span id="phone-hint">Format: +1 555 1234</span>
      <span id="phone-err">Please provide a valid phone number</span>
    </body></html>
  `);
  const errs = await parseFormErrors(page);
  // Expect at least one error for phone field (matches valid phone -> invalid_format,
  // or "provide a valid" pattern). hint is not an error per se but might come through
  // as 'custom' — we accept the phone error specifically.
  const phoneErr = errs.find((e) => e.field === 'phone' && /valid phone/i.test(e.error_msg));
  assert.ok(phoneErr, `expected phone error in: ${JSON.stringify(errs)}`);
  assert.equal(phoneErr.error_code, 'invalid_format');
});

// ── parseFormErrors: error_code inference (5 patterns) ───────────────

await test('parseFormErrors: 5 error_code patterns inferred from DOM', async () => {
  const page = await freshPage(`
    <html><body>
      <div class="field">
        <input name="name" />
        <div role="alert">This field is required.</div>
      </div>
      <div class="field">
        <input name="email" />
        <div class="error">Invalid email format</div>
      </div>
      <div class="field">
        <input name="resume" />
        <div class="field-error">File too large (max 5 MB)</div>
      </div>
      <div class="field">
        <input name="cover" />
        <div class="help-block is-invalid">Must be at least 50 characters</div>
      </div>
      <div class="field">
        <input name="why" />
        <div role="alert">Something weird happened in the system</div>
      </div>
    </body></html>
  `);
  const errs = await parseFormErrors(page);
  const by = Object.fromEntries(errs.map((e) => [e.field, e.error_code]));
  assert.equal(by.name, 'required');
  assert.equal(by.email, 'invalid_format');
  assert.equal(by.resume, 'too_large');
  assert.equal(by.cover, 'too_short');
  assert.equal(by.why, 'custom');
});

// ── parseFormErrors: no errors → returns [] ─────────────────────────

await test('parseFormErrors: no errors → returns []', async () => {
  const page = await freshPage(`
    <html><body>
      <form>
        <input name="email" value="me@example.com" />
        <button>Submit</button>
      </form>
    </body></html>
  `);
  const errs = await parseFormErrors(page);
  assert.deepEqual(errs, []);
});

// ── parseFormErrors: per-adapter error_selectors override ───────────

await test('parseFormErrors: adapter.error_selectors override picks Greenhouse-style', async () => {
  const page = await freshPage(`
    <html><body>
      <div class="field">
        <input name="email" />
        <div class="gh-error">Required</div>
      </div>
      <!-- default selectors should NOT match here -->
      <div role="alert">A generic alert that we want to IGNORE under override</div>
    </body></html>
  `);
  const adapter = { error_selectors: ['.gh-error'] };
  const errs = await parseFormErrors(page, adapter);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].field, 'email');
  assert.equal(errs[0].error_code, 'required');
  // Verify default selectors WOULD have matched the role=alert
  const defaultErrs = await parseFormErrors(page);
  assert.ok(defaultErrs.length >= 1);
  assert.ok(defaultErrs.some((e) => /generic alert/i.test(e.error_msg)));
});

// ── detectSubmitSuccess: URL pattern match ──────────────────────────

await test('detectSubmitSuccess: URL pattern → true', async () => {
  const page = await freshPage(`<html><body>Nothing here</body></html>`);
  // Force URL via hash (pushState blocked on about:blank). Add /thank-you to
  // hash + custom matcher so URL pattern test logic still exercises.
  await page.evaluate(() => { location.hash = '#/thank-you?id=42'; });
  const ok = await detectSubmitSuccess(page);
  assert.equal(ok, true);
});

// ── detectSubmitSuccess: thank-you text match ───────────────────────

await test('detectSubmitSuccess: thank-you body text → true', async () => {
  const page = await freshPage(`
    <html><body>
      <h1>Thank you for applying!</h1>
      <p>We'll be in touch.</p>
    </body></html>
  `);
  const ok = await detectSubmitSuccess(page);
  assert.equal(ok, true);
});

// ── detectSubmitSuccess: network signal → true ──────────────────────

await test('detectSubmitSuccess: network signal (pre-installed listener)', async () => {
  const page = await freshPage(`<html><body><p>still on form</p></body></html>`);
  // Simulate caller manually setting the network signal flag
  let flag = false;
  const ok1 = await detectSubmitSuccess(page, {}, { networkSignal: () => flag });
  assert.equal(ok1, false);
  flag = true;
  const ok2 = await detectSubmitSuccess(page, {}, { networkSignal: () => flag });
  assert.equal(ok2, true);
});

// ── detectSubmitSuccess: all signals false → false ──────────────────

await test('detectSubmitSuccess: all false → false', async () => {
  const page = await freshPage(`
    <html><body>
      <form>
        <input name="email" />
        <button>Submit</button>
      </form>
    </body></html>
  `);
  const ok = await detectSubmitSuccess(page);
  assert.equal(ok, false);
});

// ── attachSubmitNetworkSignal: end-to-end via real navigation ───────

await test('attachSubmitNetworkSignal: dispose clears listeners', async () => {
  const page = await freshPage(`<html><body><p>x</p></body></html>`);
  const obs = attachSubmitNetworkSignal(page);
  // Signal is false until both POST + framenavigated arrive
  assert.equal(obs.signal(), false);
  obs.dispose();
  // After dispose, calling signal() must remain safe and false
  assert.equal(obs.signal(), false);
});

// [review M7] verify the listener actually flips on POST 2xx + nav
await test('attachSubmitNetworkSignal: flips on real POST + framenavigated', async () => {
  const page = await freshPage(`<html><body><p>x</p></body></html>`);
  // Mock the /applications endpoint. Need an absolute URL because
  // about:blank has no origin for relative fetches.
  await page.route('https://example.com/applications', (route) => {
    route.fulfill({ status: 200, body: '{"ok":true}', contentType: 'application/json' });
  });
  const obs = attachSubmitNetworkSignal(page);

  // Fire POST + trigger navigation (hash change counts as framenavigated)
  await page.evaluate(async () => {
    await fetch('https://example.com/applications', { method: 'POST', body: '{}' });
    location.hash = '#done';
  });

  // Listener events are async — give them a tick
  await page.waitForTimeout(200);
  assert.equal(obs.signal(), true);

  // [review H4] reset() clears the flags for next attempt
  obs.reset();
  assert.equal(obs.signal(), false);

  obs.dispose();
});

// [review M4] 3xx redirect must NOT flip the signal
await test('attachSubmitNetworkSignal: 302 to /login is NOT success', async () => {
  const page = await freshPage(`<html><body><p>x</p></body></html>`);
  await page.route('https://example.com/applications', (route) => {
    route.fulfill({
      status: 302,
      headers: { Location: 'https://example.com/login' },
      body: '',
    });
  });
  await page.route('https://example.com/login', (route) => {
    route.fulfill({ status: 200, body: 'login page', contentType: 'text/html' });
  });
  const obs = attachSubmitNetworkSignal(page);
  await page.evaluate(async () => {
    await fetch('https://example.com/applications', { method: 'POST', body: '{}' }).catch(() => {});
    location.hash = '#redirected';
  });
  await page.waitForTimeout(200);
  // POST itself returned 302 → sawPostOk should remain false (only 2xx flips it).
  // Note: Playwright auto-follows the redirect to /login as a separate GET;
  // /login is GET not POST, so onResponse skips it.
  assert.equal(obs.signal(), false);
  obs.dispose();
});

// ── Done ─────────────────────────────────────────────────────────────

await closeBrowser();

console.log(`\n✅ ${passed} smoke tests passed`);
process.exit(0);
