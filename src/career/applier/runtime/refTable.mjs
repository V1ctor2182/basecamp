// Ref table — maps symbolic refs (eN) to Playwright Locator descriptors.
//
// 07-applier/08-snapshot-refs-layer m1.
//
// Per-Page instance. Each successful snapshot() builds a NEW RefTable
// (m1: full replacement; m2 adds generation tracking so stale refs from
// prior snapshots return STALE_REF rather than silently resolving to
// elements they no longer represent). m1 keeps it dead simple — refs
// from the most recent snapshot are valid; nothing else is.
//
// The table stores semantic info (role/name/occurrenceIndex) rather than
// ElementHandles or backendNodeIds. This is the Plan A choice from the
// plan-milestones discussion: leverage Playwright's getByRole + nth() for
// resolution at action-time, so we get Playwright's auto-wait + visibility
// retries for free. The CDP-resolution alternative (Plan B) can be slotted
// in per-action post-ROOM-COMPLETE when 09-snapshot-eval-harness flags
// specific ATS pages where Locator fails.

/**
 * Per-Page ref table. Builds via mint() during snapshot enumeration; reads
 * via resolve() during action dispatch.
 */
export class RefTable {
  /**
   * @param {import('playwright').Page} [page] — the Page this table was
   *   minted against. Stored so resolve() can detect cross-page misuse
   *   (M5 fix from review). m2 will also use this to attach
   *   framenavigated listeners for SPA pushState invalidation.
   */
  constructor(page) {
    /** @type {Map<string, { role: string, name: string, occurrenceIndex: number, frameIdx: number }>} */
    this._entries = new Map();
    this._counter = 0;
    this._page = page || null;
  }

  /**
   * Mint a new ref for an interactive node. `occurrenceIndex` is the
   * 0-based index of this (role, name) pair within the current snapshot
   * (document order). m2 will extend with frameIdx for iframe support.
   *
   * @param {string} role
   * @param {string} name
   * @param {number} occurrenceIndex
   * @param {number} [frameIdx=0] — 0 = top-level page; m2 sets this when
   *   walking iframes
   * @returns {string} the minted ref like "e1"
   */
  mint(role, name, occurrenceIndex, frameIdx = 0) {
    this._counter += 1;
    const refId = `e${this._counter}`;
    this._entries.set(refId, { role, name, occurrenceIndex, frameIdx });
    return refId;
  }

  /**
   * Resolve a ref to a Playwright Locator. m2 will replace the throw paths
   * with unified SnapshotError instances (STALE_REF / UNKNOWN_REF). For m1
   * we throw plain Error with the ref + context — good enough for tests +
   * downstream code can already see clear messages.
   *
   * @param {string} refId
   * @param {import('playwright').Page} page
   * @returns {import('playwright').Locator}
   */
  resolve(refId, page) {
    // M5 fix: detect cross-page misuse early with a clear error rather
    // than letting it manifest as a Playwright timeout 10s later.
    if (this._page && page && page !== this._page) {
      throw new Error(
        `WRONG_PAGE: refTable was minted against a different Page; ` +
          `call snapshot(page) to mint a fresh table for this page.`,
      );
    }
    const entry = this._entries.get(refId);
    if (!entry) {
      // m2 will replace with SnapshotError.unknownRef(refId)
      throw new Error(
        `UNKNOWN_REF: ${refId} not in current snapshot. Call snapshot() first.`,
      );
    }
    const { role, name, occurrenceIndex } = entry;
    // exact:true so "Submit" doesn't accidentally match "Submit application"
    return page.getByRole(role, { name, exact: true }).nth(occurrenceIndex);
  }

  /** @param {string} refId */
  has(refId) {
    return this._entries.has(refId);
  }

  get(refId) {
    return this._entries.get(refId);
  }

  size() {
    return this._entries.size;
  }
}
