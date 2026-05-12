// Element-bounded screenshot — JPEG crop of a single ref'd element.
//
// 07-applier/08-snapshot-refs-layer m3.
//
// Complements 02-playwright-runtime's captureStep (full-page). This is
// for "show the LLM / the human ONLY this widget" cases:
//   - self-iteration/02-data-flywheel captures evidence for a specific
//     field that failed (not the whole page)
//   - 03-iteration-dashboard renders inline previews of failed widgets
//   - 03-field-classifier emits an element crop when LLM judgment can't
//     resolve a control type from a11y info alone
//
// Path: data/career/.playwright/screenshots/{jobId}/element-{eN}-{label}.jpg
// (Distinct prefix from 02's `{NNN}-{label}.jpg` to avoid collision with
// per-step full-page captures.)

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { SCREENSHOTS_DIR } from './browser.mjs';
import {
  SnapshotError,
  classifyPlaywrightError,
  SNAPSHOT_ERROR_CODES,
} from './errors.mjs';

const LABEL_RE = /^[a-z0-9-]{1,40}$/;
const JOB_ID_RE = /^[a-f0-9]{12}$/;

function sanitizeLabel(label) {
  if (!label) return 'crop';
  if (LABEL_RE.test(label)) return label;
  throw new TypeError(
    `elementScreenshot: label must match /^[a-z0-9-]{1,40}$/ (got: ${label})`,
  );
}

/**
 * Capture a JPEG of the element identified by `refId`, cropped to its
 * bounding box (Playwright's locator.screenshot does the clip automatically).
 * Quality 70 to match 02's full-page screenshots.
 *
 * @param {import('playwright').Page} page
 * @param {import('./refTable.mjs').RefTable} refTable
 * @param {string} refId — like "e3"
 * @param {string} jobId — 12-hex
 * @param {string} [label='crop'] — descriptive suffix
 * @returns {Promise<string>} absolute path of the written JPEG
 */
export async function captureElement(page, refTable, refId, jobId, label) {
  if (!JOB_ID_RE.test(jobId)) {
    throw new TypeError(`elementScreenshot: jobId must match 12-hex (got: ${jobId})`);
  }
  const safeLabel = sanitizeLabel(label);
  // resolve() throws SnapshotError on bad ref / stale / wrong-page / iframe-detached
  const locator = refTable.resolve(refId, page);
  const dir = path.join(SCREENSHOTS_DIR, jobId);
  await fs.mkdir(dir, { recursive: true });
  const filename = `element-${refId}-${safeLabel}.jpg`;
  const filepath = path.join(dir, filename);
  try {
    await locator.screenshot({
      path: filepath,
      type: 'jpeg',
      quality: 70,
    });
  } catch (err) {
    // M3 fix from review: route via classifyPlaywrightError so disk-full
    // / write-failure errors don't get the misleading "element gone" hint.
    const code = classifyPlaywrightError(err);
    const entry = refTable.get(refId);
    if (code === SNAPSHOT_ERROR_CODES.ELEMENT_GONE) {
      throw SnapshotError.elementGone(refId, entry, err);
    }
    if (code === SNAPSHOT_ERROR_CODES.ACTION_TIMEOUT) {
      throw SnapshotError.actionTimeout(refId, entry, 'captureElement', 30_000, err);
    }
    // Re-throw raw — likely disk/permissions or non-element root cause
    throw err;
  }
  return filepath;
}
