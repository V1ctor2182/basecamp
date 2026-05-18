// Induction orchestrator — dispatches feedback records to the
// type-specific Haiku-prompted inducer when threshold is met.
//
// 07-applier/self-iteration/02-data-flywheel m2.
//
// Per OQ6: maybeInduce(feedbackType) is called at endpoint.mjs apply
// close (cheap O(N) groupBy over last 30 days) AND from the m4
// "Run induction now" manual button. Idempotent: induced-markers.json
// tracks (type, groupKey) → count_at_last_induction so the same batch
// isn't re-inducted on every apply close.
//
// Re-induction gate: induce when currentCount - markers.count >= threshold.
// First-time: induce iff currentCount >= threshold.

import {
  readJsonl,
  countByGroup,
  _FILES,
} from './stores.mjs';
import {
  savePending,
  readMarkers,
  writeMarkers,
  readRejectedIds,
  markerKey,
} from './suggestionStore.mjs';
import { induce as induceClassifierRule } from './induceClassifierRule.mjs';
import { induce as induceSiteAdapter } from './induceSiteAdapter.mjs';

export const INDUCTION_THRESHOLD = 5;

/** Per spec — 30-day window for groupBy + readJsonl since filter. */
export const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Feedback type → (file, groupKey extractor, inducer). */
const PIPELINES = Object.freeze({
  'field-misclassified': {
    file: _FILES.FIELD_MISCLASSIFIED,
    groupKey: (r) => r.site || null,
    proposalType: 'classifier-rule',
    runInduce: induceClassifierRule,
  },
  'site-failures': {
    file: _FILES.SITE_FAILURES,
    groupKey: (r) => r.domain || null,
    proposalType: 'site-adapter',
    runInduce: induceSiteAdapter,
  },
});

export const KNOWN_FEEDBACK_TYPES = Object.freeze(Object.keys(PIPELINES));

// REVIEW C2 (adv) / H3 (Plan) fix: module-level per-feedbackType mutex.
// Without this, two concurrent maybeInduce calls (e.g. apply-close hook +
// manual "Run now" button overlapping) both read the same markers, both
// pass the threshold gate, both call savePending, and both writeMarkers —
// duplicate proposals on disk + only one survives in markers. The
// orchestrator now serializes per-type within the process.
/** @type {Map<string, Promise<unknown>>} */
const _maybeInduceChain = new Map();
function _serializeMaybeInduce(feedbackType, task) {
  const prev = _maybeInduceChain.get(feedbackType) || Promise.resolve();
  const next = prev.then(task, task);
  _maybeInduceChain.set(
    feedbackType,
    next.catch(() => {}),
  );
  return next;
}

/**
 * Check the named feedback flywheel for groups at threshold and dispatch
 * Haiku induction. Returns the array of new Proposal envelopes (may be
 * empty). Updates induced-markers.json for each successful induction
 * so the next call skips already-handled batches.
 *
 * @param {string} feedbackType — 'field-misclassified' | 'site-failures'
 * @param {{ client?: object, recordCost?: Function, now?: number }} [deps]
 * @returns {Promise<Array<object>>} new proposal envelopes
 */
export async function maybeInduce(feedbackType, deps = {}) {
  const pipeline = PIPELINES[feedbackType];
  if (!pipeline) {
    throw new TypeError(
      `maybeInduce: unknown feedbackType ${JSON.stringify(feedbackType)} (known: ${KNOWN_FEEDBACK_TYPES.join(', ')})`,
    );
  }
  // REVIEW C2 (adv) / H3 (Plan) fix: serialize concurrent calls for the
  // same feedbackType so two parallel orchestrators don't duplicate
  // proposals. Each call still reads fresh markers inside the mutex.
  return _serializeMaybeInduce(feedbackType, () => _maybeInduceInner(feedbackType, pipeline, deps));
}

async function _maybeInduceInner(feedbackType, pipeline, deps) {
  const now = deps.now || Date.now();
  const since = now - WINDOW_MS;

  // O(N) scan of last 30 days, group by site/domain.
  const counts = await countByGroup(pipeline.file, pipeline.groupKey, { since });
  if (counts.size === 0) return [];

  const markers = await readMarkers();
  const rejected = await readRejectedIds();

  const newProposals = [];
  const updatedMarkers = { ...markers };

  for (const [groupKey, currentCount] of counts) {
    if (currentCount < INDUCTION_THRESHOLD) continue;
    const mKey = markerKey(feedbackType, groupKey);
    const prior = markers[mKey];
    // REVIEW C2 (Plan) fix: record-expiry handling. When old records
    // age out of the 30-day window, currentCount can drop below
    // prior.count_at_last_induction, making the delta negative and
    // permanently blocking re-induction. Treat that case as "fresh"
    // — if currentCount alone >= threshold, allow induction.
    if (prior && currentCount < prior.count_at_last_induction) {
      // fall through — induce iff currentCount >= threshold (already
      // checked above)
    } else if (prior && currentCount - prior.count_at_last_induction < INDUCTION_THRESHOLD) {
      continue;
    }
    // Skip if the prior proposal was rejected. m3 writes the
    // rejected id; we don't want to spam the user with the same
    // suggestion against the same group within the cooldown.
    if (prior && rejected.has(prior.proposal_id)) {
      continue;
    }
    // Fetch the most recent threshold-worth of records for this group.
    // NOTE: readJsonl streams forward (oldest first); we buffer + tail
    // so the inducer sees the most recent samples — these reflect the
    // current ATS DOM better than 6-month-old records.
    const groupRecordsAll = [];
    for await (const record of readJsonl(pipeline.file, {
      since,
      filter: (r) => pipeline.groupKey(r) === groupKey,
    })) {
      groupRecordsAll.push(record);
    }
    const tailCap = INDUCTION_THRESHOLD * 4;
    const groupRecords =
      groupRecordsAll.length > tailCap ? groupRecordsAll.slice(-tailCap) : groupRecordsAll;
    if (groupRecords.length < INDUCTION_THRESHOLD) continue; // race-safety

    let result;
    try {
      result = await pipeline.runInduce(groupKey, groupRecords, deps);
    } catch (err) {
      // Network / config / SDK failures here — log and move on. The
      // group's marker stays unmoved, so a future apply close will
      // retry naturally.
      console.warn(
        `feedback: induction failed for ${feedbackType}/${groupKey}: ${err?.message || err}`,
      );
      continue;
    }
    if (!result) {
      // Both Haiku and Sonnet returned malformed output. Skip but
      // DON'T update markers — the next call retries with the same
      // records (which is appropriate; quality may have improved).
      console.warn(
        `feedback: induction returned no proposal for ${feedbackType}/${groupKey} (both models malformed)`,
      );
      continue;
    }

    const envelope = {
      type: pipeline.proposalType,
      group_key: groupKey,
      feedback_type: feedbackType,
      source_records: groupRecords.slice(-INDUCTION_THRESHOLD).map((r) => ({
        ts: r.ts,
        ...(r.field_label !== undefined ? { field_label: r.field_label } : {}),
        ...(r.error_kind !== undefined ? { error_kind: r.error_kind } : {}),
        ...(r.step_idx !== undefined ? { step_idx: r.step_idx } : {}),
      })),
      proposal: result.proposal,
      cost_usd: result.cost_usd,
      model_used: result.model_used,
    };

    // REVIEW H7 (adv) fix: try/catch around savePending so a schema
    // throw on one envelope doesn't lose the prior newProposals (and
    // the markers update they depended on).
    let id;
    try {
      id = await savePending(envelope);
    } catch (err) {
      console.warn(
        `feedback: savePending failed for ${feedbackType}/${groupKey}: ${err?.message || err}`,
      );
      continue;
    }
    updatedMarkers[mKey] = {
      count_at_last_induction: currentCount,
      induced_at: new Date(now).toISOString(),
      proposal_id: id,
    };
    newProposals.push({ ...envelope, id, status: 'pending', created_at: new Date(now).toISOString() });
  }

  if (newProposals.length) {
    await writeMarkers(updatedMarkers);
  }
  return newProposals;
}

/**
 * Convenience: run induction across ALL known feedback types. Used by the
 * m4 "Run induction now" manual button + endpoint.mjs apply-close hook.
 *
 * @param {{ client?: object, recordCost?: Function, now?: number }} [deps]
 */
export async function maybeInduceAll(deps = {}) {
  const proposals = [];
  for (const type of KNOWN_FEEDBACK_TYPES) {
    const batch = await maybeInduce(type, deps);
    proposals.push(...batch);
  }
  return proposals;
}
