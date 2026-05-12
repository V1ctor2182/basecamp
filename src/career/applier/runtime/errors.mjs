// Unified error codes for the snapshot+refs layer.
//
// 07-applier/08-snapshot-refs-layer m2.
//
// Per C4 constraint: Playwright native errors MUST be translated into a
// stable enum of codes (STALE_REF / UNKNOWN_REF / ELEMENT_GONE /
// ACTION_TIMEOUT / IFRAME_DETACHED / WRONG_PAGE). Each carries a
// machine-readable code + a one-line hint the LLM can read to know what
// to do next ("Call snapshot() first" / "Re-snapshot then retry" / etc).
//
// Why an enum: downstream Rooms (03-field-classifier, 04-multi-step-state-
// machine, self-iteration/02-data-flywheel) want to branch on FAILURE
// TYPE, not parse Playwright error messages. m1 threw plain Errors; m2
// replaces those throw sites with SnapshotError instances.

export const SNAPSHOT_ERROR_CODES = Object.freeze({
  // Ref was minted by a prior snapshot generation; action layer invalidated
  // the table (after a click/fill/etc), and the LLM tried to re-use a ref
  // without re-snapshotting. C3 constraint enforced.
  STALE_REF: 'STALE_REF',
  // Ref was never minted (LLM hallucinated a ref, or referenced one from
  // a totally different RefTable instance).
  UNKNOWN_REF: 'UNKNOWN_REF',
  // Ref was valid but the underlying element no longer exists or is
  // detached. Catches: getByRole returns 0 matches; locator.click on a
  // node removed from the DOM after snapshot; Playwright TargetClosed.
  ELEMENT_GONE: 'ELEMENT_GONE',
  // Playwright's TimeoutError raised by an action — element didn't reach
  // actionable state within the configured timeout (visible + stable +
  // enabled + receives events).
  ACTION_TIMEOUT: 'ACTION_TIMEOUT',
  // iframe was detached between snapshot and action — Frame.isDetached()
  // returns true on resolve.
  IFRAME_DETACHED: 'IFRAME_DETACHED',
  // resolve() called with a Page that doesn't match the RefTable's
  // owning Page (likely caller bug — never mint on Page A then resolve
  // with Page B).
  WRONG_PAGE: 'WRONG_PAGE',
});

/**
 * Unified error class for all snapshot+refs layer failures. Use the
 * static factories rather than the constructor directly — they ensure
 * code/message/hint stay consistent.
 */
export class SnapshotError extends Error {
  /**
   * @param {object} opts
   * @param {string} opts.code — one of SNAPSHOT_ERROR_CODES
   * @param {string} opts.message
   * @param {string} opts.hint — LLM-facing instruction
   * @param {string} [opts.refId]
   * @param {object} [opts.entry] — RefTable entry { role, name, occurrenceIndex, frame? }
   * @param {Error} [opts.cause]
   */
  constructor({ code, message, hint, refId, entry, cause }) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
    this.hint = hint;
    if (refId) this.refId = refId;
    if (entry) this.entry = entry;
    if (cause) this.cause = cause;
  }

  /** Single-line message suitable for inclusion in an LLM tool-call response. */
  toLLMMessage() {
    const refPart = this.refId ? `ref=${this.refId} ` : '';
    return `${this.code}: ${refPart}${this.message}. ${this.hint}`;
  }

  // ── Factories ──────────────────────────────────────────────────────────

  static staleRef(refId, entry, mintedGen, currentGen) {
    return new SnapshotError({
      code: SNAPSHOT_ERROR_CODES.STALE_REF,
      message: `ref ${refId} was minted at generation ${mintedGen}, current is ${currentGen} (an action invalidated the snapshot)`,
      hint: 'Call snapshot() first.',
      refId,
      entry,
    });
  }

  static unknownRef(refId) {
    return new SnapshotError({
      code: SNAPSHOT_ERROR_CODES.UNKNOWN_REF,
      message: `ref ${refId} not present in the current snapshot`,
      hint: 'Call snapshot() first.',
      refId,
    });
  }

  static elementGone(refId, entry, cause) {
    const role = entry?.role ?? '?';
    const name = JSON.stringify(entry?.name ?? '');
    return new SnapshotError({
      code: SNAPSHOT_ERROR_CODES.ELEMENT_GONE,
      message: `element for ${refId} (role=${role} name=${name}) is no longer in the DOM`,
      hint: 'Call snapshot() first.',
      refId,
      entry,
      cause,
    });
  }

  static actionTimeout(refId, entry, action, timeoutMs, cause) {
    const role = entry?.role ?? '?';
    const name = JSON.stringify(entry?.name ?? '');
    return new SnapshotError({
      code: SNAPSHOT_ERROR_CODES.ACTION_TIMEOUT,
      message: `${action} on ${refId} (role=${role} name=${name}) exceeded ${timeoutMs}ms (element never reached actionable state)`,
      hint: 'Call snapshot() first; the element may now be detached or hidden.',
      refId,
      entry,
      cause,
    });
  }

  static iframeDetached(refId, entry) {
    return new SnapshotError({
      code: SNAPSHOT_ERROR_CODES.IFRAME_DETACHED,
      message: `iframe containing ${refId} was detached between snapshot and action`,
      hint: 'Call snapshot() first.',
      refId,
      entry,
    });
  }

  static wrongPage() {
    return new SnapshotError({
      code: SNAPSHOT_ERROR_CODES.WRONG_PAGE,
      message: 'refTable was minted against a different Page',
      hint: 'Call snapshot(page) to mint a fresh table for this page.',
    });
  }
}

/**
 * Classify a Playwright error message into a SnapshotError code. Returns
 * one of ELEMENT_GONE / ACTION_TIMEOUT, or null if the error doesn't match
 * a known pattern (caller should re-throw the original).
 *
 * Playwright error patterns:
 *   - TimeoutError class (name === 'TimeoutError') — ACTION_TIMEOUT
 *   - "Locator.click: Timeout NNNN ms exceeded" message — ACTION_TIMEOUT
 *   - "Target closed" / "Target page, context or browser has been closed"
 *     — ELEMENT_GONE (the whole context died; from agent's POV the
 *     element is unreachable)
 *   - "Element is not attached to the DOM" — ELEMENT_GONE
 *   - "strict mode violation" / "resolved to 0 elements" — ELEMENT_GONE
 *     (getByRole.nth returned no element — the row from snapshot no
 *     longer exists)
 */
export function classifyPlaywrightError(err) {
  if (!err) return null;
  const msg = String(err.message || '');
  // M3 fix: check "resolved to 0 elements" / detached BEFORE the
  // TimeoutError catch-all. Playwright's TimeoutError on a removed-
  // element scenario has the timeout phrase in its message AND a "0
  // elements" line in its call log; we want the more specific
  // ELEMENT_GONE classification, not the bland ACTION_TIMEOUT.
  if (/element is not attached|element handle is detached/i.test(msg)) {
    return SNAPSHOT_ERROR_CODES.ELEMENT_GONE;
  }
  if (/resolved to 0 elements|no element matches/i.test(msg)) {
    return SNAPSHOT_ERROR_CODES.ELEMENT_GONE;
  }
  if (/Target closed|Target page, context or browser has been closed/i.test(msg)) {
    return SNAPSHOT_ERROR_CODES.ELEMENT_GONE;
  }
  // H2 fix: frame-detached during action
  if (/frame was detached|frame got detached/i.test(msg)) {
    return SNAPSHOT_ERROR_CODES.IFRAME_DETACHED;
  }
  // H2 fix: execution context destroyed (navigation aborted action)
  if (/execution context (was )?destroyed|navigation .* page was closed/i.test(msg)) {
    return SNAPSHOT_ERROR_CODES.ELEMENT_GONE;
  }
  // H2 fix: Playwright auto-wait conditions that timed out
  if (
    /element is (not visible|not stable|not enabled|outside of the viewport)|intercepts pointer events/i.test(
      msg,
    )
  ) {
    return SNAPSHOT_ERROR_CODES.ACTION_TIMEOUT;
  }
  // Strict mode (multiple matches) — usually means our nth() resolved
  // ambiguously; treat as element-gone for retry semantics
  if (/strict mode violation/i.test(msg)) return SNAPSHOT_ERROR_CODES.ELEMENT_GONE;
  // Generic timeout — last so above more-specific patterns win
  if (err.name === 'TimeoutError') return SNAPSHOT_ERROR_CODES.ACTION_TIMEOUT;
  if (/Timeout \d+ ?ms exceeded/i.test(msg)) return SNAPSHOT_ERROR_CODES.ACTION_TIMEOUT;
  return null;
}
