// Event aggregator for the Iteration Dashboard (07-applier/self-iteration
// 03-iteration-dashboard m1).
//
// Reads existing append-only stores and normalizes them into a unified
// `Event` timeline that the React page (m2) renders. NO new persistent
// store — we override Q2 of the spec because:
//   1. All sources are already JSONL append-only (feedback/*.jsonl,
//      qa-bank/history.jsonl, eval-fixtures/tuner-log.json, applications.json)
//   2. Mirror-writes from 01+02 would modify shipped/frozen code
//   3. <500 records total → real-time aggregation is fast enough
//
// EH4 / D5: pure file reads, no LLM call, no network fetch.

import { createHash } from 'node:crypto';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { FEEDBACK_DIR, readJsonl as feedbackReadJsonl, _FILES as FEEDBACK_FILES } from '../feedback/stores.mjs';
import { SUGGESTED_DIR, listSuggestions } from '../feedback/suggestionStore.mjs';
import { DEFAULT_FIXTURES_DIR } from '../eval/fixtures/loader.mjs';

const APPLICATIONS_JSON = path.resolve('data', 'career', 'applications.json');
const QA_BANK_HISTORY = path.resolve('data', 'career', 'qa-bank', 'history.jsonl');
const TUNER_LOG = path.join(DEFAULT_FIXTURES_DIR, 'tuner-log.json');
const PROMOTE_QUEUE_DIR = path.join(DEFAULT_FIXTURES_DIR, 'promote-queue');

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

/**
 * Event shape — all sources normalize to this so the UI doesn't care
 * which store produced a given row.
 *
 * @typedef {object} Event
 * @property {string} id        — stable sha256 prefix (record bytes → addressable)
 * @property {string} ts        — ISO 8601 with offset
 * @property {EventKind} kind
 * @property {string?} ref      — original record id when available (jobId, suggestionId, ...)
 * @property {string} summary   — one-line human-readable
 * @property {object} payload   — full raw record (size-bounded by source schemas)
 */

/**
 * @typedef {
 *   'evidence.captured'
 *   | 'field.edited'
 *   | 'field.misclassified'
 *   | 'suggestion.proposed'
 *   | 'suggestion.approved'
 *   | 'suggestion.rejected'
 *   | 'tuner.run'
 *   | 'apply.completed'
 *   | 'qa-bank.entry.added'
 * } EventKind
 */

/** sha256 prefix of any JSON-serializable record. Used as the stable
 *  addressable id when the source store doesn't carry one. */
export function stableId(record) {
  const json = JSON.stringify(record);
  return createHash('sha256').update(json).digest('hex').slice(0, 12);
}

/**
 * Aggregate events from every source over the given window. Returns
 * newest-first, optionally paginated.
 *
 * REVIEW HIGH 8 (adv) fix: pagination uses a composite (ts, id) cursor.
 * Pre-fix two events at the same ts could both end up "after" a strict-
 * less-than boundary, dropping one when the page boundary landed on the
 * tie. Now the cursor admits items whose ts < beforeTs OR (ts == beforeTs
 * AND id > beforeId). Secondary sort by id keeps the order deterministic
 * across reads.
 *
 * @param {object} [opts]
 * @param {number} [opts.since=now-30d]    — ms epoch
 * @param {number} [opts.limit=30]
 * @param {string} [opts.beforeTs]         — ISO; cursor primary key
 * @param {string} [opts.beforeId]         — cursor secondary key (id from last page's last event)
 * @returns {Promise<{ events: Event[], hasMore: boolean, nextCursor: {ts:string,id:string}|null }>}
 */
export async function readEvents(opts = {}) {
  const since = typeof opts.since === 'number' ? opts.since : Date.now() - DEFAULT_WINDOW_MS;
  const limit = Math.min(Math.max(1, Number(opts.limit) || DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const beforeTs = opts.beforeTs || null;
  const beforeId = opts.beforeId || null;
  const all = [];

  // 1. Site-failures → 🔴 evidence.captured
  try {
    for await (const r of feedbackReadJsonl(FEEDBACK_FILES.SITE_FAILURES, { since })) {
      all.push({
        id: stableId(r),
        ts: r.ts,
        kind: 'evidence.captured',
        ref: r.jobId,
        summary: `${r.error_kind} on ${r.domain}${r.site_adapter_id ? ` [${r.site_adapter_id}]` : ''}`,
        payload: r,
      });
    }
  } catch {
    /* fail-soft */
  }

  // 2. Field-edits → 🟢 qa-bank.entry.added (user edited the suggested draft)
  try {
    for await (const r of feedbackReadJsonl(FEEDBACK_FILES.FIELD_EDITS, { since })) {
      all.push({
        id: stableId(r),
        ts: r.ts,
        kind: 'field.edited',
        ref: r.jobId,
        summary: `field "${r.field_label}" edited (distance=${r.edit_distance}, conf=${r.confidence})`,
        payload: r,
      });
    }
  } catch {
    /* fail-soft */
  }

  // 3. Field-misclassified → 🟢 (classifier got class wrong)
  try {
    for await (const r of feedbackReadJsonl(FEEDBACK_FILES.FIELD_MISCLASSIFIED, { since })) {
      all.push({
        id: stableId(r),
        ts: r.ts,
        kind: 'field.misclassified',
        ref: r.jobId,
        summary: `"${r.field_label}" predicted=${r.predicted_class} → actual=${r.actual_class}`,
        payload: r,
      });
    }
  } catch {
    /* fail-soft */
  }

  // 4. Suggested proposals → 🟣 proposed / 🟠 approved / 🔵 rejected
  try {
    const proposals = await listSuggestions({ status: 'all' });
    for (const p of proposals) {
      const tsMs = Date.parse(p.created_at);
      if (tsMs < since) continue;
      const kind =
        p.status === 'approved'
          ? 'suggestion.approved'
          : p.status === 'rejected'
            ? 'suggestion.rejected'
            : 'suggestion.proposed';
      all.push({
        id: p.id,
        ts: p.created_at,
        kind,
        ref: p.id,
        summary: `${p.type} for ${p.group_key} (${p.feedback_type}, ${p.source_records.length} record(s))`,
        payload: p,
      });
    }
  } catch {
    /* fail-soft */
  }

  // 5. Tuner-log.json → 🟣 tuner.run (single event per file load — last run)
  try {
    const raw = await fs.readFile(TUNER_LOG, 'utf8');
    const log = JSON.parse(raw);
    // tuner-log.json has no timestamp; use file mtime as the event ts.
    const stat = await fs.stat(TUNER_LOG);
    const ts = new Date(stat.mtimeMs).toISOString();
    if (stat.mtimeMs >= since) {
      const accepted = (log.iterations || []).filter((i) => i.decision === 'accepted').length;
      const added = (log.final_allowlist || []).filter(
        (r) => !(log.initial_allowlist || []).includes(r),
      );
      const removed = (log.initial_allowlist || []).filter(
        (r) => !(log.final_allowlist || []).includes(r),
      );
      const diffSummary =
        added.length || removed.length
          ? `+[${added.join(', ')}] -[${removed.join(', ')}]`
          : 'no change';
      all.push({
        id: stableId({ kind: 'tuner.run', mtime: stat.mtimeMs }),
        ts,
        kind: 'tuner.run',
        ref: null,
        summary: `tuner ${log.converged ? 'converged' : log.stalled ? 'stalled' : 'max-iter'}: ${accepted} accepted, ${diffSummary}`,
        payload: {
          converged: !!log.converged,
          stalled: !!log.stalled,
          max_iterations_reached: !!log.max_iterations_reached,
          accepted,
          added,
          removed,
        },
      });
    }
  } catch {
    /* fail-soft — log may not exist */
  }

  // 6. applications.json → 🟢 apply.completed (one event per Applied row)
  try {
    const raw = await fs.readFile(APPLICATIONS_JSON, 'utf8');
    const apps = JSON.parse(raw);
    if (Array.isArray(apps)) {
      for (const app of apps) {
        if (app.status !== 'Applied') continue;
        const tl = Array.isArray(app.timeline) ? app.timeline : [];
        // Use the most recent timeline event as the apply.completed ts.
        const appliedEvent =
          tl.findLast?.((e) => e.event === 'status_changed' || e.event === 'created') ||
          tl[tl.length - 1];
        if (!appliedEvent?.ts) continue;
        const tsMs = Date.parse(appliedEvent.ts);
        if (!Number.isFinite(tsMs) || tsMs < since) continue;
        all.push({
          id: `apply-${app.id}`,
          ts: appliedEvent.ts,
          kind: 'apply.completed',
          ref: app.id,
          summary: `applied to ${app.company || '?'} — ${app.role || '?'}`,
          payload: { company: app.company, role: app.role, status: app.status, score: app.score },
        });
      }
    }
  } catch {
    /* fail-soft */
  }

  // 7. qa-bank history → 🟢 qa-bank.entry.added (one per row)
  try {
    if (await _exists(QA_BANK_HISTORY)) {
      const rl = readline.createInterface({
        input: createReadStream(QA_BANK_HISTORY, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      try {
        for await (const line of rl) {
          if (!line.trim()) continue;
          let r;
          try {
            r = JSON.parse(line);
          } catch {
            continue;
          }
          const tsStr = r.ts || r.created_at;
          const tsMs = Date.parse(tsStr);
          if (!Number.isFinite(tsMs) || tsMs < since) continue;
          all.push({
            id: stableId(r),
            ts: tsStr,
            kind: 'qa-bank.entry.added',
            ref: r.jobId || null,
            summary: `qa-bank: ${(r.question || r.field_label || '').slice(0, 60)}`,
            payload: r,
          });
        }
      } finally {
        rl.close();
      }
    }
  } catch {
    /* fail-soft */
  }

  // Sort newest first; secondary by id DESC for cursor determinism.
  all.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

  // Composite-cursor pagination (REVIEW HIGH 8 adv).
  const filtered = beforeTs
    ? all.filter((e) => {
        if (e.ts < beforeTs) return true;
        if (e.ts > beforeTs) return false;
        // Tie on ts → admit when id < beforeId under DESC ordering.
        return beforeId ? e.id < beforeId : false;
      })
    : all;
  const page = filtered.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = filtered.length > page.length && last ? { ts: last.ts, id: last.id } : null;
  return { events: page, hasMore: filtered.length > page.length, nextCursor };
}

/**
 * Health header counts. Degrades gracefully — every field that can't
 * be computed from existing data returns null.
 *
 * REVIEW MEDIUM (Plan + adv) fix: read site-failures.jsonl ONCE per
 * health call. Pre-fix buildHealth scanned the file itself THEN called
 * buildPending which scanned again — 2× IO per 30s poll. Now we share
 * the failure list between failureCount and buildPending via the helper.
 */
export async function buildHealth() {
  const since = Date.now() - DEFAULT_WINDOW_MS;

  // APPLY count + SUCCESS rate from applications.json (30d window).
  let applyCount = 0;
  let successCount = 0;
  try {
    const apps = JSON.parse(await fs.readFile(APPLICATIONS_JSON, 'utf8'));
    if (Array.isArray(apps)) {
      for (const app of apps) {
        const tl = Array.isArray(app.timeline) ? app.timeline : [];
        const last = tl[tl.length - 1];
        const ts = Date.parse(last?.ts || '');
        if (!Number.isFinite(ts) || ts < since) continue;
        if (app.status === 'Applied') {
          applyCount += 1;
          successCount += 1; // Applied IS the success state for V1
        } else if (app.status === 'Rejected' || app.status === 'No-Reply') {
          applyCount += 1;
        }
      }
    }
  } catch {
    /* fail-soft */
  }

  // Single shared read of site-failures.jsonl — feeds BOTH failureCount
  // and the pending.promote list. Read once, use twice.
  const failures = await _readSiteFailuresWindow(since);
  const failureCount = failures.length;

  // 01 coverage (snapshot calibration score): read tuner-log.json's final
  // per-fixture aggregate min if present.
  let calibrationMin = null;
  try {
    const log = JSON.parse(await fs.readFile(TUNER_LOG, 'utf8'));
    // Walk iterations DESC to find the last accepted score (or baseline).
    const lastWithScore = [...(log.iterations || [])]
      .reverse()
      .find((i) => Number.isFinite(i.aggregate_after));
    if (lastWithScore) calibrationMin = lastWithScore.aggregate_after;
  } catch {
    /* fail-soft */
  }

  // Pending counts — pass the pre-read failures in to skip the re-scan.
  const pending = await buildPending({ _failures: failures });

  return {
    window_days: 30,
    apply_count: applyCount,
    success_rate: applyCount === 0 ? null : round4(successCount / applyCount),
    failure_count: failureCount,
    calibration_min: calibrationMin,
    pending_counts: {
      promote: pending.promote.length,
      pr_review: pending.pr_review.length,
      tier2: 0, // placeholder per m3-OQ
      tier3: 0,
    },
    generated_at: new Date().toISOString(),
  };
}

/** Shared site-failures reader so buildHealth + buildPending can split
 *  the IO cost within a single request. */
async function _readSiteFailuresWindow(since) {
  const out = [];
  try {
    for await (const r of feedbackReadJsonl(FEEDBACK_FILES.SITE_FAILURES, { since })) {
      out.push(r);
    }
  } catch {
    /* fail-soft */
  }
  return out;
}

/**
 * Pending action queue — what the operator needs to do.
 *   - Promote queue: site-failures that haven't been promoted yet
 *   - PR review: list of currently-pending suggestion proposals
 *   - Tier 2/3: placeholders (0) per m3-OQ
 */
export async function buildPending(opts = {}) {
  const since = Date.now() - DEFAULT_WINDOW_MS;
  const promoted = await _listPromotedIds();

  // Accept a pre-read failures array from buildHealth (avoids the second
  // JSONL scan); otherwise read directly here.
  const failures = Array.isArray(opts._failures)
    ? opts._failures
    : await _readSiteFailuresWindow(since);

  const promote = [];
  for (const r of failures) {
    const id = stableId(r);
    if (promoted.has(id)) continue;
    promote.push({
      id,
      ts: r.ts,
      jobId: r.jobId,
      domain: r.domain,
      site_adapter_id: r.site_adapter_id,
      error_kind: r.error_kind,
      error_message: r.error_message,
    });
  }
  promote.sort((a, b) => (a.ts < b.ts ? 1 : -1));

  const pr_review = [];
  try {
    const proposals = await listSuggestions({ status: 'pending' });
    for (const p of proposals) {
      pr_review.push({
        id: p.id,
        ts: p.created_at,
        type: p.type,
        group_key: p.group_key,
        feedback_type: p.feedback_type,
      });
    }
  } catch {
    /* fail-soft */
  }

  return {
    promote,
    pr_review,
    tier2: [],
    tier3: [],
  };
}

/** Coverage detail block. */
export async function buildCoverage() {
  const fixtures = [];
  try {
    const { loadFixtures } = await import('../eval/fixtures/loader.mjs');
    const registry = await loadFixtures();
    for (const fx of registry.fixtures) {
      fixtures.push({
        id: fx.id,
        vendor: fx.vendor,
        page_type: fx.truth.page_type ?? null,
        must_detect_count: fx.truth.must_detect.length,
        must_not_detect_count: fx.truth.must_not_detect.length,
      });
    }
  } catch {
    /* fail-soft — fixtures dir missing or invalid */
  }

  let tuner = null;
  try {
    const log = JSON.parse(await fs.readFile(TUNER_LOG, 'utf8'));
    tuner = {
      initial_allowlist: log.initial_allowlist || [],
      final_allowlist: log.final_allowlist || [],
      converged: !!log.converged,
      stalled: !!log.stalled,
      iterations: (log.iterations || []).length,
    };
  } catch {
    /* fail-soft */
  }

  return { fixtures, tuner };
}

// ── Internal helpers ───────────────────────────────────────────────────

async function _exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function _listPromotedIds() {
  const out = new Set();
  try {
    const entries = await fs.readdir(PROMOTE_QUEUE_DIR);
    for (const name of entries) {
      // file name format: `{ts}-{evidenceId}.yml`
      const m = name.match(/-([a-f0-9]{12})\.yml$/);
      if (m) out.add(m[1]);
    }
  } catch {
    /* dir may not exist yet */
  }
  return out;
}

function round4(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

// Test-only.
export const _PATHS = Object.freeze({
  APPLICATIONS_JSON,
  QA_BANK_HISTORY,
  TUNER_LOG,
  PROMOTE_QUEUE_DIR,
  FEEDBACK_DIR,
  SUGGESTED_DIR,
});
