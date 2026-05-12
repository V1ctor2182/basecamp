// Ref table — maps symbolic refs (eN) to Playwright Locators (m1) +
// tracks generation for pessimistic invalidation (m2).
//
// 07-applier/08-snapshot-refs-layer m1+m2.
//
// Per-Page instance. Each snapshot() builds a NEW RefTable so refs from
// prior snapshots are simply not in the new table (UNKNOWN_REF). m2 adds
// IN-TABLE staleness: after any mutating action (click/fill/etc), the
// table's generation counter bumps, marking ALL existing entries as
// stale until the caller re-snapshots. This is C3's pessimistic
// invalidation — SPA pushState bypasses framenavigated, so we rely on
// post-action invalidation as the primary signal.

import { SnapshotError } from './errors.mjs';

/**
 * Per-Page ref table. Builds via mint() during snapshot enumeration; reads
 * via resolve() during action dispatch. Each mint records the table's
 * current generation; resolve checks the recorded generation matches
 * (else STALE_REF). invalidate() bumps the generation.
 */
export class RefTable {
  /**
   * @param {import('playwright').Page} [page] — owning Page (for WRONG_PAGE
   *   detection)
   */
  constructor(page) {
    /** @type {Map<string, { role: string, name: string, occurrenceIndex: number, frame: import('playwright').Frame | null }>} */
    this._entries = new Map();
    /** @type {Map<string, number>} */
    this._mintedGen = new Map();
    this._counter = 0;
    this._currentGen = 0;
    this._page = page || null;
  }

  /**
   * Mint a new ref for an interactive node. Records the table's current
   * generation alongside the entry so resolve() can detect staleness.
   *
   * @param {string} role
   * @param {string} name — already normalized (control chars stripped)
   * @param {number} occurrenceIndex — 0-based among (role, name) duplicates
   * @param {import('playwright').Frame} [frame=null] — null for top-level
   *   Page; iframe Frame for inline-recursed content (m2)
   * @returns {string} the minted ref like "e1"
   */
  mint(role, name, occurrenceIndex, frame = null) {
    this._counter += 1;
    const refId = `e${this._counter}`;
    this._entries.set(refId, { role, name, occurrenceIndex, frame });
    this._mintedGen.set(refId, this._currentGen);
    return refId;
  }

  /**
   * Pessimistic invalidation — bump the generation so all existing refs
   * become STALE_REF on next resolve. Entries kept so the error message
   * can still report what role/name the ref WAS for, which helps the LLM
   * understand what changed.
   */
  invalidate() {
    this._currentGen += 1;
  }

  /**
   * Resolve a ref to a Playwright Locator scoped to its owning frame.
   * Throws SnapshotError instances (m2 — was plain Error in m1).
   *
   * @param {string} refId
   * @param {import('playwright').Page} page
   * @returns {import('playwright').Locator}
   */
  resolve(refId, page) {
    // M5 fix from m1 review: detect cross-page misuse early
    if (this._page && page && page !== this._page) {
      throw SnapshotError.wrongPage();
    }
    const entry = this._entries.get(refId);
    if (!entry) {
      throw SnapshotError.unknownRef(refId);
    }
    const mintedGen = this._mintedGen.get(refId);
    if (mintedGen !== this._currentGen) {
      throw SnapshotError.staleRef(refId, entry, mintedGen, this._currentGen);
    }
    // m2: iframe support — entry.frame is null for top-level, set for iframe
    if (entry.frame && entry.frame.isDetached()) {
      throw SnapshotError.iframeDetached(refId, entry);
    }
    const target = entry.frame || page;
    return target.getByRole(entry.role, { name: entry.name, exact: true }).nth(entry.occurrenceIndex);
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

  /** Current generation — useful for tests. */
  generation() {
    return this._currentGen;
  }

  /**
   * Iterate over (refId, entry) pairs in mint order. Public API for
   * smokes + downstream Rooms that need to walk the table.
   * (M4 fix: was accessing private _entries directly.)
   */
  *entries() {
    yield* this._entries.entries();
  }

  /** Iterate over refIds in mint order. */
  *refIds() {
    yield* this._entries.keys();
  }
}
