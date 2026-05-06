// Tailor-bundle loader. Reads base.md + metadata.yml.emphasize +
// proof-points.md + identity.yml + Block E from data/career/reports/{jobId}.md
// for a single (resumeId, jobId) pair. Every read is graceful on missing
// file → '' / [] / {}. Mirrors the cvBundle pattern from m2 of stage-b-sonnet.
//
// Bundle scope:
//   { baseMd, proofPoints, emphasize, identity, blockEText }
//
// `identity` is included even though m1's prompt doesn't render it — m4's
// renderer call (POST /api/career/render/pdf) needs it for the PDF header,
// and this bundle is the one-stop shop downstream consumers thread through.

import path from 'node:path';
import fs from 'node:fs/promises';
import yaml from 'js-yaml';

import { extractBlockEFromReport } from './tailorPrompt.mjs';

const DATA_DIR = path.resolve('data');
const CAREER_DIR = path.join(DATA_DIR, 'career');
const RESUMES_DIR = path.join(CAREER_DIR, 'resumes');
const PROOF_POINTS_FILE = path.join(CAREER_DIR, 'proof-points.md');
const IDENTITY_FILE = path.join(CAREER_DIR, 'identity.yml');
const REPORTS_DIR = path.join(CAREER_DIR, 'reports');

async function readFileOrEmpty(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return '';
    throw e;
  }
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

async function loadResumeMetadata(resumeId) {
  const file = path.join(RESUMES_DIR, String(resumeId), 'metadata.yml');
  const raw = await readFileOrEmpty(file);
  if (!raw.trim()) return {};
  try {
    const parsed = yaml.load(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function loadBlockE(jobId) {
  const file = path.join(REPORTS_DIR, String(jobId) + '.md');
  const raw = await readFileOrEmpty(file);
  return extractBlockEFromReport(raw);
}

// Returns { baseMd, proofPoints, emphasize, identity, blockEText }.
// All fields graceful on missing file / parse fail.
export async function loadTailorBundle(resumeId, jobId) {
  const baseMdFile = path.join(RESUMES_DIR, String(resumeId), 'base.md');
  const [baseMd, proofPoints, identity, metadata, blockEText] =
    await Promise.all([
      readFileOrEmpty(baseMdFile),
      readFileOrEmpty(PROOF_POINTS_FILE),
      loadIdentity(),
      loadResumeMetadata(resumeId),
      loadBlockE(jobId),
    ]);
  const emphasize =
    metadata && typeof metadata === 'object' && metadata.emphasize &&
      typeof metadata.emphasize === 'object'
      ? metadata.emphasize
      : {};
  return { baseMd, proofPoints, emphasize, identity, blockEText };
}

// Test seam — exposes resolved paths so smoke fixtures can write into
// known locations without re-deriving cwd math.
export const _PATHS = Object.freeze({
  RESUMES_DIR,
  PROOF_POINTS_FILE,
  IDENTITY_FILE,
  REPORTS_DIR,
});
