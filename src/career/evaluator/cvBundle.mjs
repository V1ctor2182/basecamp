// CV-bundle loader. Reads the candidate's base.md (default resume) +
// narrative.md + proof-points.md + identity.yml + last 5 qa-bank/history
// entries from disk, returning the bundle shape consumed by m1's
// buildSystemBlock(). Every read is graceful on missing file → '' / [] / {}.
//
// This module is shared by stageBRunner (m2) and the m4 stage-b endpoint
// (the regenerate-report path needs the same bundle). Future Tailor Engine
// also consumes it.
//
// Default resume policy (locked at m2 plan):
//   - Pick the entry in resumes/index.yml where is_default === true
//   - If no default, OR resumes:[] is empty, OR index.yml missing → cv=''
//   - Don't fall back to "first entry" — silent default-picking masks the
//     empty-index case and would let Stage B evaluate against a wrong resume.
//
// qa-bank policy:
//   - Last 5 entries from history.jsonl
//   - Malformed lines silently skipped (not thrown) — partial qa-bank is
//     better than zero few-shot context.

import path from 'node:path';
import fs from 'node:fs/promises';
import yaml from 'js-yaml';

const DATA_DIR = path.resolve('data');
const CAREER_DIR = path.join(DATA_DIR, 'career');
const RESUMES_DIR = path.join(CAREER_DIR, 'resumes');
const RESUME_INDEX_FILE = path.join(RESUMES_DIR, 'index.yml');
const NARRATIVE_FILE = path.join(CAREER_DIR, 'narrative.md');
const PROOF_POINTS_FILE = path.join(CAREER_DIR, 'proof-points.md');
const IDENTITY_FILE = path.join(CAREER_DIR, 'identity.yml');
const QA_HISTORY_FILE = path.join(CAREER_DIR, 'qa-bank', 'history.jsonl');

const QA_FEWSHOT_LIMIT = 5;

async function readFileOrEmpty(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return '';
    throw e;
  }
}

async function loadDefaultCv() {
  const indexRaw = await readFileOrEmpty(RESUME_INDEX_FILE);
  if (!indexRaw.trim()) return '';
  let index;
  try {
    index = yaml.load(indexRaw);
  } catch {
    return '';
  }
  const list = Array.isArray(index?.resumes) ? index.resumes : [];
  const def = list.find((r) => r && r.is_default === true);
  if (!def?.id) return '';
  const cvPath = path.join(RESUMES_DIR, String(def.id), 'base.md');
  return readFileOrEmpty(cvPath);
}

async function loadIdentity() {
  const raw = await readFileOrEmpty(IDENTITY_FILE);
  if (!raw.trim()) return {};
  try {
    const parsed = yaml.load(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function loadQaFewShot() {
  const raw = await readFileOrEmpty(QA_HISTORY_FILE);
  if (!raw.trim()) return [];
  const lines = raw.split('\n').filter((l) => l.trim());
  const records = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (r && typeof r === 'object') records.push(r);
    } catch {
      // skip malformed line — partial qa-bank is fine
    }
  }
  return records.slice(-QA_FEWSHOT_LIMIT);
}

// Returns { cv, narrative, proofPoints, identity, qaFewShot } — the bundle
// shape consumed by buildSystemBlock(bundle) in stageBPrompt.mjs.
export async function loadCvBundle() {
  const [cv, narrative, proofPoints, identity, qaFewShot] = await Promise.all([
    loadDefaultCv(),
    readFileOrEmpty(NARRATIVE_FILE),
    readFileOrEmpty(PROOF_POINTS_FILE),
    loadIdentity(),
    loadQaFewShot(),
  ]);
  return { cv, narrative, proofPoints, identity, qaFewShot };
}

// Test seam — exposed paths so the smoke can write fixtures into known
// locations without hardcoding the relative-resolve logic.
export const _PATHS = Object.freeze({
  RESUME_INDEX_FILE,
  RESUMES_DIR,
  NARRATIVE_FILE,
  PROOF_POINTS_FILE,
  IDENTITY_FILE,
  QA_HISTORY_FILE,
});
