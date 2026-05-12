#!/usr/bin/env node
// Smoke for 07-applier/08-snapshot-refs-layer m3: select / press / upload
// + element screenshot + 8-cycle handle-leak verification. Closes the Room.
//
// SMOKE=1 forced.

process.env.SMOKE = '1';

import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import {
  getPage,
  closeBrowser,
  USER_DATA_DIR,
  SCREENSHOTS_DIR,
} from '../src/career/applier/runtime/browser.mjs';
import { snapshot } from '../src/career/applier/runtime/snapshot.mjs';
import {
  click,
  fill,
  select,
  press,
  upload,
  check,
  uncheck,
} from '../src/career/applier/runtime/actions.mjs';
import { captureElement } from '../src/career/applier/runtime/elementScreenshot.mjs';
import { SNAPSHOT_ERROR_CODES } from '../src/career/applier/runtime/errors.mjs';

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

// Fixture isolation — back up both .playwright/profile and screenshots
const BACKUP_PROFILE = USER_DATA_DIR + `.smoke-backup.${process.pid}`;
const BACKUP_SS = SCREENSHOTS_DIR + `.smoke-backup.${process.pid}`;
let hadProfile = false;
let hadScreenshots = false;
if (existsSync(USER_DATA_DIR)) {
  await fs.rename(USER_DATA_DIR, BACKUP_PROFILE);
  hadProfile = true;
}
if (existsSync(SCREENSHOTS_DIR)) {
  await fs.rename(SCREENSHOTS_DIR, BACKUP_SS);
  hadScreenshots = true;
}

// Temp file for upload test
const TMP_UPLOAD = path.join(os.tmpdir(), `applier-smoke-upload.${process.pid}.txt`);
await fs.writeFile(TMP_UPLOAD, 'smoke fixture content\n');

async function teardown() {
  try {
    await closeBrowser();
  } catch {}
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.rm(SCREENSHOTS_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.unlink(TMP_UPLOAD).catch(() => {});
  if (hadProfile) await fs.rename(BACKUP_PROFILE, USER_DATA_DIR).catch(() => {});
  if (hadScreenshots) await fs.rename(BACKUP_SS, SCREENSHOTS_DIR).catch(() => {});
}

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const FIXTURE_JOB = 'efefefefefef';

// ATS-shaped form with combobox + file input + standard fields
const ATS_FORM_HTML = `<!doctype html>
<title>Integration</title>
<body>
  <h1>Apply</h1>
  <input type="text" aria-label="First Name" id="fn">
  <select aria-label="Years of Experience" id="exp">
    <option value="">Select...</option>
    <option value="1">1-2 years</option>
    <option value="3">3-5 years</option>
    <option value="6">6+ years</option>
  </select>
  <input type="file" aria-label="Resume" id="resume">
  <button id="submit">Submit Application</button>
</body>`;
const ATS_DATA_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(ATS_FORM_HTML);

try {
  // ── 1. select on combobox — label/value/index variants (C2 fix) ──────
  // M7 fix: verify generation bumps to 1 after successful select.
  await test('select(@combobox) — label/value/index variants round-trip', async () => {
    const page = await getPage();
    await page.goto(ATS_DATA_URL);
    // 1a: label variant (default for string arg)
    let { text, table } = await snapshot(page);
    let expRef = text.split('\n').find((l) => l.includes('"Years of Experience"')).match(/\[ref=(e\d+)\]/)[1];
    await select(page, table, expRef, '3-5 years');
    assert.equal(await page.locator('#exp').inputValue(), '3', 'label variant');
    assert.equal(table.generation(), 1, 'select success should bump gen to 1 (M7 fix)');
    // 1b: value variant
    ({ text, table } = await snapshot(page));
    expRef = text.split('\n').find((l) => l.includes('"Years of Experience"')).match(/\[ref=(e\d+)\]/)[1];
    await select(page, table, expRef, { value: '6' });
    assert.equal(await page.locator('#exp').inputValue(), '6', 'value variant');
    // 1c: index variant (option index 2 = "3-5 years" with value '3')
    ({ text, table } = await snapshot(page));
    expRef = text.split('\n').find((l) => l.includes('"Years of Experience"')).match(/\[ref=(e\d+)\]/)[1];
    await select(page, table, expRef, { index: 2 });
    assert.equal(await page.locator('#exp').inputValue(), '3', 'index variant');
    await page.close();
  });

  // ── 2. select on non-combobox → ROLE_MISMATCH; unknown ref → UNKNOWN_REF
  // H2 fix: verify precedence — unknown ref returns UNKNOWN_REF, not
  // ROLE_MISMATCH. Locks the fall-through behavior so a refactor can't
  // silently flip it.
  await test('select error precedence — ROLE_MISMATCH for wrong-role, UNKNOWN_REF for missing', async () => {
    const page = await getPage();
    await page.goto(ATS_DATA_URL);
    const { text, table } = await snapshot(page);
    const submitRef = text
      .split('\n')
      .find((l) => l.includes('"Submit Application"'))
      .match(/\[ref=(e\d+)\]/)[1];
    // 2a: wrong role → ROLE_MISMATCH (entry exists but not combobox)
    let caught;
    try {
      await select(page, table, submitRef, 'whatever');
    } catch (err) {
      caught = err;
    }
    assert.equal(caught?.code, 'ROLE_MISMATCH');
    assert.ok(caught.message.includes('combobox'));
    // 2b: unknown ref → UNKNOWN_REF (entry doesn't exist; fall through to resolve)
    caught = undefined;
    try {
      await select(page, table, 'e999', 'whatever');
    } catch (err) {
      caught = err;
    }
    assert.equal(caught?.code, 'UNKNOWN_REF', 'unknown ref should be UNKNOWN_REF not ROLE_MISMATCH');
    // Both are caller errors — table should NOT be invalidated
    assert.equal(table.generation(), 0, 'caller errors must not invalidate table');
    await page.close();
  });

  // ── 3. press whitelisted Enter on focused input + verify gen bump ────
  // M7 fix: assert generation bumps to 1 after press success.
  await test('press(@input, "Enter") fires keydown + bumps generation', async () => {
    const page = await getPage();
    await page.goto(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<input aria-label="Search" id="s"><script>window._enterKeys=0;document.getElementById('s').addEventListener('keydown',(e)=>{if(e.key==='Enter')window._enterKeys++;});</script>`,
        ),
    );
    const { text, table } = await snapshot(page);
    const searchRef = text
      .split('\n')
      .find((l) => l.includes('"Search"'))
      .match(/\[ref=(e\d+)\]/)[1];
    await press(page, table, searchRef, 'Enter');
    const enters = await page.evaluate(() => window._enterKeys);
    assert.equal(enters, 1, 'expected one Enter keydown');
    assert.equal(table.generation(), 1, 'press success should bump generation (M7)');
    await page.close();
  });

  // ── 4. press disallowed key → KEY_NOT_ALLOWED + hint lists allowed keys
  // M1 fix from review: verify hint mentions allowed-key set so the LLM
  // can recover.
  await test('press with non-whitelisted key throws KEY_NOT_ALLOWED + hint lists allowed keys', async () => {
    const page = await getPage();
    await page.goto(ATS_DATA_URL);
    const { text, table } = await snapshot(page);
    const fnRef = text
      .split('\n')
      .find((l) => l.includes('"First Name"'))
      .match(/\[ref=(e\d+)\]/)[1];
    for (const badKey of ['Control+t', 'a', 'F12', 'Meta+w']) {
      let caught;
      try {
        await press(page, table, fnRef, badKey);
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, `expected error on key ${badKey}`);
      assert.equal(caught.code, 'KEY_NOT_ALLOWED', `expected KEY_NOT_ALLOWED for ${badKey}`);
      assert.ok(
        caught.hint.includes('Enter') && caught.hint.includes('Tab'),
        `hint should list allowed keys; got: ${caught.hint}`,
      );
    }
    // Table generation untouched (caller error)
    assert.equal(table.generation(), 0);
    await page.close();
  });

  // ── 5. upload to input[type=file] succeeds + form sees the file ──────
  await test('upload(@file-input, "/path") sets input.files via setInputFiles', async () => {
    const page = await getPage();
    await page.goto(ATS_DATA_URL);
    const { text, table } = await snapshot(page);
    const resumeRef = text
      .split('\n')
      .find((l) => l.includes('"Resume"'))
      .match(/\[ref=(e\d+)\]/)[1];
    await upload(page, table, resumeRef, TMP_UPLOAD);
    const fileName = await page.evaluate(() => document.getElementById('resume').files[0]?.name);
    assert.equal(
      fileName,
      path.basename(TMP_UPLOAD),
      'input.files[0].name should match uploaded path',
    );
    await page.close();
  });

  // ── 6. upload validation: non-absolute / missing / directory → UPLOAD_FAILED
  // M6 fix from review: added "is a directory" case (third branch of
  // upload's path validation).
  // M5 fix: upload also rejects unknown ref FIRST (was running fs.stat
  // even on bogus refs, producing misleading "file not accessible" errors).
  await test('upload validation rejects non-absolute / missing / directory / unknown-ref', async () => {
    const page = await getPage();
    await page.goto(ATS_DATA_URL);
    const { text, table } = await snapshot(page);
    const resumeRef = text
      .split('\n')
      .find((l) => l.includes('"Resume"'))
      .match(/\[ref=(e\d+)\]/)[1];
    // 6a: relative path
    let caught;
    try { await upload(page, table, resumeRef, 'relative/path.pdf'); } catch (err) { caught = err; }
    assert.equal(caught?.code, 'UPLOAD_FAILED');
    assert.ok(caught.message.includes('not absolute'), `got: ${caught.message}`);
    // 6b: missing file
    caught = undefined;
    try { await upload(page, table, resumeRef, '/tmp/does-not-exist-XXX-' + process.pid); } catch (err) { caught = err; }
    assert.equal(caught?.code, 'UPLOAD_FAILED');
    assert.ok(caught.message.includes('not accessible'));
    // 6c: directory (M6 fix) — passing /tmp itself
    caught = undefined;
    try { await upload(page, table, resumeRef, os.tmpdir()); } catch (err) { caught = err; }
    assert.equal(caught?.code, 'UPLOAD_FAILED');
    assert.ok(caught.message.includes('not a regular file'));
    // 6d: unknown ref → UNKNOWN_REF (M5 fix — ref check happens BEFORE path validation)
    caught = undefined;
    try { await upload(page, table, 'e999', TMP_UPLOAD); } catch (err) { caught = err; }
    assert.equal(caught?.code, 'UNKNOWN_REF', `unknown ref should be UNKNOWN_REF; got ${caught?.code}`);
    // Table generation untouched (all caller errors before action)
    assert.equal(table.generation(), 0);
    await page.close();
  });

  // ── 7. captureElement writes a valid JPEG cropped to element box ────
  // H4 fix from review: previously only asserted size < 10KB which a
  // full-page screenshot of a tiny fixture could also pass. Now parse
  // JPEG SOF0 marker to verify width/height roughly match the element's
  // bounding box, NOT the viewport.
  await test('captureElement writes JPEG actually cropped to bounding box', async () => {
    const page = await getPage();
    await page.goto(ATS_DATA_URL);
    const { text, table } = await snapshot(page);
    const submitRef = text
      .split('\n')
      .find((l) => l.includes('"Submit Application"'))
      .match(/\[ref=(e\d+)\]/)[1];
    const bbox = await page.locator('#submit').boundingBox();
    assert.ok(bbox, 'pre-condition: submit button has a bounding box');
    const filepath = await captureElement(page, table, submitRef, FIXTURE_JOB, 'submit-btn');
    assert.ok(existsSync(filepath), 'screenshot file should exist');
    assert.equal(
      path.basename(filepath),
      `element-${submitRef}-submit-btn.jpg`,
      'filename should match contract',
    );
    const buf = await fs.readFile(filepath);
    const head = buf.subarray(0, 3);
    assert.deepEqual(head, JPEG_MAGIC, 'JPEG magic bytes');
    // Parse JPEG SOF0 (0xFFC0) — height at offset+5, width at offset+7 (BE u16)
    const sofIdx = buf.indexOf(Buffer.from([0xff, 0xc0]));
    assert.ok(sofIdx > 0, 'JPEG SOF0 marker should be findable');
    const h = buf.readUInt16BE(sofIdx + 5);
    const w = buf.readUInt16BE(sofIdx + 7);
    // Submit button is ~120x32px (device-pixel-ratio may double on Retina).
    // Allow 2x DPR slack; reject if image is viewport-sized (1440x900).
    assert.ok(w < 400, `crop width should match button (got ${w}px; viewport is 1440)`);
    assert.ok(h < 100, `crop height should match button (got ${h}px; viewport is 900)`);
    // And within reason of the actual box (with DPR slack)
    assert.ok(w >= Math.floor(bbox.width), `crop width ${w} should be at least ${bbox.width}`);
    await page.close();
  });

  // ── 8. 8-cycle snapshot→act→re-snapshot handle-leak verification ─────
  // 验收 (f) from spec. H3 fix from review: tightened bound. Previous
  // first-half vs second-half ratio of 2.5x was too loose to catch a
  // sub-linear leak. Now we:
  //   1. Discard cycle 0 as warmup (Playwright init + CDP handshake)
  //   2. Compare cycle 7 vs cycle 1 directly (1.5x slack — leak would be 2x+)
  //   3. Assert absolute latency cap on the last cycle (sanity)
  //   4. Capture process.memoryUsage().external before/after
  //      (CDP buffers live in external memory; a real leak shows there)
  await test('8-cycle loop — no latency growth + no external memory leak', async () => {
    const page = await getPage();
    await page.goto(ATS_DATA_URL);
    const memBefore = process.memoryUsage().external;
    const cycleTimings = [];
    for (let i = 0; i < 8; i++) {
      const t0 = Date.now();
      const { text, table } = await snapshot(page);
      const fnRef = text
        .split('\n')
        .find((l) => l.includes('"First Name"'))
        .match(/\[ref=(e\d+)\]/)[1];
      await fill(page, table, fnRef, `Alice${i}`);
      cycleTimings.push(Date.now() - t0);
    }
    const finalVal = await page.locator('#fn').inputValue();
    assert.equal(finalVal, 'Alice7', 'last fill should persist');
    // H3: cycle 7 vs cycle 1 (skip warmup cycle 0)
    const c1 = cycleTimings[1];
    const c7 = cycleTimings[7];
    assert.ok(
      c7 < c1 * 1.5,
      `cycle 7 (${c7}ms) > 1.5× cycle 1 (${c1}ms) — likely handle leak`,
    );
    // H3: absolute cap on last cycle (snapshot+fill on tiny data: URL
    // should never exceed 3s on any reasonable machine)
    assert.ok(c7 < 3000, `cycle 7 absolute latency too high: ${c7}ms`);
    // H3: external memory delta — allow 10MB slack for Chromium's
    // internal accumulation; real handle leak would grow > MB/cycle
    const memDeltaMB = (process.memoryUsage().external - memBefore) / 1_000_000;
    assert.ok(
      memDeltaMB < 10,
      `external memory grew ${memDeltaMB.toFixed(1)}MB across 8 cycles — possible leak`,
    );
    await page.close();
  });

  // ── 8b. check/uncheck verbs (H3 from holistic review) ──────────────
  // Greenhouse EEO consent + Workday "I agree" checkboxes — previously
  // had to use click() which silently failed on fancy ATS toggles.
  await test('check(@checkbox) toggles a checkbox; uncheck reverses', async () => {
    const page = await getPage();
    await page.goto(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<input type="checkbox" id="cb" aria-label="I agree"><label for="cb">I agree</label>`,
        ),
    );
    let { text, table } = await snapshot(page);
    const cbRef = text
      .split('\n')
      .find((l) => l.includes('"I agree"'))
      .match(/\[ref=(e\d+)\]/)[1];
    assert.equal(await page.locator('#cb').isChecked(), false, 'pre: unchecked');
    await check(page, table, cbRef);
    assert.equal(await page.locator('#cb').isChecked(), true, 'after check: checked');
    assert.equal(table.generation(), 1, 'check bumps generation');
    // uncheck — needs fresh snapshot since table is stale
    ({ text, table } = await snapshot(page));
    const cbRef2 = text.split('\n').find((l) => l.includes('"I agree"')).match(/\[ref=(e\d+)\]/)[1];
    await uncheck(page, table, cbRef2);
    assert.equal(await page.locator('#cb').isChecked(), false, 'after uncheck: unchecked');
    await page.close();
  });

  // ── 8c. check on a button → ROLE_MISMATCH ────────────────────────────
  await test('check on non-checkbox throws ROLE_MISMATCH', async () => {
    const page = await getPage();
    await page.goto(ATS_DATA_URL);
    const { text, table } = await snapshot(page);
    const submitRef = text.split('\n').find((l) => l.includes('"Submit Application"')).match(/\[ref=(e\d+)\]/)[1];
    let caught;
    try { await check(page, table, submitRef); } catch (e) { caught = e; }
    assert.equal(caught?.code, 'ROLE_MISMATCH');
    assert.equal(table.generation(), 0, 'caller error must not invalidate');
    await page.close();
  });

  // ── 8d. select with bogus option → OPTION_NOT_FOUND (H5 holistic) ──
  await test('select with non-existent option throws OPTION_NOT_FOUND', async () => {
    const page = await getPage();
    await page.goto(ATS_DATA_URL);
    const { text, table } = await snapshot(page);
    const expRef = text.split('\n').find((l) => l.includes('"Years of Experience"')).match(/\[ref=(e\d+)\]/)[1];
    let caught;
    try { await select(page, table, expRef, 'BogusOption'); } catch (e) { caught = e; }
    assert.equal(caught?.code, 'OPTION_NOT_FOUND', `expected OPTION_NOT_FOUND, got ${caught?.code}`);
    // OPTION_NOT_FOUND happens INSIDE _runAction → IS invalidating (action-time failure)
    assert.equal(table.generation(), 1, 'action-time failure still invalidates');
    await page.close();
  });

  // ── 9. End-to-end: full ATS form fill via all action verbs ──────────
  // C1 fix: previous test appended encodeURIComponent to ATS_DATA_URL
  // (which is itself already-encoded data URL) — the appended bytes
  // never executed as HTML. Build a fresh URL with submit-notify wired
  // INSIDE the HTML, then assert submitFired.
  await test('end-to-end: fill text + select + upload + click submit notifies', async () => {
    const page = await getPage();
    let submitFired = false;
    await page.exposeFunction('_submitNotify', () => {
      submitFired = true;
    });
    // Build HTML with the click listener inside the document body
    const E2E_HTML = ATS_FORM_HTML.replace(
      '</body>',
      `<script>document.getElementById("submit").addEventListener("click",()=>window._submitNotify());</script></body>`,
    );
    const E2E_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(E2E_HTML);
    await page.goto(E2E_URL);

    // Step 1: fill First Name
    const snap1 = await snapshot(page);
    const fnRef = snap1.text.split('\n').find((l) => l.includes('"First Name"')).match(/\[ref=(e\d+)\]/)[1];
    await fill(page, snap1.table, fnRef, 'Alice Tester');
    assert.equal(snap1.table.generation(), 1, 'after fill, gen=1');

    // Step 2: re-snapshot + select (M7 fix: verify generation bumps on select success)
    const snap2 = await snapshot(page);
    const expRef = snap2.text.split('\n').find((l) => l.includes('"Years of Experience"')).match(/\[ref=(e\d+)\]/)[1];
    await select(page, snap2.table, expRef, '3-5 years');
    assert.equal(snap2.table.generation(), 1, 'after select, gen=1');

    // Step 3: re-snapshot + upload (M7 fix: verify generation bumps on upload success)
    const snap3 = await snapshot(page);
    const resumeRef = snap3.text.split('\n').find((l) => l.includes('"Resume"')).match(/\[ref=(e\d+)\]/)[1];
    await upload(page, snap3.table, resumeRef, TMP_UPLOAD);
    assert.equal(snap3.table.generation(), 1, 'after upload, gen=1');

    // Step 4: re-snapshot + click Submit
    const snap4 = await snapshot(page);
    const submitRef = snap4.text.split('\n').find((l) => l.includes('"Submit Application"')).match(/\[ref=(e\d+)\]/)[1];
    await click(page, snap4.table, submitRef);

    // C1 fix: now actually verify the click reached the page handler
    assert.equal(submitFired, true, 'submit click should fire _submitNotify');

    // Verify final state
    assert.equal(await page.locator('#fn').inputValue(), 'Alice Tester');
    assert.equal(await page.locator('#exp').inputValue(), '3');
    const resumeName = await page.evaluate(() => document.getElementById('resume').files[0]?.name);
    assert.equal(resumeName, path.basename(TMP_UPLOAD));
    await page.close();
  });
} finally {
  await teardown();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
