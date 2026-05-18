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
  // M1 fix from review: Page.enable is NOT required for Page.getFrameTree.
  // It only enables Page DOMAIN EVENTS (frameAttached/frameNavigated/etc).
  // Methods work without it. Removed.
  _enabledSessions.add(cdp);
}

// Hard ceiling on Accessibility.getFullAXTree — extremely large or
// pathological pages have hung in the wild. (M3 fix.)
const SNAPSHOT_TIMEOUT_MS = 15_000;

// m2: depth-first walk of Playwright Frame tree, returning frames in
// the SAME order as Page.getFrameTree's CDP traversal. Both APIs return
// tree-order (parent before children, siblings in document order), so
// indices line up — top frame at [0], children DFS after.
function _walkPlaywrightFrames(frame, out) {
  out.push(frame);
  for (const child of frame.childFrames()) {
    _walkPlaywrightFrames(child, out);
  }
}

function _walkCdpFrameTree(node, out) {
  out.push(node.frame);
  if (node.childFrames) {
    for (const child of node.childFrames) {
      _walkCdpFrameTree(child, out);
    }
  }
}

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
 * Carries backendNodeId per H7 holistic review — needed for future
 * hybrid Plan A→B migration (per-action CDP swap requires
 * backendNodeId to compute box model / dispatch Input events). Storing
 * it now is ~3 LOC; retrofitting during migration would be a Room-wide
 * refactor.
 *
 * @returns {{ role: string, name: string, states: string[], backendNodeId: number | null }[]}
 */
function pruneAxTree(rawNodes) {
  const result = [];
  for (const n of rawNodes) {
    const role = n.role?.value;
    if (!role || !INTERACTIVE_SET.has(role)) continue;
    const name = resolveAccessibleName(n);
    if (!name) continue; // Q4: no name → skip (m1 simplification)
    const states = readStates(n);
    const backendNodeId = n.backendDOMNodeId ?? null;
    result.push({ role, name, states, backendNodeId });
  }
  return result;
}

// Strip Unicode control chars + zero-width chars from accessible names.
// Workday i18n strings have been observed containing \u200B (zero-width
// space); we apply this to BOTH the displayed name AND the stored
// name in the RefTable so getByRole still finds the element. (M2 fix.)
// REVIEW H1 (m2 Plan + adv) fix: exported so 01-code-calibration's
// runner.mjs can normalize truth-yml names through the SAME function
// instead of mirroring the regex. Pre-fix the two files diverged on
// next snapshot.mjs edit; export makes snapshot.mjs the single source.
export const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g;
const NAME_DISPLAY_CAP = 80;

export function normalizeName(rawName) {
  if (!rawName) return '';
  // H2 fix: replace ASCII double-quote with single-quote in the stored
  // name BEFORE it reaches the RefTable + display. This way display and
  // storage stay identical (Playwright's getByRole({ name }) sees the
  // same string) AND the emitted snapshot lines are parseable by the
  // simple `"[^"]*"` regex downstream Rooms use. ~Zero LLM-disambig
  // value lost since ATS field labels almost never contain literal `"`.
  return rawName
    .replace(CONTROL_CHARS_RE, '')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Format one interactive node as a single line of text:
 *   `- role "name" [ref=eN] [state1] [state2]`
 *
 * The `name` passed in MUST already be the normalized form stored in the
 * RefTable — normalizeName() handled control chars, zero-width, AND
 * quote-to-apostrophe (H2 fix from holistic review) so we don't need
 * escaping here. Display = storage = what getByRole sees.
 *
 * isIframe=true emits `[iframe]` state so the LLM can disambiguate
 * cross-frame role+name duplicates (H1 fix from holistic review).
 */
function serializeNode(role, name, refId, states, isIframe = false) {
  const truncated = name.length > NAME_DISPLAY_CAP;
  const displayName = truncated ? name.slice(0, NAME_DISPLAY_CAP) : name;
  let line = `- ${role} "${displayName}" [ref=${refId}]`;
  if (isIframe) line += ' [iframe]';
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
/**
 * Race a Promise against a timeout. Throws a clear SNAPSHOT_TIMEOUT error
 * if exceeded. m2 reused for both top-level + per-iframe AX tree fetches.
 */
async function _raceTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`SNAPSHOT_TIMEOUT: ${label} exceeded ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}

/**
 * Take a snapshot of the page's interactive a11y nodes, INCLUDING iframe
 * content (Q1: inline-recurse). Returns text + RefTable.
 *
 * iframe handling (m2): walk page.frames() AND CDP Page.getFrameTree in
 * parallel tree-order; for each frame fetch AX tree via
 * Accessibility.getFullAXTree({ frameId }), merge with global eN
 * numbering, tag refs with the originating Frame so resolve() routes
 * actions to the correct frame's getByRole. Greenhouse's 90%-iframe form
 * works transparently — the LLM sees one unified view.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ text: string, table: RefTable }>}
 */
export async function snapshot(page) {
  const cdp = await getCDPSession(page);
  await ensureAccessibilityEnabled(cdp);

  // Enumerate frames in tree-order from BOTH Playwright + CDP.
  // Playwright Frame objects let us call getByRole at action time;
  // CDP frame IDs let us scope getFullAXTree to the right frame.
  const pwFrames = [];
  _walkPlaywrightFrames(page.mainFrame(), pwFrames);

  const { frameTree } = await _raceTimeout(
    cdp.send('Page.getFrameTree'),
    SNAPSHOT_TIMEOUT_MS,
    'Page.getFrameTree',
  );
  const cdpFrames = [];
  _walkCdpFrameTree(frameTree, cdpFrames);

  // If frame counts diverge (mid-load detach race?), fall back to top
  // frame only — better partial snapshot than throwing.
  const frameCount = Math.min(pwFrames.length, cdpFrames.length);

  const table = new RefTable(page);
  const lines = [];
  // C1 fix from holistic review: track skipped frames so callers know
  // the snapshot is partial. Silent skipping would make debugging real-
  // ATS issues a nightmare for 6 downstream Rooms.
  let skippedFrames = 0;

  for (let i = 0; i < frameCount; i++) {
    const pwFrame = pwFrames[i];
    const cdpFrame = cdpFrames[i];
    // Skip detached frames — zombies from a mid-load race
    if (pwFrame.isDetached()) {
      skippedFrames++;
      continue;
    }
    // URL sanity check (H1 from m2 review) — guard mid-snapshot races
    if (
      i > 0 &&
      pwFrame.url() &&
      cdpFrame.url &&
      pwFrame.url() !== cdpFrame.url
    ) {
      console.warn(
        `[snapshot] frame ${i} URL mismatch (pw=${pwFrame.url()} cdp=${cdpFrame.url}) — skipping; possible mid-snapshot race`,
      );
      skippedFrames++;
      continue;
    }
    // Top frame: no frameId; iframe: pass frameId
    const args = i === 0 ? {} : { frameId: cdpFrame.id };
    let nodes;
    try {
      const result = await _raceTimeout(
        cdp.send('Accessibility.getFullAXTree', args),
        SNAPSHOT_TIMEOUT_MS,
        `Accessibility.getFullAXTree (frame ${i})`,
      );
      nodes = result.nodes;
    } catch (err) {
      // Per-frame fetch failure (cross-origin iframe etc.) — count it
      // and continue. C1 fix: was silently skipping; now logged + counted.
      console.warn(
        `[snapshot] frame ${i} AX tree fetch failed (${err.message}) — skipping; likely cross-origin`,
      );
      skippedFrames++;
      continue;
    }
    const pruned = pruneAxTree(nodes);
    const refFrame = i === 0 ? null : pwFrame;
    const isIframe = i > 0;
    /** @type {Map<string, number>} */
    const frameOccurrenceCounts = new Map();
    for (const { role, name, states, backendNodeId } of pruned) {
      const key = `${role}::${name}`;
      const occurrenceIndex = frameOccurrenceCounts.get(key) || 0;
      frameOccurrenceCounts.set(key, occurrenceIndex + 1);
      const refId = table.mint(role, name, occurrenceIndex, refFrame, backendNodeId);
      lines.push(serializeNode(role, name, refId, states, isIframe));
    }
  }

  // C1: return skippedFrames so callers can detect partial snapshots.
  return {
    text: lines.join('\n'),
    table,
    skippedFrames,
  };
}

// C3 fix from review: dropped `_internal` named export — helpers are
// transitively exercised via snapshot() on real fixtures. No need for
// direct unit tests that bypass the public entry point.
