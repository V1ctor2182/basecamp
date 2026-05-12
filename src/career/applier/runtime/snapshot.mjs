// Snapshot serializer — enumerate interactive a11y nodes via CDP, emit
// compact one-line-per-node text + build a RefTable of symbolic refs.
//
// 07-applier/08-snapshot-refs-layer m1.
//
// Output contract (LLM-facing):
//
//     - heading "First Name" [ref=e1]
//     - textbox "First Name" [ref=e2] [required]
//     - textbox "Email" [ref=e3]
//     - button "Submit" [ref=e4]
//
// Token budget: 200-400 tokens for a typical Greenhouse apply page, vs
// 7000-8000 tokens for a raw a11y dump or DOM HTML. This is the entire
// IP ported from Vercel agent-browser — the prompt format that makes
// LLM-driven browser automation cheap + reliable.
//
// m1 scope (this file):
//   - INTERACTIVE_ROLES allowlist (9 roles per locked Q2)
//   - Single-frame snapshot (top-level page only; m2 adds iframe inline)
//   - One-line text emission with optional ARIA state suffix
//   - Icon-button name fallback chain: aria-label → title → skip (Q4)
//   - Occurrence-index disambiguator (Q8) — incremented per (role, name)
//     pair so RefTable.resolve can use getByRole.nth()
//
// CDP fact (verified 2026-05-12): Playwright v1.50+ removed
// page.accessibility.snapshot(); we route through CDPSession.send(
// 'Accessibility.getFullAXTree'). One CDPSession per Page, cached.

import { RefTable } from './refTable.mjs';

// Interactive roles allowlist — start conservative; 09-snapshot-eval-harness
// will tune via deterministic auto-tuner once we have real ATS fixture
// data. Order doesn't matter (set semantics) but kept stable for log diff.
export const INTERACTIVE_ROLES = Object.freeze([
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
const INTERACTIVE_SET = new Set(INTERACTIVE_ROLES);

// ARIA state props we emit in the text suffix. Only those with semantic
// load (changes how an LLM should interpret the field), not redundant
// signals (e.g. "focused" — LLM doesn't care). C2 still satisfied: no
// DOM ids / classes / XPaths / data-* attrs leak.
const EMITTED_STATES = ['required', 'checked', 'selected', 'expanded', 'disabled'];

// Per-Page CDPSession cache. WeakMap so closed Pages get GC'd naturally.
/** @type {WeakMap<import('playwright').Page, import('playwright').CDPSession>} */
const _cdpSessions = new WeakMap();
// H4 fix: Accessibility.enable is per-CDPSession, not per-Page. Keying on
// CDPSession lets downstream Rooms (which may mint their own CDPSessions
// for Network/DOM domains) maintain their own enable state.
/** @type {WeakSet<import('playwright').CDPSession>} */
const _enabledSessions = new WeakSet();

async function getCDPSession(page) {
  const cached = _cdpSessions.get(page);
  if (cached) return cached;
  const cdp = await page.context().newCDPSession(page);
  _cdpSessions.set(page, cdp);
  // H3 fix: when Page closes, evict stale CDPSession from cache so the
  // next snapshot() on a fresh Page doesn't pick up a closed transport.
  page.once('close', () => {
    _cdpSessions.delete(page);
  });
  return cdp;
}

async function ensureAccessibilityEnabled(cdp) {
  if (_enabledSessions.has(cdp)) return;
  await cdp.send('Accessibility.enable');
  _enabledSessions.add(cdp);
}

// Hard ceiling on Accessibility.getFullAXTree — extremely large or
// pathological pages have hung in the wild. (M3 fix.)
const SNAPSHOT_TIMEOUT_MS = 15_000;

/**
 * Resolve an AX node's "accessible name" — the human-readable label LLM
 * uses to identify the field. Fallback chain per Q4:
 *   1. AX tree's name.value (Chrome's computation; covers <label>, aria-label,
 *      placeholder, text content, etc.)
 *   2. (covered by AX tree via aria-label property — Chrome includes it)
 *   3. title attribute (rarely usable but better than nothing)
 *   4. Skip (return null → caller filters out)
 *
 * In practice the AX tree's name.value covers 99% of cases — Chrome's
 * accessible-name computation already walks aria-labelledby / aria-label /
 * <label for=> / placeholder / text content. We only need the title-attr
 * fallback for some Workday icon buttons.
 */
function resolveAccessibleName(axNode) {
  const fromAx = axNode.name?.value;
  if (!fromAx) return null;
  // M2 fix: strip Unicode control + zero-width chars BEFORE deciding
  // "is it usable" — otherwise a name that's just U+200B passes the
  // non-empty check but produces an empty display string.
  const normalized = normalizeName(fromAx);
  if (!normalized) return null;
  // Title fallback — we don't have direct AX tree access to the title attr
  // in m1 (would require a DOM.getAttributes round-trip per node). m2 can
  // wire that up if 09-snapshot-eval-harness shows Workday icon-only buttons
  // are slipping through. For m1, no-name = skip (return null).
  return normalized;
}

/**
 * Read EMITTED_STATES from an AX node. Returns array of state names whose
 * values are "truthy" in the AX representation:
 *   - required: properties[].name === 'required', value.value === true
 *   - checked: properties[].name === 'checked', value.value === 'true' / 'mixed'
 *   - selected: same pattern
 *   - expanded: same pattern
 *   - disabled: same pattern
 */
function readStates(axNode) {
  const props = axNode.properties || [];
  const states = [];
  for (const stateName of EMITTED_STATES) {
    const prop = props.find((p) => p.name === stateName);
    if (!prop) continue;
    const val = prop.value?.value;
    if (val === true || val === 'true' || val === 'mixed') {
      states.push(stateName);
    }
  }
  return states;
}

/**
 * Walk the raw AX node list returned by CDP, keep only interactive nodes,
 * and emit one record per node in document order. CDP returns nodes
 * in tree-traversal order so document-order is already correct.
 *
 * @returns {{ role: string, name: string, states: string[] }[]}
 */
function pruneAxTree(rawNodes) {
  const result = [];
  for (const n of rawNodes) {
    const role = n.role?.value;
    if (!role || !INTERACTIVE_SET.has(role)) continue;
    const name = resolveAccessibleName(n);
    if (!name) continue; // Q4: no name → skip (m1 simplification)
    const states = readStates(n);
    result.push({ role, name, states });
  }
  return result;
}

// Strip Unicode control chars + zero-width chars from accessible names.
// Workday i18n strings have been observed containing \u200B (zero-width
// space); we apply this to BOTH the displayed name AND the stored
// name in the RefTable so getByRole still finds the element. (M2 fix.)
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g;
const NAME_DISPLAY_CAP = 80;

function normalizeName(rawName) {
  if (!rawName) return '';
  return rawName.replace(CONTROL_CHARS_RE, '').replace(/\s+/g, ' ').trim();
}

/**
 * Format one interactive node as a single line of text:
 *   `- role "name" [ref=eN] [state1] [state2]`
 *
 * The `name` passed in MUST already be the normalized form stored in the
 * RefTable — we do NOT re-sanitize here, so display and storage stay in
 * sync. (C1 + C2 fix from review.) If the name is longer than
 * NAME_DISPLAY_CAP we emit a `[truncated]` marker so the LLM knows two
 * identically-displayed lines may not represent identical elements.
 *
 * Quotes inside name are escaped to '\\"' (JSON-style) so the line stays
 * parseable as a simple `- role "..." [ref=...]` regex.
 */
function serializeNode(role, name, refId, states) {
  const truncated = name.length > NAME_DISPLAY_CAP;
  const displayName = (truncated ? name.slice(0, NAME_DISPLAY_CAP) : name).replace(
    /"/g,
    '\\"',
  );
  let line = `- ${role} "${displayName}" [ref=${refId}]`;
  if (truncated) line += ' [truncated]';
  for (const state of states) {
    line += ` [${state}]`;
  }
  return line;
}

/**
 * Take a snapshot of the page's interactive a11y nodes. Returns both the
 * text the LLM sees and the RefTable the action layer uses to resolve
 * symbolic refs to Locators.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ text: string, table: RefTable }>}
 */
export async function snapshot(page) {
  const cdp = await getCDPSession(page);
  await ensureAccessibilityEnabled(cdp);
  // M3 fix: bound the CDP call. Pathological pages have hung in the wild.
  const { nodes } = await Promise.race([
    cdp.send('Accessibility.getFullAXTree'),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `SNAPSHOT_TIMEOUT: Accessibility.getFullAXTree exceeded ${SNAPSHOT_TIMEOUT_MS}ms`,
            ),
          ),
        SNAPSHOT_TIMEOUT_MS,
      ),
    ),
  ]);
  const pruned = pruneAxTree(nodes);

  const table = new RefTable(page);
  // Track occurrence index per (role, name) pair so identical fields get
  // distinct nth() targets when resolved (Q8).
  /** @type {Map<string, number>} */
  const occurrenceCounts = new Map();

  const lines = [];
  for (const { role, name, states } of pruned) {
    const key = `${role}::${name}`;
    const occurrenceIndex = occurrenceCounts.get(key) || 0;
    occurrenceCounts.set(key, occurrenceIndex + 1);
    const refId = table.mint(role, name, occurrenceIndex);
    lines.push(serializeNode(role, name, refId, states));
  }

  return {
    text: lines.join('\n'),
    table,
  };
}

// C3 fix from review: dropped `_internal` named export — helpers are
// transitively exercised via snapshot() on real fixtures. No need for
// direct unit tests that bypass the public entry point.
