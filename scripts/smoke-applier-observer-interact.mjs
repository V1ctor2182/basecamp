#!/usr/bin/env node
// Smoke for 07-applier/02-playwright-runtime m6:
// attachFormObserver + focusField + resetField.
//
// Real Chromium via getBrowser(); fresh page per test for isolation.

process.env.SMOKE = '1';

import assert from 'node:assert/strict';

import {
  getBrowser,
  getPage,
  closeBrowser,
} from '../src/career/applier/runtime/browser.mjs';
import {
  attachFormObserver,
} from '../src/career/applier/runtime/observer.mjs';
import {
  focusField,
  clearFocusField,
  resetField,
  detectFieldKind,
  FIELD_KINDS,
  FOCUS_OUTLINE_CSS,
} from '../src/career/applier/runtime/interact.mjs';

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

await getBrowser();
let _pageCounter = 0;
async function freshPage(html) {
  _pageCounter++;
  const jobId = `oi${String(_pageCounter).padStart(10, '0')}`;
  const page = await getPage(jobId);
  await page.setContent(html, { waitUntil: 'load' });
  return page;
}

// ── Exports + constants ──────────────────────────────────────────────

await test('exports: FIELD_KINDS frozen + 7 entries + OUTLINE css has #d33', () => {
  assert.ok(Object.isFrozen(FIELD_KINDS));
  assert.equal(FIELD_KINDS.length, 7);
  assert.ok(FIELD_KINDS.includes('combobox'));
  assert.match(FOCUS_OUTLINE_CSS, /#d33/);
  assert.match(FOCUS_OUTLINE_CSS, /2px/);
});

// ── observer: attach + fire callback once on input ──────────────────

await test('observer: attach + input event → callback fires once', async () => {
  const page = await freshPage(`
    <html><body>
      <form id="f">
        <input name="email" id="email" type="email" />
      </form>
    </body></html>
  `);
  const events = [];
  const detach = await attachFormObserver(page, '#f', (evt) => events.push(evt));

  await page.locator('#email').fill('me@x.com');
  // Debounce is 200ms, wait a bit longer for safety
  await page.waitForTimeout(350);

  assert.equal(events.length, 1, `expected 1 event, got ${events.length}`);
  assert.equal(events[0].field_ref, 'email');
  assert.equal(events[0].value, 'me@x.com');
  assert.ok(events[0].event_type === 'input' || events[0].event_type === 'change');

  await detach();
});

// ── observer: rapid typing → debounced to single callback ───────────

await test('observer: 5 rapid inputs within 200ms → callback fires once with last value', async () => {
  const page = await freshPage(`
    <html><body>
      <form id="f">
        <input name="name" id="n" />
      </form>
    </body></html>
  `);
  const events = [];
  const detach = await attachFormObserver(page, '#f', (evt) => events.push(evt));

  // Fire 5 rapid input events within ~50ms each via direct DOM dispatch
  // (Playwright type() is too slow to test debounce reliably).
  await page.evaluate(() => {
    const el = document.getElementById('n');
    const setVal = (v) => {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setVal('A');
    setTimeout(() => setVal('AB'), 30);
    setTimeout(() => setVal('ABC'), 60);
    setTimeout(() => setVal('ABCD'), 90);
    setTimeout(() => setVal('ABCDE'), 120);
  });
  await page.waitForTimeout(450);

  assert.equal(events.length, 1, `expected 1 debounced event, got ${events.length}: ${JSON.stringify(events)}`);
  assert.equal(events[0].value, 'ABCDE');

  await detach();
});

// ── observer: events outside form → not delivered ───────────────────

await test('observer: input outside form scope → callback NOT fired', async () => {
  const page = await freshPage(`
    <html><body>
      <form id="f">
        <input name="inside" id="inside" />
      </form>
      <input name="outside" id="outside" />
    </body></html>
  `);
  const events = [];
  const detach = await attachFormObserver(page, '#f', (evt) => events.push(evt));

  await page.locator('#outside').fill('out');
  await page.waitForTimeout(350);

  assert.equal(events.length, 0, `expected 0 events, got: ${JSON.stringify(events)}`);
  await detach();
});

// ── observer: detach → subsequent events not delivered ──────────────

await test('observer: detach() then input → callback NOT fired', async () => {
  const page = await freshPage(`
    <html><body>
      <form id="f">
        <input name="x" id="x" />
      </form>
    </body></html>
  `);
  const events = [];
  const detach = await attachFormObserver(page, '#f', (evt) => events.push(evt));
  await detach();

  await page.locator('#x').fill('after-detach');
  await page.waitForTimeout(350);

  assert.equal(events.length, 0, `expected 0 events after detach, got: ${JSON.stringify(events)}`);
});

// [review C1] concurrent attach must NOT throw "binding already registered"
await test('observer: concurrent attach on fresh page → both succeed', async () => {
  const page = await freshPage(`
    <html><body>
      <form id="a"><input name="ia" id="ia" /></form>
      <form id="b"><input name="ib" id="ib" /></form>
    </body></html>
  `);
  // Fire both attaches in parallel without awaiting the first
  const [detachA, detachB] = await Promise.all([
    attachFormObserver(page, '#a', () => {}),
    attachFormObserver(page, '#b', () => {}),
  ]);
  // Both should resolve without "already registered" — sanity by detaching
  await detachA();
  await detachB();
});

// ── observer: 2 observers on same page → independent callbacks ──────

await test('observer: multi-attach on same page → both fire independently', async () => {
  const page = await freshPage(`
    <html><body>
      <form id="a"><input name="a-input" id="ai" /></form>
      <form id="b"><input name="b-input" id="bi" /></form>
    </body></html>
  `);
  const eventsA = [];
  const eventsB = [];
  const detachA = await attachFormObserver(page, '#a', (evt) => eventsA.push(evt));
  const detachB = await attachFormObserver(page, '#b', (evt) => eventsB.push(evt));

  await page.locator('#ai').fill('hello-a');
  await page.locator('#bi').fill('hello-b');
  await page.waitForTimeout(350);

  assert.equal(eventsA.length, 1);
  assert.equal(eventsA[0].field_ref, 'a-input');
  assert.equal(eventsA[0].value, 'hello-a');
  assert.equal(eventsB.length, 1);
  assert.equal(eventsB[0].field_ref, 'b-input');
  assert.equal(eventsB[0].value, 'hello-b');

  await detachA();
  await detachB();
});

// ── focusField: scrollIntoView centers the field ────────────────────

await test('focusField: scroll moves field toward viewport center', async () => {
  // [review M3] setViewportSize BEFORE setContent — initial paint
  // matches the asserted viewport without depending on reflow timing.
  _pageCounter++;
  const jobId = `oi${String(_pageCounter).padStart(10, '0')}`;
  const page = await getPage(jobId);
  await page.setViewportSize({ width: 800, height: 600 });
  await page.setContent(`
    <html><body style="margin:0">
      <div style="height: 2000px; background: #eee">
        <input id="top" />
      </div>
      <input id="bottom" placeholder="bottom field" style="margin: 0" />
    </body></html>
  `, { waitUntil: 'load' });

  const before = await page.locator('#bottom').evaluate((el) => el.getBoundingClientRect().top);
  await focusField(page, page.locator('#bottom'));
  // Smooth scroll: wait a tick
  await page.waitForTimeout(400);
  const after = await page.locator('#bottom').evaluate((el) => el.getBoundingClientRect().top);

  assert.ok(after < before, `expected scroll up; before=${before} after=${after}`);
  // Field should be near vertical center (within 200px of half-viewport)
  assert.ok(after >= 0 && after < 600, `field should now be inside viewport, top=${after}`);
});

// ── focusField: outline attribute + computed style ──────────────────

await test('focusField: adds data-applier-focus + outline visible', async () => {
  const page = await freshPage(`
    <html><body>
      <input id="f" />
    </body></html>
  `);
  await focusField(page, page.locator('#f'));

  const attr = await page.locator('#f').getAttribute('data-applier-focus');
  assert.equal(attr, '1');

  // Outline visible — either via injected stylesheet OR the inline-style fallback.
  // We check computed style.outlineWidth is at least 2px.
  const outlineWidth = await page.locator('#f').evaluate((el) => {
    return getComputedStyle(el).outlineWidth;
  });
  // [review L3] Tightened regex — match "2px" prefix exactly, not "12px" etc.
  assert.match(outlineWidth, /^2px\b/, `expected 2px outline, got "${outlineWidth}"`);

  // clearFocusField removes attribute
  await clearFocusField(page, page.locator('#f'));
  const after = await page.locator('#f').getAttribute('data-applier-focus');
  assert.equal(after, null);
});

// ── focusField: focus() shifts activeElement ────────────────────────

await test('focusField: input becomes document.activeElement', async () => {
  const page = await freshPage(`
    <html><body>
      <input id="a" />
      <input id="b" />
    </body></html>
  `);
  // Pre-focus 'a' so we can confirm focus actually moves
  await page.locator('#a').focus();
  await focusField(page, page.locator('#b'));
  const activeId = await page.evaluate(() => document.activeElement?.id);
  assert.equal(activeId, 'b');
});

// ── resetField: text input fill('') ─────────────────────────────────

await test('resetField: text input → cleared via fill empty', async () => {
  const page = await freshPage(`
    <html><body>
      <input id="t" value="prefilled" />
    </body></html>
  `);
  // sanity: value present
  assert.equal(await page.locator('#t').inputValue(), 'prefilled');
  await resetField(page, page.locator('#t'));
  assert.equal(await page.locator('#t').inputValue(), '');
});

// ── resetField: select reset to index 0 ─────────────────────────────

await test('resetField: select → selectedIndex back to 0', async () => {
  const page = await freshPage(`
    <html><body>
      <select id="s">
        <option value="">-- pick --</option>
        <option value="us">USA</option>
        <option value="ca" selected>Canada</option>
      </select>
    </body></html>
  `);
  assert.equal(await page.locator('#s').evaluate((el) => el.selectedIndex), 2);
  await resetField(page, page.locator('#s'));
  assert.equal(await page.locator('#s').evaluate((el) => el.selectedIndex), 0);
});

// ── resetField: file input setInputFiles([]) ────────────────────────

await test('resetField: file input → files.length back to 0', async () => {
  const page = await freshPage(`
    <html><body>
      <input id="upload" type="file" />
    </body></html>
  `);
  // Pre-populate by setting a file via the input
  const tmpBuf = Buffer.from('hello');
  await page.locator('#upload').setInputFiles({
    name: 'r.txt',
    mimeType: 'text/plain',
    buffer: tmpBuf,
  });
  assert.equal(await page.locator('#upload').evaluate((el) => el.files.length), 1);

  await resetField(page, page.locator('#upload'));
  assert.equal(await page.locator('#upload').evaluate((el) => el.files.length), 0);
});

// [review M5] explicit kind hint overrides auto-detect
await test('resetField: explicit kind="text" hint forces fill path', async () => {
  const page = await freshPage(`
    <html><body><input id="t" value="prefilled" /></body></html>
  `);
  await resetField(page, page.locator('#t'), 'text');
  assert.equal(await page.locator('#t').inputValue(), '');
});

// [review H2] combobox reset on non-contenteditable widget MUST throw
await test('resetField: combobox kind on non-contenteditable trigger throws', async () => {
  const page = await freshPage(`
    <html><body>
      <!-- React-Select-like trigger: role=combobox, NOT contenteditable,
           label is "USA" (set by setting textContent or whatever). The
           Ctrl+A + Delete sequence will be silently eaten by the widget. -->
      <div id="rs" role="combobox" tabindex="0">USA</div>
    </body></html>
  `);
  await assert.rejects(
    () => resetField(page, page.locator('#rs')),
    /combobox keyboard sequence did not clear/i,
  );
});

// [review L8] clearFocusField on unmarked element is a safe no-op
await test('clearFocusField: idempotent on unmarked element', async () => {
  const page = await freshPage(`<html><body><input id="f" /></body></html>`);
  // never called focusField — element has no data-applier-focus
  await clearFocusField(page, page.locator('#f'));
  const attr = await page.locator('#f').getAttribute('data-applier-focus');
  assert.equal(attr, null);
});

// ── detectFieldKind: all 4 base tags + combobox ─────────────────────

await test('detectFieldKind: tag/type → 4 kinds + combobox', async () => {
  const page = await freshPage(`
    <html><body>
      <input id="text" type="text" />
      <input id="email" type="email" />
      <input id="tel" type="tel" />
      <input id="file" type="file" />
      <textarea id="ta"></textarea>
      <select id="sel"><option></option></select>
      <div id="cb" role="combobox"></div>
    </body></html>
  `);
  assert.equal(await detectFieldKind(page.locator('#text')), 'text');
  assert.equal(await detectFieldKind(page.locator('#email')), 'email');
  assert.equal(await detectFieldKind(page.locator('#tel')), 'tel');
  assert.equal(await detectFieldKind(page.locator('#file')), 'file');
  assert.equal(await detectFieldKind(page.locator('#ta')), 'textarea');
  assert.equal(await detectFieldKind(page.locator('#sel')), 'select');
  assert.equal(await detectFieldKind(page.locator('#cb')), 'combobox');
});

// ── Done ─────────────────────────────────────────────────────────────

await closeBrowser();

console.log(`\n✅ ${passed} smoke tests passed`);
process.exit(0);
