#!/usr/bin/env node
// Smoke for 07-applier/04-multi-step-state-machine m2:
// siteAdapter.mjs (detectAdapter + ADAPTERS registry) +
// stepProbe.mjs (probeTotalSteps, findNextButton, isOnSubmitStep).
//
// Pure-Node — uses a minimal mock Page/Locator harness that mirrors the
// subset of Playwright's API stepProbe touches. No Chromium. ~1s.

import assert from 'node:assert/strict';

import {
  ADAPTERS,
  KNOWN_IDS,
  detectAdapter,
  getAdapter,
  resolveNextButtonHints,
  resolveProgressBarHints,
  resolveStepListHints,
  resolveSubmitHints,
} from '../src/career/applier/multistep/siteAdapter.mjs';
import {
  probeProgressBar,
  probeStepList,
  probeTotalSteps,
  findNextButton,
  isOnSubmitStep,
  LOCATOR_TIMEOUT_MS,
} from '../src/career/applier/multistep/stepProbe.mjs';

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

// ── Mock Page / Locator harness ──────────────────────────────────────
//
// Tests describe a "DOM" as a flat list of nodes:
//   { role, name?, attrs?, visible?, children? }
// children is only used for nested listitem-inside-list queries.

class MockLocator {
  constructor(matches) {
    this.matches = matches; // array of node descriptors
  }
  async count() { return this.matches.length; }
  first() { return new MockLocator(this.matches.slice(0, 1)); }
  nth(i) { return new MockLocator(this.matches[i] ? [this.matches[i]] : []); }
  async getAttribute(name) {
    const n = this.matches[0];
    if (!n || !n.attrs) return null;
    return n.attrs[name] ?? null;
  }
  async textContent() {
    const n = this.matches[0];
    return n?.text ?? null;
  }
  async isVisible() {
    const n = this.matches[0];
    if (!n) return false;
    return n.visible !== false; // default true
  }
  getByRole(role, opts = {}) {
    const items = (this.matches[0]?.children || []).filter((c) => c.role === role);
    return filterByName(new MockLocator(items), opts);
  }
}

function filterByName(loc, opts) {
  if (!opts || (opts.name == null && opts.exact == null)) return loc;
  const filter = (n) => {
    if (opts.name == null) return true;
    if (opts.name instanceof RegExp) return opts.name.test(n.name || '');
    if (typeof opts.name === 'string') {
      return opts.exact === false
        ? (n.name || '').toLowerCase().includes(opts.name.toLowerCase())
        : (n.name || '').toLowerCase() === opts.name.toLowerCase();
    }
    return false;
  };
  return new MockLocator(loc.matches.filter(filter));
}

function makePage(nodes) {
  return {
    nodes, // flat array
    getByRole(role, opts = {}) {
      const matches = nodes.filter((n) => n.role === role);
      return filterByName(new MockLocator(matches), opts);
    },
    locator(selector) {
      // Very minimal — only [role="X"] selectors are used
      const m = selector.match(/^\[role="([^"]+)"\]$/);
      if (m) {
        return new MockLocator(nodes.filter((n) => n.role === m[1]));
      }
      return new MockLocator([]);
    },
  };
}

// ── 1. detectAdapter URL routing ─────────────────────────────────────

await test('detectAdapter: Workday URLs → workday', () => {
  assert.equal(detectAdapter('https://anthropic.wd5.myworkdayjobs.com/External/job/ABC-123'), 'workday');
  assert.equal(detectAdapter('https://workdayjobs.com/...'), 'workday');
});

await test('detectAdapter: iCIMS URLs → icims', () => {
  assert.equal(detectAdapter('https://jobs.icims.com/jobs/12345/apply'), 'icims');
  assert.equal(detectAdapter('https://example-tenant.icims.com/jobs/X'), 'icims');
});

await test('detectAdapter: SuccessFactors URLs → successfactors', () => {
  assert.equal(detectAdapter('https://career5.successfactors.com/career/jobReqId=1'), 'successfactors');
});

await test('detectAdapter: unknown/empty/non-string → generic', () => {
  assert.equal(detectAdapter('https://greenhouse.io/jobs/X'), 'generic');
  assert.equal(detectAdapter(''), 'generic');
  assert.equal(detectAdapter(null), 'generic');
  assert.equal(detectAdapter(undefined), 'generic');
  assert.equal(detectAdapter(42), 'generic');
});

// ── 2. Adapter registry ──────────────────────────────────────────────

await test('ADAPTERS: 4 entries with required fields', () => {
  assert.equal(ADAPTERS.length, 4);
  for (const a of ADAPTERS) {
    assert.ok(a.id);
    assert.ok(a.urlPattern instanceof RegExp);
    assert.ok(Array.isArray(a.nextButtonHints) && a.nextButtonHints.length >= 1);
    assert.ok(Array.isArray(a.submitHints) && a.submitHints.length >= 1);
    assert.ok(Object.isFrozen(a));
  }
});

await test('getAdapter: known id returns descriptor; unknown throws', () => {
  assert.equal(getAdapter('workday').id, 'workday');
  assert.throws(() => getAdapter('lever'), /unknown adapter/);
});

await test('resolveNextButtonHints / resolveSubmitHints: accept id OR descriptor', () => {
  const a = getAdapter('workday');
  assert.deepEqual(resolveNextButtonHints('workday'), a.nextButtonHints);
  assert.deepEqual(resolveNextButtonHints(a), a.nextButtonHints);
  assert.ok(resolveSubmitHints('workday').includes('Submit'));
  assert.ok(resolveProgressBarHints('workday').length >= 1);
  assert.ok(resolveStepListHints('workday').length >= 1);
});

// ── 3. probeProgressBar (Strategy 1) ─────────────────────────────────

await test('probeProgressBar: aria-valuetext "Step 3 of 7" → {current:3, total:7}', async () => {
  const page = makePage([
    { role: 'progressbar', attrs: { 'aria-valuetext': 'Step 3 of 7' } },
  ]);
  const result = await probeProgressBar(page);
  assert.deepEqual(result, { current: 3, total: 7 });
});

await test('probeProgressBar: aria-valuetext "page 2 of 5" → {current:2, total:5}', async () => {
  const page = makePage([
    { role: 'progressbar', attrs: { 'aria-valuetext': 'page 2 of 5' } },
  ]);
  const result = await probeProgressBar(page);
  assert.deepEqual(result, { current: 2, total: 5 });
});

await test('probeProgressBar: short form "3/7" → {current:3, total:7}', async () => {
  const page = makePage([
    { role: 'progressbar', attrs: { 'aria-valuetext': '3/7' } },
  ]);
  const result = await probeProgressBar(page);
  assert.deepEqual(result, { current: 3, total: 7 });
});

await test('probeProgressBar: aria-valuenow + aria-valuemax fallback', async () => {
  const page = makePage([
    { role: 'progressbar', attrs: { 'aria-valuenow': '4', 'aria-valuemax': '10' } },
  ]);
  const result = await probeProgressBar(page);
  assert.deepEqual(result, { current: 4, total: 10 });
});

await test('probeProgressBar: no progressbar → null', async () => {
  const page = makePage([]);
  const result = await probeProgressBar(page);
  assert.equal(result, null);
});

await test('probeProgressBar: unparseable valuetext + no numeric fallback → null', async () => {
  const page = makePage([
    { role: 'progressbar', attrs: { 'aria-valuetext': 'Loading...' } },
  ]);
  const result = await probeProgressBar(page);
  assert.equal(result, null);
});

// ── 4. probeStepList (Strategy 2) ────────────────────────────────────

await test('probeStepList: list with 5 listitems → {total:5}', async () => {
  const page = makePage([
    {
      role: 'list',
      name: 'Application Steps',
      children: [
        { role: 'listitem', name: 'Personal Info' },
        { role: 'listitem', name: 'Resume' },
        { role: 'listitem', name: 'Voluntary Disclosures' },
        { role: 'listitem', name: 'Review' },
        { role: 'listitem', name: 'Submit' },
      ],
    },
  ]);
  const result = await probeStepList(page, getAdapter('workday'));
  assert.deepEqual(result, { total: 5 });
});

await test('probeStepList: no list matching adapter hints → null', async () => {
  const page = makePage([
    { role: 'list', name: 'unrelated nav', children: [] },
  ]);
  const result = await probeStepList(page, getAdapter('workday'));
  assert.equal(result, null);
});

await test('probeStepList: list with 0 listitems → null', async () => {
  const page = makePage([
    { role: 'list', name: 'Application Steps', children: [] },
  ]);
  const result = await probeStepList(page, getAdapter('workday'));
  assert.equal(result, null);
});

// ── 5. probeTotalSteps combined strategy fallback ────────────────────

await test('probeTotalSteps: progressbar wins → source=progressbar', async () => {
  const page = makePage([
    { role: 'progressbar', attrs: { 'aria-valuetext': 'Step 1 of 4' } },
    {
      role: 'list',
      name: 'Application Steps',
      children: Array.from({ length: 99 }, (_, i) => ({ role: 'listitem', name: `s${i}` })),
    },
  ]);
  const result = await probeTotalSteps(page, 'workday');
  assert.equal(result.source, 'progressbar', 'progressbar takes precedence');
  assert.equal(result.total, 4);
  assert.equal(result.current, 1);
});

await test('probeTotalSteps: no progressbar, sidebar present → source=sidebar', async () => {
  const page = makePage([
    {
      role: 'list',
      name: 'Application Steps',
      children: Array.from({ length: 3 }, (_, i) => ({ role: 'listitem', name: `s${i}` })),
    },
  ]);
  const result = await probeTotalSteps(page, 'workday');
  assert.equal(result.source, 'sidebar');
  assert.equal(result.total, 3);
});

await test('probeTotalSteps: neither → source=exploratory, total=null', async () => {
  const page = makePage([
    { role: 'button', name: 'Next' },
  ]);
  const result = await probeTotalSteps(page, 'workday');
  assert.equal(result.source, 'exploratory');
  assert.equal(result.total, null);
});

await test('probeTotalSteps: accepts adapter descriptor OR id string', async () => {
  const page = makePage([
    { role: 'progressbar', attrs: { 'aria-valuetext': 'Step 1 of 2' } },
  ]);
  const r1 = await probeTotalSteps(page, 'icims');
  const r2 = await probeTotalSteps(page, getAdapter('icims'));
  assert.deepEqual(r1, r2);
});

// ── 6. findNextButton ────────────────────────────────────────────────

await test('findNextButton: "Next" button present → returns {locator, hint:"Next"}', async () => {
  const page = makePage([
    { role: 'button', name: 'Next', visible: true },
  ]);
  const result = await findNextButton(page, 'workday');
  assert.ok(result);
  assert.equal(result.hint, 'Next');
});

await test('findNextButton: only "Save and Continue" → matches via that hint', async () => {
  const page = makePage([
    { role: 'button', name: 'Save and Continue', visible: true },
  ]);
  const result = await findNextButton(page, 'workday');
  assert.ok(result);
  assert.equal(result.hint, 'Save and Continue');
});

await test('findNextButton: no Next-like button → null', async () => {
  const page = makePage([
    { role: 'button', name: 'Back', visible: true },
    { role: 'button', name: 'Submit', visible: true },
  ]);
  const result = await findNextButton(page, 'workday');
  assert.equal(result, null);
});

await test('findNextButton: skips invisible duplicates', async () => {
  const page = makePage([
    { role: 'button', name: 'Next', visible: false },
    { role: 'button', name: 'Next', visible: true },
  ]);
  const result = await findNextButton(page, 'workday');
  assert.ok(result, 'should pick the visible Next button');
});

await test('findNextButton: case-insensitive match ("NEXT" all caps)', async () => {
  const page = makePage([
    { role: 'button', name: 'NEXT', visible: true },
  ]);
  const result = await findNextButton(page, 'workday');
  assert.ok(result);
});

// ── 7. isOnSubmitStep ────────────────────────────────────────────────

await test('isOnSubmitStep: "Submit Application" present → true', async () => {
  const page = makePage([
    { role: 'button', name: 'Submit Application', visible: true },
  ]);
  assert.equal(await isOnSubmitStep(page, 'workday'), true);
});

await test('isOnSubmitStep: just "Submit" present → true', async () => {
  const page = makePage([
    { role: 'button', name: 'Submit', visible: true },
  ]);
  assert.equal(await isOnSubmitStep(page, 'workday'), true);
});

await test('isOnSubmitStep: only Next → false', async () => {
  const page = makePage([
    { role: 'button', name: 'Next', visible: true },
  ]);
  assert.equal(await isOnSubmitStep(page, 'workday'), false);
});

await test('isOnSubmitStep: invisible Submit → false (not actually at submit step)', async () => {
  const page = makePage([
    { role: 'button', name: 'Submit', visible: false },
  ]);
  assert.equal(await isOnSubmitStep(page, 'workday'), false);
});

// ── 8. Timeout / hung locator resilience ─────────────────────────────

await test('LOCATOR_TIMEOUT_MS is exported and reasonable', () => {
  assert.ok(LOCATOR_TIMEOUT_MS >= 1000 && LOCATOR_TIMEOUT_MS <= 30000);
});

await test('probeProgressBar: getByRole throws → returns null (no crash)', async () => {
  const badPage = {
    getByRole() {
      throw new Error('exploded');
    },
    locator() {
      return new MockLocator([]);
    },
  };
  const result = await probeProgressBar(badPage);
  assert.equal(result, null);
});

await test('findNextButton: getByRole throws → returns null', async () => {
  const badPage = {
    getByRole() {
      throw new Error('exploded');
    },
    locator() {
      return new MockLocator([]);
    },
  };
  const result = await findNextButton(badPage, 'workday');
  assert.equal(result, null);
});

await test('probeTotalSteps: both strategies throw → exploratory (no crash)', async () => {
  const badPage = {
    getByRole() {
      throw new Error('exploded');
    },
    locator() {
      return new MockLocator([]);
    },
  };
  const result = await probeTotalSteps(badPage, 'workday');
  assert.equal(result.source, 'exploratory');
  assert.equal(result.total, null);
});

// ── 9. Review-fix coverage ───────────────────────────────────────────

await test('M1: hostname-only match rejects path-injected substrings', () => {
  // URL with "workdayjobs" only in path — not hostname → generic
  assert.equal(detectAdapter('https://example.com/workdayjobs-clone'), 'generic');
  // URL with workdayjobs.com inside hostname (subdomain) → still matches
  assert.equal(detectAdapter('https://anthropic.wd5.myworkdayjobs.com/x'), 'workday');
  // Malformed URL falls back to substring match on raw string (still finds it)
  assert.equal(detectAdapter('myworkdayjobs.com/x'), 'workday');
});

await test('M4: KNOWN_IDS subset of m1 SITE_ADAPTERS — exported + matches ADAPTERS', () => {
  assert.deepEqual(KNOWN_IDS, ['workday', 'icims', 'successfactors', 'generic']);
  for (const a of ADAPTERS) {
    assert.ok(KNOWN_IDS.includes(a.id));
  }
});

await test('H1: isOnSubmitStep does NOT false-match "Apply Filter" (substring contamination)', async () => {
  // Pure "Apply" alone would substring-match before the H1 anchor fix;
  // after the fix only exact (case-insensitive) "Apply" matches.
  const page = makePage([
    { role: 'button', name: 'Apply Filter', visible: true },
  ]);
  assert.equal(await isOnSubmitStep(page, 'successfactors'), false);
});

await test('H1: isOnSubmitStep still matches exact "Apply" (successfactors submit)', async () => {
  const page = makePage([
    { role: 'button', name: 'Apply', visible: true },
  ]);
  assert.equal(await isOnSubmitStep(page, 'successfactors'), true);
});

await test('H1: isOnSubmitStep does NOT false-match "Submit feedback"', async () => {
  const page = makePage([
    { role: 'button', name: 'Submit feedback', visible: true },
  ]);
  assert.equal(await isOnSubmitStep(page, 'workday'), false);
});

await test('H2: probeProgressBar rejects garbage current > total', async () => {
  const page = makePage([
    { role: 'progressbar', attrs: { 'aria-valuetext': 'Step 12 of 7' } },
  ]);
  const r = await probeProgressBar(page);
  assert.equal(r, null, 'current > total should fall through');
});

await test('H2: probeProgressBar rejects current=0', async () => {
  const page = makePage([
    { role: 'progressbar', attrs: { 'aria-valuetext': 'Step 0 of 5' } },
  ]);
  const r = await probeProgressBar(page);
  assert.equal(r, null);
});

await test('H2: probeProgressBar accepts current=total (final step)', async () => {
  const page = makePage([
    { role: 'progressbar', attrs: { 'aria-valuetext': 'Step 5 of 5' } },
  ]);
  const r = await probeProgressBar(page);
  assert.deepEqual(r, { current: 5, total: 5 });
});

await test('H2: probeProgressBar rejects garbage in valuenow/max path too', async () => {
  const page = makePage([
    { role: 'progressbar', attrs: { 'aria-valuenow': '99', 'aria-valuemax': '5' } },
  ]);
  const r = await probeProgressBar(page);
  assert.equal(r, null);
});

await test('M6: probeProgressBar hung Locator → returns null within timeout', async () => {
  const hungPage = {
    getByRole() {
      return {
        count: () => new Promise(() => {}), // never resolves
        nth: () => ({
          getAttribute: () => new Promise(() => {}),
        }),
      };
    },
    locator() {
      return new MockLocator([]);
    },
  };
  const t0 = Date.now();
  const r = await probeProgressBar(hungPage);
  const elapsed = Date.now() - t0;
  assert.equal(r, null);
  // Should return within LOCATOR_TIMEOUT_MS + small overhead (not hang forever)
  assert.ok(elapsed < LOCATOR_TIMEOUT_MS + 2000, `should timeout, elapsed ${elapsed}ms`);
}, { timeout: 10000 });

console.log(`\n✅ All ${passed} smoke tests passed.`);
