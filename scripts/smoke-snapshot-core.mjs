#!/usr/bin/env node
// Smoke for 07-applier/08-snapshot-refs-layer m1: snapshot serializer +
// ref table + click/fill via Playwright Locator bridge.
//
// SMOKE=1 forced. Real Chromium spawn (~10-15s for full run).

process.env.SMOKE = '1';

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import {
  getBrowser,
  getPage,
  closeBrowser,
  USER_DATA_DIR,
} from '../src/career/applier/runtime/browser.mjs';
import {
  snapshot,
  INTERACTIVE_ROLES,
} from '../src/career/applier/runtime/snapshot.mjs';
import { RefTable } from '../src/career/applier/runtime/refTable.mjs';
import { click, fill } from '../src/career/applier/runtime/actions.mjs';

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

// Fixture isolation — same pattern as m1/m2/m3 of 02-playwright-runtime
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

// ATS-shaped HTML fixture inline (no external file). Mimics a stripped-
// down Greenhouse apply form: header + 4 fields + submit + irrelevant
// decorative elements (to verify allowlist filtering works).
const FIXTURE_HTML = `<!doctype html>
<title>Apply</title>
<style>img.deco { width: 1px; height: 1px; }</style>
<body>
  <h1>Apply for Senior Engineer</h1>
  <p>This paragraph should NOT be in snapshot (not interactive).</p>
  <img class="deco" alt="" src="data:,">
  <form id="apply-form">
    <label for="fn">First Name</label>
    <input id="fn" name="first" type="text" required>

    <label for="email">Email</label>
    <input id="email" type="email" required>

    <label for="phone">Phone</label>
    <input id="phone" type="tel">

    <label for="exp">Years of Experience</label>
    <input id="exp" type="number" aria-label="Years of Experience">

    <fieldset>
      <legend>Are you authorized to work in the US?</legend>
      <label><input type="radio" name="auth" value="yes"> Yes</label>
      <label><input type="radio" name="auth" value="no"> No</label>
    </fieldset>

    <button type="button" id="cancel">Cancel</button>
    <button type="submit" id="submit">Submit Application</button>
  </form>
  <script>
    window._submitFired = 0;
    document.getElementById('submit').addEventListener('click', () => window._submitFired++);
  </script>
</body>`;

const FIXTURE_DATA_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(FIXTURE_HTML);

try {
  // ── 1. INTERACTIVE_ROLES allowlist contains the expected 9 ────────────
  await test('INTERACTIVE_ROLES allowlist matches locked spec (9 roles)', async () => {
    assert.equal(INTERACTIVE_ROLES.length, 9);
    const expected = new Set([
      'button',
      'link',
      'textbox',
      'checkbox',
      'radio',
      'combobox',
      'menuitem',
      'tab',
      'heading',
    ]);
    for (const r of INTERACTIVE_ROLES) assert.ok(expected.has(r), `unexpected role: ${r}`);
  });

  // ── 2. snapshot() emits the expected text format + role coverage ──────
  // H1 fix: previous regex matched ANY single role, so a snapshot missing
  // all form fields would still pass. Now also count by role + assert
  // minimum coverage.
  // H6 fix: explicitly verify inferred role `textbox` for <input type=text>.
  await test('snapshot() emits valid text contract + minimum role coverage', async () => {
    const page = await getPage();
    await page.goto(FIXTURE_DATA_URL);
    const { text, table } = await snapshot(page);
    const lines = text.split('\n').filter(Boolean);
    assert.ok(lines.length > 0, 'expected non-empty snapshot output');
    // Each line matches contract — name allows escaped quotes \\"
    const lineRe = /^- (button|link|textbox|checkbox|radio|combobox|menuitem|tab|heading) "[^"]*" \[ref=e\d+\](?:\s\[(?:truncated|required|checked|selected|expanded|disabled)\])*$/;
    for (const line of lines) {
      assert.ok(lineRe.test(line), `line doesn't match contract: ${JSON.stringify(line)}`);
    }
    // Count by role + assert minimums
    const counts = {};
    for (const line of lines) {
      const role = line.match(/^- (\w+) /)[1];
      counts[role] = (counts[role] || 0) + 1;
    }
    assert.ok((counts.button || 0) >= 2, `expected >=2 buttons, got ${counts.button}`);
    assert.ok((counts.textbox || 0) >= 3, `expected >=3 textboxes (inferred role from <input>), got ${counts.textbox}`);
    assert.ok((counts.heading || 0) >= 1, `expected >=1 heading, got ${counts.heading}`);
    // H6: lock the inferred-role contract for <input type=email>
    assert.ok(text.includes('textbox "Email"'), 'Email field must be role=textbox');
    assert.equal(table.size(), lines.length, 'refTable.size() matches line count');
    await page.close();
  });

  // ── 3. Allowlist filtering: non-interactive nodes dropped ─────────────
  await test('snapshot() filters out non-interactive nodes (paragraph, image, generic)', async () => {
    const page = await getPage();
    await page.goto(FIXTURE_DATA_URL);
    const { text } = await snapshot(page);
    // The fixture has a <p> with "This paragraph should NOT..." — verify it's absent
    assert.ok(!text.includes('paragraph'), 'paragraph leaked into snapshot');
    // The decorative img with alt="" should not appear
    assert.ok(!text.includes('img'), 'decorative img leaked into snapshot');
    // Form elements should be visible
    assert.ok(text.includes('First Name'), 'First Name field missing');
    assert.ok(text.includes('Email'), 'Email field missing');
    assert.ok(text.includes('Submit Application'), 'Submit button missing');
    await page.close();
  });

  // ── 4. ARIA state suffix: [required] emitted for required fields ──────
  await test('snapshot() emits [required] suffix for required textboxes', async () => {
    const page = await getPage();
    await page.goto(FIXTURE_DATA_URL);
    const { text } = await snapshot(page);
    // First Name is required — its line should have [required]
    const fnLine = text.split('\n').find((l) => l.includes('"First Name"'));
    assert.ok(fnLine, 'First Name line not found');
    assert.ok(fnLine.includes('[required]'), `expected [required] on: ${fnLine}`);
    // Phone is NOT required — its line should not have [required]
    const phoneLine = text.split('\n').find((l) => l.includes('"Phone"'));
    assert.ok(phoneLine, 'Phone line not found');
    assert.ok(!phoneLine.includes('[required]'), `Phone should not be required: ${phoneLine}`);
    await page.close();
  });

  // ── 5. click @ref fires the actual onclick ────────────────────────────
  await test('click(@submit) fires the button click handler', async () => {
    const page = await getPage();
    await page.goto(FIXTURE_DATA_URL);
    const { text, table } = await snapshot(page);
    // Find the Submit button's refId
    const submitLine = text.split('\n').find((l) => l.includes('"Submit Application"'));
    const refIdMatch = submitLine.match(/\[ref=(e\d+)\]/);
    assert.ok(refIdMatch, 'could not extract refId from Submit line');
    const submitRef = refIdMatch[1];
    // Verify pre-state
    const fired0 = await page.evaluate(() => window._submitFired);
    assert.equal(fired0, 0, 'pre-condition: click count starts at 0');
    // Click via symbolic API
    await click(page, table, submitRef);
    const fired1 = await page.evaluate(() => window._submitFired);
    assert.equal(fired1, 1, 'expected one click fired');
    await page.close();
  });

  // ── 6. fill @ref sets input value ─────────────────────────────────────
  await test('fill(@email, "alice@x.com") sets email input value', async () => {
    const page = await getPage();
    await page.goto(FIXTURE_DATA_URL);
    const { text, table } = await snapshot(page);
    const emailLine = text.split('\n').find((l) => l.includes('"Email"'));
    const emailRef = emailLine.match(/\[ref=(e\d+)\]/)[1];
    await fill(page, table, emailRef, 'alice@example.com');
    const value = await page.locator('#email').inputValue();
    assert.equal(value, 'alice@example.com');
    await page.close();
  });

  // ── 7. UNKNOWN_REF: unminted ref throws with helpful message ──────────
  await test('resolve(unknownRef) throws UNKNOWN_REF', async () => {
    const page = await getPage();
    await page.goto(FIXTURE_DATA_URL);
    const { table } = await snapshot(page);
    assert.ok(!table.has('e999'));
    assert.throws(() => table.resolve('e999', page), /UNKNOWN_REF.*e999/);
    await page.close();
  });

  // ── 8. Occurrence-index disambiguation (Q8) ───────────────────────────
  // Construct a page with two buttons sharing identical role+name, verify
  // they get distinct refs AND distinct occurrenceIndex (0 vs 1)
  await test('two identical buttons get distinct refs + distinct occurrenceIndex', async () => {
    const page = await getPage();
    await page.goto(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<button id=a>Save</button><button id=b>Save</button>',
        ),
    );
    const { text, table } = await snapshot(page);
    const saveLines = text.split('\n').filter((l) => l.includes('"Save"'));
    assert.equal(saveLines.length, 2, 'expected 2 Save lines');
    const refA = saveLines[0].match(/\[ref=(e\d+)\]/)[1];
    const refB = saveLines[1].match(/\[ref=(e\d+)\]/)[1];
    assert.notEqual(refA, refB, 'distinct refs for distinct buttons');
    const entryA = table.get(refA);
    const entryB = table.get(refB);
    assert.equal(entryA.occurrenceIndex, 0, 'first Save → occurrenceIndex 0');
    assert.equal(entryB.occurrenceIndex, 1, 'second Save → occurrenceIndex 1');
    await page.close();
  });

  // ── 9. Token-budget sanity (tight bound — H2 fix from review) ────────
  // The fixture has 9 interactive nodes × ~45 bytes/line ≈ 400 bytes.
  // 800-byte cap = 2× headroom; any regression that 2x's the per-line
  // overhead will trip this.
  await test('snapshot text byte budget — tight bound for fixture (was loose)', async () => {
    const page = await getPage();
    await page.goto(FIXTURE_DATA_URL);
    const { text } = await snapshot(page);
    assert.ok(
      text.length < 800,
      `snapshot too verbose: ${text.length} bytes — format may be leaking noise`,
    );
    await page.close();
  });

  // ── 10. Multi-page snapshot (M4 fix from review) ───────────────────────
  // Open 2 pages with different content; snapshot each; verify they're
  // independent (no shared CDPSession bleed-through, no ref collision).
  await test('two pages have independent snapshots + independent ref tables', async () => {
    const pageA = await getPage();
    const pageB = await getPage();
    await pageA.goto('data:text/html,<button>OnlyA</button>');
    await pageB.goto('data:text/html,<button>OnlyB</button>');
    const snapA = await snapshot(pageA);
    const snapB = await snapshot(pageB);
    assert.ok(snapA.text.includes('"OnlyA"'), 'pageA snapshot should have OnlyA');
    assert.ok(!snapA.text.includes('OnlyB'), 'pageA snapshot must not include OnlyB');
    assert.ok(snapB.text.includes('"OnlyB"'), 'pageB snapshot should have OnlyB');
    assert.ok(!snapB.text.includes('OnlyA'), 'pageB snapshot must not include OnlyA');
    // Distinct RefTable instances
    assert.notStrictEqual(snapA.table, snapB.table, 'tables must be distinct');
    await pageA.close();
    await pageB.close();
  });

  // ── 11. WRONG_PAGE: resolve with foreign page throws helpfully (M5) ──
  await test('refTable.resolve() rejects cross-page misuse with WRONG_PAGE', async () => {
    const pageA = await getPage();
    const pageB = await getPage();
    await pageA.goto('data:text/html,<button>X</button>');
    await pageB.goto('data:text/html,<input>');
    const { table } = await snapshot(pageA);
    // table was minted on pageA; trying to resolve via pageB must throw
    assert.throws(() => table.resolve('e1', pageB), /WRONG_PAGE/);
    await pageA.close();
    await pageB.close();
  });

  // ── 12. Truncation marker for long names (C1 fix) ─────────────────────
  await test('snapshot emits [truncated] marker for names > 80 chars', async () => {
    const page = await getPage();
    // 100-char button name — over the NAME_DISPLAY_CAP of 80
    const longName = 'a'.repeat(100);
    await page.goto(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(`<button>${longName}</button>`),
    );
    const { text } = await snapshot(page);
    const buttonLine = text.split('\n').find((l) => l.startsWith('- button'));
    assert.ok(buttonLine, 'expected button line');
    assert.ok(
      buttonLine.includes('[truncated]'),
      `expected [truncated] marker on long-name line: ${buttonLine}`,
    );
    await page.close();
  });
} finally {
  await teardown();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
