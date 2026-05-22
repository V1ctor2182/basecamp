#!/usr/bin/env node
// Smoke for 07-applier Mode 2 M1 — post-fill verification.
// Covers verifyValueMatches (pure) + verifyStep (orchestration) against
// a mocked Playwright page + RefTable. Pure-Node, ~instant.
//
// Core principle under test: a field only earns 'verified' via an
// explicit positive read-back; everything else surfaces; never throws.

import assert from 'node:assert/strict';
import {
  verifyStep,
  verifyValueMatches,
} from '../src/career/applier/multistep/machine.mjs';

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

// ── verifyValueMatches (pure) ──────────────────────────────────────────

await test('verifyValueMatches: textbox exact', () => {
  assert.equal(
    verifyValueMatches({ role: 'textbox', suggested_value: 'a@b.com' }, 'a@b.com'),
    true,
  );
});

await test('verifyValueMatches: textbox case/whitespace-insensitive', () => {
  assert.equal(
    verifyValueMatches({ role: 'textbox', suggested_value: 'New York' }, '  new   york '),
    true,
  );
});

await test('verifyValueMatches: textbox empty actual → false (the silent-error catch)', () => {
  assert.equal(
    verifyValueMatches({ role: 'textbox', suggested_value: 'Chenyang' }, ''),
    false,
  );
});

await test('verifyValueMatches: combobox — value contained in displayed text', () => {
  assert.equal(
    verifyValueMatches(
      { role: 'combobox', suggested_value: 'I do not want to answer' },
      'Disability Status I do not want to answer',
    ),
    true,
  );
});

await test('verifyValueMatches: checkbox/radio — checked → true, unchecked → false', () => {
  assert.equal(verifyValueMatches({ role: 'checkbox', suggested_value: 'I agree' }, 'checked'), true);
  assert.equal(verifyValueMatches({ role: 'checkbox', suggested_value: 'I agree' }, 'unchecked'), false);
  assert.equal(verifyValueMatches({ role: 'radio', suggested_value: 'x' }, 'checked'), true);
});

await test('verifyValueMatches: checkbox with "No" intent — unchecked → true, checked → false', () => {
  // defaultFillField uncheck()s on a negative value; a correctly-unchecked
  // "No" box must verify, not falsely mismatch.
  assert.equal(verifyValueMatches({ role: 'checkbox', suggested_value: 'No' }, 'unchecked'), true);
  assert.equal(verifyValueMatches({ role: 'checkbox', suggested_value: 'No' }, 'checked'), false);
});

await test('verifyValueMatches: file — WRONG filename → false (no false green)', () => {
  const f = { _fileInputIndex: 0, suggested_value: '/out/abc-resume.pdf' };
  assert.equal(verifyValueMatches(f, 'abc-resume.pdf'), true);
  assert.equal(verifyValueMatches(f, 'some-other-file.pdf'), false);
});

await test('verifyValueMatches: combobox still showing placeholder → false', () => {
  assert.equal(
    verifyValueMatches({ role: 'combobox', suggested_value: 'Yes' }, 'Select an option'),
    false,
  );
});

await test('verifyValueMatches: file — matching basename → true, empty → false', () => {
  const f = { _fileInputIndex: 0, suggested_value: '/out/x-resume.pdf' };
  assert.equal(verifyValueMatches(f, 'x-resume.pdf'), true);
  assert.equal(verifyValueMatches(f, ''), false);
});

// ── verifyStep (orchestration) ─────────────────────────────────────────

function mkLocator(spec) {
  return {
    async inputValue() {
      if (!('inputValue' in spec)) throw new Error('not an input element');
      return spec.inputValue;
    },
    async isChecked() {
      if (!('isChecked' in spec)) throw new Error('not checkable');
      return spec.isChecked;
    },
    async textContent() {
      return spec.textContent ?? null;
    },
    async getAttribute(n) {
      return n === 'aria-checked' ? spec.ariaChecked ?? null : null;
    },
  };
}

// Mock { page, table }. byRef: refId → locator-spec, or the string
// 'throw' to simulate a stale ref. fileNames[i] → attached file name.
function mkEnv(byRef, fileNames = []) {
  const table = {
    resolve(refId) {
      const spec = byRef[refId];
      if (spec === 'throw') throw new Error('stale ref');
      return mkLocator(spec || {});
    },
  };
  const page = {
    locator() {
      return {
        nth(i) {
          return {
            async evaluate(fn) {
              return fn({ files: fileNames[i] ? [{ name: fileNames[i] }] : [] });
            },
          };
        },
      };
    },
  };
  return { page, table };
}

await test('verifyStep: textbox value landed → verified', async () => {
  const { page, table } = mkEnv({ e1: { inputValue: 'a@b.com' } });
  const fields = [{ refId: 'e1', role: 'textbox', suggested_value: 'a@b.com' }];
  await verifyStep(page, table, fields);
  assert.equal(fields[0].verify_status, 'verified');
});

await test('verifyStep: textbox empty in DOM → mismatch + detail', async () => {
  const { page, table } = mkEnv({ e1: { inputValue: '' } });
  const fields = [{ refId: 'e1', role: 'textbox', suggested_value: 'Chenyang' }];
  await verifyStep(page, table, fields);
  assert.equal(fields[0].verify_status, 'mismatch');
  assert.ok(fields[0].verify_detail.includes('Chenyang'));
});

await test('verifyStep: combobox read via textContent → verified', async () => {
  const { page, table } = mkEnv({ e1: { textContent: 'Gender Decline To Self Identify' } });
  const fields = [{ refId: 'e1', role: 'combobox', suggested_value: 'Decline To Self Identify' }];
  await verifyStep(page, table, fields);
  assert.equal(fields[0].verify_status, 'verified');
});

await test('verifyStep: checkbox checked → verified', async () => {
  const { page, table } = mkEnv({ e1: { isChecked: true } });
  const fields = [{ refId: 'e1', role: 'checkbox', suggested_value: 'I agree' }];
  await verifyStep(page, table, fields);
  assert.equal(fields[0].verify_status, 'verified');
});

await test('verifyStep: file with attached PDF → verified', async () => {
  const { page, table } = mkEnv({}, ['x-resume.pdf']);
  const fields = [{ _fileInputIndex: 0, role: 'file', suggested_value: '/out/x-resume.pdf' }];
  await verifyStep(page, table, fields);
  assert.equal(fields[0].verify_status, 'verified');
});

await test('verifyStep: file with NO file attached → mismatch', async () => {
  const { page, table } = mkEnv({}, []);
  const fields = [{ _fileInputIndex: 0, role: 'file', suggested_value: '/out/x-resume.pdf' }];
  await verifyStep(page, table, fields);
  assert.equal(fields[0].verify_status, 'mismatch');
});

await test('verifyStep: stale ref → unverifiable, never throws', async () => {
  const { page, table } = mkEnv({ e1: 'throw' });
  const fields = [{ refId: 'e1', role: 'textbox', suggested_value: 'x' }];
  await verifyStep(page, table, fields); // must not throw
  assert.equal(fields[0].verify_status, 'unverifiable');
  assert.ok(fields[0].verify_detail);
});

await test('verifyStep: fill_error fields are left untouched', async () => {
  const { page, table } = mkEnv({ e1: { inputValue: 'whatever' } });
  const fields = [
    { refId: 'e1', role: 'textbox', suggested_value: 'x', verify_status: 'fill_error' },
  ];
  await verifyStep(page, table, fields);
  assert.equal(fields[0].verify_status, 'fill_error');
});

await test('verifyStep: empty suggested_value → skipped, no verify_status', async () => {
  const { page, table } = mkEnv({ e1: { inputValue: '' } });
  const fields = [{ refId: 'e1', role: 'textbox', suggested_value: '' }];
  await verifyStep(page, table, fields);
  assert.equal(fields[0].verify_status, undefined);
});

await test('verifyStep: mock page without locator → no-op (smoke guard)', async () => {
  const fields = [{ refId: 'e1', role: 'textbox', suggested_value: 'x' }];
  await verifyStep(
    {},
    {
      resolve() {
        throw new Error('resolve should never be called');
      },
    },
    fields,
  );
  assert.equal(fields[0].verify_status, undefined);
});

console.log(`\n✅ All ${passed} verify smoke tests passed.`);
