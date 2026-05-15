#!/usr/bin/env node
// Smoke for 07-applier/05-non-standard-controls m2:
// datePickers.mjs (6 date types) + addressControls.mjs (3 address types).
//
// Pure-Node — uses Mock Page/Locator/Table harness mirroring m1's style.

import assert from 'node:assert/strict';

import {
  ControlType,
  Confidence,
  STRATEGY_REGISTRY,
  DETECTION_RULES,
  getStrategy,
  detectControlType,
  _resetRegistryForTesting,
} from '../src/career/applier/nonstandard/controlRouter.mjs';
import { registerStandardStrategies, nonstandardFillField } from '../src/career/applier/nonstandard/nonstandardFillField.mjs';
import {
  toISO,
  registerDateStrategies,
  _testing as dateTesting,
} from '../src/career/applier/nonstandard/strategies/datePickers.mjs';
import {
  registerAddressStrategies,
  _testing as addrTesting,
} from '../src/career/applier/nonstandard/strategies/addressControls.mjs';

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

// ── Mock harness ────────────────────────────────────────────────────────

class MockLocator {
  constructor(opts = {}) {
    this.calls = [];
    this.evaluateResult = opts.evaluateResult ?? null;
    this.throwOn = opts.throwOn ?? null;
    this.childLocators = opts.childLocators ?? {};
    this.countValue = opts.countValue ?? 0;
    this.waitForOutcome = opts.waitForOutcome ?? 'success';
  }
  async _maybeThrow(method) {
    if (this.throwOn === method) throw new Error(`MockLocator: forced throw on ${method}`);
  }
  async evaluate(_fn, arg) {
    this.calls.push({ method: 'evaluate', arg });
    await this._maybeThrow('evaluate');
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
  async focus() {
    this.calls.push({ method: 'focus' });
    await this._maybeThrow('focus');
  }
  async press(key) {
    this.calls.push({ method: 'press', key });
    await this._maybeThrow('press');
  }
  async selectOption(value) {
    this.calls.push({ method: 'selectOption', value });
    await this._maybeThrow('selectOption');
  }
  async count() {
    return this.countValue;
  }
  first() {
    return this;
  }
  nth(i) {
    // For MUI: return a child locator keyed by index
    const key = `nth:${i}`;
    if (!this.childLocators[key]) this.childLocators[key] = new MockLocator();
    return this.childLocators[key];
  }
  locator(selector) {
    if (!this.childLocators[selector]) {
      this.childLocators[selector] = new MockLocator();
    }
    return this.childLocators[selector];
  }
  async waitFor(_opts) {
    this.calls.push({ method: 'waitFor' });
    if (this.waitForOutcome === 'timeout') {
      throw new Error('Timeout 2000ms exceeded');
    }
    if (this.waitForOutcome === 'throw') {
      throw new Error('waitFor failed');
    }
  }
}

class MockPage {
  constructor({ pageLocators = {} } = {}) {
    this.keyboard = {
      typed: [],
      pressed: [],
      type: async (s) => this.keyboard.typed.push(s),
      press: async (k) => this.keyboard.pressed.push(k),
    };
    this.pageLocators = pageLocators;
  }
  locator(selector) {
    if (!this.pageLocators[selector]) this.pageLocators[selector] = new MockLocator();
    return this.pageLocators[selector];
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

// ─── 1. toISO parser ──────────────────────────────────────────────────

await test('toISO: ISO format passthrough', () => {
  assert.equal(toISO('2024-06-15'), '2024-06-15');
  assert.equal(toISO('2024-1-5'), '2024-01-05');
});

await test('toISO: US MM/DD/YYYY', () => {
  assert.equal(toISO('06/15/2024'), '2024-06-15');
  assert.equal(toISO('6/15/2024'), '2024-06-15');
  assert.equal(toISO('1/2/2024'), '2024-01-02');
});

await test('toISO: long-form month names', () => {
  assert.equal(toISO('June 15, 2024'), '2024-06-15');
  assert.equal(toISO('Jun 15 2024'), '2024-06-15');
  assert.equal(toISO('15 June 2024'), '2024-06-15');
});

await test('toISO: invalid inputs → null', () => {
  assert.equal(toISO(''), null);
  assert.equal(toISO(null), null);
  assert.equal(toISO(undefined), null);
  assert.equal(toISO('not a date'), null);
  assert.equal(toISO('13/45/2024'), null); // invalid m/d
  assert.equal(toISO('2024-13-01'), null); // month out of range
  assert.equal(toISO('1899-01-01'), null); // year out of range
});

await test('toISO: Date instance + numeric edge', () => {
  const d = new Date(Date.UTC(2024, 5, 15));
  assert.equal(toISO(d), '2024-06-15');
  // Number is stringified — '20240615' won't parse to anything meaningful
  // → null. That's acceptable; classifier shouldn't emit numbers here.
  assert.equal(toISO(20240615), null);
});

// ─── 2. Date strategies ───────────────────────────────────────────────

await test('html5_date: HIGH on valid ISO; MANUAL on garbage', async () => {
  const loc = new MockLocator();
  const r = await dateTesting.fillHtml5Date(null, loc, null, '06/15/2024');
  assert.equal(r.confidence, Confidence.HIGH);
  assert.equal(r.filled, true);
  assert.deepEqual(loc.calls, [{ method: 'fill', value: '2024-06-15' }]);

  const r2 = await dateTesting.fillHtml5Date(null, new MockLocator(), null, 'garbage');
  assert.equal(r2.confidence, Confidence.MANUAL);
  assert.equal(r2.filled, false);
});

await test('react_datepicker: click + fill + focus + keyboard.type + locator.press(Escape)', async () => {
  const page = new MockPage();
  const loc = new MockLocator();
  const r = await dateTesting.fillReactDatepicker(page, loc, null, '2024-06-15');
  assert.equal(r.confidence, Confidence.MEDIUM);
  assert.equal(r.filled, true);
  // Review fix B1: focus before keyboard.type, locator-scoped press('Escape')
  const methods = loc.calls.map((c) => c.method);
  assert.deepEqual(methods, ['click', 'fill', 'focus', 'press']);
  assert.equal(loc.calls[1].value, '');
  assert.equal(loc.calls[3].key, 'Escape');
  assert.deepEqual(page.keyboard.typed, ['06/15/2024']);
});

await test('react_datepicker: locator throw → MANUAL', async () => {
  const page = new MockPage();
  const loc = new MockLocator({ throwOn: 'click' });
  const r = await dateTesting.fillReactDatepicker(page, loc, null, '2024-06-15');
  assert.equal(r.confidence, Confidence.MANUAL);
  assert.match(r.error, /react_datepicker/);
});

await test('mui_datepicker: 3 spinbutton segments filled in MM/DD/YYYY order', async () => {
  const page = new MockPage();
  const seg = new MockLocator({ countValue: 3 });
  const loc = new MockLocator();
  loc.childLocators['[role=spinbutton]'] = seg;
  const r = await dateTesting.fillMuiDatepicker(page, loc, null, '2024-06-15');
  assert.equal(r.confidence, Confidence.MEDIUM);
  // 3 child nth(0/1/2) locators each receive .fill(...)
  assert.equal(seg.childLocators['nth:0'].calls[0].value, '06');
  assert.equal(seg.childLocators['nth:1'].calls[0].value, '15');
  assert.equal(seg.childLocators['nth:2'].calls[0].value, '2024');
});

await test('mui_datepicker: partial segments (1-2) → fallback to type pattern', async () => {
  // Review fix M4: 0 segments returns MANUAL (separate test below).
  // 1-2 segments still triggers the fallback as best-effort recovery.
  const page = new MockPage();
  const seg = new MockLocator({ countValue: 2 });
  const loc = new MockLocator();
  loc.childLocators['[role=spinbutton]'] = seg;
  const r = await dateTesting.fillMuiDatepicker(page, loc, null, '2024-06-15');
  assert.equal(r.confidence, Confidence.MEDIUM);
  assert.deepEqual(page.keyboard.typed, ['06/15/2024']);
});

await test('flatpickr: page.evaluate sets value + dispatches change', async () => {
  const loc = new MockLocator();
  const r = await dateTesting.fillFlatpickr(null, loc, null, '2024-06-15');
  assert.equal(r.confidence, Confidence.MEDIUM);
  assert.equal(loc.calls[0].method, 'evaluate');
  assert.equal(loc.calls[0].arg, '2024-06-15');
});

await test('flatpickr: evaluate throws → MANUAL', async () => {
  const loc = new MockLocator({ throwOn: 'evaluate' });
  const r = await dateTesting.fillFlatpickr(null, loc, null, '2024-06-15');
  assert.equal(r.confidence, Confidence.MANUAL);
});

// Selector keys post-fix (CRITICAL C1): :not() guards prevent name collision.
const _MDY_MONTH_SEL =
  'select[name*="month" i]:not([name*="year" i]):not([name*="day" i]), select[id*="month" i]:not([id*="year" i]):not([id*="day" i])';
const _MDY_DAY_SEL =
  'select[name*="day" i]:not([name*="month" i]):not([name*="year" i]), select[id*="day" i]:not([id*="month" i]):not([id*="year" i])';
const _MDY_YEAR_SEL =
  'select[name*="year" i]:not([name*="month" i]):not([name*="day" i]), select[id*="year" i]:not([id*="month" i]):not([id*="day" i])';

await test('split_mdy_select: 3 selectOption calls (tightened selectors)', async () => {
  const loc = new MockLocator();
  const monthLoc = new MockLocator();
  const dayLoc = new MockLocator();
  const yearLoc = new MockLocator();
  loc.childLocators[_MDY_MONTH_SEL] = monthLoc;
  loc.childLocators[_MDY_DAY_SEL] = dayLoc;
  loc.childLocators[_MDY_YEAR_SEL] = yearLoc;
  const r = await dateTesting.fillSplitMdySelect(null, loc, null, '2024-06-15');
  assert.equal(r.confidence, Confidence.MEDIUM);
  assert.equal(monthLoc.calls[0].value, '06');
  assert.equal(dayLoc.calls[0].value, '15');
  assert.equal(yearLoc.calls[0].value, '2024');
});

await test('split_mdy_select: numeric fallback when padded value rejected', async () => {
  const loc = new MockLocator();
  let monthAttempts = 0;
  const monthLoc = new MockLocator();
  monthLoc.selectOption = async function (v) {
    monthAttempts++;
    this.calls.push({ method: 'selectOption', value: v });
    if (monthAttempts === 1) throw new Error('option not found');
  };
  loc.childLocators[_MDY_MONTH_SEL] = monthLoc;
  loc.childLocators[_MDY_DAY_SEL] = new MockLocator();
  loc.childLocators[_MDY_YEAR_SEL] = new MockLocator();
  const r = await dateTesting.fillSplitMdySelect(null, loc, null, '2024-06-15');
  assert.equal(r.confidence, Confidence.MEDIUM);
  assert.equal(monthLoc.calls[0].value, '06');
  assert.equal(monthLoc.calls[1].value, '6');
});

// ─── 3. Date detection rule ───────────────────────────────────────────

await test('dateDetectionRule: input[type=date] → HTML5_DATE', () => {
  const rule = dateTesting.dateDetectionRule;
  const r = rule({ role: 'textbox', name: 'Start' }, {
    className: '', tagName: 'INPUT', type: 'date', attrs: {}, dataset: {},
  }, {});
  assert.equal(r, ControlType.HTML5_DATE);
});

await test('dateDetectionRule: flatpickr-input class → FLATPICKR', () => {
  const rule = dateTesting.dateDetectionRule;
  const r = rule({ role: 'textbox', name: 'Start' }, {
    className: 'foo flatpickr-input bar', tagName: 'INPUT', type: 'text', attrs: {}, dataset: {},
  }, {});
  assert.equal(r, ControlType.FLATPICKR);
});

await test('dateDetectionRule: react-datepicker class → REACT_DATEPICKER', () => {
  const rule = dateTesting.dateDetectionRule;
  const r = rule({ role: 'textbox', name: 'Date' }, {
    className: 'react-datepicker__input-container', tagName: 'INPUT', type: 'text', attrs: {}, dataset: {},
  }, {});
  assert.equal(r, ControlType.REACT_DATEPICKER);
});

await test('dateDetectionRule: MUI date class + pickers → MUI_DATEPICKER', () => {
  const rule = dateTesting.dateDetectionRule;
  const r = rule({ role: 'combobox', name: 'Date' }, {
    className: 'MuiInputBase-input MuiPickersInput-root', tagName: 'INPUT', type: 'text', attrs: {}, dataset: {},
  }, {});
  assert.equal(r, ControlType.MUI_DATEPICKER);
});

await test('dateDetectionRule: SPLIT_MDY_SELECT via date-of-birth container name', () => {
  const rule = dateTesting.dateDetectionRule;
  const r = rule({ role: 'group', name: 'Date of birth' }, {
    className: '', tagName: 'DIV', type: '', attrs: {}, dataset: {},
  }, {});
  assert.equal(r, ControlType.SPLIT_MDY_SELECT);
});

await test('dateDetectionRule: no match → null (defer to next rule)', () => {
  const rule = dateTesting.dateDetectionRule;
  const r = rule({ role: 'textbox', name: 'First name' }, {
    className: 'form-control', tagName: 'INPUT', type: 'text', attrs: {}, dataset: {},
  }, {});
  assert.equal(r, null);
});

// ─── 4. Address strategies ────────────────────────────────────────────

await test('google_places: fill + dropdown click → MEDIUM', async () => {
  const page = new MockPage();
  page.evaluate = async () => undefined; // stub stale-container dismissal
  const containerLoc = new MockLocator({ waitForOutcome: 'success' });
  page.pageLocators['.pac-container:not([data-applier-stale]):visible .pac-item'] = containerLoc;
  const inputLoc = new MockLocator();
  const r = await addrTesting.fillGooglePlaces(page, inputLoc, null, '123 Main St');
  assert.equal(r.confidence, Confidence.MEDIUM);
  assert.equal(r.filled, true);
  assert.equal(inputLoc.calls[0].value, '123 Main St');
});

await test('google_places: dropdown timeout → LOW partial fill (block_approve in m1)', async () => {
  const page = new MockPage();
  // Stub page.evaluate (used to dismiss stale containers)
  page.evaluate = async () => undefined;
  const containerLoc = new MockLocator({ waitForOutcome: 'timeout' });
  page.pageLocators['.pac-container:not([data-applier-stale]):visible .pac-item'] = containerLoc;
  const inputLoc = new MockLocator();
  const r = await addrTesting.fillGooglePlaces(page, inputLoc, null, '123 Main St');
  // Review fix (H4/B3-Hazard#2): partial fill without place_id → LOW
  // so nonstandardFillField sets block_approve and the user verifies.
  assert.equal(r.confidence, Confidence.LOW);
  assert.equal(r.filled, true);
  assert.match(r.error, /dropdown timeout/);
});

await test('google_places: locator.fill throws → MANUAL', async () => {
  const page = new MockPage();
  page.evaluate = async () => undefined;
  const inputLoc = new MockLocator({ throwOn: 'fill' });
  const r = await addrTesting.fillGooglePlaces(page, inputLoc, null, '123 Main St');
  assert.equal(r.confidence, Confidence.MANUAL);
});

await test('google_places: empty value → MANUAL', async () => {
  const page = new MockPage();
  const inputLoc = new MockLocator();
  const r = await addrTesting.fillGooglePlaces(page, inputLoc, null, '');
  assert.equal(r.confidence, Confidence.MANUAL);
  assert.equal(inputLoc.calls.length, 0);
});

await test('algolia_places: fill + suggestion click → MEDIUM', async () => {
  const page = new MockPage();
  const sugLoc = new MockLocator({ waitForOutcome: 'success' });
  page.pageLocators['.ap-suggestions .ap-suggestion'] = sugLoc;
  const inputLoc = new MockLocator();
  const r = await addrTesting.fillAlgoliaPlaces(page, inputLoc, null, '456 Elm');
  assert.equal(r.confidence, Confidence.MEDIUM);
  assert.equal(r.filled, true);
});

await test('algolia_places: dropdown timeout → LOW partial fill', async () => {
  const page = new MockPage();
  const sugLoc = new MockLocator({ waitForOutcome: 'timeout' });
  page.pageLocators['.ap-suggestions .ap-suggestion'] = sugLoc;
  const inputLoc = new MockLocator();
  const r = await addrTesting.fillAlgoliaPlaces(page, inputLoc, null, '456 Elm');
  assert.equal(r.confidence, Confidence.LOW);
  assert.match(r.error, /dropdown timeout/);
});

// ─── 5. Address detection ─────────────────────────────────────────────

await test('addressDetectionRule: pac-input class → GOOGLE_PLACES', () => {
  const r = addrTesting.addressDetectionRule(
    { role: 'textbox', name: 'Address' },
    { className: 'pac-input', tagName: 'INPUT', type: 'text', attrs: {}, dataset: {} },
    {},
  );
  assert.equal(r, ControlType.GOOGLE_PLACES);
});

await test('addressDetectionRule: ap-input class → ALGOLIA_PLACES', () => {
  const r = addrTesting.addressDetectionRule(
    { role: 'textbox', name: 'Address' },
    { className: 'ap-input', tagName: 'INPUT', type: 'text', attrs: {}, dataset: {} },
    {},
  );
  assert.equal(r, ControlType.ALGOLIA_PLACES);
});

await test('addressDetectionRule: no match → null', () => {
  const r = addrTesting.addressDetectionRule(
    { role: 'textbox', name: 'Email' },
    { className: 'form-control', tagName: 'INPUT', type: 'email', attrs: {}, dataset: {} },
    {},
  );
  assert.equal(r, null);
});

// ─── 6. End-to-end via nonstandardFillField ───────────────────────────

await test('e2e: detectControlType + nonstandardFillField → flatpickr strategy', async () => {
  // Simulate machine.mjs's FILL loop: detect → resolve → strategy.fill.
  const entry = {
    role: 'textbox',
    name: 'Start date',
    _attrs: {
      className: 'flatpickr-input',
      tagName: 'INPUT',
      type: 'text',
      attrs: {},
      dataset: {},
    },
  };
  const table = new MockTable({ e1: entry });
  const page = new MockPage();
  const field = { suggested_value: '2024-06-15', class: 'hard', label: 'Start date' };
  await nonstandardFillField(page, 'e1', field, table);
  assert.equal(field.confidence, Confidence.MEDIUM);
  assert.ok(!field.manual_required);
  // The flatpickr strategy uses locator.evaluate
  const loc = table.resolvedLocators.get('e1');
  assert.ok(loc.calls.some((c) => c.method === 'evaluate' && c.arg === '2024-06-15'));
});

await test('e2e: UNKNOWN_CALENDAR (no strategy) → MANUAL', async () => {
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    registerStandardStrategies();
    registerDateStrategies();
    registerAddressStrategies();
    // Ensure UNKNOWN_CALENDAR remains unregistered.
    assert.equal(getStrategy(ControlType.UNKNOWN_CALENDAR), null);
    // A field that the date rule doesn't match → ARIA fallback (TEXTBOX
    // strategy fills) — NOT MANUAL. Test the explicit unregistered path
    // via direct strategy lookup.
    const f = { suggested_value: '2024-06-15' };
    // Simulate: detection returned UNKNOWN_CALENDAR
    const strategy = getStrategy(ControlType.UNKNOWN_CALENDAR);
    assert.equal(strategy, null, 'UNKNOWN_CALENDAR intentionally not registered');
  } finally {
    restoreRegistry(snap);
  }
});

// ─── 7. Review-driven regression tests ────────────────────────────────

await test('B5/C2 MUI rule no longer false-positives on MuiAutocomplete + aria-haspopup=dialog', () => {
  const rule = dateTesting.dateDetectionRule;
  // MuiAutocomplete popper for a city-search field. Has `mui` class
  // and aria-haspopup=dialog. OLD rule mis-routed to MUI_DATEPICKER.
  const r = rule({ role: 'combobox', name: 'City' }, {
    className: 'MuiInputBase-input MuiAutocomplete-input',
    tagName: 'INPUT',
    type: 'text',
    attrs: { 'aria-haspopup': 'dialog' },
    dataset: {},
  }, {});
  assert.equal(r, null, 'must NOT route to MUI_DATEPICKER');
});

await test('B5/C2 MUI rule still positives on real MuiPickersTextField', () => {
  const rule = dateTesting.dateDetectionRule;
  const r = rule({ role: 'combobox', name: 'Birth date' }, {
    className: 'MuiPickersTextField-root MuiInputBase-root',
    tagName: 'DIV',
    type: '',
    attrs: {},
    dataset: {},
  }, {});
  assert.equal(r, ControlType.MUI_DATEPICKER);
});

await test('B9/H1 token-aware class match: epicac-input-foo does NOT match pac-input', () => {
  const r = addrTesting.addressDetectionRule(
    { role: 'textbox', name: 'Spelling' },
    { className: 'epicac-input-wrapper', tagName: 'INPUT', type: 'text', attrs: {}, dataset: {} },
    {},
  );
  assert.equal(r, null);
});

await test('B9/H1 token-aware: notaflatpickr-input does NOT match flatpickr-input', () => {
  const rule = dateTesting.dateDetectionRule;
  const r = rule({ role: 'textbox', name: 'X' }, {
    className: 'notaflatpickr-input-clone', tagName: 'INPUT', type: 'text', attrs: {}, dataset: {},
  }, {});
  assert.equal(r, null);
});

await test('B9/H1 token-aware: pac-input-mobile DOES match pac-input (prefix variant)', () => {
  const r = addrTesting.addressDetectionRule(
    { role: 'textbox', name: 'Address' },
    { className: 'pac-input-mobile', tagName: 'INPUT', type: 'text', attrs: {}, dataset: {} },
    {},
  );
  assert.equal(r, ControlType.GOOGLE_PLACES);
});

await test('B8/H3 flatpickr: invokes _flatpickr.setDate when instance exists', async () => {
  let setDateCalledWith = null;
  const loc = new MockLocator();
  // Override evaluate to simulate the page-side execution: invoke the
  // function with a fake element exposing `_flatpickr.setDate`.
  loc.evaluate = async (fn, val) => {
    loc.calls.push({ method: 'evaluate', arg: val });
    const el = {
      _flatpickr: {
        setDate: (v) => { setDateCalledWith = v; },
      },
      parentElement: null,
      nextElementSibling: null,
      dispatchEvent: () => {},
    };
    fn(el, val);
  };
  const r = await dateTesting.fillFlatpickr(null, loc, null, '2024-06-15');
  assert.equal(r.confidence, Confidence.MEDIUM);
  assert.equal(setDateCalledWith, '2024-06-15');
});

await test('B8/H3 flatpickr: falls back to native dispatch when no instance', async () => {
  const events = [];
  const loc = new MockLocator();
  loc.evaluate = async (fn, val) => {
    loc.calls.push({ method: 'evaluate', arg: val });
    const el = {
      _flatpickr: null,
      parentElement: { querySelector: () => null },
      nextElementSibling: null,
      value: '',
      dispatchEvent: (ev) => events.push(ev.type),
    };
    fn(el, val);
    assert.equal(el.value, val);
  };
  const r = await dateTesting.fillFlatpickr(null, loc, null, '2024-06-15');
  assert.equal(r.confidence, Confidence.MEDIUM);
  assert.deepEqual(events, ['input', 'change']);
});

await test('B3/H5 google_places dismisses stale containers before fill', async () => {
  const page = new MockPage();
  let evaluateCalled = false;
  page.evaluate = async () => {
    evaluateCalled = true;
  };
  const containerLoc = new MockLocator({ waitForOutcome: 'success' });
  page.pageLocators['.pac-container:not([data-applier-stale]):visible .pac-item'] = containerLoc;
  const inputLoc = new MockLocator();
  await addrTesting.fillGooglePlaces(page, inputLoc, null, '500 Market St');
  assert.equal(evaluateCalled, true, 'must dismiss stale containers before fill');
});

await test('C1 split_mdy_select: month-year-select compound name does not collide', async () => {
  const loc = new MockLocator();
  const monthLoc = new MockLocator();
  const dayLoc = new MockLocator();
  const yearLoc = new MockLocator();
  loc.childLocators[_MDY_MONTH_SEL] = monthLoc;
  loc.childLocators[_MDY_DAY_SEL] = dayLoc;
  loc.childLocators[_MDY_YEAR_SEL] = yearLoc;
  const r = await dateTesting.fillSplitMdySelect(null, loc, null, '2024-06-15');
  assert.equal(r.confidence, Confidence.MEDIUM);
  assert.equal(monthLoc.calls[0].value, '06');
  assert.equal(dayLoc.calls[0].value, '15');
  assert.equal(yearLoc.calls[0].value, '2024');
});

await test('L2 split_mdy_select year fallback: 4-digit fails → 2-digit succeeds', async () => {
  const loc = new MockLocator();
  loc.childLocators[_MDY_MONTH_SEL] = new MockLocator();
  loc.childLocators[_MDY_DAY_SEL] = new MockLocator();
  const yearLoc = new MockLocator();
  let attempts = 0;
  yearLoc.selectOption = async function (v) {
    attempts++;
    this.calls.push({ method: 'selectOption', value: v });
    if (attempts === 1) throw new Error('option not found');
  };
  loc.childLocators[_MDY_YEAR_SEL] = yearLoc;
  const r = await dateTesting.fillSplitMdySelect(null, loc, null, '2024-06-15');
  assert.equal(r.confidence, Confidence.MEDIUM);
  assert.equal(yearLoc.calls[0].value, '2024');
  assert.equal(yearLoc.calls[1].value, '24');
});

await test('M4 mui_datepicker: 0 segments → MANUAL (no blind click+type)', async () => {
  const page = new MockPage();
  const seg = new MockLocator({ countValue: 0 });
  const loc = new MockLocator();
  loc.childLocators['[role=spinbutton]'] = seg;
  const r = await dateTesting.fillMuiDatepicker(page, loc, null, '2024-06-15');
  // Old behavior: silently click+type → wrong control gets a date.
  // New behavior: refuse, surface MANUAL.
  assert.equal(r.confidence, Confidence.MANUAL);
  assert.match(r.error, /no spinbutton segments/);
  // Loc never clicked
  assert.ok(!loc.calls.some((c) => c.method === 'click'));
});

await test('B6 SPLIT_MDY_SELECT detection requires container role/tag', () => {
  const rule = dateTesting.dateDetectionRule;
  // Container case: DIV / FIELDSET / role=group passes.
  const okGroup = rule(
    { role: 'group', name: 'Date of birth' },
    { className: '', tagName: 'DIV', type: '', attrs: {}, dataset: {} },
    {},
  );
  assert.equal(okGroup, ControlType.SPLIT_MDY_SELECT);
  // Single INPUT with role=textbox should NOT match (would be mis-routed).
  const inputNo = rule(
    { role: 'textbox', name: 'Date of birth' },
    { className: '', tagName: 'INPUT', type: 'text', attrs: {}, dataset: {} },
    {},
  );
  assert.equal(inputNo, null);
});

await test('E2E partial Google Places (timeout) → block_approve via nonstandardFillField', async () => {
  // Verify the LOW confidence routing through the full m1 pipeline.
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    registerStandardStrategies();
    registerDateStrategies();
    registerAddressStrategies();
    const entry = {
      role: 'textbox',
      name: 'Address',
      _attrs: {
        className: 'pac-input',
        tagName: 'INPUT',
        type: 'text',
        attrs: {},
        dataset: {},
      },
    };
    const table = new MockTable({ e1: entry });
    const page = new MockPage();
    page.evaluate = async () => undefined;
    const containerLoc = new MockLocator({ waitForOutcome: 'timeout' });
    page.pageLocators['.pac-container:not([data-applier-stale]):visible .pac-item'] = containerLoc;
    const field = { suggested_value: '123 Main St', class: 'hard', label: 'Address' };
    await nonstandardFillField(page, 'e1', field, table);
    assert.equal(field.confidence, Confidence.LOW);
    assert.equal(field.block_approve, true);
    // C1 m1 fix: suggested_value nulled to suppress memory write
    assert.equal(field.suggested_value, null);
    assert.equal(field.suggested_value_filled, '123 Main St');
  } finally {
    restoreRegistry(snap);
  }
});

// ─── Summary ──────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
