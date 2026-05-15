#!/usr/bin/env node
// Smoke for 07-applier/05-non-standard-controls m1:
// controlRouter.mjs (enums + detection + registry + sniff) +
// nonstandardFillField.mjs (production _fillField replacement + 5
// standard control strategies).
//
// Pure-Node — uses a minimal mock Page/Locator/RefTable harness that
// records calls. No Chromium, no real snapshot. ~1s.

import assert from 'node:assert/strict';

import {
  ControlType,
  Confidence,
  STRATEGY_REGISTRY,
  DETECTION_RULES,
  registerStrategy,
  registerDetectionRule,
  getStrategy,
  ariaRoleToControlType,
  sniffElement,
  detectControlType,
  isValidConfidence,
  isValidControlType,
  _resetRegistryForTesting,
} from '../src/career/applier/nonstandard/controlRouter.mjs';
import {
  nonstandardFillField,
  registerStandardStrategies,
} from '../src/career/applier/nonstandard/nonstandardFillField.mjs';

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

// ── Mock Locator / Table / Page harness ─────────────────────────────────
//
// MockLocator records every method call on `.calls` so assertions can
// verify (a) which Playwright verb fired and (b) with what arguments.
// `evaluateResult` is what locator.evaluate() returns (the sniff result).

class MockLocator {
  constructor({ evaluateResult = null, throwOn = null } = {}) {
    this.calls = [];
    this.evaluateResult = evaluateResult;
    this.throwOn = throwOn; // method name to throw on, e.g. 'fill'
  }
  async _maybeThrow(method) {
    if (this.throwOn === method) {
      throw new Error(`MockLocator: forced throw on ${method}`);
    }
  }
  async evaluate(fn) {
    this.calls.push({ method: 'evaluate' });
    await this._maybeThrow('evaluate');
    // The evaluateResult is what the page-side function returned — we
    // skip running `fn` because there's no real DOM node.
    return this.evaluateResult;
  }
  async fill(value) {
    this.calls.push({ method: 'fill', value });
    await this._maybeThrow('fill');
  }
  async click() {
    this.calls.push({ method: 'click' });
    await this._maybeThrow('click');
  }
  async check() {
    this.calls.push({ method: 'check' });
    await this._maybeThrow('check');
  }
  async uncheck() {
    this.calls.push({ method: 'uncheck' });
    await this._maybeThrow('uncheck');
  }
  async selectOption(value) {
    this.calls.push({ method: 'selectOption', value });
    await this._maybeThrow('selectOption');
  }
  async setInputFiles(value) {
    this.calls.push({ method: 'setInputFiles', value });
    await this._maybeThrow('setInputFiles');
  }
}

class MockTable {
  constructor(entries = {}) {
    // entries: { refId: { role, name, occurrenceIndex, _attrs?, _throwOnResolve?, _locatorOpts? } }
    this.entries = entries;
    this.resolvedLocators = new Map();
    this.resolveCallCount = 0;
  }
  get(refId) {
    return this.entries[refId] || undefined;
  }
  publicEntry(refId) {
    const e = this.entries[refId];
    if (!e) return null;
    return {
      refId,
      role: e.role,
      name: e.name,
      occurrenceIndex: e.occurrenceIndex ?? 0,
      frameIdx: 0,
    };
  }
  resolve(refId, _page) {
    this.resolveCallCount += 1;
    const e = this.entries[refId];
    if (!e) throw new Error(`MockTable.resolve: UNKNOWN_REF ${refId}`);
    if (e._throwOnResolve) {
      throw new Error(`MockTable.resolve: STALE_REF ${refId}`);
    }
    if (!this.resolvedLocators.has(refId)) {
      this.resolvedLocators.set(
        refId,
        new MockLocator({
          evaluateResult: e._attrs ?? null,
          throwOn: e._throwOn ?? null,
        }),
      );
    }
    return this.resolvedLocators.get(refId);
  }
}

const MOCK_PAGE = { __mock: 'page' };

// Helper: snapshot + restore registry state so tests don't leak.
function snapshotRegistry() {
  return {
    strategies: new Map(STRATEGY_REGISTRY),
    rules: DETECTION_RULES.slice(),
  };
}
function restoreRegistry(snap) {
  STRATEGY_REGISTRY.clear();
  for (const [k, v] of snap.strategies) STRATEGY_REGISTRY.set(k, v);
  DETECTION_RULES.length = 0;
  for (const r of snap.rules) DETECTION_RULES.push(r);
}

// ─── 1. Enum + validation helpers ────────────────────────────────────────

await test('ControlType has the expected closed set (5 standard + 18 non-standard + UNKNOWN)', () => {
  const values = Object.values(ControlType);
  // 5 standard + 6 date + 3 address + 4 selection variants + 5 special + 1 unknown = 24
  assert.equal(values.length, 24, 'ControlType count');
  // Verify canonical members:
  for (const v of [
    'textbox',
    'select_native',
    'checkbox',
    'radio_native',
    'file',
    'html5_date',
    'flatpickr',
    'split_mdy_select',
    'google_places',
    'algolia_places',
    'radio_div',
    'multi_select_chip',
    'custom_combobox',
    'search_select',
    'rich_text',
    'slider_range',
    'captcha',
    'shadow_dom',
    'iframe_form',
    'unknown_calendar',
    'custom_autocomplete',
    'mui_datepicker',
    'react_datepicker',
    'unknown',
  ]) {
    assert.ok(values.includes(v), `ControlType missing ${v}`);
  }
});

await test('Confidence has 4 tiers + lowercase strings', () => {
  assert.equal(Confidence.HIGH, 'high');
  assert.equal(Confidence.MEDIUM, 'medium');
  assert.equal(Confidence.LOW, 'low');
  assert.equal(Confidence.MANUAL, 'manual');
  assert.ok(isValidConfidence('high'));
  assert.ok(isValidConfidence('manual'));
  assert.ok(!isValidConfidence('HIGH'));
  assert.ok(!isValidConfidence('unknown'));
});

await test('isValidControlType guards', () => {
  assert.ok(isValidControlType('textbox'));
  assert.ok(isValidControlType('unknown'));
  assert.ok(!isValidControlType('TEXTBOX'));
  assert.ok(!isValidControlType('bogus'));
});

// ─── 2. ariaRoleToControlType (pure mapping) ─────────────────────────────

await test('ariaRoleToControlType maps standard roles', () => {
  assert.equal(ariaRoleToControlType('textbox'), ControlType.TEXTBOX);
  assert.equal(ariaRoleToControlType('combobox'), ControlType.SELECT_NATIVE);
  assert.equal(ariaRoleToControlType('checkbox'), ControlType.CHECKBOX);
  assert.equal(ariaRoleToControlType('radio'), ControlType.RADIO_NATIVE);
});

await test('ariaRoleToControlType: spinbutton + month/day/year name → SPLIT_MDY_SELECT', () => {
  assert.equal(ariaRoleToControlType('spinbutton', 'Month'), ControlType.SPLIT_MDY_SELECT);
  assert.equal(ariaRoleToControlType('spinbutton', 'Day of birth'), ControlType.SPLIT_MDY_SELECT);
  assert.equal(ariaRoleToControlType('spinbutton', 'Birth Year'), ControlType.SPLIT_MDY_SELECT);
  // Non-date spinbutton → TEXTBOX (best-effort numeric input)
  assert.equal(ariaRoleToControlType('spinbutton', 'Quantity'), ControlType.TEXTBOX);
});

await test('ariaRoleToControlType: unknown roles → UNKNOWN', () => {
  assert.equal(ariaRoleToControlType('link'), ControlType.UNKNOWN);
  assert.equal(ariaRoleToControlType('heading'), ControlType.UNKNOWN);
  assert.equal(ariaRoleToControlType(''), ControlType.UNKNOWN);
});

// ─── 3. registerStrategy validation ─────────────────────────────────────

await test('registerStrategy validates ControlType', () => {
  const snap = snapshotRegistry();
  try {
    assert.throws(
      () => registerStrategy('not-a-real-type', { fill: async () => ({}) }),
      /unknown ControlType/,
    );
    // valid type + missing fill function → throws
    assert.throws(() => registerStrategy(ControlType.TEXTBOX, {}), /must have async fill/);
    assert.throws(
      () => registerStrategy(ControlType.TEXTBOX, { fill: 'not-a-function' }),
      /must have async fill/,
    );
  } finally {
    restoreRegistry(snap);
  }
});

await test('getStrategy returns null for unregistered types', () => {
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    assert.equal(getStrategy(ControlType.TEXTBOX), null);
    assert.equal(getStrategy(ControlType.CAPTCHA), null);
  } finally {
    restoreRegistry(snap);
  }
});

await test('m1 baseline registers 5 standard strategies', () => {
  // After importing nonstandardFillField at the top of this file, the 5
  // strategies should be present (TEXTBOX, SELECT_NATIVE, CHECKBOX,
  // RADIO_NATIVE, FILE).
  assert.ok(getStrategy(ControlType.TEXTBOX), 'TEXTBOX');
  assert.ok(getStrategy(ControlType.SELECT_NATIVE), 'SELECT_NATIVE');
  assert.ok(getStrategy(ControlType.CHECKBOX), 'CHECKBOX');
  assert.ok(getStrategy(ControlType.RADIO_NATIVE), 'RADIO_NATIVE');
  assert.ok(getStrategy(ControlType.FILE), 'FILE');
  // Non-standard types are NOT registered in m1.
  assert.equal(getStrategy(ControlType.HTML5_DATE), null);
  assert.equal(getStrategy(ControlType.CAPTCHA), null);
  assert.equal(getStrategy(ControlType.RICH_TEXT), null);
});

// ─── 4. detectControlType ──────────────────────────────────────────────

await test('detectControlType: file class shortcut (no DOM I/O)', async () => {
  const table = new MockTable({
    e1: { role: 'textbox', name: 'Resume', _attrs: { tagName: 'INPUT' } },
  });
  const type = await detectControlType(MOCK_PAGE, 'e1', table, { class: 'file' });
  assert.equal(type, ControlType.FILE);
  // Cache should NOT have run sniff for this shortcut.
  assert.equal(table.resolveCallCount, 0);
});

await test('detectControlType: missing entry → UNKNOWN', async () => {
  const table = new MockTable({});
  const type = await detectControlType(MOCK_PAGE, 'eNope', table, { class: 'hard' });
  assert.equal(type, ControlType.UNKNOWN);
});

await test('detectControlType: ARIA-only baseline (no rules registered)', async () => {
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    registerStandardStrategies();
    // No DETECTION_RULES — should map textbox/combobox/checkbox via ARIA.
    const table = new MockTable({
      e1: { role: 'textbox', name: 'First Name' },
      e2: { role: 'combobox', name: 'Country' },
      e3: { role: 'checkbox', name: 'Agree' },
      e4: { role: 'radio', name: 'Yes' },
    });
    assert.equal(await detectControlType(MOCK_PAGE, 'e1', table, {}), ControlType.TEXTBOX);
    assert.equal(await detectControlType(MOCK_PAGE, 'e2', table, {}), ControlType.SELECT_NATIVE);
    assert.equal(await detectControlType(MOCK_PAGE, 'e3', table, {}), ControlType.CHECKBOX);
    assert.equal(await detectControlType(MOCK_PAGE, 'e4', table, {}), ControlType.RADIO_NATIVE);
    // No sniff should have run.
    assert.equal(table.resolveCallCount, 0);
  } finally {
    restoreRegistry(snap);
  }
});

await test('detectControlType: detection rule overrides ARIA mapping', async () => {
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    registerStandardStrategies();
    // Rule: role=textbox + className contains 'flatpickr-input' → FLATPICKR
    registerDetectionRule((entry, info) => {
      if (
        entry.role === 'textbox' &&
        info &&
        typeof info.className === 'string' &&
        info.className.includes('flatpickr-input')
      ) {
        return ControlType.FLATPICKR;
      }
      return null;
    });
    const table = new MockTable({
      e1: {
        role: 'textbox',
        name: 'Start date',
        _attrs: {
          className: 'flatpickr-input',
          dataset: {},
          tagName: 'INPUT',
          type: 'text',
          attrs: {},
        },
      },
    });
    const type = await detectControlType(MOCK_PAGE, 'e1', table, {});
    assert.equal(type, ControlType.FLATPICKR);
    // Sniff ran once.
    assert.equal(table.resolveCallCount, 1);
  } finally {
    restoreRegistry(snap);
  }
});

await test('detectControlType: result cached on table entry', async () => {
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    registerStandardStrategies();
    let ruleCalls = 0;
    registerDetectionRule((entry, info) => {
      ruleCalls += 1;
      if (entry.role === 'textbox' && info?.className?.includes('ql-editor')) {
        return ControlType.RICH_TEXT;
      }
      return null;
    });
    const table = new MockTable({
      e1: {
        role: 'textbox',
        name: 'Bio',
        _attrs: {
          className: 'ql-editor',
          dataset: {},
          tagName: 'DIV',
          type: '',
          attrs: {},
        },
      },
    });
    const t1 = await detectControlType(MOCK_PAGE, 'e1', table, {});
    const t2 = await detectControlType(MOCK_PAGE, 'e1', table, {});
    assert.equal(t1, ControlType.RICH_TEXT);
    assert.equal(t2, ControlType.RICH_TEXT);
    // Second call should hit cache — rule fires once, resolve fires once.
    assert.equal(ruleCalls, 1, 'rule called once (cached on 2nd call)');
    assert.equal(table.resolveCallCount, 1, 'resolve called once (cached on 2nd call)');
  } finally {
    restoreRegistry(snap);
  }
});

await test('detectControlType: rule throw is swallowed (does not derail)', async () => {
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    registerStandardStrategies();
    registerDetectionRule(() => {
      throw new Error('buggy rule');
    });
    // Second rule should still get a chance.
    registerDetectionRule((entry) => (entry.role === 'textbox' ? ControlType.FLATPICKR : null));
    const table = new MockTable({
      e1: {
        role: 'textbox',
        name: 'Date',
        _attrs: { className: '', dataset: {}, tagName: 'INPUT', type: 'text', attrs: {} },
      },
    });
    const type = await detectControlType(MOCK_PAGE, 'e1', table, {});
    assert.equal(type, ControlType.FLATPICKR, 'second rule wins after first throws');
  } finally {
    restoreRegistry(snap);
  }
});

// ─── 5. sniffElement ───────────────────────────────────────────────────

await test('sniffElement returns curated structure', async () => {
  const locator = new MockLocator({
    evaluateResult: {
      className: 'pac-input',
      dataset: { sitekey: 'abc' },
      tagName: 'INPUT',
      type: 'text',
      attrs: { 'aria-haspopup': 'listbox' },
    },
  });
  const info = await sniffElement(locator);
  assert.deepEqual(info.dataset, { sitekey: 'abc' });
  assert.equal(info.tagName, 'INPUT');
  assert.equal(info.className, 'pac-input');
});

await test('sniffElement: null locator → null', async () => {
  assert.equal(await sniffElement(null), null);
  assert.equal(await sniffElement({}), null); // no evaluate method
});

await test('sniffElement: evaluate throws → null', async () => {
  const locator = new MockLocator({ throwOn: 'evaluate' });
  const info = await sniffElement(locator);
  assert.equal(info, null);
});

// ─── 6. nonstandardFillField — standard control strategies ──────────────

await test('nonstandardFillField TEXTBOX: locator.fill called with stringified value', async () => {
  const table = new MockTable({ e1: { role: 'textbox', name: 'First Name' } });
  const field = { suggested_value: 'Victor', class: 'hard' };
  await nonstandardFillField(MOCK_PAGE, 'e1', field, table);
  const loc = table.resolvedLocators.get('e1');
  assert.deepEqual(loc.calls, [{ method: 'fill', value: 'Victor' }]);
  assert.equal(field.confidence, Confidence.HIGH);
  assert.ok(!field.manual_required);
  assert.ok(!field.block_approve);
});

await test('nonstandardFillField SELECT_NATIVE: locator.selectOption called', async () => {
  const table = new MockTable({ e2: { role: 'combobox', name: 'Country' } });
  const field = { suggested_value: 'United States', class: 'hard' };
  await nonstandardFillField(MOCK_PAGE, 'e2', field, table);
  const loc = table.resolvedLocators.get('e2');
  assert.deepEqual(loc.calls, [{ method: 'selectOption', value: 'United States' }]);
  assert.equal(field.confidence, Confidence.HIGH);
});

await test('nonstandardFillField CHECKBOX truthy: locator.check called', async () => {
  const table = new MockTable({ e3: { role: 'checkbox', name: 'Agree to terms' } });
  const field = { suggested_value: 'Yes', class: 'legal' };
  await nonstandardFillField(MOCK_PAGE, 'e3', field, table);
  const loc = table.resolvedLocators.get('e3');
  assert.deepEqual(loc.calls, [{ method: 'check' }]);
  assert.equal(field.confidence, Confidence.HIGH);
});

await test('nonstandardFillField CHECKBOX falsy: locator.uncheck called', async () => {
  const table = new MockTable({ e3: { role: 'checkbox', name: 'Subscribe' } });
  const field = { suggested_value: 'No', class: 'legal' };
  await nonstandardFillField(MOCK_PAGE, 'e3', field, table);
  const loc = table.resolvedLocators.get('e3');
  assert.deepEqual(loc.calls, [{ method: 'uncheck' }]);
});

await test('nonstandardFillField CHECKBOX boolean true → check', async () => {
  const table = new MockTable({ e3: { role: 'checkbox', name: 'Subscribe' } });
  const field = { suggested_value: true, class: 'legal' };
  await nonstandardFillField(MOCK_PAGE, 'e3', field, table);
  const loc = table.resolvedLocators.get('e3');
  assert.deepEqual(loc.calls, [{ method: 'check' }]);
});

await test('nonstandardFillField RADIO_NATIVE: locator.click called', async () => {
  // role=radio + INPUT → RADIO_NATIVE via ARIA-only when no rules registered.
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    registerStandardStrategies();
    const table = new MockTable({ e4: { role: 'radio', name: 'Yes' } });
    const field = { suggested_value: 'Yes', class: 'legal' };
    await nonstandardFillField(MOCK_PAGE, 'e4', field, table);
    const loc = table.resolvedLocators.get('e4');
    assert.deepEqual(loc.calls, [{ method: 'click' }]);
    assert.equal(field.confidence, Confidence.HIGH);
  } finally {
    restoreRegistry(snap);
  }
});

await test('nonstandardFillField FILE: locator.setInputFiles called', async () => {
  const table = new MockTable({ e5: { role: 'button', name: 'Upload resume' } });
  const field = { suggested_value: '/tmp/resume.pdf', class: 'file' };
  await nonstandardFillField(MOCK_PAGE, 'e5', field, table);
  const loc = table.resolvedLocators.get('e5');
  assert.deepEqual(loc.calls, [{ method: 'setInputFiles', value: '/tmp/resume.pdf' }]);
});

await test('nonstandardFillField FILE: empty value → MANUAL (no setInputFiles)', async () => {
  const table = new MockTable({ e5: { role: 'button', name: 'Upload resume' } });
  const field = { suggested_value: '', class: 'file' };
  await nonstandardFillField(MOCK_PAGE, 'e5', field, table);
  const loc = table.resolvedLocators.get('e5');
  assert.equal(loc.calls.length, 0, 'no setInputFiles called');
  assert.equal(field.manual_required, true);
  assert.equal(field.confidence, Confidence.MANUAL);
});

// ─── 7. MANUAL / LOW / error paths ──────────────────────────────────────

await test('nonstandardFillField: unregistered ControlType → MANUAL (no throw)', async () => {
  // role=spinbutton + name='Month' → SPLIT_MDY_SELECT, no strategy registered.
  const table = new MockTable({ e6: { role: 'spinbutton', name: 'Month' } });
  const field = { suggested_value: '06', class: 'hard' };
  await nonstandardFillField(MOCK_PAGE, 'e6', field, table);
  // No locator action.
  const loc = table.resolvedLocators.get('e6');
  assert.equal(loc.calls.length, 0);
  // classifiedField mutated.
  assert.equal(field.manual_required, true);
  assert.equal(field.confidence, Confidence.MANUAL);
  // suggested_value cleared, manual hint preserved.
  assert.equal(field.suggested_value, null);
  assert.equal(field.suggested_value_manual, '06');
  assert.match(field.manual_reason, /No strategy registered for split_mdy_select/);
});

await test('nonstandardFillField: LOW confidence strategy → block_approve=true', async () => {
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    registerStandardStrategies();
    // Override TEXTBOX with a LOW-confidence variant.
    registerStrategy(ControlType.TEXTBOX, {
      fill: async (_p, locator, _f, value) => {
        await locator.fill(String(value));
        return { filled: true, confidence: Confidence.LOW, manual: false, suggestedValue: null };
      },
    });
    const table = new MockTable({ e1: { role: 'textbox', name: 'Why?' } });
    const field = { suggested_value: 'because reasons', class: 'open' };
    await nonstandardFillField(MOCK_PAGE, 'e1', field, table);
    assert.equal(field.confidence, Confidence.LOW);
    assert.equal(field.block_approve, true);
    // C1 fix from review: LOW confidence MUST null suggested_value so
    // machine.mjs's recordToMemory call short-circuits — otherwise
    // applyMemoryHit (fieldMemory.mjs:101-105) promotes the value to
    // HIGH on subsequent steps, laundering LOW guesses past the
    // bulk-approve gate. The original is preserved for UI under
    // suggested_value_filled.
    assert.equal(field.suggested_value, null);
    assert.equal(field.suggested_value_filled, 'because reasons');
  } finally {
    restoreRegistry(snap);
  }
});

await test('nonstandardFillField: strategy throw is propagated', async () => {
  const table = new MockTable({
    e1: { role: 'textbox', name: 'X', _throwOn: 'fill' },
  });
  const field = { suggested_value: 'bad', class: 'hard' };
  await assert.rejects(
    () => nonstandardFillField(MOCK_PAGE, 'e1', field, table),
    /forced throw on fill/,
  );
  // classifiedField NOT mutated to manual on real throws — machine.mjs
  // catch path sets fill_error.
  assert.ok(!field.manual_required);
});

await test('nonstandardFillField: table.resolve throw is propagated', async () => {
  const table = new MockTable({
    e1: { role: 'textbox', name: 'X', _throwOnResolve: true },
  });
  const field = { suggested_value: 'foo', class: 'hard' };
  await assert.rejects(
    () => nonstandardFillField(MOCK_PAGE, 'e1', field, table),
    /STALE_REF/,
  );
});

await test('nonstandardFillField: malformed strategy result → MANUAL', async () => {
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    registerStandardStrategies();
    registerStrategy(ControlType.TEXTBOX, {
      fill: async () => null, // not an object
    });
    const table = new MockTable({ e1: { role: 'textbox', name: 'X' } });
    const field = { suggested_value: 'foo', class: 'hard' };
    await nonstandardFillField(MOCK_PAGE, 'e1', field, table);
    assert.equal(field.manual_required, true);
    assert.match(field.manual_reason, /malformed result/);
  } finally {
    restoreRegistry(snap);
  }
});

await test('nonstandardFillField: strategy returns MANUAL explicitly', async () => {
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    registerStandardStrategies();
    registerStrategy(ControlType.TEXTBOX, {
      fill: async () => ({
        filled: false,
        confidence: Confidence.MANUAL,
        manual: true,
        suggestedValue: 'fallback',
        error: 'sentinel manual',
      }),
    });
    const table = new MockTable({ e1: { role: 'textbox', name: 'X' } });
    const field = { suggested_value: 'original', class: 'hard' };
    await nonstandardFillField(MOCK_PAGE, 'e1', field, table);
    assert.equal(field.manual_required, true);
    assert.equal(field.confidence, Confidence.MANUAL);
    assert.equal(field.suggested_value, null);
    assert.equal(field.suggested_value_manual, 'original');
    assert.match(field.manual_reason, /sentinel manual/);
  } finally {
    restoreRegistry(snap);
  }
});

// ─── 8. table.resolve called ONCE per field (OQ1 raw locator bypass) ────

await test('nonstandardFillField: table.resolve called exactly once per fill', async () => {
  const table = new MockTable({ e1: { role: 'textbox', name: 'X' } });
  const field = { suggested_value: 'hello', class: 'hard' };
  await nonstandardFillField(MOCK_PAGE, 'e1', field, table);
  assert.equal(table.resolveCallCount, 1, 'resolve called once');
});

// ─── 9. Review-driven regression tests (CRITICAL + HIGH fixes) ──────────

await test('H4 spinbutton regex tight: "Years of experience" → TEXTBOX (not SPLIT_MDY_SELECT)', () => {
  assert.equal(
    ariaRoleToControlType('spinbutton', 'Years of experience'),
    ControlType.TEXTBOX,
    'compound noun does not falsely route to SPLIT_MDY_SELECT',
  );
  assert.equal(
    ariaRoleToControlType('spinbutton', 'Month-to-month basis'),
    ControlType.TEXTBOX,
  );
  // But date-context tokens still route correctly:
  assert.equal(
    ariaRoleToControlType('spinbutton', 'Birth Month'),
    ControlType.SPLIT_MDY_SELECT,
  );
  assert.equal(
    ariaRoleToControlType('spinbutton', 'DOB Year'),
    ControlType.SPLIT_MDY_SELECT,
  );
  // Bare segment label also routes:
  assert.equal(ariaRoleToControlType('spinbutton', 'mm'), ControlType.SPLIT_MDY_SELECT);
});

await test('H3 fillRadioNative: suggested_value mismatch → MANUAL (no click)', async () => {
  const table = new MockTable({ e4: { role: 'radio', name: 'Yes' } });
  // classifier output points to refId for "Yes" but suggested_value says "No"
  const field = { suggested_value: 'No', label: 'Yes', class: 'legal' };
  await nonstandardFillField(MOCK_PAGE, 'e4', field, table);
  const loc = table.resolvedLocators.get('e4');
  assert.equal(loc.calls.length, 0, 'no click when mismatch');
  assert.equal(field.manual_required, true);
  assert.match(field.manual_reason, /does not match option label/);
});

await test('H4 fillCheckbox: ambiguous "maybe" → MANUAL (no check/uncheck)', async () => {
  const table = new MockTable({ e3: { role: 'checkbox', name: 'Authorized to work' } });
  const field = { suggested_value: 'maybe', class: 'legal' };
  await nonstandardFillField(MOCK_PAGE, 'e3', field, table);
  const loc = table.resolvedLocators.get('e3');
  assert.equal(loc.calls.length, 0, 'no action on ambiguous value');
  assert.equal(field.manual_required, true);
  assert.match(field.manual_reason, /ambiguous value/);
});

await test('H4 fillCheckbox: NaN → MANUAL (not silently truthy)', async () => {
  const table = new MockTable({ e3: { role: 'checkbox', name: 'X' } });
  const field = { suggested_value: NaN, class: 'legal' };
  await nonstandardFillField(MOCK_PAGE, 'e3', field, table);
  const loc = table.resolvedLocators.get('e3');
  assert.equal(loc.calls.length, 0);
  assert.equal(field.manual_required, true);
});

await test('H1 filled:false + non-MANUAL confidence → MANUAL', async () => {
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    registerStandardStrategies();
    registerStrategy(ControlType.TEXTBOX, {
      // Buggy strategy claims HIGH confidence but didn't actually fill.
      fill: async () => ({
        filled: false,
        confidence: Confidence.HIGH,
        manual: false,
        suggestedValue: null,
      }),
    });
    const table = new MockTable({ e1: { role: 'textbox', name: 'X' } });
    const field = { suggested_value: 'foo', class: 'hard' };
    await nonstandardFillField(MOCK_PAGE, 'e1', field, table);
    assert.equal(field.manual_required, true);
    assert.match(field.manual_reason, /filled:false without MANUAL/);
  } finally {
    restoreRegistry(snap);
  }
});

await test('M2 unknown confidence → MANUAL (not silent MEDIUM)', async () => {
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    registerStandardStrategies();
    registerStrategy(ControlType.TEXTBOX, {
      fill: async (_p, locator, _f, value) => {
        await locator.fill(String(value));
        return { filled: true, confidence: 'HIGH', manual: false, suggestedValue: null };
      },
    });
    const table = new MockTable({ e1: { role: 'textbox', name: 'X' } });
    const field = { suggested_value: 'foo', class: 'hard' };
    await nonstandardFillField(MOCK_PAGE, 'e1', field, table);
    // The strategy DID fill DOM (locator.fill called), but reported an
    // uppercase 'HIGH' which doesn't match the canonical enum. We refuse
    // to claim success at an unknown confidence tier.
    assert.equal(field.manual_required, true);
    assert.match(field.manual_reason, /unknown confidence/);
  } finally {
    restoreRegistry(snap);
  }
});

await test('C1 detectControlType cache uses router WeakMap (no entry mutation)', async () => {
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    registerStandardStrategies();
    const entry = { role: 'textbox', name: 'X' };
    const table = new MockTable({ e1: entry });
    await detectControlType(MOCK_PAGE, 'e1', table, {});
    // Old design wrote entry._controlTypeHint — verify we no longer mutate.
    assert.equal(
      entry._controlTypeHint,
      undefined,
      'router must NOT mutate RefTable entry (use WeakMap instead)',
    );
  } finally {
    restoreRegistry(snap);
  }
});

await test('H5 detectControlType: STALE_REF from table.resolve propagates (not silently swallowed)', async () => {
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    registerStandardStrategies();
    // A registered rule forces the sniff path (resolve) to run.
    registerDetectionRule(() => null);
    const table = new MockTable({
      e1: { role: 'textbox', name: 'X', _throwOnResolve: true },
    });
    await assert.rejects(
      () => detectControlType(MOCK_PAGE, 'e1', table, { class: 'hard' }),
      /STALE_REF/,
    );
  } finally {
    restoreRegistry(snap);
  }
});

await test('H3 fillRadioNative: matching label → click (case/whitespace tolerant)', async () => {
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    registerStandardStrategies();
    const table = new MockTable({ e4: { role: 'radio', name: 'Yes' } });
    const field = { suggested_value: '  yes  ', label: 'Yes', class: 'legal' };
    await nonstandardFillField(MOCK_PAGE, 'e4', field, table);
    const loc = table.resolvedLocators.get('e4');
    assert.deepEqual(loc.calls, [{ method: 'click' }]);
    assert.equal(field.confidence, Confidence.HIGH);
    assert.ok(!field.manual_required);
  } finally {
    restoreRegistry(snap);
  }
});

// ─── Summary ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
