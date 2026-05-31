// triage.mjs
//
// 07-applier/04-multi-step/m8 — Pure data transforms for Apply.tsx's
// Status board + Triage view. Lives in .mjs (not .tsx) so the smoke
// test can exercise the logic without spinning up a React renderer.
//
// All exports take in-memory data (no I/O) and return plain objects.
//
// Consumed by:
//   - src/career/Apply.tsx (render layer)
//   - scripts/smoke-apply-ui-status-triage.mjs (fixture-driven smoke)

/** Status board chip categories. Order is render order. */
export const CHIP_KINDS = Object.freeze([
  'to_retry',    // mismatch / fill_error — auto-fix can plausibly recover
  'unlabeled',   // unverifiable — classifier didn't tag a confident value
  'manual',      // file upload / CAPTCHA / not_seen — needs the user
]);

/** verify_status values that count as "verified". */
const VERIFIED_STATUSES = new Set(['verified']);

/** verify_status values that go into to_retry chip. */
const TO_RETRY_STATUSES = new Set(['mismatch', 'fill_error']);

/** verify_status values that go into the manual chip — fields the
 *  state machine bailed out of (`'manual'`) and fields it never even
 *  attempted (`'not_seen'`). Both need the operator's hand on the
 *  Chromium window. [review C2/H4]
 *  m9 adds 'skipped_by_user' — operator explicitly Skipped via the
 *  per-field card. Treated as manual since they're handling it
 *  themselves. */
const MANUAL_STATUSES = new Set(['manual', 'not_seen', 'skipped_by_user']);

/** Field classes that ALWAYS land in the manual chip regardless of
 *  verify_status — file uploads + CAPTCHA-like blockers are intrinsic
 *  human steps, not auto-fix candidates. [review C1] Drops the dead
 *  'captcha'/'signature' branches — the upstream classifier emits
 *  `class:'manual'` for CAPTCHA (machine.mjs:371) and never
 *  'captcha'/'signature'. */
const MANUAL_CLASSES = new Set(['file', 'manual']);

/**
 * Flatten per_step_draft into a single ordered list with stable keys
 * for React render. Drops fields without a refId (those aren't actionable
 * — the state machine can't reference them).
 *
 * @param {object} session - ApplySession-shaped object
 * @returns {Array<{
 *   key: string,
 *   stepIdx: number,
 *   refId: string,
 *   label: string,
 *   class: string,
 *   suggested_value: string | null,
 *   verify_status: string | null,
 *   verify_detail: string | null,
 *   confidence: string | null,
 *   role: string | null,
 *   required: boolean,
 *   control_fingerprint: { ancestors?: string[], tag?: string, role?: string } | null,
 * }>}
 */
export function aggregateFields(session) {
  if (!session || typeof session !== 'object') return [];
  const drafts = session.per_step_draft || {};
  const out = [];
  // step-index keys are numeric strings in JSON — preserve numeric order.
  const stepKeys = Object.keys(drafts).sort((a, b) => Number(a) - Number(b));
  for (const k of stepKeys) {
    const entry = drafts[k];
    const fields = entry?.fields;
    if (!Array.isArray(fields)) continue;
    const stepIdx = entry.step_idx ?? Number(k);
    // [review M5] Skip malformed step keys (NaN / non-numeric).
    if (!Number.isFinite(stepIdx)) continue;
    for (const f of fields) {
      if (!f || typeof f !== 'object') continue;
      if (!f.refId) continue;  // unactionable — skip
      out.push({
        key: `${stepIdx}::${f.refId}`,
        stepIdx,
        refId: f.refId,
        label: String(f.label ?? f.refId),
        class: String(f.class ?? 'unknown'),
        // [review H1] Plumb subclass through so m11's recovery.mjs
        // altFormatLadder lookup can find phone/date ladders — the
        // classifier emits class='hard' + subclass='phone', so
        // gating on class alone fails to ever fire Recovery 2 in prod.
        subclass: f.subclass ?? null,
        suggested_value: f.suggested_value ?? null,
        verify_status: f.verify_status ?? null,
        verify_detail: f.verify_detail ?? null,
        confidence: f.confidence ?? null,
        role: f.role ?? null,
        required: f.required !== false,
        control_fingerprint: f.control_fingerprint ?? null,
      });
    }
  }
  return out;
}

/**
 * Classify a field into a chip kind, or `null` if it doesn't surface
 * on the status board (verified, or no action signal yet).
 *
 * @param {object} field - output of aggregateFields entry
 * @returns {'to_retry' | 'unlabeled' | 'manual' | null}
 */
export function chipKindFor(field) {
  if (!field) return null;
  if (MANUAL_CLASSES.has(field.class)) return 'manual';
  const vs = field.verify_status;
  if (vs == null) return null;             // pre-verify — no chip
  if (VERIFIED_STATUSES.has(vs)) return null;
  if (TO_RETRY_STATUSES.has(vs)) return 'to_retry';
  if (vs === 'unverifiable') return 'unlabeled';
  // [review C2/H4] not_seen + manual verify_status are user-handled
  // states — surface them in the manual chip instead of silently
  // dropping them out of every count.
  if (MANUAL_STATUSES.has(vs)) return 'manual';
  return null;
}

/**
 * Compute status-board counts:
 *   total = fields with verify_status set
 *   verified = subset with verify_status='verified'
 *   chips = per-kind counts
 *   pct = round((verified / total) * 100), null when total = 0
 *
 * Note on "total": this is the count of fields we've ATTEMPTED to
 * fill+verify, not the total form size. The form size is unknown
 * until the state machine finishes probing every step. The chip-
 * driven UI tracks attempted fields, which is what the user cares
 * about for cleanup.
 *
 * @param {Array} fields - output of aggregateFields
 * @returns {{ total: number, verified: number, pct: number | null, chips: { to_retry: number, unlabeled: number, manual: number } }}
 */
export function computeStatusCounts(fields) {
  const chips = { to_retry: 0, unlabeled: 0, manual: 0 };
  let total = 0;
  let verified = 0;
  if (!Array.isArray(fields)) {
    return { total: 0, verified: 0, pct: null, chips };
  }
  for (const f of fields) {
    if (!f) continue;
    // [review C1/C2/H4] Single source of truth: chipKindFor decides.
    // Manual chip captures (class IN manual classes) OR (verify_status
    // IN manual statuses). verified short-circuits before chip.
    if (VERIFIED_STATUSES.has(f.verify_status)) {
      verified++;
      total++;
      continue;
    }
    const kind = chipKindFor(f);
    if (kind == null) continue;  // pre-verify or unknown — exclude
    total++;
    chips[kind]++;
  }
  const pct = total > 0 ? Math.round((verified / total) * 100) : null;
  return { total, verified, pct, chips };
}

/**
 * Group failing fields by their shared DOM ancestor selector. ≥ 2
 * fields sharing the same `control_fingerprint.ancestors[0]` AND in
 * a failing state ⇒ collapse into a group. All other fields are
 * standalone entries.
 *
 * [P3-OQ2] Simple version: just first-ancestor equality. LLM semantic
 * clustering is Phase 5/m5 territory.
 *
 * @param {Array} fields - aggregated fields
 * @returns {Array<
 *   { kind: 'group', groupKey: string, fields: Array, batch_hint: string | null }
 *   | { kind: 'standalone', field: object }
 * >}
 */
export function groupByAncestor(fields) {
  if (!Array.isArray(fields)) return [];
  const buckets = new Map();
  const standalone = [];
  for (const f of fields) {
    if (!f) continue;
    // [review H2] cache the chip kind once per field — avoids the
    // double chipKindFor() call.
    const kind = chipKindFor(f);
    const failing = kind === 'to_retry' || kind === 'unlabeled';
    const anc = f.control_fingerprint?.ancestors?.[0];
    if (failing && anc) {
      if (!buckets.has(anc)) buckets.set(anc, []);
      buckets.get(anc).push(f);
    } else {
      standalone.push(f);
    }
  }
  // Promote buckets back to standalone when only one member — single
  // failing field under a unique ancestor is not a "group" semantically.
  const out = [];
  for (const [groupKey, members] of buckets) {
    if (members.length >= 2) {
      out.push({
        kind: 'group',
        groupKey,
        fields: members,
        // Phase 5 will infer a real shared cause; m8 just surfaces
        // the ancestor selector as a hint.
        batch_hint: deriveBatchHint(members),
      });
    } else {
      standalone.push(...members);
    }
  }
  for (const f of standalone) {
    out.push({ kind: 'standalone', field: f });
  }
  return out;
}

/** Best-effort summary of what's wrong across a group's members.
 *  Returns null when we can't say anything specific. */
function deriveBatchHint(members) {
  const codes = new Set();
  for (const m of members) {
    if (m.verify_status === 'mismatch') codes.add('value did not land');
    else if (m.verify_status === 'fill_error') codes.add('fill threw');
    else if (m.verify_status === 'unverifiable') codes.add('unlabeled');
  }
  if (codes.size === 0) return null;
  if (codes.size === 1) return [...codes][0];
  return [...codes].join(' / ');
}

/**
 * Sort triage entries [P3-OQ7]: required > optional, within each tier
 * preserve form order (stepIdx asc, then refId asc when stepIdx ties).
 *
 * Groups inherit "required" from any member — if any failing member
 * is required, the whole group sorts in the required tier.
 *
 * @param {Array} entries - output of groupByAncestor
 * @returns {Array}
 */
export function sortTriageEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const score = (entry) => {
    if (entry.kind === 'group') {
      // [review M1] Defensive guard — Math.min on empty returns Infinity.
      // Buckets are filtered to ≥ 2 members upstream, so this is paranoia,
      // but a refactor that re-uses score() would otherwise propagate it
      // through the comparator silently.
      const fields = entry.fields.length > 0 ? entry.fields : [{ stepIdx: 0, refId: '', required: false }];
      const required = fields.some((f) => f.required);
      const stepIdx = Math.min(...fields.map((f) => f.stepIdx));
      // [review H1] Use composite (stepIdx, refId) keys as the
      // tiebreak — refId alone is NOT globally unique (synthetic refs
      // like `__captcha`, `__file_0` can collide across steps).
      const tieKey = fields
        .map((f) => `${f.stepIdx}::${f.refId}`)
        .sort()[0];
      return [required ? 0 : 1, stepIdx, tieKey];
    }
    const f = entry.field;
    return [f.required ? 0 : 1, f.stepIdx, `${f.stepIdx}::${f.refId}`];
  };
  return [...entries].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) {
      if (sa[i] < sb[i]) return -1;
      if (sa[i] > sb[i]) return 1;
    }
    return 0;
  });
}

/**
 * One-shot helper: aggregate → group → sort. Returns the renderable
 * triage list plus the status counts that the StatusBoard chips read.
 *
 * @param {object} session
 * @returns {{ entries: Array, counts: { total, verified, pct, chips } }}
 */
export function buildTriageState(session) {
  const fields = aggregateFields(session);
  const counts = computeStatusCounts(fields);
  // Triage view only renders entries the operator can ACT on through
  // this UI — to_retry (auto-fix candidates) + unlabeled (needs
  // clarification). Manual entries are tracked via the chip count;
  // the operator handles them directly in the Chromium window so
  // there's no card-level action to surface here. [review H2]
  const actionable = fields.filter((f) => {
    const k = chipKindFor(f);
    return k === 'to_retry' || k === 'unlabeled';
  });
  const grouped = groupByAncestor(actionable);
  const entries = sortTriageEntries(grouped);
  return { entries, counts };
}
