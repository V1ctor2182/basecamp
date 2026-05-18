// Eval runner — loads fixture HTML into a Playwright page, runs
// snapshot.mjs against it, and diffs the result against the ground-truth
// YAML. Emits a 3-dim score (coverage / noise / aria_accuracy) + per-
// fixture detail records that the m3 tuner can act on.
//
// 07-applier/self-iteration/01-code-calibration m2.
//
// Score definitions (Q2 locked: aggregate = min):
//   coverage      = matched_must_detect / total_must_detect
//   noise_rate    = leaked_must_not_detect / total_must_not_detect       (0 if list empty)
//   aria_accuracy = role+states correct / matched_by_name                (1 if no match)
//   per_fixture   = min(coverage, 1 - noise_rate, aria_accuracy)
//   overall       = min(per_fixture across all fixtures)                 (Q2 pessimistic)
//
// Match categorization (consumed by m3 tuner):
//   - matched:           role + name both correct, states subset OK
//   - role_mismatch:     name matched but role differs
//   - missing:           neither role nor name matched
//   - out_of_allowlist:  truth role ∉ snapshot.INTERACTIVE_ROLES (annotator
//                         signaled a role the snapshot pipeline never emits)

import {
  snapshot,
  INTERACTIVE_ROLES,
  normalizeName as _snapshotNormalizeName,
} from '../applier/runtime/snapshot.mjs';
import { getPage, closeBrowser } from '../applier/runtime/browser.mjs';

const INTERACTIVE_SET = new Set(INTERACTIVE_ROLES);

// REVIEW H1 (m2 Plan + adv) fix: re-export snapshot.mjs's normalizeName
// directly instead of mirroring the regex. Pre-fix both files held a
// copy and "must stay in sync" was the only guard — a future snapshot
// edit (e.g. adding NBSP to the strip set) would have silently broken
// every truth annotation containing that char.
export const normalizeName = _snapshotNormalizeName;

// snapshot.mjs serializeNode emits:
//   - role "name" [ref=eN] [iframe?] [truncated?] [state1] [state2] ...
// Name never contains `"` (normalized) so a non-greedy capture is safe.
const SNAPSHOT_LINE_RE = /^- (\S+) "([^"]*)" \[ref=([^\]]+)\](.*)$/;
const BRACKET_TAG_RE = /\[([^\]]+)\]/g;

/**
 * Parse one line of snapshot text into a structured node. Returns null
 * for non-data lines (e.g. blank line, future-format diagnostics).
 */
export function parseSnapshotLine(line) {
  const m = SNAPSHOT_LINE_RE.exec(line);
  if (!m) return null;
  const [, role, name, refId, tail] = m;
  const tags = [];
  let mm;
  BRACKET_TAG_RE.lastIndex = 0;
  while ((mm = BRACKET_TAG_RE.exec(tail))) tags.push(mm[1]);
  const isIframe = tags.includes('iframe');
  const truncated = tags.includes('truncated');
  const states = tags.filter((t) => t !== 'iframe' && t !== 'truncated');
  return { role, name, refId, states, isIframe, truncated };
}

/**
 * Parse the full snapshot text into a structured node array. Skips
 * unparseable lines (forward-compat with future diagnostic lines).
 */
export function parseSnapshotText(text) {
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const node = parseSnapshotLine(line);
    if (node) out.push(node);
  }
  return out;
}

/**
 * Run snapshot against one fixture's HTML and score it against truth.
 *
 * @param {object} fixture — from loader.mjs (must have .html + .truth)
 * @param {import('playwright').Page} page
 * @returns {Promise<FixtureResult>}
 */
export async function evalFixture(fixture, page) {
  // REVIEW H4 (adv) fix [CRITICAL: EH4 enforcement]: page.setContent
  // does NOT prevent subresource fetches. A fixture HTML referencing
  // `<img src=https://cdn...>` / `<link rel=stylesheet>` / `<script>`
  // would silently hit the live network during eval, violating EH4
  // ("eval consumes offline HTML only"). Install a route handler that
  // aborts everything except inline (data: URIs and about:blank are
  // unaffected — they don't trip routing).
  const abortHandler = (route) => {
    const url = route.request().url();
    if (url.startsWith('data:') || url.startsWith('about:')) {
      route.continue().catch(() => {});
    } else {
      route.abort().catch(() => {});
    }
  };
  await page.route('**/*', abortHandler);
  try {
    // setContent waits for 'load' by default — accessibility tree is fully
    // populated by then. We do NOT navigate to fixture.truth.url; per EH4
    // the eval flow MUST consume only the offline HTML.
    await page.setContent(fixture.html, { waitUntil: 'load', timeout: 15_000 });
  } finally {
    await page.unroute('**/*', abortHandler).catch(() => {});
  }
  const snap = await snapshot(page);
  const nodes = parseSnapshotText(snap.text);
  const score = scoreFixture(fixture, nodes);
  return {
    id: fixture.id,
    vendor: fixture.vendor,
    page_type: fixture.truth.page_type ?? null,
    nodes_emitted: nodes.length,
    skipped_frames: snap.skippedFrames ?? 0,
    score,
  };
}

/**
 * Pure scoring — given a parsed-node list + truth, compute the 3-dim
 * score + per-item categorization. Exported separately so smoke tests
 * can drive it without spinning up Playwright.
 *
 * @param {object} fixture
 * @param {Array<{role: string, name: string, states: string[]}>} nodes
 */
export function scoreFixture(fixture, nodes) {
  const truth = fixture.truth;
  // Build a (role,name)-keyed map AND a name-only map for role_mismatch
  // detection. Names go through normalizeName first so the comparison is
  // robust against whitespace / non-printable drift.
  const nodeByRoleName = new Map();
  const nodesByName = new Map();
  for (const n of nodes) {
    const nName = normalizeName(n.name);
    const key = `${n.role} ${nName}`;
    nodeByRoleName.set(key, n);
    if (!nodesByName.has(nName)) nodesByName.set(nName, []);
    nodesByName.get(nName).push(n);
  }

  const detail = {
    matched: [],
    role_mismatch: [], // {expected: {role,name}, observed: {role,name}}
    missing: [],       // UNION of (role_mismatch ∪ out_of_allowlist ∪ uncategorized misses); see counts note
    out_of_allowlist: [], // {role,name, observed_role?} — truth role ∉ INTERACTIVE_ROLES
    leaked: [],        // {name, reason}
    aria_errors: [],   // {name, expected_states, observed_states}
  };

  for (const must of truth.must_detect) {
    const want = { role: must.role, name: normalizeName(must.name) };
    if (!INTERACTIVE_SET.has(want.role)) {
      // REVIEW H2 (Plan) fix: surface the case where the truth role is
      // out of allowlist BUT the snapshot DID emit something under the
      // same name with a different (allowlisted) role. Without this the
      // m3 tuner can't tell "add this role to the allowlist" from
      // "remap this label to a different role" — both look the same.
      const sameName = nodesByName.get(want.name);
      const observedRole = sameName && sameName.length ? sameName[0].role : null;
      detail.out_of_allowlist.push({
        role: want.role,
        name: want.name,
        observed_role: observedRole,
      });
      // also counted as `missing` in coverage — annotator's role can't
      // be emitted by the current snapshot pipeline regardless.
      detail.missing.push(want);
      continue;
    }
    const key = `${want.role} ${want.name}`;
    const exact = nodeByRoleName.get(key);
    if (exact) {
      detail.matched.push({ ...want, observed: exact });
      // ARIA accuracy: every truth state should appear on the observed
      // node. Extras on the node are OK (e.g. snapshot might emit
      // `[disabled]` we didn't annotate); missing required = aria error.
      if (Array.isArray(must.states) && must.states.length) {
        const observedSet = new Set(exact.states);
        const missingStates = must.states.filter((s) => !observedSet.has(s));
        if (missingStates.length) {
          detail.aria_errors.push({
            name: want.name,
            expected_states: must.states,
            observed_states: exact.states,
            missing_states: missingStates,
          });
        }
      }
      // `required: true` in truth without an explicit non-empty states[]
      // entry — imply the [required] state should be on the node. An
      // empty states:[] does NOT suppress the sugar.
      const explicitStatesProvided = Array.isArray(must.states) && must.states.length > 0;
      if (
        must.required === true &&
        !explicitStatesProvided &&
        !exact.states.includes('required')
      ) {
        detail.aria_errors.push({
          name: want.name,
          expected_states: ['required'],
          observed_states: exact.states,
          missing_states: ['required'],
        });
      }
      continue;
    }
    // No exact (role,name) — was it a role_mismatch?
    const sameName = nodesByName.get(want.name);
    if (sameName && sameName.length) {
      detail.role_mismatch.push({
        expected: want,
        observed: { role: sameName[0].role, name: want.name },
      });
      // role_mismatch is NOT counted toward `matched` — coverage
      // penalizes it the same as a miss (the tuner needs that signal).
      detail.missing.push(want);
      continue;
    }
    detail.missing.push(want);
  }

  for (const ban of truth.must_not_detect) {
    const banName = normalizeName(ban.name);
    if (nodesByName.has(banName)) {
      detail.leaked.push({ name: banName, reason: ban.reason });
    }
  }

  const totalMustDetect = truth.must_detect.length;
  const totalMustNotDetect = truth.must_not_detect.length;
  const coverage = totalMustDetect === 0 ? 1 : detail.matched.length / totalMustDetect;
  const noise_rate =
    totalMustNotDetect === 0 ? 0 : detail.leaked.length / totalMustNotDetect;
  const matchedCount = detail.matched.length;
  const aria_accuracy =
    matchedCount === 0 ? 1 : (matchedCount - detail.aria_errors.length) / matchedCount;
  const aggregate = Math.min(coverage, 1 - noise_rate, aria_accuracy);

  // REVIEW H1 (adv) fix: explicit count breakdown so the m3 tuner has
  // a clean denominator. `missing` is the UNION (role_mismatch ∪
  // out_of_allowlist ∪ uncategorized_missing) — counting all three buckets
  // into one for the coverage signal. `uncategorized_missing` = pure misses
  // (neither role-mismatch nor out-of-allowlist) and is what m3 should
  // use when asking "is there a candidate fix for this gap?"
  const uncategorizedMissing =
    detail.missing.length - detail.role_mismatch.length - detail.out_of_allowlist.length;

  return {
    coverage: round4(coverage),
    noise_rate: round4(noise_rate),
    aria_accuracy: round4(aria_accuracy),
    aggregate: round4(aggregate),
    counts: {
      total_must_detect: totalMustDetect,
      total_must_not_detect: totalMustNotDetect,
      matched: detail.matched.length,
      // `missing` is the union; consumers preferring a partition sum
      // {matched, role_mismatch, out_of_allowlist, uncategorized_missing}
      // = total_must_detect (verified by smoke test).
      missing: detail.missing.length,
      role_mismatch: detail.role_mismatch.length,
      out_of_allowlist: detail.out_of_allowlist.length,
      uncategorized_missing: uncategorizedMissing,
      leaked: detail.leaked.length,
      aria_errors: detail.aria_errors.length,
    },
    detail,
  };
}

function round4(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

/**
 * Cross-fixture aggregate. Q2 locked: min (pessimistic — defends the
 * worst ATS). We also report mean for human-eyeball debugging.
 *
 * @param {Array<FixtureResult>} results
 */
export function aggregate(results) {
  if (!results.length) {
    return { min: 0, mean: 0, n: 0, perFixture: [] };
  }
  const aggs = results.map((r) => r.score.aggregate);
  const min = aggs.reduce((m, x) => Math.min(m, x), Infinity);
  const mean = aggs.reduce((s, x) => s + x, 0) / aggs.length;
  return {
    min: round4(min),
    mean: round4(mean),
    n: results.length,
    perFixture: results.map((r) => ({
      id: r.id,
      aggregate: r.score.aggregate,
      coverage: r.score.coverage,
      noise_rate: r.score.noise_rate,
      aria_accuracy: r.score.aria_accuracy,
    })),
  };
}

/**
 * High-level helper — eval every fixture in a registry. Owns the
 * Playwright page lifecycle: one fresh page per fixture (state
 * isolation), closes pages after each eval. The shared browser
 * singleton stays warm so multiple eval-snapshot runs in the same
 * process don't re-launch Chromium.
 *
 * @param {{ fixtures: ReadonlyArray<object> }} registry — from loadFixtures
 * @param {{ closeBrowserOnFinish?: boolean }} [opts]
 * @returns {Promise<{ results: FixtureResult[], summary: ReturnType<typeof aggregate> }>}
 */
export async function evalRegistry(registry, opts = {}) {
  const results = [];
  try {
    for (const fx of registry.fixtures) {
      const page = await getPage();
      try {
        const res = await evalFixture(fx, page);
        results.push(res);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    if (opts.closeBrowserOnFinish !== false) {
      // Default true — CLI use. Library callers chaining multiple evals
      // pass false to keep the singleton warm.
      await closeBrowser().catch(() => {});
    }
  }
  return { results, summary: aggregate(results) };
}

/**
 * @typedef {object} FixtureResult
 * @property {string} id
 * @property {string} vendor
 * @property {string | null} page_type
 * @property {number} nodes_emitted
 * @property {number} skipped_frames
 * @property {ReturnType<typeof scoreFixture>} score
 */
