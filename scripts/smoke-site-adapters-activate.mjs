#!/usr/bin/env node
// Smoke for 07-applier/06-site-adapters m2:
// activate.mjs (activateAdapter / deactivateAdapter / isAdapterActive) +
// classifier/regexRules.mjs extra-rules seam (registerExtraRules /
// clearExtraRules + integration in classifyField).
//
// Pure-Node — uses MockTable from m1 patterns + the real
// detectControlType + classifyField functions. No Chromium.

import assert from 'node:assert/strict';

import {
  ControlType,
  DETECTION_RULES,
  detectControlType,
} from '../src/career/applier/nonstandard/controlRouter.mjs';
import {
  classifyField,
  registerExtraRules,
  clearExtraRules,
  _clearAllExtraRules,
  _extraRulesSize,
} from '../src/career/applier/classifier/regexRules.mjs';
import { compileAdapter, SiteAdapterSchema } from '../src/career/applier/siteAdapters/schema.mjs';
import {
  activateAdapter,
  deactivateAdapter,
  isAdapterActive,
  _activeTokenCount,
} from '../src/career/applier/siteAdapters/activate.mjs';

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

// ── Mocks (subset of m1's harness; only what activate touches) ────────

class MockLocator {
  constructor(attrs) {
    this.attrs = attrs;
  }
  async evaluate() {
    return this.attrs;
  }
}

class MockTable {
  constructor(entries) {
    this.entries = entries;
  }
  get(refId) {
    return this.entries[refId];
  }
  publicEntry(refId) {
    const e = this.entries[refId];
    if (!e) return null;
    return { refId, role: e.role, name: e.name, occurrenceIndex: 0, frameIdx: 0 };
  }
  resolve(refId) {
    const e = this.entries[refId];
    if (!e) throw new Error('UNKNOWN_REF');
    return new MockLocator(e._attrs || null);
  }
}

const MOCK_PAGE = { __mock: 'page' };

function makeAdapter(overrides = {}) {
  const base = {
    name: 'TestATS',
    id: 'testats',
    detection: { url_patterns: ['testats\\.com'] },
    flow: { type: 'single-step' },
    controls: {},
    known_fields: [],
    quirks: [],
    ...overrides,
  };
  return compileAdapter(SiteAdapterSchema.parse(base));
}

// Snapshot baselines so we can detect leaks across tests.
function baselineDetectionRulesLength() {
  return DETECTION_RULES.length;
}

// ── 1. registerExtraRules / clearExtraRules contract ──────────────────

await test('registerExtraRules: returns opaque token + clearExtraRules removes it', () => {
  _clearAllExtraRules();
  const t = registerExtraRules([
    {
      labelRegex: /^smoke$/i,
      class: 'hard',
      lookupKey: 'identity.smoke',
      subclass: 'smoke',
      confidenceHint: 'high',
    },
  ]);
  assert.equal(typeof t, 'string');
  assert.equal(_extraRulesSize(), 1);
  clearExtraRules(t);
  assert.equal(_extraRulesSize(), 0);
});

await test('registerExtraRules: validates rule shape (rejects bad class / non-regex)', () => {
  assert.throws(() => registerExtraRules('not-array'), /must be an array/);
  assert.throws(
    () => registerExtraRules([{ labelRegex: 'string', class: 'hard', lookupKey: 'x' }]),
    /labelRegex RegExp/,
  );
  assert.throws(
    () => registerExtraRules([{ labelRegex: /x/, class: 'bogus', lookupKey: 'x' }]),
    /invalid class/,
  );
});

await test('clearExtraRules: double-clear throws', () => {
  _clearAllExtraRules();
  const t = registerExtraRules([
    { labelRegex: /x/, class: 'hard', lookupKey: 'x', confidenceHint: 'high' },
  ]);
  clearExtraRules(t);
  assert.throws(() => clearExtraRules(t), /unknown token/);
});

await test('classifyField: extra rule fires BEFORE HARD_PATTERNS', () => {
  _clearAllExtraRules();
  // Standard 'first name' would normally route to HARD with lookupKey
  // 'name.split[0]'. Inject an adapter rule that captures it differently.
  const t = registerExtraRules([
    {
      labelRegex: /^first name$/i,
      class: 'hard',
      lookupKey: 'adapter.test.first_name',
      subclass: 'adapter-first-name',
      confidenceHint: 'high',
    },
  ]);
  const result = classifyField({ role: 'textbox', name: 'First Name' });
  assert.equal(result.class, 'hard');
  assert.equal(result.lookupKey, 'adapter.test.first_name', 'adapter rule wins');
  assert.equal(result.subclass, 'adapter-first-name');
  assert.equal(result.source, 'adapter-known-field');
  clearExtraRules(t);
});

await test('classifyField: no extra-rule match falls through to standard HARD', () => {
  _clearAllExtraRules();
  const t = registerExtraRules([
    {
      labelRegex: /^never_matches$/i,
      class: 'hard',
      lookupKey: 'x',
      confidenceHint: 'high',
    },
  ]);
  const result = classifyField({ role: 'textbox', name: 'First Name' });
  assert.equal(result.class, 'hard');
  assert.equal(result.lookupKey, 'name.split[0]', 'standard HARD pattern still fires');
  clearExtraRules(t);
});

await test('classifyField: file-class extra rule on a textbox role does NOT fire (gated)', () => {
  _clearAllExtraRules();
  const t = registerExtraRules([
    { labelRegex: /resume/i, class: 'file', lookupKey: 'resume', confidenceHint: 'high' },
  ]);
  // role=textbox → file gate blocks; falls through. "resume" name will hit
  // the standard pipeline. There's no HARD/LEGAL match, no OPEN match
  // exactly; "resume" is a FILE_PATTERN but is also gated by role in the
  // standard sweep. textbox fall-through gives 'open' / 'unknown-open'.
  const result = classifyField({ role: 'textbox', name: 'Paste resume text' });
  assert.notEqual(result.class, 'file', 'file gate prevents wrong classification');
  clearExtraRules(t);
});

await test('classifyField: file-class extra rule on button role DOES fire', () => {
  _clearAllExtraRules();
  const t = registerExtraRules([
    { labelRegex: /^upload resume$/i, class: 'file', lookupKey: 'resume', confidenceHint: 'high' },
  ]);
  const result = classifyField({ role: 'button', name: 'Upload Resume' });
  assert.equal(result.class, 'file');
  assert.equal(result.source, 'adapter-known-field');
  clearExtraRules(t);
});

// ── 2. activateAdapter / deactivateAdapter ────────────────────────────

await test('activateAdapter: empty controls + known_fields → valid token, no rules pushed', () => {
  _clearAllExtraRules();
  const baseline = baselineDetectionRulesLength();
  const adapter = makeAdapter({});
  const token = activateAdapter(adapter);
  try {
    assert.equal(DETECTION_RULES.length, baseline, 'no DETECTION_RULES added');
    assert.equal(_extraRulesSize(), 0, 'no extra rules added');
    assert.equal(token.adapterId, 'testats');
    // REVIEW C2 fix: `token.reverted` no longer exists as a property
    // (was tamperable). Liveness check goes through isAdapterActive
    // (Set membership). Verify here.
    assert.ok(isAdapterActive('testats'), 'active before revert');
  } finally {
    token.revert();
  }
  assert.equal(isAdapterActive('testats'), false, 'inactive after revert');
});

await test('activateAdapter: pushes controls.date_picker into DETECTION_RULES', async () => {
  _clearAllExtraRules();
  const baseline = baselineDetectionRulesLength();
  const adapter = makeAdapter({
    controls: {
      date_picker: {
        control_type: 'flatpickr',
        detect: { class_contains: 'flatpickr-input' },
      },
    },
  });
  const token = activateAdapter(adapter);
  assert.equal(DETECTION_RULES.length, baseline + 1, 'one rule pushed');

  // Verify detection actually triggers
  const table = new MockTable({
    e1: {
      role: 'textbox',
      name: 'Start date',
      _attrs: {
        className: 'flatpickr-input some-other',
        dataset: {},
        tagName: 'INPUT',
        type: 'text',
        attrs: {},
      },
    },
  });
  const type = await detectControlType(MOCK_PAGE, 'e1', table, {});
  assert.equal(type, ControlType.FLATPICKR);

  token.revert();
  assert.equal(DETECTION_RULES.length, baseline, 'rule removed on revert');
});

await test('activateAdapter: control rule MISSING detect criteria is skipped (no force-route)', () => {
  _clearAllExtraRules();
  const baseline = baselineDetectionRulesLength();
  const adapter = makeAdapter({
    controls: {
      date_picker: { control_type: 'flatpickr' }, // no `detect` field
    },
  });
  const token = activateAdapter(adapter);
  assert.equal(DETECTION_RULES.length, baseline, 'no rule pushed when detect absent');
  token.revert();
});

await test('activateAdapter: known_fields injected as classifier extra rules', () => {
  _clearAllExtraRules();
  const adapter = makeAdapter({
    known_fields: [
      {
        label_pattern: '^company-specific question$',
        class: 'open',
        maps_to: 'qa-bank.csq',
        confidence: 'high',
      },
    ],
  });
  const token = activateAdapter(adapter);
  const result = classifyField({ role: 'textbox', name: 'Company-Specific Question' });
  assert.equal(result.class, 'open');
  assert.equal(result.lookupKey, 'qa-bank.csq');
  assert.equal(result.source, 'adapter-known-field');
  token.revert();
});

await test('deactivateAdapter: double-revert throws', () => {
  _clearAllExtraRules();
  const adapter = makeAdapter({
    known_fields: [
      { label_pattern: '^x$', class: 'hard', maps_to: 'identity.x', confidence: 'high' },
    ],
  });
  const token = activateAdapter(adapter);
  deactivateAdapter(token);
  assert.throws(() => deactivateAdapter(token), /already reverted/);
});

await test('Stack: activate A on top of B → both effective; deactivate A cleans only A', () => {
  _clearAllExtraRules();
  const baseline = baselineDetectionRulesLength();
  const adapterA = makeAdapter({
    id: 'aaa',
    detection: { url_patterns: ['a\\.com'] },
    controls: {
      date_picker: { control_type: 'flatpickr', detect: { class_contains: 'a-pick' } },
    },
    known_fields: [
      { label_pattern: '^q-a$', class: 'open', maps_to: 'a.q', confidence: 'high' },
    ],
  });
  const adapterB = makeAdapter({
    id: 'bbb',
    detection: { url_patterns: ['b\\.com'] },
    controls: {
      date_picker: { control_type: 'mui_datepicker', detect: { class_contains: 'b-pick' } },
    },
    known_fields: [
      { label_pattern: '^q-b$', class: 'open', maps_to: 'b.q', confidence: 'high' },
    ],
  });
  const tokA = activateAdapter(adapterA);
  const tokB = activateAdapter(adapterB);
  assert.equal(DETECTION_RULES.length, baseline + 2);
  assert.equal(_extraRulesSize(), 2);
  assert.ok(isAdapterActive('aaa'));
  assert.ok(isAdapterActive('bbb'));

  // Both classifier rules effective
  assert.equal(classifyField({ role: 'textbox', name: 'Q-A' }).lookupKey, 'a.q');
  assert.equal(classifyField({ role: 'textbox', name: 'Q-B' }).lookupKey, 'b.q');

  // Deactivate A — B's rules remain
  tokA.revert();
  assert.equal(DETECTION_RULES.length, baseline + 1, 'one rule remains (B)');
  assert.equal(_extraRulesSize(), 1);
  assert.equal(isAdapterActive('aaa'), false);
  assert.ok(isAdapterActive('bbb'));
  assert.notEqual(classifyField({ role: 'textbox', name: 'Q-A' }).lookupKey, 'a.q', 'A rule gone');
  assert.equal(classifyField({ role: 'textbox', name: 'Q-B' }).lookupKey, 'b.q', 'B rule intact');

  tokB.revert();
  assert.equal(DETECTION_RULES.length, baseline, 'all cleaned');
});

await test('isAdapterActive: tracks live tokens (multiple activations of same id)', () => {
  _clearAllExtraRules();
  const adapter = makeAdapter({
    known_fields: [
      { label_pattern: '^x$', class: 'hard', maps_to: 'a.x', confidence: 'high' },
    ],
  });
  const t1 = activateAdapter(adapter);
  const t2 = activateAdapter(adapter);
  assert.ok(isAdapterActive('testats'));
  assert.equal(_activeTokenCount(), 2, 'two tokens for same id');
  t1.revert();
  assert.ok(isAdapterActive('testats'), 'still active via t2');
  t2.revert();
  assert.equal(isAdapterActive('testats'), false);
});

await test('activateAdapter: control rule with tag_name + aria_role + class_contains ALL must match', async () => {
  _clearAllExtraRules();
  const baseline = baselineDetectionRulesLength();
  const adapter = makeAdapter({
    controls: {
      date_picker: {
        control_type: 'mui_datepicker',
        detect: { class_contains: 'MuiPicker', tag_name: 'INPUT', aria_role: 'textbox' },
      },
    },
  });
  const token = activateAdapter(adapter);

  // All three match → rule fires
  const tableYes = new MockTable({
    e1: {
      role: 'textbox',
      name: 'Date',
      _attrs: { className: 'MuiPicker-input root', tagName: 'INPUT', dataset: {}, type: 'text', attrs: {} },
    },
  });
  assert.equal(
    await detectControlType(MOCK_PAGE, 'e1', tableYes, {}),
    ControlType.MUI_DATEPICKER,
  );

  // Wrong tag → rule does NOT fire; falls back to ARIA-only
  const tableNo = new MockTable({
    e1: {
      role: 'textbox',
      name: 'Date',
      _attrs: { className: 'MuiPicker-input root', tagName: 'DIV', dataset: {}, type: '', attrs: {} },
    },
  });
  assert.equal(await detectControlType(MOCK_PAGE, 'e1', tableNo, {}), ControlType.TEXTBOX);

  token.revert();
  assert.equal(DETECTION_RULES.length, baseline);
});

await test('activateAdapter: bad adapter (missing id) throws', () => {
  assert.throws(() => activateAdapter(null), /CompiledAdapter/);
  assert.throws(() => activateAdapter({ name: 'X' }), /CompiledAdapter/);
});

// ── 3. Review-driven regression tests (CRITICAL + HIGH fixes) ─────────

await test('REVIEW C3: adapter rule UNSHIFTED to DETECTION_RULES (beats baseline)', async () => {
  _clearAllExtraRules();
  // Pre-register a "baseline" rule that always claims TEXTBOX. Adapter
  // should still beat it because adapter rules unshift to the front.
  const baselineRule = () => ControlType.TEXTBOX;
  DETECTION_RULES.push(baselineRule); // simulate m1-m3 baseline
  try {
    const adapter = makeAdapter({
      controls: {
        date_picker: {
          control_type: 'flatpickr',
          detect: { class_contains: 'flatpickr-input' },
        },
      },
    });
    const token = activateAdapter(adapter);
    const table = new MockTable({
      e1: {
        role: 'textbox',
        name: 'Date',
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
    assert.equal(type, ControlType.FLATPICKR, 'adapter beats baseline');
    token.revert();
  } finally {
    const idx = DETECTION_RULES.indexOf(baselineRule);
    if (idx >= 0) DETECTION_RULES.splice(idx, 1);
  }
});

await test('REVIEW C1: revert is atomic — _activeTokens.has is authoritative liveness', () => {
  _clearAllExtraRules();
  const adapter = makeAdapter({
    known_fields: [
      { label_pattern: '^x$', class: 'hard', maps_to: 'a.x', confidence: 'high' },
    ],
  });
  const token = activateAdapter(adapter);
  assert.ok(isAdapterActive('testats'));
  token.revert();
  assert.equal(isAdapterActive('testats'), false);
});

await test('REVIEW C2: token.revert is non-writable (cannot be shadowed)', () => {
  _clearAllExtraRules();
  const adapter = makeAdapter({
    known_fields: [
      { label_pattern: '^x$', class: 'hard', maps_to: 'a.x', confidence: 'high' },
    ],
  });
  const token = activateAdapter(adapter);
  assert.throws(() => {
    token.revert = () => {};
  }, TypeError);
  token.revert(); // still the real one
});

await test('REVIEW C1 (adv): _makeControlRule null-entry → null (does NOT crash)', async () => {
  _clearAllExtraRules();
  const adapter = makeAdapter({
    controls: {
      date_picker: {
        control_type: 'flatpickr',
        detect: { aria_role: 'textbox', class_contains: 'flatpickr-input' },
      },
    },
  });
  const token = activateAdapter(adapter);
  // The rule callback is the most-recently-prepended in DETECTION_RULES.
  const rule = DETECTION_RULES[0];
  assert.equal(rule(null, null), null, 'null entry + null info → null, no crash');
  assert.equal(rule({}, null), null, 'no info → null');
  assert.equal(rule(null, { className: 'flatpickr-input', tagName: 'INPUT' }), null);
  token.revert();
});

await test('REVIEW H2 (adv): partial activation rollback on known_fields validation throw', () => {
  _clearAllExtraRules();
  const baseline = baselineDetectionRulesLength();
  const adapter = makeAdapter({
    controls: {
      date_picker: { control_type: 'flatpickr', detect: { class_contains: 'fp' } },
    },
    // Skip schema validation by building raw — we want bad confidence to
    // slip into registerExtraRules and trip step 2's TypeError.
  });
  // Mutate the compiled adapter's known_fields to force a step-2 throw.
  // Adapter is deep-frozen so we have to construct a fresh shape.
  const tampered = {
    ...adapter,
    known_fields: [
      { labelRegex: /^x$/i, class: 'hard', maps_to: 'a.x', confidence: 'BOGUS_TIER' },
    ],
  };
  assert.throws(() => activateAdapter(tampered), /invalid confidenceHint/);
  // CRITICAL: even though step 1 pushed a control rule, step 2's throw
  // must roll it back. DETECTION_RULES length back to baseline.
  assert.equal(
    DETECTION_RULES.length,
    baseline,
    'step 1 rolled back on step 2 throw',
  );
});

await test('REVIEW H1 (adv): class_contains is token-aware, not substring', async () => {
  _clearAllExtraRules();
  const adapter = makeAdapter({
    controls: {
      date_picker: {
        control_type: 'flatpickr',
        detect: { class_contains: 'pick' }, // intentionally short
      },
    },
  });
  const token = activateAdapter(adapter);
  // 'not-a-picker' previously substring-matched 'pick' — should NOT now.
  const tableNo = new MockTable({
    e1: {
      role: 'textbox',
      name: 'X',
      _attrs: {
        className: 'not-a-picker',
        dataset: {},
        tagName: 'INPUT',
        type: 'text',
        attrs: {},
      },
    },
  });
  const typeNo = await detectControlType(MOCK_PAGE, 'e1', tableNo, {});
  assert.notEqual(typeNo, ControlType.FLATPICKR, 'substring "pick" inside compound class no longer matches');

  // But exact-token or `pick-*` prefix still matches.
  const tableYes = new MockTable({
    e1: {
      role: 'textbox',
      name: 'X',
      _attrs: {
        className: 'pick',
        dataset: {},
        tagName: 'INPUT',
        type: 'text',
        attrs: {},
      },
    },
  });
  assert.equal(await detectControlType(MOCK_PAGE, 'e1', tableYes, {}), ControlType.FLATPICKR);

  const tablePrefix = new MockTable({
    e1: {
      role: 'textbox',
      name: 'X',
      _attrs: {
        className: 'pick-day-root',
        dataset: {},
        tagName: 'INPUT',
        type: 'text',
        attrs: {},
      },
    },
  });
  assert.equal(await detectControlType(MOCK_PAGE, 'e1', tablePrefix, {}), ControlType.FLATPICKR);
  token.revert();
});

await test('REVIEW M2: registerExtraRules validates confidenceHint enum', () => {
  _clearAllExtraRules();
  assert.throws(
    () =>
      registerExtraRules([
        { labelRegex: /x/, class: 'hard', lookupKey: 'a.x', confidenceHint: 'EXTREME' },
      ]),
    /invalid confidenceHint/,
  );
});

// ── Summary ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
