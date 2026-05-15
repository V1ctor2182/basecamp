#!/usr/bin/env node
// Smoke for 07-applier/05-non-standard-controls m3:
// selectionControls.mjs (radio_div + multi_select_chip + custom_combobox + search_select).

import assert from 'node:assert/strict';

import {
  ControlType,
  Confidence,
  STRATEGY_REGISTRY,
  DETECTION_RULES,
  detectControlType,
  _resetRegistryForTesting,
} from '../src/career/applier/nonstandard/controlRouter.mjs';
import { registerStandardStrategies, nonstandardFillField } from '../src/career/applier/nonstandard/nonstandardFillField.mjs';
import {
  registerSelectionStrategies,
  _testing as selTesting,
} from '../src/career/applier/nonstandard/strategies/selectionControls.mjs';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    failed++;
  }
}

// ── Mock harness ─────────────────────────────────────────────────────

class MockLocator {
  constructor(opts = {}) {
    this.calls = [];
    this.throwOn = opts.throwOn ?? null;
    this.throwOnClickTimeout = opts.throwOnClickTimeout ?? false;
    this.waitForOutcome = opts.waitForOutcome ?? 'success';
    this.evaluateResult = opts.evaluateResult ?? null;
  }
  async _maybeThrow(method) {
    if (this.throwOn === method) throw new Error(`MockLocator: forced throw on ${method}`);
  }
  async evaluate(_fn, arg) { this.calls.push({ method: 'evaluate', arg }); await this._maybeThrow('evaluate'); return this.evaluateResult; }
  async fill(value) { this.calls.push({ method: 'fill', value }); await this._maybeThrow('fill'); }
  async click(opts) {
    this.calls.push({ method: 'click', opts });
    await this._maybeThrow('click');
    if (this.throwOnClickTimeout) throw new Error('Timeout 2000ms exceeded');
  }
  async focus() { this.calls.push({ method: 'focus' }); await this._maybeThrow('focus'); }
  async press(key) { this.calls.push({ method: 'press', key }); await this._maybeThrow('press'); }
  first() { return this; }
  async waitFor(_opts) {
    this.calls.push({ method: 'waitFor' });
    if (this.waitForOutcome === 'timeout') throw new Error('Timeout 2000ms exceeded');
  }
}

class MockPage {
  constructor() {
    this.keyboard = { typed: [], type: async (s) => this.keyboard.typed.push(s) };
    this._optionLocators = new Map();
    this._optionCount = 1;
    this._optionText = '';
  }
  getByRole(role, opts) {
    const name = opts?.name ?? '__any__';
    const exact = opts?.exact ? '!exact' : '';
    const key = `${role}:${name}${exact}`;
    if (!this._optionLocators.has(key)) {
      const loc = new MockLocator();
      // Add count() and textContent() methods used by search_select
      const text = this._optionText;
      const count = this._optionCount;
      loc.count = async () => count;
      loc.textContent = async () => text;
      this._optionLocators.set(key, loc);
    }
    return this._optionLocators.get(key);
  }
}

class MockTable {
  constructor(entries = {}) {
    this.entries = entries;
    this.resolvedLocators = new Map();
  }
  get(refId) { return this.entries[refId]; }
  publicEntry(refId) {
    const e = this.entries[refId];
    if (!e) return null;
    return { refId, role: e.role, name: e.name, occurrenceIndex: 0, frameIdx: 0 };
  }
  resolve(refId, _page) {
    const e = this.entries[refId];
    if (!e) throw new Error('UNKNOWN_REF');
    if (!this.resolvedLocators.has(refId)) {
      this.resolvedLocators.set(refId, e._locator || new MockLocator({ evaluateResult: e._attrs }));
    }
    return this.resolvedLocators.get(refId);
  }
}

function snapshotRegistry() {
  return { strategies: new Map(STRATEGY_REGISTRY), rules: DETECTION_RULES.slice() };
}
function restoreRegistry(snap) {
  STRATEGY_REGISTRY.clear();
  for (const [k, v] of snap.strategies) STRATEGY_REGISTRY.set(k, v);
  DETECTION_RULES.length = 0;
  for (const r of snap.rules) DETECTION_RULES.push(r);
}

// ─── 1. parseMultiValue ──────────────────────────────────────────────

await test('parseMultiValue: array passthrough', () => {
  assert.deepEqual(selTesting.parseMultiValue(['Java', 'JS']), ['Java', 'JS']);
  assert.deepEqual(selTesting.parseMultiValue(['Java', '', null, 'JS']), ['Java', 'JS']);
});

await test('parseMultiValue: pipe-separated', () => {
  assert.deepEqual(selTesting.parseMultiValue('Java|JS|Go'), ['Java', 'JS', 'Go']);
  assert.deepEqual(selTesting.parseMultiValue('Java | JS | Go'), ['Java', 'JS', 'Go']);
});

await test('parseMultiValue: comma-separated (only if no pipe)', () => {
  assert.deepEqual(selTesting.parseMultiValue('Java, JS, Go'), ['Java', 'JS', 'Go']);
  // Pipe takes precedence over comma.
  assert.deepEqual(selTesting.parseMultiValue('Java, JS|Go'), ['Java, JS', 'Go']);
});

await test('parseMultiValue: single string → 1-element array', () => {
  assert.deepEqual(selTesting.parseMultiValue('Backend Engineer'), ['Backend Engineer']);
});

await test('parseMultiValue: empty / null → []', () => {
  assert.deepEqual(selTesting.parseMultiValue(null), []);
  assert.deepEqual(selTesting.parseMultiValue(''), []);
  assert.deepEqual(selTesting.parseMultiValue('  '), []);
  assert.deepEqual(selTesting.parseMultiValue([]), []);
});

// ─── 2. radio_div ────────────────────────────────────────────────────

await test('radio_div: matching label → click + HIGH', async () => {
  const loc = new MockLocator();
  const r = await selTesting.fillRadioDiv(null, loc, { label: 'Yes' }, 'Yes');
  assert.equal(r.confidence, Confidence.HIGH);
  assert.deepEqual(loc.calls.map((c) => c.method), ['click']);
});

await test('radio_div: mismatched label → MANUAL (no click)', async () => {
  const loc = new MockLocator();
  const r = await selTesting.fillRadioDiv(null, loc, { label: 'Yes', suggested_value: 'No' }, 'No');
  assert.equal(r.confidence, Confidence.MANUAL);
  assert.equal(loc.calls.length, 0);
  assert.match(r.error, /does not match option label/);
});

await test('radio_div: locator throw → MANUAL', async () => {
  const loc = new MockLocator({ throwOn: 'click' });
  const r = await selTesting.fillRadioDiv(null, loc, { label: 'Yes' }, 'Yes');
  assert.equal(r.confidence, Confidence.MANUAL);
});

// ─── 3. multi_select_chip ────────────────────────────────────────────

await test('multi_select_chip: empty values → MANUAL', async () => {
  const page = new MockPage();
  const loc = new MockLocator();
  const r = await selTesting.fillMultiSelectChip(page, loc, null, '');
  assert.equal(r.confidence, Confidence.MANUAL);
  assert.equal(loc.calls.length, 0);
});

await test('multi_select_chip: 3 values → 1 click + clear/fill pairs + waitFor + option clicks', async () => {
  const page = new MockPage();
  const loc = new MockLocator();
  const r = await selTesting.fillMultiSelectChip(page, loc, null, 'Java|JS|Go');
  assert.equal(r.confidence, Confidence.MEDIUM);
  // Review fix CRITICAL C1: explicit fill('') + fill(v) per iteration.
  // Sequence per value: fill('') + fill(v).
  const fillCalls = loc.calls.filter((c) => c.method === 'fill').map((c) => c.value);
  assert.deepEqual(fillCalls, ['', 'Java', '', 'JS', '', 'Go']);
  // Final press('Escape') is locator-scoped
  assert.equal(loc.calls.at(-1).method, 'press');
  assert.equal(loc.calls.at(-1).key, 'Escape');
  // Review fix CRITICAL #1: getByRole called with exact:true.
  for (const v of ['Java', 'JS', 'Go']) {
    const opt = page.getByRole('option', { name: v, exact: true });
    assert.ok(opt.calls.some((c) => c.method === 'waitFor'), `option ${v} waitFor'd`);
    assert.ok(opt.calls.some((c) => c.method === 'click'), `option ${v} clicked`);
  }
});

await test('multi_select_chip: option waitFor timeout → MANUAL', async () => {
  const page = new MockPage();
  const loc = new MockLocator();
  const opt = page.getByRole('option', { name: 'Java', exact: true });
  opt.waitForOutcome = 'timeout';
  const r = await selTesting.fillMultiSelectChip(page, loc, null, 'Java');
  assert.equal(r.confidence, Confidence.MANUAL);
  assert.match(r.error, /multi_select_chip/);
});

// ─── 4. custom_combobox ──────────────────────────────────────────────

await test('custom_combobox: direct exact option match → MEDIUM', async () => {
  const page = new MockPage();
  const loc = new MockLocator();
  const r = await selTesting.fillCustomCombobox(page, loc, null, 'Engineering');
  assert.equal(r.confidence, Confidence.MEDIUM);
  // Review fix CRITICAL #1: exact:true. Key includes !exact suffix.
  const opt = page.getByRole('option', { name: 'Engineering', exact: true });
  assert.ok(opt.calls.some((c) => c.method === 'click'));
});

await test('custom_combobox: option timeout + listbox visible → arrow+Enter fallback → LOW', async () => {
  const page = new MockPage();
  const loc = new MockLocator();
  // Arm the exact-name option click to timeout
  const opt = page.getByRole('option', { name: 'Engineering', exact: true });
  opt.throwOnClickTimeout = true;
  // Listbox visible (review fix H2: arrow fallback only if listbox is open)
  const listbox = page.getByRole('listbox');
  listbox.waitForOutcome = 'success';
  const r = await selTesting.fillCustomCombobox(page, loc, null, 'Engineering');
  assert.equal(r.confidence, Confidence.LOW);
  const presses = loc.calls.filter((c) => c.method === 'press').map((c) => c.key);
  assert.deepEqual(presses, ['ArrowDown', 'Enter']);
});

await test('custom_combobox: option timeout + NO listbox → MANUAL (no blind keyboard submit)', async () => {
  const page = new MockPage();
  const loc = new MockLocator();
  const opt = page.getByRole('option', { name: 'Engineering', exact: true });
  opt.throwOnClickTimeout = true;
  const listbox = page.getByRole('listbox');
  listbox.waitForOutcome = 'timeout';
  const r = await selTesting.fillCustomCombobox(page, loc, null, 'Engineering');
  // Review fix H2: refuse arrow+Enter when no listbox — Enter could submit
  // the form on Workday/Greenhouse if focus is on the wrong element.
  assert.equal(r.confidence, Confidence.MANUAL);
  const presses = loc.calls.filter((c) => c.method === 'press');
  assert.equal(presses.length, 0, 'no key presses sent');
});

await test('custom_combobox: empty value → MANUAL', async () => {
  const r = await selTesting.fillCustomCombobox(new MockPage(), new MockLocator(), null, '');
  assert.equal(r.confidence, Confidence.MANUAL);
});

// ─── 5. search_select ────────────────────────────────────────────────

await test('search_select: exact name match → click + MEDIUM', async () => {
  const page = new MockPage();
  const loc = new MockLocator();
  // Pre-arm exact-name option (review fix CRITICAL #2)
  const exact = page.getByRole('option', { name: 'New York', exact: true });
  exact.waitForOutcome = 'success';
  const r = await selTesting.fillSearchSelect(page, loc, null, 'New York');
  assert.equal(r.confidence, Confidence.MEDIUM);
  assert.equal(loc.calls[0].value, 'New York');
});

await test('search_select: no exact match + 1 visible option matching prefix → MEDIUM', async () => {
  const page = new MockPage();
  page._optionCount = 1;
  page._optionText = 'Mountain View, CA';
  const loc = new MockLocator();
  // Exact match times out
  const exact = page.getByRole('option', { name: 'Mountain View', exact: true });
  exact.waitForOutcome = 'timeout';
  const r = await selTesting.fillSearchSelect(page, loc, null, 'Mountain View');
  assert.equal(r.confidence, Confidence.MEDIUM);
});

await test('search_select: no exact match + 2 ambiguous options → LOW (no auto-click)', async () => {
  const page = new MockPage();
  page._optionCount = 2;
  const loc = new MockLocator();
  const exact = page.getByRole('option', { name: 'Mountain', exact: true });
  exact.waitForOutcome = 'timeout';
  const r = await selTesting.fillSearchSelect(page, loc, null, 'Mountain');
  // Review fix CRITICAL #2: ambiguous match → LOW so user verifies
  assert.equal(r.confidence, Confidence.LOW);
  assert.match(r.error, /no unambiguous match/);
});

await test('search_select: 0 options visible → LOW partial fill', async () => {
  const page = new MockPage();
  page._optionCount = 0;
  const loc = new MockLocator();
  const exact = page.getByRole('option', { name: 'Nowhere', exact: true });
  exact.waitForOutcome = 'timeout';
  const r = await selTesting.fillSearchSelect(page, loc, null, 'Nowhere');
  assert.equal(r.confidence, Confidence.LOW);
});

await test('search_select: empty value → MANUAL', async () => {
  const r = await selTesting.fillSearchSelect(new MockPage(), new MockLocator(), null, '');
  assert.equal(r.confidence, Confidence.MANUAL);
});

// ─── 6. Detection rule ───────────────────────────────────────────────

await test('selectionDetectionRule: role=radio + DIV → RADIO_DIV', () => {
  const r = selTesting.selectionDetectionRule(
    { role: 'radio', name: 'Yes' },
    { className: '', tagName: 'DIV', type: '', attrs: {}, dataset: {} },
    {},
  );
  assert.equal(r, ControlType.RADIO_DIV);
});

await test('selectionDetectionRule: role=radio + INPUT → null (defer to m1)', () => {
  const r = selTesting.selectionDetectionRule(
    { role: 'radio', name: 'Yes' },
    { className: '', tagName: 'INPUT', type: 'radio', attrs: {}, dataset: {} },
    {},
  );
  assert.equal(r, null);
});

await test('selectionDetectionRule: aria-multiselectable=true → MULTI_SELECT_CHIP', () => {
  const r = selTesting.selectionDetectionRule(
    { role: 'combobox', name: 'Skills' },
    { className: '', tagName: 'DIV', type: '', attrs: { 'aria-multiselectable': 'true' }, dataset: {} },
    {},
  );
  assert.equal(r, ControlType.MULTI_SELECT_CHIP);
});

await test('selectionDetectionRule: exact "chip" token → MULTI_SELECT_CHIP (CUSTOM_COMBOBOX fallback never reached)', () => {
  // The rule now requires EXACT 'chip' token (not 'chip-foo'). Hardened
  // per review HIGH: previously `chip-icon` false-positived single-select.
  const r = selTesting.selectionDetectionRule(
    { role: 'combobox', name: 'Skills' },
    { className: 'css-1234 chip', tagName: 'DIV', type: '', attrs: {}, dataset: {} },
    {},
  );
  assert.equal(r, ControlType.MULTI_SELECT_CHIP);
});

await test('selectionDetectionRule (review fix HIGH): chip-icon does NOT route to MULTI_SELECT_CHIP', () => {
  // A single-select combobox with a chip-style icon class — would
  // previously mis-route to MULTI_SELECT_CHIP. Now it falls through
  // to CUSTOM_COMBOBOX (new C2 fallback).
  const r = selTesting.selectionDetectionRule(
    { role: 'combobox', name: 'Department' },
    { className: 'mui-select chip-icon', tagName: 'DIV', type: '', attrs: {}, dataset: {} },
    {},
  );
  assert.equal(r, ControlType.CUSTOM_COMBOBOX);
});

await test('selectionDetectionRule: aria-autocomplete=list → SEARCH_SELECT', () => {
  const r = selTesting.selectionDetectionRule(
    { role: 'combobox', name: 'City' },
    { className: '', tagName: 'INPUT', type: 'text', attrs: { 'aria-autocomplete': 'list' }, dataset: {} },
    {},
  );
  assert.equal(r, ControlType.SEARCH_SELECT);
});

await test('selectionDetectionRule: aria-haspopup=listbox + DIV → CUSTOM_COMBOBOX', () => {
  const r = selTesting.selectionDetectionRule(
    { role: 'combobox', name: 'Department' },
    { className: '', tagName: 'DIV', type: '', attrs: { 'aria-haspopup': 'listbox' }, dataset: {} },
    {},
  );
  assert.equal(r, ControlType.CUSTOM_COMBOBOX);
});

await test('selectionDetectionRule: aria-haspopup=listbox + SELECT → null (native, m1 handles)', () => {
  const r = selTesting.selectionDetectionRule(
    { role: 'combobox', name: 'Country' },
    { className: '', tagName: 'SELECT', type: '', attrs: { 'aria-haspopup': 'listbox' }, dataset: {} },
    {},
  );
  assert.equal(r, null);
});

// ─── 7. End-to-end ───────────────────────────────────────────────────

await test('e2e: detectControlType + nonstandardFillField → CUSTOM_COMBOBOX → MEDIUM', async () => {
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    registerStandardStrategies();
    registerSelectionStrategies();
    const entry = {
      role: 'combobox',
      name: 'Department',
      _attrs: {
        className: 'custom-select',
        tagName: 'DIV',
        type: '',
        attrs: { 'aria-haspopup': 'listbox' },
        dataset: {},
      },
    };
    const table = new MockTable({ e1: entry });
    const page = new MockPage();
    const field = { suggested_value: 'Engineering', class: 'hard', label: 'Department' };
    await nonstandardFillField(page, 'e1', field, table);
    assert.equal(field.confidence, Confidence.MEDIUM);
    assert.ok(!field.manual_required);
  } finally {
    restoreRegistry(snap);
  }
});

await test('e2e: SEARCH_SELECT ambiguous → LOW → block_approve + suggested_value nulled', async () => {
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    registerStandardStrategies();
    registerSelectionStrategies();
    const entry = {
      role: 'combobox',
      name: 'City',
      _attrs: {
        className: 'search-input',
        tagName: 'INPUT',
        type: 'text',
        attrs: { 'aria-autocomplete': 'list' },
        dataset: {},
      },
    };
    const table = new MockTable({ e1: entry });
    const page = new MockPage();
    page._optionCount = 3; // multiple ambiguous matches
    // Exact-name match times out
    const exact = page.getByRole('option', { name: 'Mountain', exact: true });
    exact.waitForOutcome = 'timeout';
    const field = { suggested_value: 'Mountain', class: 'hard', label: 'City' };
    await nonstandardFillField(page, 'e1', field, table);
    // LOW propagates to block_approve (m1 contract) and suggested_value is nulled
    // (C1 m1 fix: prevents memory laundering).
    assert.equal(field.confidence, Confidence.LOW);
    assert.equal(field.block_approve, true);
    assert.equal(field.suggested_value, null);
    assert.equal(field.suggested_value_filled, 'Mountain');
  } finally {
    restoreRegistry(snap);
  }
});

// ─── 8. Review-driven regression tests ────────────────────────────────

await test('REVIEW: parseMultiValue dedupes case-insensitively', () => {
  assert.deepEqual(selTesting.parseMultiValue('Java|Java|JS'), ['Java', 'JS']);
  assert.deepEqual(selTesting.parseMultiValue('java|JAVA|Java'), ['java']);
  assert.deepEqual(selTesting.parseMultiValue(['Java', 'java', 'JS']), ['Java', 'JS']);
});

await test('REVIEW: parseMultiValue rejects punctuation-only tokens', () => {
  assert.deepEqual(selTesting.parseMultiValue(',|,'), []);
  assert.deepEqual(selTesting.parseMultiValue('|'), []);
  assert.deepEqual(selTesting.parseMultiValue('a||b'), ['a', 'b']);
});

await test('REVIEW C2: plain non-native combobox falls through to CUSTOM_COMBOBOX', () => {
  // Bare role=combobox on a DIV with NO aria-haspopup, NO aria-autocomplete,
  // NO aria-multiselectable, NO chip class. Old code: returned null →
  // m1 ARIA mapping → SELECT_NATIVE → selectOption throws on non-<select>.
  // New code: fallthrough CUSTOM_COMBOBOX → click-to-expand (safer).
  const r = selTesting.selectionDetectionRule(
    { role: 'combobox', name: 'Department' },
    { className: 'plain-styled', tagName: 'DIV', type: '', attrs: {}, dataset: {} },
    {},
  );
  assert.equal(r, ControlType.CUSTOM_COMBOBOX);
});

await test('REVIEW C2: native <select> still returns null (m1 handles)', () => {
  const r = selTesting.selectionDetectionRule(
    { role: 'combobox', name: 'Country' },
    { className: '', tagName: 'SELECT', type: '', attrs: {}, dataset: {} },
    {},
  );
  assert.equal(r, null);
});

// ─── Summary ─────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
