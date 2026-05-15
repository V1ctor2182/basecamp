#!/usr/bin/env node
// Smoke for 07-applier/05-non-standard-controls m4 (ROOM COMPLETE):
// specialControls.mjs (captcha + rich_text + slider + shadow + iframe),
// manualHighlight.mjs (red outline injection), and endpoint.mjs
// production wiring of nonstandardFillField as default _fillField.

import assert from 'node:assert/strict';

import {
  ControlType,
  Confidence,
  STRATEGY_REGISTRY,
  DETECTION_RULES,
  detectControlType,
  _resetRegistryForTesting,
} from '../src/career/applier/nonstandard/controlRouter.mjs';
import {
  nonstandardFillField,
  registerStandardStrategies,
} from '../src/career/applier/nonstandard/nonstandardFillField.mjs';
import {
  registerSpecialStrategies,
  _testing as specTesting,
  detectCaptcha,
} from '../src/career/applier/nonstandard/strategies/specialControls.mjs';
import {
  highlightManual,
  clearManualHighlight,
} from '../src/career/applier/nonstandard/manualHighlight.mjs';

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
    this.contentFrameResult = opts.contentFrameResult ?? null;
    this.evaluateImpl = opts.evaluateImpl ?? null;
    this.childLocators = opts.childLocators ?? {};
    this.locatorChain = opts.locatorChain ?? null;
  }
  async _maybeThrow(method) {
    if (this.throwOn === method) throw new Error(`MockLocator: forced throw on ${method}`);
  }
  async evaluate(fn, arg) {
    this.calls.push({ method: 'evaluate', arg });
    await this._maybeThrow('evaluate');
    if (this.evaluateImpl) return this.evaluateImpl(fn, arg);
    return null;
  }
  async fill(value) {
    this.calls.push({ method: 'fill', value });
    await this._maybeThrow('fill');
  }
  async contentFrame() {
    this.calls.push({ method: 'contentFrame' });
    return this.contentFrameResult;
  }
  locator(selector) {
    if (this.locatorChain) {
      this.calls.push({ method: 'locator', selector });
      return this.locatorChain;
    }
    if (!this.childLocators[selector]) {
      this.childLocators[selector] = new MockLocator();
    }
    return this.childLocators[selector];
  }
  first() { return this; }
}

class MockFrame {
  constructor() {
    this.innerLocators = new Map();
  }
  getByRole(role) {
    const key = `role:${role}`;
    if (!this.innerLocators.has(key)) this.innerLocators.set(key, new MockLocator());
    return this.innerLocators.get(key);
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
      this.resolvedLocators.set(refId, e._locator || new MockLocator({ evaluateImpl: () => e._attrs }));
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

// ─── 1. detectCaptcha helper ─────────────────────────────────────────

await test('detectCaptcha: data-sitekey attr → true', () => {
  assert.equal(detectCaptcha({ attrs: { 'data-sitekey': 'abc123' }, className: '' }), true);
});

await test('detectCaptcha: dataset.sitekey camelCase → true', () => {
  assert.equal(detectCaptcha({ attrs: {}, dataset: { sitekey: 'abc' }, className: '' }), true);
});

await test('detectCaptcha: class token g-recaptcha → true', () => {
  assert.equal(detectCaptcha({ attrs: {}, className: 'mycls g-recaptcha other' }), true);
});

await test('detectCaptcha: class token h-captcha → true', () => {
  assert.equal(detectCaptcha({ attrs: {}, className: 'h-captcha' }), true);
});

await test('detectCaptcha: class token cf-turnstile → true', () => {
  assert.equal(detectCaptcha({ attrs: {}, className: 'cf-turnstile widget' }), true);
});

await test('detectCaptcha: substring trap rejected (recaptcha-skin-helper)', () => {
  // Old substring code would have false-positived on 'recaptcha-skin-helper'.
  // Token equality means 'recaptcha' alone matches but composed names do not.
  assert.equal(
    detectCaptcha({ attrs: {}, className: 'recaptcha-skin-helper' }),
    false,
  );
});

await test('detectCaptcha: empty sitekey rejected', () => {
  assert.equal(detectCaptcha({ attrs: { 'data-sitekey': '   ' }, className: '' }), false);
  assert.equal(detectCaptcha({ attrs: { 'data-sitekey': '' }, className: '' }), false);
});

// ─── 2. CAPTCHA + Rich text strategies (Constraints #3 + #4) ─────────

await test('CAPTCHA strategy: ALWAYS MANUAL, never touches locator (Constraint #3)', async () => {
  const loc = new MockLocator();
  const r = await specTesting.fillCaptcha(null, loc, { suggested_value: 'whatever' }, 'whatever');
  assert.equal(r.confidence, Confidence.MANUAL);
  assert.equal(r.filled, false);
  assert.equal(loc.calls.length, 0, 'NO locator action — must never attempt to bypass');
});

await test('rich_text strategy: ALWAYS MANUAL, never touches locator (Constraint #4)', async () => {
  const loc = new MockLocator();
  const r = await specTesting.fillRichText(null, loc, { suggested_value: 'bio text' }, 'bio text');
  assert.equal(r.confidence, Confidence.MANUAL);
  assert.equal(loc.calls.length, 0);
});

// ─── 3. slider_range ─────────────────────────────────────────────────

await test('slider_range: numeric string → fill + MEDIUM', async () => {
  const loc = new MockLocator();
  const r = await specTesting.fillSliderRange(null, loc, null, '50');
  assert.equal(r.confidence, Confidence.MEDIUM);
  assert.equal(loc.calls[0].value, '50');
});

await test('slider_range: integer value → coerced to numeric string', async () => {
  const loc = new MockLocator();
  const r = await specTesting.fillSliderRange(null, loc, null, 50);
  assert.equal(r.confidence, Confidence.MEDIUM);
  assert.equal(loc.calls[0].value, '50');
});

await test('slider_range: non-numeric → MANUAL', async () => {
  const loc = new MockLocator();
  const r = await specTesting.fillSliderRange(null, loc, null, 'not-a-number');
  assert.equal(r.confidence, Confidence.MANUAL);
  assert.equal(loc.calls.length, 0);
});

await test('slider_range: empty value → MANUAL', async () => {
  const loc = new MockLocator();
  const r = await specTesting.fillSliderRange(null, loc, null, '');
  assert.equal(r.confidence, Confidence.MANUAL);
});

// ─── 4. shadow_dom ───────────────────────────────────────────────────

await test('shadow_dom: pierces via Playwright auto-pierce + fill → MEDIUM', async () => {
  const inner = new MockLocator();
  const loc = new MockLocator({ locatorChain: inner });
  const r = await specTesting.fillShadowDom(null, loc, null, 'shadow value');
  assert.equal(r.confidence, Confidence.MEDIUM);
  // Review fix H1: no `:host` prefix — Playwright auto-pierces.
  assert.ok(
    loc.calls.some((c) => c.method === 'locator' && c.selector === 'input, textarea, select'),
  );
  assert.equal(inner.calls[0].value, 'shadow value');
});

await test('shadow_dom: inner fill throws → MANUAL', async () => {
  const inner = new MockLocator({ throwOn: 'fill' });
  const loc = new MockLocator({ locatorChain: inner });
  const r = await specTesting.fillShadowDom(null, loc, null, 'value');
  assert.equal(r.confidence, Confidence.MANUAL);
});

// ─── 5. iframe_form ──────────────────────────────────────────────────

await test('iframe_form: with label → name-filtered fill → MEDIUM', async () => {
  // Review fix H2: classifiedField.label is now required for MEDIUM
  // confidence (avoids first-textbox trap).
  const frame = new MockFrame();
  const namedLoc = new MockLocator();
  namedLoc.count = async () => 1;
  frame.getByRole = function (role, opts) {
    return opts?.name ? namedLoc : new MockLocator();
  };
  const loc = new MockLocator({ contentFrameResult: frame });
  const r = await specTesting.fillIframeForm(
    null,
    loc,
    { label: 'Email' },
    'iframe value',
  );
  assert.equal(r.confidence, Confidence.MEDIUM);
  assert.equal(namedLoc.calls[0].value, 'iframe value');
});

await test('iframe_form: no label → unfiltered fill → LOW (downgraded confidence)', async () => {
  // Without a classifier label we fall back to .first() but downgrade
  // to LOW so the user verifies (avoids silent first-textbox wrong-write).
  const frame = new MockFrame();
  const loc = new MockLocator({ contentFrameResult: frame });
  const r = await specTesting.fillIframeForm(null, loc, null, 'value');
  assert.equal(r.confidence, Confidence.LOW);
});

await test('iframe_form: contentFrame() returns null → MANUAL', async () => {
  const loc = new MockLocator({ contentFrameResult: null });
  const r = await specTesting.fillIframeForm(null, loc, null, 'value');
  assert.equal(r.confidence, Confidence.MANUAL);
  assert.match(r.error, /contentFrame.*null/);
});

// ─── 6. Detection rule ───────────────────────────────────────────────

await test('specialDetectionRule: data-sitekey → CAPTCHA', () => {
  const r = specTesting.specialDetectionRule(
    { role: 'iframe', name: '' },
    { className: 'g-recaptcha', tagName: 'DIV', type: '', attrs: { 'data-sitekey': 'k' }, dataset: { sitekey: 'k' } },
    {},
  );
  assert.equal(r, ControlType.CAPTCHA);
});

await test('specialDetectionRule: contenteditable=true → RICH_TEXT', () => {
  const r = specTesting.specialDetectionRule(
    { role: 'textbox', name: 'Bio' },
    { className: '', tagName: 'DIV', type: '', attrs: { contenteditable: 'true' }, dataset: {} },
    {},
  );
  assert.equal(r, ControlType.RICH_TEXT);
});

await test('specialDetectionRule: ql-editor class → RICH_TEXT', () => {
  const r = specTesting.specialDetectionRule(
    { role: 'textbox', name: 'Cover letter' },
    { className: 'ql-editor', tagName: 'DIV', type: '', attrs: {}, dataset: {} },
    {},
  );
  assert.equal(r, ControlType.RICH_TEXT);
});

await test('specialDetectionRule: input[type=range] → SLIDER_RANGE', () => {
  const r = specTesting.specialDetectionRule(
    { role: 'slider', name: 'Years' },
    { className: '', tagName: 'INPUT', type: 'range', attrs: {}, dataset: {} },
    {},
  );
  assert.equal(r, ControlType.SLIDER_RANGE);
});

await test('specialDetectionRule: hasShadow=true → SHADOW_DOM', () => {
  const r = specTesting.specialDetectionRule(
    { role: 'group', name: 'Custom' },
    { className: '', tagName: 'DIV', type: '', attrs: {}, dataset: {}, hasShadow: true },
    {},
  );
  assert.equal(r, ControlType.SHADOW_DOM);
});

await test('specialDetectionRule: IFRAME tagName → IFRAME_FORM', () => {
  const r = specTesting.specialDetectionRule(
    { role: 'document', name: '' },
    { className: '', tagName: 'IFRAME', type: '', attrs: {}, dataset: {} },
    {},
  );
  assert.equal(r, ControlType.IFRAME_FORM);
});

// ─── 7. manualHighlight ──────────────────────────────────────────────

await test('highlightManual: injects outline + scrollIntoView + data-applier-manual flag (NO PII attr)', async () => {
  let attrs = null;
  const fakeEl = {
    dataset: {},
    style: {},
    setAttribute(k, v) { attrs = attrs || {}; attrs[k] = v; },
    scrollIntoView: () => {},
  };
  const loc = new MockLocator({
    evaluateImpl: (fn, args) => fn(fakeEl, args),
  });
  const ok = await highlightManual(null, loc, 'My suggested value');
  assert.equal(ok, true);
  assert.ok(fakeEl.style.outline.includes('#e53e3e'), 'red outline applied');
  assert.equal(attrs['data-applier-manual'], 'true');
  // Review fix CRITICAL C3: data-applier-suggested MUST NOT be written
  // (PII leak / stored-XSS surface). Dashboard reads value from session
  // JSON instead.
  assert.equal(
    attrs['data-applier-suggested'],
    undefined,
    'PII attribute MUST NOT be written to DOM',
  );
});

await test('highlightManual: null locator → false (no-op)', async () => {
  assert.equal(await highlightManual(null, null, 'val'), false);
});

await test('highlightManual: evaluate throws → false (best-effort)', async () => {
  const loc = new MockLocator({ throwOn: 'evaluate' });
  assert.equal(await highlightManual(null, loc, 'val'), false);
});

await test('clearManualHighlight: restores prior outline', async () => {
  const fakeEl = {
    dataset: { applierOutlinePrior: '1px dashed gray', applierShadowPrior: 'none' },
    style: { outline: '3px solid #e53e3e', boxShadow: '0 0 0 6px rgba(229,62,62,0.18)' },
    removeAttribute: () => {},
  };
  const loc = new MockLocator({
    evaluateImpl: (fn) => fn(fakeEl),
  });
  const ok = await clearManualHighlight(null, loc);
  assert.equal(ok, true);
  assert.equal(fakeEl.style.outline, '1px dashed gray');
  assert.equal(fakeEl.style.boxShadow, 'none');
});

// ─── 8. E2E through nonstandardFillField ─────────────────────────────

await test('e2e: CAPTCHA detected → MANUAL + highlight injected + ZERO non-evaluate locator calls (Constraint #3)', async () => {
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    registerStandardStrategies();
    registerSpecialStrategies();
    let highlightInjected = false;
    const loc = new MockLocator({
      evaluateImpl: (fn, arg) => {
        // First evaluate call is sniffElement; subsequent is highlightManual.
        if (arg && arg.outline) {
          highlightInjected = true;
          return null;
        }
        return {
          className: 'g-recaptcha',
          tagName: 'DIV',
          type: '',
          attrs: { 'data-sitekey': 'sitekey-xyz' },
          dataset: { sitekey: 'sitekey-xyz' },
        };
      },
    });
    const entry = { role: 'iframe', name: '', _locator: loc };
    const table = new MockTable({ e1: entry });
    const field = { suggested_value: 'whatever', class: 'open', label: 'CAPTCHA' };
    await nonstandardFillField({}, 'e1', field, table);
    assert.equal(field.manual_required, true);
    assert.equal(field.confidence, Confidence.MANUAL);
    assert.equal(field.suggested_value, null, 'suggested_value nulled (C1 m1 fix)');
    assert.equal(field.suggested_value_manual, 'whatever');
    assert.match(field.manual_reason, /captcha/i);
    // Review fix M2: ZERO non-evaluate calls — Constraint #3.
    assert.ok(
      loc.calls.every((c) => c.method === 'evaluate'),
      'CAPTCHA must produce ONLY evaluate calls (sniff + highlight) — never click/fill/select',
    );
    assert.ok(highlightInjected, 'highlightManual injected outline');
  } finally {
    restoreRegistry(snap);
  }
});

await test('REVIEW C1: CAPTCHA hosted as role=combobox still wins (not claimed by selection rule)', async () => {
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    registerStandardStrategies();
    // Register OTHER rules first that would claim role=combobox; then
    // specialControls registers later. The pre-check in detectControlType
    // must still route to CAPTCHA.
    const { registerDateStrategies } = await import('../src/career/applier/nonstandard/strategies/datePickers.mjs');
    const { registerAddressStrategies } = await import('../src/career/applier/nonstandard/strategies/addressControls.mjs');
    const { registerSelectionStrategies } = await import('../src/career/applier/nonstandard/strategies/selectionControls.mjs');
    registerDateStrategies();
    registerAddressStrategies();
    registerSelectionStrategies();
    registerSpecialStrategies();
    const loc = new MockLocator({
      evaluateImpl: (fn, arg) => {
        if (arg && arg.outline) return null; // highlight evaluate
        return {
          className: 'g-recaptcha',
          tagName: 'DIV',
          type: '',
          // role=combobox would normally be claimed by selectionDetectionRule
          attrs: { 'aria-haspopup': 'listbox', 'data-sitekey': 'k' },
          dataset: { sitekey: 'k' },
        };
      },
    });
    const entry = { role: 'combobox', name: '', _locator: loc };
    const table = new MockTable({ e1: entry });
    const field = { suggested_value: 'whatever', class: 'open' };
    await nonstandardFillField({}, 'e1', field, table);
    // CAPTCHA pre-check wins → MANUAL, never tries to click the combobox.
    assert.equal(field.manual_required, true);
    assert.match(field.manual_reason, /captcha/i);
    assert.ok(loc.calls.every((c) => c.method === 'evaluate'), 'no click/fill on CAPTCHA');
  } finally {
    restoreRegistry(snap);
  }
});

await test('REVIEW C2: <input class="notranslate"> no longer routes to RICH_TEXT', () => {
  // Ensure removal of 'notranslate' from RICH_TEXT_CLASS_TOKENS.
  const r = specTesting.specialDetectionRule(
    { role: 'textbox', name: 'Email' },
    {
      className: 'form-control notranslate',
      tagName: 'INPUT',
      type: 'email',
      attrs: {},
      dataset: {},
    },
    {},
  );
  assert.equal(r, null, '`notranslate` alone must not route to RICH_TEXT (Constraint #4 false-positive fix)');
});

await test('REVIEW H1: shadow_dom uses Playwright auto-pierce (no :host prefix)', async () => {
  const inner = new MockLocator();
  let selectorUsed = null;
  const loc = new MockLocator({
    locatorChain: inner,
  });
  // Intercept the locator() call to capture the selector
  loc.locator = function (selector) {
    selectorUsed = selector;
    this.calls.push({ method: 'locator', selector });
    return inner;
  };
  await specTesting.fillShadowDom(null, loc, null, 'value');
  assert.equal(
    selectorUsed,
    'input, textarea, select',
    'must use plain selector for auto-pierce; old `:host >> css=...` was invalid Playwright syntax',
  );
});

await test('REVIEW H2: iframe_form filters by classifiedField.label (avoids first-textbox trap)', async () => {
  const frame = new MockFrame();
  // Pre-create the role-with-name locator so we can capture which one
  // gets the fill.
  let namedCount = 0;
  const namedLoc = new MockLocator();
  namedLoc.count = async () => 1;
  frame.innerLocators.set('role:textbox', namedLoc);
  // Override getByRole to inspect args
  let receivedName = null;
  let receivedExact = null;
  frame.getByRole = function (role, opts) {
    if (role === 'textbox' && opts?.name) {
      receivedName = opts.name;
      receivedExact = opts.exact;
      return namedLoc;
    }
    return new MockLocator();
  };
  const loc = new MockLocator({ contentFrameResult: frame });
  const r = await specTesting.fillIframeForm(
    null,
    loc,
    { label: 'Email address' },
    'foo@bar.com',
  );
  assert.equal(receivedName, 'Email address', 'must filter by label');
  assert.equal(receivedExact, true, 'must use exact:true');
  assert.equal(r.confidence, Confidence.MEDIUM);
  assert.equal(namedLoc.calls[0].value, 'foo@bar.com');
});

await test('e2e: rich_text → MANUAL + no fill (Constraint #4)', async () => {
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    registerStandardStrategies();
    registerSpecialStrategies();
    const loc = new MockLocator({
      evaluateImpl: (fn, arg) => {
        if (arg && arg.outline) return null;
        return {
          className: 'ql-editor',
          tagName: 'DIV',
          type: '',
          attrs: {},
          dataset: {},
        };
      },
    });
    const entry = { role: 'textbox', name: 'Cover letter', _locator: loc };
    const table = new MockTable({ e1: entry });
    const field = { suggested_value: 'long bio text', class: 'open', label: 'Cover letter' };
    await nonstandardFillField({}, 'e1', field, table);
    assert.equal(field.manual_required, true);
    assert.match(field.manual_reason, /rich_text/i);
    assert.ok(!loc.calls.some((c) => c.method === 'fill'));
  } finally {
    restoreRegistry(snap);
  }
});

await test('e2e: slider_range numeric → MEDIUM (real fill)', async () => {
  const snap = snapshotRegistry();
  try {
    _resetRegistryForTesting();
    registerStandardStrategies();
    registerSpecialStrategies();
    const loc = new MockLocator({
      evaluateImpl: () => ({
        className: '',
        tagName: 'INPUT',
        type: 'range',
        attrs: {},
        dataset: {},
      }),
    });
    const entry = { role: 'slider', name: 'Years', _locator: loc };
    const table = new MockTable({ e1: entry });
    const field = { suggested_value: '5', class: 'hard', label: 'Years' };
    await nonstandardFillField({}, 'e1', field, table);
    assert.equal(field.confidence, Confidence.MEDIUM);
    assert.ok(loc.calls.some((c) => c.method === 'fill' && c.value === '5'));
  } finally {
    restoreRegistry(snap);
  }
});

// ─── 9. endpoint.mjs production wiring ───────────────────────────────

await test('endpoint.mjs wiring: nonstandardFillField is default _fillField in startMachine', async () => {
  // Import here to confirm side-effect: importing endpoint also
  // registers all m1-m4 strategies via its strategy imports.
  const { startMachine } = await import('../src/career/applier/multistep/endpoint.mjs');
  let receivedDeps = null;
  const fakeRunMachine = async (_args, deps) => {
    receivedDeps = deps;
    return { outcome: 'continue' };
  };
  await startMachine(
    {
      jobId: '000000000001',
      jobUrl: 'https://example.com/job',
      resumeId: 'rsm-abc',
    },
    {
      _runMachine: fakeRunMachine,
      _getPage: async () => ({}),
    },
  );
  // Wait a tick for the fire-and-forget machine spawn to land
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(receivedDeps, 'machineDeps received');
  assert.equal(
    typeof receivedDeps._fillField,
    'function',
    '_fillField defaulted to nonstandardFillField',
  );
  // Verify it's the actual nonstandardFillField (by name).
  assert.equal(receivedDeps._fillField.name, 'nonstandardFillField');
});

await test('endpoint.mjs wiring: smoke can override _fillField via _machineDeps', async () => {
  const { startMachine } = await import('../src/career/applier/multistep/endpoint.mjs');
  const mockFill = async () => {};
  let receivedDeps = null;
  const fakeRunMachine = async (_args, deps) => {
    receivedDeps = deps;
    return { outcome: 'continue' };
  };
  await startMachine(
    {
      jobId: '000000000002',
      jobUrl: 'https://example.com/job2',
      resumeId: 'rsm-abc',
    },
    {
      _runMachine: fakeRunMachine,
      _getPage: async () => ({}),
      _machineDeps: { _fillField: mockFill },
    },
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(receivedDeps, 'machineDeps received');
  assert.equal(receivedDeps._fillField, mockFill, 'smoke override wins over default');
});

// ─── Summary ─────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
