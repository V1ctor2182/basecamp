// Per-step screenshot capture — Mode 2 留证 ("audit trail") for applier runs.
//
// 07-applier/02-playwright-runtime m3.
//
// Stateless utilities. Writes JPEG (quality 70) to
//   data/career/.playwright/screenshots/{jobId}/{NNN}-{label}.jpg
//
// Decisions (locked from plan-milestones):
//   - JPEG q70 — ~5x smaller than PNG,留证用够 (OQ6)
//   - 3-digit zero-padded stepN — sort-friendly + supports up to 999 steps
//     (Workday tops out around 8, plenty of headroom)
//   - jobId is 12-hex (matches project-wide regex)
//   - Label is sanitized (only [a-z0-9-] allowed) to prevent path traversal
//
// Consumers (downstream Rooms):
//   - 07-applier/08-snapshot-refs-layer's action wrapper calls captureStep
//     after each click/fill for evidence trail
//   - self-iteration/02-data-flywheel reads via listScreenshots when an
//     apply fails (capture evidence into the shared evidence-store)
//   - self-iteration/03-iteration-dashboard renders screenshots inline in
//     the evidence-promotion UI

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { SCREENSHOTS_DIR } from './browser.mjs';

const JOB_ID_RE = /^[a-f0-9]{12}$/;
const LABEL_RE = /^[a-z0-9-]{1,40}$/;
const DEFAULT_LABEL = 'step';
const FILENAME_RE = /^(\d{3})-([a-z0-9-]+)\.jpg$/;

function assertValidJobId(jobId) {
  if (!JOB_ID_RE.test(jobId)) {
    throw new TypeError(`screenshot: jobId must match 12-hex (got: ${jobId})`);
  }
}

function sanitizeLabel(label) {
  if (label === undefined || label === null || label === '') return DEFAULT_LABEL;
  if (LABEL_RE.test(label)) return label;
  throw new TypeError(
    `screenshot: label must match /^[a-z0-9-]{1,40}$/ (got: ${label}); ` +
      `sanitize on the caller side to prevent path traversal`,
  );
}

function pad3(n) {
  // M1 fix: step numbering starts at 1 (001-step.jpg). 0 was previously
  // accidentally allowed; pin the policy. Smoke convention + downstream
  // dashboard ordering assumes 1-indexed.
  const i = Number(n);
  if (!Number.isInteger(i) || i < 1 || i > 999) {
    throw new RangeError(`screenshot: stepN must be integer in [1, 999] (got: ${n})`);
  }
  return String(i).padStart(3, '0');
}

/**
 * Capture a JPEG screenshot of the full page and write it to the per-jobId
 * screenshots directory. Idempotent on (jobId, stepN, label) — calling with
 * the same arguments overwrites.
 *
 * NOT safe for concurrent writes to the same (jobId, stepN, label) — caller
 * must serialize. Concurrent writes to DIFFERENT jobIds or different stepNs
 * within one jobId are safe (mkdir is recursive-EEXIST-safe; writes to
 * distinct paths don't interleave).
 *
 * @param {import('playwright').Page} page
 * @param {string} jobId — 12-hex job identifier
 * @param {number} stepN — integer in [1, 999], padded to 3 digits in filename
 * @param {string} [label='step'] — descriptive suffix; matches /^[a-z0-9-]{1,40}$/
 * @returns {Promise<string>} absolute path of the written JPEG
 */
export async function captureStep(page, jobId, stepN, label) {
  assertValidJobId(jobId);
  const safeLabel = sanitizeLabel(label);
  const filename = `${pad3(stepN)}-${safeLabel}.jpg`;
  const dir = path.join(SCREENSHOTS_DIR, jobId);
  await fs.mkdir(dir, { recursive: true });
  const filepath = path.join(dir, filename);
  // H4 fix: wrap Playwright's raw "Target page... has been closed" errors
  // with our context (jobId/step/label) so downstream loggers + the
  // iteration-dashboard can route the failure to the right run.
  try {
    await page.screenshot({
      path: filepath,
      type: 'jpeg',
      quality: 70,
      fullPage: true,
    });
  } catch (err) {
    throw new Error(
      `captureStep failed for job=${jobId} step=${pad3(stepN)} label=${safeLabel}: ${err.message}`,
      { cause: err },
    );
  }
  return filepath;
}

/**
 * List screenshot filenames for a jobId, sorted by stepN ascending. Returns
 * empty array if the directory doesn't exist (job never had screenshots,
 * not an error).
 *
 * @param {string} jobId
 * @returns {Promise<string[]>} filenames like ['001-step.jpg', '002-form-filled.jpg']
 */
export async function listScreenshots(jobId) {
  assertValidJobId(jobId);
  const dir = path.join(SCREENSHOTS_DIR, jobId);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  // H5 fix: surface orphan files (filenames not matching the convention)
  // so a sibling tool or manual `cp` that bypasses captureStep doesn't get
  // silently dropped. Warning is at most one log per call, regardless of
  // orphan count, to avoid spamming.
  const valid = [];
  const orphans = [];
  for (const name of entries) {
    if (FILENAME_RE.test(name)) valid.push(name);
    else orphans.push(name);
  }
  if (orphans.length > 0) {
    const preview = orphans.slice(0, 3).join(', ');
    const more = orphans.length > 3 ? ` (+${orphans.length - 3} more)` : '';
    console.warn(
      `[applier/screenshot] ${orphans.length} unparseable filename(s) ` +
        `in ${dir}: ${preview}${more}`,
    );
  }
  return valid.sort((a, b) => {
    const an = Number(a.match(FILENAME_RE)[1]);
    const bn = Number(b.match(FILENAME_RE)[1]);
    return an - bn;
  });
}

/**
 * Remove all screenshots for a jobId. Silent on ENOENT (idempotent — calling
 * for a never-captured job is a no-op, not an error).
 *
 * Consumers: failed-apply cleanup; self-iteration/02-data-flywheel after
 * promoting evidence (don't keep duplicates).
 *
 * @param {string} jobId
 */
export async function clearScreenshots(jobId) {
  assertValidJobId(jobId);
  const dir = path.join(SCREENSHOTS_DIR, jobId);
  await fs.rm(dir, { recursive: true, force: true });
}
