#!/usr/bin/env node
// Smoke for 07-applier/08-snapshot-refs-layer m2: pessimistic invalidation
// + unified error codes + iframe inline-recurse.
//
// SMOKE=1 forced. Real Chromium spawn.

process.env.SMOKE = '1';

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import {
  getPage,
  closeBrowser,
  USER_DATA_DIR,
} from '../src/career/applier/runtime/browser.mjs';
import { snapshot } from '../src/career/applier/runtime/snapshot.mjs';
import { RefTable } from '../src/career/applier/runtime/refTable.mjs';
import { click, fill } from '../src/career/applier/runtime/actions.mjs';
import {
  SnapshotError,
  SNAPSHOT_ERROR_CODES,
  classifyPlaywrightError,
} from '../src/career/applier/runtime/errors.mjs';

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

const SIMPLE_FORM_HTML = `<!doctype html>
<title>Form</title>
<body>
  <h1>Test Form</h1>
  <input id="e" type="email" aria-label="Email">
  <button id="submit-btn">Submit</button>
  <button id="cancel-btn">Cancel</button>
</body>`;
const SIMPLE_DATA_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(SIMPLE_FORM_HTML);

// Nested iframe via srcdoc — outer page has heading + button, iframe has
// its own form. Verifies iframe inline-recurse + frame-scoped resolve.
const IFRAME_HTML = `<!doctype html>
<title>Outer</title>
<body>
  <h1>Outer Heading</h1>
  <button>OuterButton</button>
  <iframe srcdoc='&lt;input aria-label="InnerEmail"&gt;&lt;button&gt;InnerSubmit&lt;/button&gt;'></iframe>
</body>`;
const IFRAME_DATA_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(IFRAME_HTML);

try {
  // ── 1. Generation 0 at construction; mint records gen ────────────────
  await test('RefTable generation starts at 0; mint records current gen', async () => {
    const t = new RefTable();
    assert.equal(t.generation(), 0);
    t.mint('button', 'X', 0);
    t.invalidate();
    assert.equal(t.generation(), 1);
    t.invalidate();
    assert.equal(t.generation(), 2);
  });

  // ── 2. POST-action invalidation: refs go STALE_REF after click ────────
  // C3 verification: after one click, the table's generation bumps. Any
  // ref minted at the prior generation now throws STALE_REF on resolve.
  await test('post-click invalidation: refs become STALE_REF on next resolve', async () => {
    const page = await getPage();
    await page.goto(SIMPLE_DATA_URL);
    const { text, table } = await snapshot(page);
    const submitRef = text.split('\n').find((l) => l.includes('"Submit"')).match(/\[ref=(e\d+)\]/)[1];
    const cancelRef = text.split('\n').find((l) => l.includes('"Cancel"')).match(/\[ref=(e\d+)\]/)[1];
    // Click submit — succeeds + invalidates the table
    await click(page, table, submitRef);
    assert.equal(table.generation(), 1, 'click should bump generation to 1');
    // Trying cancel ref now → STALE_REF
    let caught;
    try {
      await click(page, table, cancelRef);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected error on stale ref');
    assert.equal(caught.code, SNAPSHOT_ERROR_CODES.STALE_REF, `expected STALE_REF, got ${caught.code}`);
    assert.equal(caught.refId, cancelRef);
    assert.ok(caught.entry, 'stale-ref error should include entry for debugging');
    assert.equal(caught.entry.name, 'Cancel');
    await page.close();
  });

  // ── 3. fill also invalidates ──────────────────────────────────────────
  await test('fill action invalidates table (not click-specific)', async () => {
    const page = await getPage();
    await page.goto(SIMPLE_DATA_URL);
    const { text, table } = await snapshot(page);
    const emailRef = text.split('\n').find((l) => l.includes('"Email"')).match(/\[ref=(e\d+)\]/)[1];
    await fill(page, table, emailRef, 'x@y.com');
    assert.equal(table.generation(), 1, 'fill should also bump generation');
    await page.close();
  });

  // ── 4. UNKNOWN_REF + ELEMENT_GONE error codes via Playwright wrapping ─
  await test('UNKNOWN_REF on never-minted refs', async () => {
    const page = await getPage();
    await page.goto(SIMPLE_DATA_URL);
    const { table } = await snapshot(page);
    let caught;
    try {
      await click(page, table, 'e999');
    } catch (err) {
      caught = err;
    }
    assert.equal(caught.code, SNAPSHOT_ERROR_CODES.UNKNOWN_REF);
    assert.equal(caught.refId, 'e999');
    assert.ok(caught.hint.includes('snapshot'), 'hint should mention snapshot');
    await page.close();
  });

  // ── 5. ELEMENT_GONE when underlying element was removed from DOM ─────
  await test('ELEMENT_GONE when DOM element removed after snapshot', async () => {
    const page = await getPage();
    await page.goto(SIMPLE_DATA_URL);
    const { text, table } = await snapshot(page);
    const submitRef = text.split('\n').find((l) => l.includes('"Submit"')).match(/\[ref=(e\d+)\]/)[1];
    // Externally remove the submit button before click
    await page.evaluate(() => document.getElementById('submit-btn').remove());
    let caught;
    try {
      await click(page, table, submitRef, { timeout: 1000 });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected error after element removal');
    // Either ELEMENT_GONE (resolved-to-0) or ACTION_TIMEOUT (waited for visibility, never came)
    assert.ok(
      [SNAPSHOT_ERROR_CODES.ELEMENT_GONE, SNAPSHOT_ERROR_CODES.ACTION_TIMEOUT].includes(caught.code),
      `expected ELEMENT_GONE or ACTION_TIMEOUT, got ${caught.code}`,
    );
    assert.ok(caught.entry, 'error should include entry for debugging');
    assert.equal(caught.entry.name, 'Submit');
    await page.close();
  });

  // ── 6. classifyPlaywrightError unit cases ─────────────────────────────
  await test('classifyPlaywrightError maps Playwright errors to codes', async () => {
    const timeoutErr = Object.assign(new Error('Locator.click: Timeout 10000ms exceeded.'), {
      name: 'TimeoutError',
    });
    assert.equal(classifyPlaywrightError(timeoutErr), SNAPSHOT_ERROR_CODES.ACTION_TIMEOUT);

    const targetClosedErr = new Error('Target page, context or browser has been closed');
    assert.equal(classifyPlaywrightError(targetClosedErr), SNAPSHOT_ERROR_CODES.ELEMENT_GONE);

    const zeroElErr = new Error('locator.click: resolved to 0 elements');
    assert.equal(classifyPlaywrightError(zeroElErr), SNAPSHOT_ERROR_CODES.ELEMENT_GONE);

    const unknown = new Error('some unrelated failure');
    assert.equal(classifyPlaywrightError(unknown), null, 'unknown errors should return null');
  });

  // ── 7. iframe inline-recurse: outer + inner content in one snapshot ───
  // Verifies Q1 (inline-recurse default): the LLM sees a unified view of
  // top-level + iframe content without needing to "switch frame".
  // M2 fix: replaced waitForTimeout(300) with explicit iframe load wait.
  // M4 fix: use public refIds() iterator instead of _entries.
  await test('iframe inline-recurse: outer + inner elements both in snapshot', async () => {
    const page = await getPage();
    await page.goto(IFRAME_DATA_URL);
    // Explicit iframe load wait — deterministic vs waitForTimeout race
    await page.locator('iframe').first().waitFor({ state: 'attached' });
    const innerFrame = page.frames().find((f) => f !== page.mainFrame());
    await innerFrame.waitForLoadState('domcontentloaded');
    const { text, table } = await snapshot(page);
    // Outer page: heading + button
    assert.ok(text.includes('heading "Outer Heading"'), 'missing outer heading');
    assert.ok(text.includes('button "OuterButton"'), 'missing outer button');
    // iframe content: inner email + inner submit
    assert.ok(text.includes('textbox "InnerEmail"'), 'missing iframe email field');
    assert.ok(text.includes('button "InnerSubmit"'), 'missing iframe submit button');
    // Refs for iframe-scoped entries have a frame attached
    for (const refId of table.refIds()) {
      const entry = table.get(refId);
      if (['InnerEmail', 'InnerSubmit'].includes(entry.name)) {
        assert.ok(entry.frame !== null, `iframe ref ${refId} should have frame attached`);
      } else {
        assert.equal(entry.frame, null, `top-level ref ${refId} should have null frame`);
      }
    }
    await page.close();
  });

  // ── 8. iframe action: click ref inside iframe actually clicks iframe element ─
  await test('iframe action routing: click @inner-ref fires iframe-scoped click', async () => {
    const page = await getPage();
    // Custom iframe with a click-counter inside
    await page.goto(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<button>OuterBtn</button><iframe srcdoc="<button id=ib onclick='window._innerClicks=(window._innerClicks||0)+1'>IframeBtn</button>"></iframe>`,
        ),
    );
    await page.locator('iframe').first().waitFor({ state: 'attached' });
    const innerFrame = page.frames().find((f) => f !== page.mainFrame());
    await innerFrame.waitForLoadState('domcontentloaded');
    const { text, table } = await snapshot(page);
    const innerRef = text
      .split('\n')
      .find((l) => l.includes('"IframeBtn"'))
      .match(/\[ref=(e\d+)\]/)[1];
    await click(page, table, innerRef);
    // Verify the click landed in the iframe's window
    const clicks = await innerFrame.evaluate(() => window._innerClicks);
    assert.equal(clicks, 1, 'iframe button should have been clicked');
    await page.close();
  });

  // ── 8b. IFRAME_DETACHED — iframe removed between snapshot + action (M5) ─
  await test('IFRAME_DETACHED when iframe is removed between snapshot and resolve', async () => {
    const page = await getPage();
    await page.goto(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(`<iframe srcdoc="<button>InsideBtn</button>"></iframe>`),
    );
    await page.locator('iframe').first().waitFor({ state: 'attached' });
    const innerFrame = page.frames().find((f) => f !== page.mainFrame());
    await innerFrame.waitForLoadState('domcontentloaded');
    const { text, table } = await snapshot(page);
    const innerRef = text
      .split('\n')
      .find((l) => l.includes('"InsideBtn"'))
      ?.match(/\[ref=(e\d+)\]/)[1];
    assert.ok(innerRef, 'expected a ref for InsideBtn');
    // Externally remove the iframe — Playwright Frame.isDetached() will now be true
    await page.evaluate(() => document.querySelector('iframe').remove());
    // Give a tick for Playwright's frame-detached event to propagate
    await new Promise((r) => setTimeout(r, 100));
    let caught;
    try {
      // resolve() itself should throw IFRAME_DETACHED (not even attempt the click)
      await click(page, table, innerRef, { timeout: 500 });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected error after iframe detach');
    assert.equal(
      caught.code,
      SNAPSHOT_ERROR_CODES.IFRAME_DETACHED,
      `expected IFRAME_DETACHED, got ${caught.code} (msg: ${caught.message})`,
    );
    await page.close();
  });

  // ── 9. SnapshotError.toLLMMessage produces single-line LLM-readable text ─
  await test('SnapshotError.toLLMMessage returns single-line message with code + hint', async () => {
    const err = SnapshotError.staleRef('e3', { role: 'button', name: 'Save' }, 0, 1);
    const msg = err.toLLMMessage();
    assert.ok(msg.startsWith('STALE_REF:'), 'should start with code');
    assert.ok(msg.includes('e3'), 'should include refId');
    assert.ok(msg.includes('snapshot()'), 'should include hint');
    assert.ok(!msg.includes('\n'), 'should be single-line');
  });
} finally {
  await teardown();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
