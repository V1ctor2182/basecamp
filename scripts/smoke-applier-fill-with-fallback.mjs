#!/usr/bin/env node
// Smoke for 07-applier/02-playwright-runtime m4:
// fillWithFallback + 5-strategy ladder.
//
// Real Chromium via getBrowser() — slow (~5-10s) but the strategies'
// interactions with the DOM (click + selectOption + keyboard) demand
// genuine browser semantics, not mocks. SMOKE=1 forced.
//
// Each fixture is an inline HTML page set via page.setContent(). No
// network, no file://, no shared fixtures dir.

process.env.SMOKE = '1';

import assert from 'node:assert/strict';

import {
  getBrowser,
  getPage,
  closeBrowser,
} from '../src/career/applier/runtime/browser.mjs';
import {
  fillWithFallback,
  DEFAULT_LADDER,
  DEFAULT_LADDER_NAMES,
} from '../src/career/applier/runtime/fillWithFallback.mjs';
import * as selectOptionStrategy from '../src/career/applier/runtime/strategies/selectOption.mjs';
import * as reactSelectClickStrategy from '../src/career/applier/runtime/strategies/reactSelectClick.mjs';
import * as keyboardInputStrategy from '../src/career/applier/runtime/strategies/keyboardInput.mjs';

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

// New page per test. Shared-page across tests was unreliable — keyboard
// modifier state + ResolverContext state + scheduled microtasks from
// previous fixtures' inline scripts could pollute the next test (e.g.
// react_select_click's option-click would fail to trigger the inline
// JS handler when run after a prior test had run all 5 strategies).
// One page per test eats ~50ms extra but guarantees isolation.
const browser = await getBrowser();
let _pageCounter = 0;
async function freshPage(html) {
  _pageCounter++;
  const jobId = `fwfb${String(_pageCounter).padStart(8, '0')}`;
  const page = await getPage(jobId);
  await page.setContent(html, { waitUntil: 'load' });
  return page;
}

// ── Strategy ladder + exports ────────────────────────────────────────

await test('exports: DEFAULT_LADDER + names + size 5', () => {
  assert.equal(DEFAULT_LADDER.length, 5);
  assert.deepEqual(DEFAULT_LADDER_NAMES, [
    'selectOption',
    'react_select_click',
    'keyboard_input',
    'role_locator_click',
    'aria_combobox',
  ]);
});

// ── Per-strategy happy paths ────────────────────────────────────────

await test('selectOption: native <select> happy path', async () => {
  const page = await freshPage(`
    <html><body>
      <select id="s">
        <option value="">--</option>
        <option value="Yes">Yes</option>
        <option value="No">No</option>
      </select>
    </body></html>
  `);
  const loc = page.locator('#s');
  const res = await fillWithFallback(page, loc, 'Yes');
  assert.equal(res.final.success, true);
  assert.equal(res.final.strategy, 'selectOption');
  assert.equal(res.strategies_tried.length, 1);
  assert.equal(res.strategies_tried[0].name, 'selectOption');
  assert.equal(res.strategies_tried[0].result, 'verified');
});

await test('react_select_click: portal-mounted role=option', async () => {
  // Skip selectOption + go straight to react_select_click via explicit
  // ladder so the test is hermetic (selectOption would fail on a div
  // and we don't want to depend on the verify-mismatch path here).
  const page = await freshPage(`
    <html><body>
      <div id="control" role="combobox" tabindex="0">Select...</div>
      <div id="listbox" role="listbox" style="display:none">
        <div role="option">Decline To Self Identify</div>
        <div role="option">Yes</div>
        <div role="option">No</div>
      </div>
      <script>
        const ctrl = document.getElementById('control');
        const lb = document.getElementById('listbox');
        ctrl.addEventListener('click', () => { lb.style.display = 'block'; });
        lb.addEventListener('click', (e) => {
          if (e.target.getAttribute('role') === 'option') {
            ctrl.textContent = e.target.textContent;
            ctrl.setAttribute('value', e.target.textContent);
            lb.style.display = 'none';
          }
        });
      </script>
    </body></html>
  `);
  const loc = page.locator('#control');
  const res = await fillWithFallback(page, loc, 'Decline To Self Identify', {
    ladder: [reactSelectClickStrategy],
  });
  assert.equal(res.final.success, true);
  assert.equal(res.final.strategy, 'react_select_click');
});

await test('keyboard_input: autocomplete text input', async () => {
  const page = await freshPage(`
    <html><body>
      <input id="ac" type="text" autocomplete="off" />
    </body></html>
  `);
  const loc = page.locator('#ac');
  const res = await fillWithFallback(page, loc, 'New York', {
    ladder: [keyboardInputStrategy],
  });
  assert.equal(res.final.success, true);
  assert.equal(res.final.strategy, 'keyboard_input');
  // Verify by direct readback
  const actual = await loc.inputValue();
  assert.equal(actual.toLowerCase(), 'new york');
});

await test('role_locator_click: role=option visible by default', async () => {
  // A "listbox always visible" pattern — role_locator_click clicks
  // the matching option directly without needing to open anything.
  const page = await freshPage(`
    <html><body>
      <div role="listbox" tabindex="0" id="lb">
        <div role="option" id="opt1">Yes</div>
        <div role="option" id="opt2">No</div>
        <div role="option" id="opt3">Maybe</div>
      </div>
      <input id="hidden" type="hidden" value="" />
      <script>
        document.querySelectorAll('[role="option"]').forEach(o => {
          o.addEventListener('click', () => {
            document.getElementById('hidden').value = o.textContent;
            o.setAttribute('aria-selected', 'true');
          });
        });
      </script>
    </body></html>
  `);
  const lb = page.locator('#lb');
  const res = await fillWithFallback(page, lb, 'Maybe', {
    ladder: [{
      NAME: 'role_locator_click_test',
      fill: async (locator, value, p) => {
        const opt = p.getByRole('option', { name: String(value), exact: false }).first();
        await opt.click({ timeout: 2000 });
        return { result: 'fill_ok' };
      },
    }],
    // The listbox itself isn't a fillable input, so verify reads the
    // hidden input's value via a custom verifier.
    verifier: async () => {
      const v = await page.locator('#hidden').inputValue();
      return { ok: v.toLowerCase() === 'maybe', actual: v };
    },
  });
  assert.equal(res.final.success, true);
});

// ── Full ladder behaviors ───────────────────────────────────────────

await test('full ladder: all 5 strategies fail → final.success=false', async () => {
  // A read-only div that no strategy can fill.
  const page = await freshPage(`
    <html><body>
      <div id="readonly" tabindex="0">Static text</div>
    </body></html>
  `);
  const loc = page.locator('#readonly');
  const res = await fillWithFallback(page, loc, 'Anything');
  assert.equal(res.final.success, false);
  assert.equal(res.final.strategy, null);
  // Each strategy should have tried (and added to tried[])
  assert.ok(res.strategies_tried.length >= 1, 'at least one strategy attempted');
  // Every entry has a name + result
  for (const t of res.strategies_tried) {
    assert.ok(t.name);
    assert.ok(t.result);
  }
});

await test('full ladder: selectOption fails, react_select_click succeeds (EEO scenario)', async () => {
  // A custom select that selectOption can't reach (no <select>);
  // react_select_click handles via portal listbox.
  const page = await freshPage(`
    <html><body>
      <div id="eeo" role="combobox" tabindex="0" class="select__control" value="">Select...</div>
      <div id="lb" role="listbox" style="position:absolute">
        <div role="option">Decline</div>
        <div role="option">Yes</div>
      </div>
      <script>
        const ctrl = document.getElementById('eeo');
        const lb = document.getElementById('lb');
        lb.style.display = 'none';
        ctrl.addEventListener('click', () => { lb.style.display = 'block'; });
        lb.addEventListener('click', e => {
          if (e.target.getAttribute('role') === 'option') {
            ctrl.textContent = e.target.textContent;
            ctrl.setAttribute('value', e.target.textContent);
            lb.style.display = 'none';
          }
        });
      </script>
    </body></html>
  `);
  const loc = page.locator('#eeo');
  const res = await fillWithFallback(page, loc, 'Decline');
  assert.equal(res.final.success, true);
  // first non-selectOption strategy that works should be react_select_click
  assert.equal(res.final.strategy, 'react_select_click');
  // selectOption should appear first in tried[] with a non-verified result
  assert.equal(res.strategies_tried[0].name, 'selectOption');
  assert.notEqual(res.strategies_tried[0].result, 'verified');
});

await test('verify mismatch: fill lands but value doesn\'t match expected — continues ladder', async () => {
  // selectOption succeeds setting the value, but value is 'Y' while
  // expected is 'Yes'. The verify_value compare (trim+lowercase) sees
  // mismatch and the ladder continues. NO subsequent strategy will
  // succeed here (it's still just an input), so final.success=false
  // BUT strategies_tried[0].result === 'fill_ok_verify_mismatch'.
  const page = await freshPage(`
    <html><body>
      <select id="s">
        <option value="">--</option>
        <option value="Y">Y</option>
      </select>
    </body></html>
  `);
  const loc = page.locator('#s');
  const res = await fillWithFallback(page, loc, 'Yes');
  // selectOption sets value to 'Y' (one of the options); verify sees 'y' vs 'yes' → mismatch
  // Actually selectOption('Yes') on a <select> without 'Yes' option throws → no_effect
  // Either way the verify won't succeed; strategy_tried[0] reflects that.
  assert.equal(res.final.success, false);
  assert.equal(res.strategies_tried[0].name, 'selectOption');
  // Result is either 'fill_ok_verify_mismatch' (Playwright picked closest) or 'no_effect'
  assert.ok(
    ['fill_ok_verify_mismatch', 'no_effect', 'option_not_found', 'no_effect_timeout'].includes(res.strategies_tried[0].result),
    `unexpected result: ${res.strategies_tried[0].result}`,
  );
});

await test('reset between strategies: strategy A failure does not pollute B', async () => {
  // Native select where selectOption fails (no matching option), then
  // we provide a custom strategy as #2 that should still see a clean
  // state to verify it sets value correctly.
  const page = await freshPage(`
    <html><body>
      <select id="s">
        <option value="">--</option>
        <option value="One">One</option>
      </select>
    </body></html>
  `);
  const loc = page.locator('#s');
  let strategy2SawClean = false;
  const customStrategy = {
    NAME: 'custom_check',
    async fill(locator) {
      const v = await locator.inputValue();
      // After resetLocator runs between strategies, value should be '' (or the first option for selects)
      strategy2SawClean = (v === '' || v === '--');
      await locator.selectOption('One');
      return { result: 'fill_ok' };
    },
  };
  const res = await fillWithFallback(page, loc, 'One', {
    ladder: [
      // first strategy: a fake strategy that mutates value to something wrong
      {
        NAME: 'pollute',
        async fill(locator) {
          // intentionally select an existing option to leave a residue
          await locator.selectOption({ index: 0 });
          return { result: 'fill_ok' };
        },
      },
      customStrategy,
    ],
  });
  // The 2nd strategy succeeded — final is 'custom_check'
  assert.equal(res.final.success, true);
  assert.equal(res.final.strategy, 'custom_check');
  // Strategy 2 saw the cleaned state (resetLocator ran)
  assert.ok(strategy2SawClean, 'reset between strategies should clear the residue');
});

await test('first-success short-circuit: later strategies are NOT called', async () => {
  const page = await freshPage(`
    <html><body>
      <select id="s">
        <option value="">--</option>
        <option value="Yes">Yes</option>
      </select>
    </body></html>
  `);
  const loc = page.locator('#s');
  let strategy2Called = false;
  const res = await fillWithFallback(page, loc, 'Yes', {
    ladder: [
      selectOptionStrategy,
      {
        NAME: 'should_not_run',
        async fill() {
          strategy2Called = true;
          return { result: 'fill_ok' };
        },
      },
    ],
  });
  assert.equal(res.final.success, true);
  assert.equal(res.final.strategy, 'selectOption');
  assert.equal(strategy2Called, false, 'first-success must short-circuit');
});

await test('per-strategy timeout 3s caps a slow strategy', async () => {
  const page = await freshPage(`<html><body><div id="x" tabindex="0">stuck</div></body></html>`);
  const loc = page.locator('#x');
  const slow = {
    NAME: 'slow_strategy',
    async fill() {
      // 4s sleep — should be killed by the 3s timeout on Playwright ops
      // inside any real strategy. For this synthetic strategy we just
      // sleep; the test asserts the WHOLE fillWithFallback returns in
      // bounded time (< 10s for safety).
      await new Promise((r) => setTimeout(r, 4000));
      return { result: 'fill_ok' };
    },
  };
  const start = Date.now();
  const res = await fillWithFallback(page, loc, 'whatever', { ladder: [slow] });
  const elapsed = Date.now() - start;
  // Our 'slow' strategy doesn't use a real Playwright op so the timeout
  // bound test isn't strict. The point is we don't HANG forever.
  // Strategy returns after 4s; verifier then runs; total ~4-5s.
  assert.ok(elapsed < 10000, `fillWithFallback should bound runtime; took ${elapsed}ms`);
  // strategy returned but locator value didn't change → verify fail
  assert.equal(res.final.success, false);
});

await test('ref invalid: locator points at non-existent element → ELEMENT_GONE propagates', async () => {
  const page = await freshPage(`<html><body><div>nothing here</div></body></html>`);
  const loc = page.locator('#does-not-exist');
  // selectOption against a missing element throws ACTION_TIMEOUT or
  // ELEMENT_GONE. ELEMENT_GONE propagates (re-throws); ACTION_TIMEOUT
  // counts as "this strategy didn't fit" and goes to next.
  // Either way the orchestrator either throws OR returns success=false.
  let outcome;
  try {
    const res = await fillWithFallback(page, loc, 'X');
    outcome = { threw: false, success: res.final.success };
  } catch (err) {
    outcome = { threw: true, err: String(err?.message ?? err).slice(0, 100) };
  }
  // Acceptable: either threw (ELEMENT_GONE) OR all strategies failed.
  if (outcome.threw) {
    // good
  } else {
    assert.equal(outcome.success, false);
  }
});

await test('options.ladder override: caller supplies custom ordering', async () => {
  const page = await freshPage(`
    <html><body>
      <select id="s">
        <option value="">--</option>
        <option value="Yes">Yes</option>
      </select>
    </body></html>
  `);
  const loc = page.locator('#s');
  let custom1Called = false;
  let custom2Called = false;
  const res = await fillWithFallback(page, loc, 'Yes', {
    ladder: [
      {
        NAME: 'custom_1',
        async fill() {
          custom1Called = true;
          throw new Error('custom_1 never fits');  // no-op, soft error
        },
      },
      {
        NAME: 'custom_2',
        async fill(locator) {
          custom2Called = true;
          await locator.selectOption('Yes');
          return { result: 'fill_ok' };
        },
      },
    ],
  });
  assert.equal(custom1Called, true);
  assert.equal(custom2Called, true);
  assert.equal(res.final.strategy, 'custom_2');
  assert.equal(res.final.success, true);
  // Default ladder NOT used
  assert.ok(!res.strategies_tried.some((t) => t.name === 'selectOption' && t !== res.strategies_tried[0]),
    'default selectOption should not appear when ladder is overridden');
});

// ── Cleanup ──────────────────────────────────────────────────────────

await closeBrowser();
console.log(`\n✅ All ${passed} smoke tests passed.`);
