// Promote-evidence flow — turn a `site-failures.jsonl` record into a
// scaffolded TODO for the eval-fixture corpus.
//
// 07-applier/self-iteration/03-iteration-dashboard m1.
//
// Per m1-OQ locked at plan-milestones: we DO NOT capture full HTML in
// the promote step. The promote action writes a single TODO yaml under
// `data/career/eval-fixtures/promote-queue/{ts}-{id}.yml` containing
// the URL + evidence metadata; the operator runs `capture-fixture.mjs`
// manually against that URL to fill the actual HTML.
//
// Why: site-failures.jsonl.snapshot_excerpt is schema-capped at ~400
// chars (insufficient for a full fixture) and a server-side Playwright
// capture would (a) violate EH4's offline-only spirit, (b) require the
// failing ATS to still be reachable, (c) add a heavy IO dep to a polled
// HTTP endpoint.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { readJsonl as feedbackReadJsonl, _FILES as FEEDBACK_FILES } from '../feedback/stores.mjs';
import { DEFAULT_FIXTURES_DIR } from '../eval/fixtures/loader.mjs';
import { stableId } from './eventStream.mjs';

export const PROMOTE_QUEUE_DIR = path.join(DEFAULT_FIXTURES_DIR, 'promote-queue');

// REVIEW HIGH 1 (adv) + MEDIUM (Plan) fix: per-id mutex so two concurrent
// POST /promote/:id calls don't both pass the existence check + write
// racing yaml files. Single-process Express, so an in-memory Map is
// sufficient — no fs lock needed.
/** @type {Map<string, Promise<{status:string,path:string,url:string}>>} */
const _inflight = new Map();

/** Used by URL-param validation in server.mjs to reject obvious junk
 *  before we hit the file system. The id is a 12-hex sha256 prefix. */
export const EVIDENCE_ID_RE = /^[a-f0-9]{12}$/;

/**
 * Promote a site-failure record (addressed by its stableId hash) into
 * a TODO yaml. Idempotent — refuses to clobber an existing entry; the
 * second-promote attempt returns 'already_promoted'.
 *
 * @param {string} evidenceId — 12-hex sha256 prefix
 * @returns {Promise<{ status: 'created' | 'already_promoted', path: string, url: string }>}
 */
export function promoteEvidence(evidenceId) {
  if (!EVIDENCE_ID_RE.test(evidenceId)) {
    return Promise.reject(
      new TypeError(`promoteEvidence: evidenceId must be 12-hex, got ${JSON.stringify(evidenceId)}`),
    );
  }
  // Per-id mutex: rapid double-clicks on Promote (or a misbehaving
  // client) get serialized so only one promote actually runs to completion.
  const existing = _inflight.get(evidenceId);
  if (existing) return existing;
  const task = _promoteEvidenceImpl(evidenceId).finally(() => {
    _inflight.delete(evidenceId);
  });
  _inflight.set(evidenceId, task);
  return task;
}

async function _promoteEvidenceImpl(evidenceId) {
  // Find the record in site-failures.jsonl.
  let target = null;
  for await (const r of feedbackReadJsonl(FEEDBACK_FILES.SITE_FAILURES)) {
    if (stableId(r) === evidenceId) {
      target = r;
      break;
    }
  }
  if (!target) {
    const err = new Error(`promoteEvidence: no site-failure record matches id ${evidenceId}`);
    err.code = 'EVIDENCE_NOT_FOUND';
    throw err;
  }

  // Refuse duplicate promotes — scan promote-queue/ for an existing file.
  await fs.mkdir(PROMOTE_QUEUE_DIR, { recursive: true });
  const existingPath = await _findExistingPromote(evidenceId);
  if (existingPath) {
    return {
      status: 'already_promoted',
      path: existingPath,
      url: target.error_message?.match(/https?:\/\/[^\s]+/)?.[0] || `https://${target.domain}/`,
    };
  }

  // Build the TODO yaml.
  const url = `https://${target.domain}/`;
  const vendor = target.site_adapter_id || 'custom';
  const slug = _slugifyDomain(target.domain);
  // REVIEW LOW (Plan) defensive: `String(target.ts || '')` so a future
  // schema change that drops ts doesn't crash with "Cannot read properties
  // of undefined".
  const tsForFilename = String(target.ts || '').replace(/[^0-9TZ]/g, '') || 'no-ts';
  const filename = `${tsForFilename}-${evidenceId}.yml`;
  const filepath = path.join(PROMOTE_QUEUE_DIR, filename);

  const body = _buildPromoteTodoYaml({
    url,
    vendor,
    suggested_slug: slug,
    evidence: {
      id: evidenceId,
      ts: target.ts,
      domain: target.domain,
      site_adapter_id: target.site_adapter_id,
      step_idx: target.step_idx,
      error_kind: target.error_kind,
      error_message: target.error_message,
      job_id: target.jobId,
    },
  });

  // Atomic write via tmp + rename so a crash mid-promote doesn't leave
  // a torn yaml that crashes the dashboard on next poll.
  const tmp = filepath + `.tmp.${process.pid}`;
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, filepath);

  return { status: 'created', path: filepath, url };
}

/** Look up an existing promote yaml for this evidence id. Returns the
 *  full path if found, null otherwise. */
async function _findExistingPromote(evidenceId) {
  let entries;
  try {
    entries = await fs.readdir(PROMOTE_QUEUE_DIR);
  } catch {
    return null;
  }
  const suffix = `-${evidenceId}.yml`;
  for (const name of entries) {
    if (name.endsWith(suffix)) {
      return path.join(PROMOTE_QUEUE_DIR, name);
    }
  }
  return null;
}

/** Suggest a kebab-case slug from a domain hostname.
 *
 *   anthropic.wd5.myworkdayjobs.com  →  anthropic
 *   jobs.icims.com                   →  icims
 *   boards.greenhouse.io             →  greenhouse
 *
 * Conservative: just take the first dot-segment and kebab-ify. The
 * operator can override at capture-fixture time. */
function _slugifyDomain(domain) {
  if (typeof domain !== 'string' || !domain) return 'unknown';
  const first = domain.split('.')[0];
  return first.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

/** Hand-rolled YAML for full control over comment placement + ordering
 *  (js-yaml drops comments + reorders keys). The output is NOT meant
 *  to be schema-valid as a ground-truth.yml — it's a TODO marker. */
function _buildPromoteTodoYaml({ url, vendor, suggested_slug, evidence }) {
  const lines = [
    '# Promoted from site-failure evidence — pending fixture capture.',
    '#',
    '# To complete this fixture:',
    `#   node scripts/capture-fixture.mjs --url ${url} --vendor ${vendor} --slug ${suggested_slug}`,
    '#',
    '# Then review + annotate the generated truth.yml, run `npm run eval:snapshot`',
    `#   to verify scores, and finally delete this file:`,
    `#   rm ${path.relative(process.cwd(), path.join(PROMOTE_QUEUE_DIR, '<this-file>'))}`,
    '#',
    `# This file lives outside the loader's scan path (subdirectory of`,
    `# eval-fixtures/) so it does NOT affect the eval pipeline.`,
    '',
    `url: ${JSON.stringify(url)}`,
    `vendor: ${vendor}`,
    `suggested_slug: ${suggested_slug}`,
    '',
    'evidence:',
    `  id: ${evidence.id}`,
    `  ts: ${JSON.stringify(evidence.ts)}`,
    `  job_id: ${JSON.stringify(evidence.job_id ?? null)}`,
    `  domain: ${JSON.stringify(evidence.domain ?? null)}`,
    `  site_adapter_id: ${JSON.stringify(evidence.site_adapter_id ?? null)}`,
    `  step_idx: ${evidence.step_idx === null || evidence.step_idx === undefined ? 'null' : evidence.step_idx}`,
    `  error_kind: ${JSON.stringify(evidence.error_kind ?? null)}`,
    `  error_message: ${JSON.stringify(evidence.error_message ?? null)}`,
    '',
  ];
  return lines.join('\n');
}
