// Mode 1 draft input bundle loader. Reads the inputs that draftPrompt.
// buildSystemBlock + buildUserMessage consume:
//
//   - reportText:    data/career/reports/{jobId}.md (Block A/E)
//   - legalYml:      data/career/qa-bank/legal.yml (parsed)
//   - templatesText: data/career/qa-bank/templates.md
//   - identityYml:   data/career/identity.yml (parsed)
//   - qaHistory:     last 5 entries from qa-bank/history.jsonl, NEWEST-FIRST
//                    (draftPrompt CONTRACT: caller passes newest-first;
//                    cvBundle.loadQaFewShot returns oldest-first via
//                    slice(-5), so this loader reverses).
//   - pdfPath:       data/career/output/{jobId}-{defaultResumeId}.pdf
//                    (or the most-recent {jobId}-*.pdf if multiple exist;
//                    null when no Tailor output yet)
//
// Defensive read: every individual file is graceful on missing/parse-error.
// The endpoint decides whether to 404 (e.g. report missing) BEFORE calling
// the runner — see m3.

import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import yaml from 'js-yaml';

const DATA_DIR = path.resolve('data');
const CAREER_DIR = path.join(DATA_DIR, 'career');
const REPORTS_DIR = path.join(CAREER_DIR, 'reports');
const QA_BANK_DIR = path.join(CAREER_DIR, 'qa-bank');
const QA_LEGAL_FILE = path.join(QA_BANK_DIR, 'legal.yml');
const QA_TEMPLATES_FILE = path.join(QA_BANK_DIR, 'templates.md');
const QA_HISTORY_FILE = path.join(QA_BANK_DIR, 'history.jsonl');
const IDENTITY_FILE = path.join(CAREER_DIR, 'identity.yml');
const TAILOR_OUTPUT_DIR = path.join(CAREER_DIR, 'output');

const QA_HISTORY_LIMIT = 5;
const JOB_ID_RE = /^[a-f0-9]{12}$/;

async function readFileOrEmpty(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return '';
    throw e;
  }
}

async function loadYamlOrEmpty(filePath) {
  const raw = await readFileOrEmpty(filePath);
  if (!raw.trim()) return {};
  try {
    const parsed = yaml.load(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Read history.jsonl, parse JSONL leniently (skip malformed lines), return
// LAST QA_HISTORY_LIMIT entries in NEWEST-FIRST order.
async function loadQaHistoryNewestFirst() {
  const raw = await readFileOrEmpty(QA_HISTORY_FILE);
  if (!raw.trim()) return [];
  const lines = raw.split('\n').filter((l) => l.trim());
  const records = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (r && typeof r === 'object') records.push(r);
    } catch {
      // partial qa-bank > zero qa-bank
    }
  }
  // Take the last QA_HISTORY_LIMIT (chronological order, newest at the end
  // since history.jsonl is append-only), then reverse so the prompt sees
  // newest-first per draftPrompt's documented contract.
  return records.slice(-QA_HISTORY_LIMIT).reverse();
}

// Look up the tailored PDF path for a jobId. The Tailor Engine writes
// `{jobId}-{resumeId}.pdf` per render. We pick the LATEST file by mtime
// when multiple resumeIds have been tailored for the same job (e.g. user
// re-tailored). Returns null when no PDF exists (m3 endpoint then emits
// the class:'file' field with low confidence + empty suggested_value via
// the prompt's pdfPath-missing path).
async function findLatestPdfPath(jobId) {
  if (!JOB_ID_RE.test(jobId)) return null;
  if (!existsSync(TAILOR_OUTPUT_DIR)) return null;
  let entries;
  try {
    entries = await fs.readdir(TAILOR_OUTPUT_DIR);
  } catch {
    return null;
  }
  const matches = [];
  for (const name of entries) {
    // Match {jobId}-{resumeId}.pdf; resumeId regex matches Tailor Engine's
    // canonical convention (^[a-z0-9-]{1,40}$).
    const m = name.match(new RegExp(`^${jobId}-([a-z0-9-]{1,40})\\.pdf$`));
    if (m) matches.push({ name, resumeId: m[1] });
  }
  if (matches.length === 0) return null;
  // Pick most recent by mtime
  let latest = null;
  for (const candidate of matches) {
    const full = path.join(TAILOR_OUTPUT_DIR, candidate.name);
    try {
      const stat = await fs.stat(full);
      if (!latest || stat.mtimeMs > latest.mtimeMs) {
        latest = { ...candidate, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // skip unreadable file
    }
  }
  if (!latest) return null;
  // Return forward-slash path for portability between server-side
  // mutations and any future URL construction (matches Stage B
  // report_path convention).
  return `data/career/output/${latest.name}`;
}

/**
 * Load the full Mode 1 input bundle for a given jobId.
 *
 * Returns { reportText, legalYml, templatesText, identityYml, qaHistory,
 *   pdfPath, reportExists }
 *
 * The endpoint should check `reportExists === false` BEFORE calling
 * the runner — drafting without Block E personalization seed produces
 * generic answers, so the contract is "Stage B must run first".
 */
export async function loadApplierBundle(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    throw new TypeError(`invalid jobId: ${JSON.stringify(jobId)}`);
  }
  const reportFile = path.join(REPORTS_DIR, `${jobId}.md`);
  const reportExists = existsSync(reportFile);

  const [reportText, legalYml, templatesText, identityYml, qaHistory, pdfPath] =
    await Promise.all([
      reportExists ? fs.readFile(reportFile, 'utf8') : Promise.resolve(''),
      loadYamlOrEmpty(QA_LEGAL_FILE),
      readFileOrEmpty(QA_TEMPLATES_FILE),
      loadYamlOrEmpty(IDENTITY_FILE),
      loadQaHistoryNewestFirst(),
      findLatestPdfPath(jobId),
    ]);

  return {
    reportText,
    legalYml,
    templatesText,
    identityYml,
    qaHistory,
    pdfPath,
    reportExists,
  };
}

// Test seam — exposed paths so smokes can write fixtures.
export const _PATHS = Object.freeze({
  REPORTS_DIR,
  QA_LEGAL_FILE,
  QA_TEMPLATES_FILE,
  QA_HISTORY_FILE,
  IDENTITY_FILE,
  TAILOR_OUTPUT_DIR,
});
