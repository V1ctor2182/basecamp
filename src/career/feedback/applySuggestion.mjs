// Approve / Reject seam for m2-induced proposals.
//
// 07-applier/self-iteration/02-data-flywheel m3.
//
// approveSuggestion:
//   - classifier-rule → append to data/career/feedback/learned-classifier-
//     rules.yml AND call registerExtraRules so the change is live within
//     the same Node process (no server restart required)
//   - site-adapter   → write data/career/site-adapters/{id}.yml AND bust
//     the m1 loader cache so the next loadAdapters call picks it up
//
// rejectSuggestion:
//   - append proposal id to data/career/feedback/rejected-ids.json
//   - m2's maybeInduce reads this set to skip re-proposing for the same
//     (type, groupKey) cluster
//
// Both paths flip the envelope's status field (pending → approved /
// rejected) so listSuggestions's status filter is accurate.
//
// Module-load: ensureLearnedRulesLoaded() reads learned-classifier-rules
// .yml and registers each row via 06-site-adapters' registerExtraRules
// seam. Idempotent — token tracked. Top-level-awaited at the bottom of
// this file (mirrors multistep/siteAdapter.mjs pattern), so importing
// this module from server.mjs at boot is enough to wire learned rules
// into every classifyField sweep.

import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import { z } from 'zod';

import { FEEDBACK_DIR } from './stores.mjs';
import {
  SUGGESTED_DIR,
  REJECTED_IDS_FILE,
  ProposalEnvelopeSchema,
  readSuggestion,
  serializeByKey,
} from './suggestionStore.mjs';
import {
  registerExtraRules,
  clearExtraRules,
} from '../applier/classifier/regexRules.mjs';
import {
  _clearCache as _clearAdaptersCache,
  DEFAULT_ADAPTERS_DIR,
} from '../applier/siteAdapters/loader.mjs';
import { SiteAdapterSchema } from '../applier/siteAdapters/schema.mjs';

export const LEARNED_RULES_FILE = path.join(FEEDBACK_DIR, 'learned-classifier-rules.yml');

/** REVIEW H6 (adv) — clamp ceiling for user-approved adapter priorities.
 *  Above this would shadow bundled adapters (default 100, workday/icims/
 *  successfactors at 110). 100 keeps approved adapters at-or-below
 *  bundled. */
const MAX_USER_ADAPTER_PRIORITY = 100;

/** REVIEW C1 (Plan) + L3 (adv) — reserved adapter ids the approve flow
 *  refuses to overwrite. `default` is the always-match fallback; `_common`
 *  is the merge-defaults file. */
const RESERVED_ADAPTER_IDS = Object.freeze(new Set(['default', '_common']));

/** Schema for one learned-classifier rule row.
 *  REVIEW H4 (adv) fix: drop `.strict()` for on-disk read so a future
 *  m4 column addition doesn't invalidate previously-written rows. We
 *  still validate strict on inbound proposals via
 *  ClassifierRuleProposalSchema in m2 — only the on-disk read is lenient. */
const LearnedRuleRowSchema = z.object({
  regex: z.string().min(1).max(256),
  class: z.enum(['hard', 'legal', 'open', 'file']),
  maps_to: z.string().min(1).max(200),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  rationale: z.string().max(800).optional(),
  /** Provenance — the proposal id that produced this rule. Required
   *  for REVIEW C2 (adv) idempotent retry dedup. */
  proposal_id: z.string().min(1).max(120).optional(),
  /** ISO timestamp when the rule was approved. */
  approved_at: z.string().datetime({ offset: true }).optional(),
});

const LearnedRulesFileSchema = z.object({
  rules: z.array(LearnedRuleRowSchema),
});

/** Module-level state. Token returned from registerExtraRules so a
 *  subsequent ensureLearnedRulesLoaded re-load can clear the prior
 *  batch atomically. */
let _learnedRulesToken = null;

/**
 * Read learned-classifier-rules.yml from disk and register every row
 * via 06's registerExtraRules seam. Idempotent: if already loaded,
 * clears the prior token first so duplicates don't accumulate.
 *
 * @returns {Promise<{ ruleCount: number }>}
 */
export async function ensureLearnedRulesLoaded() {
  let raw;
  try {
    raw = await fs.readFile(LEARNED_RULES_FILE, 'utf8');
  } catch {
    // File missing → treat as empty. Don't create it eagerly; m3
    // approve path creates it on first append.
    if (_learnedRulesToken) {
      try {
        clearExtraRules(_learnedRulesToken);
      } catch {}
      _learnedRulesToken = null;
    }
    return { ruleCount: 0 };
  }
  let parsed;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    console.warn(`applySuggestion: learned-classifier-rules.yml malformed: ${err.message}`);
    return { ruleCount: 0 };
  }
  const validated = LearnedRulesFileSchema.safeParse(parsed || { rules: [] });
  if (!validated.success) {
    console.warn(
      `applySuggestion: learned-classifier-rules.yml schema invalid: ${validated.error.issues
        .map((i) => i.message)
        .join('; ')}`,
    );
    return { ruleCount: 0 };
  }
  // Clear previous batch (idempotent re-load).
  if (_learnedRulesToken) {
    try {
      clearExtraRules(_learnedRulesToken);
    } catch {}
    _learnedRulesToken = null;
  }
  if (validated.data.rules.length === 0) return { ruleCount: 0 };

  // Compile each rule into the registerExtraRules shape: labelRegex
  // (RegExp /i) + class + lookupKey + subclass + confidenceHint.
  const compiled = [];
  for (const row of validated.data.rules) {
    let rx;
    try {
      rx = new RegExp(row.regex, 'i');
    } catch (err) {
      console.warn(
        `applySuggestion: learned rule for ${row.maps_to} has invalid regex ${JSON.stringify(row.regex)}: ${err.message}`,
      );
      continue;
    }
    compiled.push({
      labelRegex: rx,
      class: row.class,
      lookupKey: row.maps_to,
      subclass: `learned:${row.maps_to}`,
      confidenceHint: row.confidence,
    });
  }
  if (compiled.length === 0) return { ruleCount: 0 };
  _learnedRulesToken = registerExtraRules(compiled);
  return { ruleCount: compiled.length };
}

// ── Approve ───────────────────────────────────────────────────────────

/**
 * Apply an approved proposal: classifier-rule → append to learned-rules
 * YAML + register live; site-adapter → write site-adapter YAML + bust
 * loader cache. Flips the proposal's status to 'approved'.
 *
 * @param {string} id — proposal id
 * @returns {Promise<{ status: 'approved', applied: 'classifier-rule'|'site-adapter', path: string }>}
 * @throws Error with .status property (404 / 409 / 400 / 500) for HTTP routes.
 */
export async function approveSuggestion(id) {
  // REVIEW C1/C3 (both reviewers) CRITICAL: serialize per-id approve/reject
  // operations. Pre-fix two concurrent approves of the same id both passed
  // the status==='pending' check and both applied — duplicating classifier
  // rule rows or racing site-adapter YAML writes. The mutex key is
  // `applySuggestion:${id}` so reject for the same id is also serialized.
  return serializeByKey(`applySuggestion:${id}`, () => _approveInner(id));
}

async function _approveInner(id) {
  const envelope = await readSuggestion(id);
  if (!envelope) {
    const err = new Error(`proposal not found: ${id}`);
    err.status = 404;
    throw err;
  }
  if (envelope.status !== 'pending') {
    const err = new Error(`proposal already ${envelope.status}: ${id}`);
    err.status = 409;
    throw err;
  }

  let applied;
  let outputPath;
  if (envelope.type === 'classifier-rule') {
    outputPath = await _applyClassifierRule(envelope);
    applied = 'classifier-rule';
  } else if (envelope.type === 'site-adapter') {
    outputPath = await _applySiteAdapter(envelope);
    applied = 'site-adapter';
  } else {
    const err = new Error(`unknown proposal type: ${envelope.type}`);
    err.status = 400;
    throw err;
  }

  await _flipStatus(id, envelope, 'approved');
  return { status: 'approved', applied, path: outputPath };
}

async function _applyClassifierRule(envelope) {
  const proposal = envelope.proposal;
  // Read current file. REVIEW C2 (Plan) / M3 (adv): pre-fix a malformed
  // YAML silently reset rules to [], wiping every previously-approved
  // rule. Now we back up the corrupt file and throw so the user notices.
  let current = { rules: [] };
  if (existsSync(LEARNED_RULES_FILE)) {
    let raw;
    try {
      raw = await fs.readFile(LEARNED_RULES_FILE, 'utf8');
    } catch (err) {
      const e = new Error(`learned-classifier-rules.yml read failed: ${err.message}`);
      e.status = 500;
      throw e;
    }
    let parsed;
    try {
      parsed = yaml.load(raw);
    } catch (err) {
      await _backupCorruptFile(LEARNED_RULES_FILE);
      const e = new Error(
        `learned-classifier-rules.yml YAML parse failed (backed up). Original error: ${err.message}`,
      );
      e.status = 500;
      throw e;
    }
    const validated = LearnedRulesFileSchema.safeParse(parsed || { rules: [] });
    if (!validated.success) {
      await _backupCorruptFile(LEARNED_RULES_FILE);
      const e = new Error(
        `learned-classifier-rules.yml schema invalid (backed up). Details: ${validated.error.issues
          .map((i) => i.message)
          .join('; ')}`,
      );
      e.status = 500;
      throw e;
    }
    current = validated.data;
  }
  // REVIEW C2 (adv) fix: dedup by proposal_id so a retry after partial
  // failure (rule written but status-flip threw) doesn't append a
  // duplicate row on the retry.
  const dupIdx = current.rules.findIndex((r) => r.proposal_id === envelope.id);
  const row = LearnedRuleRowSchema.parse({
    regex: proposal.regex,
    class: proposal.class,
    maps_to: proposal.maps_to,
    confidence: proposal.confidence,
    rationale: proposal.rationale,
    proposal_id: envelope.id,
    approved_at: new Date().toISOString(),
  });
  if (dupIdx >= 0) {
    current.rules[dupIdx] = row; // overwrite same-proposal-id row
  } else {
    current.rules.push(row);
  }

  await fs.mkdir(FEEDBACK_DIR, { recursive: true });
  await _atomicWriteYaml(LEARNED_RULES_FILE, current, '# Auto-generated by 02-data-flywheel m3. DO NOT EDIT MANUALLY.\n');

  // Re-load so the new rule is live in-process.
  await ensureLearnedRulesLoaded();
  return LEARNED_RULES_FILE;
}

async function _backupCorruptFile(target) {
  try {
    const ts = new Date().toISOString().replace(/[^0-9TZ]/g, '');
    await fs.copyFile(target, `${target}.corrupt-${ts}`);
  } catch {
    // backup is best-effort
  }
}

async function _atomicWriteYaml(target, data, header) {
  // REVIEW M1 (adv) fix: tmp filename includes randomUUID so concurrent
  // same-process writes don't share a tmp path (which the per-id mutex
  // also prevents, but defense-in-depth).
  const tmp = `${target}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  const dumped = yaml.dump(data, { lineWidth: -1, noRefs: true });
  await fs.writeFile(tmp, (header || '') + dumped, 'utf8');
  await fs.rename(tmp, target);
}

async function _applySiteAdapter(envelope) {
  const proposal = envelope.proposal;
  if (!proposal || typeof proposal.id !== 'string') {
    const err = new Error('site-adapter proposal missing id');
    err.status = 400;
    throw err;
  }
  // Sanity check: id is a safe filename slug.
  if (!/^[a-z0-9_-]+$/.test(proposal.id)) {
    const err = new Error(`site-adapter id must be lowercase slug: ${proposal.id}`);
    err.status = 400;
    throw err;
  }
  // REVIEW C1 (Plan) + L3 (adv): reject reserved bundled-adapter ids.
  // `default` is the catchall fallback; `_common` is the merge-defaults
  // pseudo-adapter. Either would corrupt the loader contract.
  if (RESERVED_ADAPTER_IDS.has(proposal.id)) {
    const err = new Error(`cannot overwrite reserved adapter id: ${proposal.id}`);
    err.status = 409;
    throw err;
  }
  const target = path.join(DEFAULT_ADAPTERS_DIR, `${proposal.id}.yml`);
  // REVIEW C1 (Plan): refuse to overwrite a pre-existing YAML — would
  // silently replace a bundled adapter like workday/greenhouse etc.
  if (existsSync(target)) {
    const err = new Error(
      `site-adapter ${proposal.id}.yml already exists — pick a different id or remove the existing file first`,
    );
    err.status = 409;
    throw err;
  }
  // REVIEW H5 (adv): re-validate against SiteAdapterSchema before write.
  // m2's induceSiteAdapter already validates, but an envelope round-
  // trip through disk could be hand-edited or corrupted; a buggy
  // envelope would otherwise ship malformed YAML that breaks the m1
  // loader at next boot.
  let validated;
  try {
    validated = SiteAdapterSchema.parse(proposal);
  } catch (err) {
    const e = new Error(`site-adapter proposal fails SiteAdapterSchema: ${err.message}`);
    e.status = 400;
    throw e;
  }
  // REVIEW H6 (adv): clamp priority so user-approved adapters can't
  // shadow bundled ones. Bundled multi-step adapters sit at 110; cap
  // approved at 100 so they don't take precedence over hand-curated
  // bundled YAMLs.
  if (validated.priority > MAX_USER_ADAPTER_PRIORITY) {
    validated = { ...validated, priority: MAX_USER_ADAPTER_PRIORITY };
  }

  await fs.mkdir(DEFAULT_ADAPTERS_DIR, { recursive: true });
  await _atomicWriteYaml(
    target,
    validated,
    `# Auto-generated by 02-data-flywheel m3 from proposal ${envelope.id}.\n# DO NOT EDIT MANUALLY (or rename the file — id must match filename).\n`,
  );

  // Bust the m1 loader's mtime cache so the next loadAdapters call
  // picks up this new adapter.
  _clearAdaptersCache();
  return target;
}

// ── Reject ────────────────────────────────────────────────────────────

/**
 * Mark a proposal as rejected: append its id to rejected-ids.json
 * (m2 reads this to skip re-proposing for the same group) and flip
 * status to 'rejected'. The proposal file is NOT deleted — m3 UI lists
 * it for audit, m2's maybeInduce checks markers + rejected-ids before
 * re-inducing.
 *
 * @param {string} id
 * @returns {Promise<{ status: 'rejected' }>}
 */
export async function rejectSuggestion(id) {
  // REVIEW C1/C3 fix: same per-id mutex as approve so an approve+reject
  // race for the same id can't both succeed.
  return serializeByKey(`applySuggestion:${id}`, () => _rejectInner(id));
}

async function _rejectInner(id) {
  const envelope = await readSuggestion(id);
  if (!envelope) {
    const err = new Error(`proposal not found: ${id}`);
    err.status = 404;
    throw err;
  }
  if (envelope.status !== 'pending') {
    const err = new Error(`proposal already ${envelope.status}: ${id}`);
    err.status = 409;
    throw err;
  }
  // Append id to rejected-ids.json (read-modify-write). REVIEW H1 (Plan):
  // serializeByKey(REJECTED_IDS_FILE) ensures concurrent rejects don't
  // overwrite each other. The outer per-id mutex already prevents same-id
  // races; this guards different ids racing on the shared file.
  await serializeByKey(REJECTED_IDS_FILE, async () => {
    let current = [];
    if (existsSync(REJECTED_IDS_FILE)) {
      try {
        const raw = await fs.readFile(REJECTED_IDS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) current = parsed;
      } catch {
        current = [];
      }
    }
    if (!current.includes(id)) current.push(id);
    await fs.mkdir(FEEDBACK_DIR, { recursive: true });
    const tmp = `${REJECTED_IDS_FILE}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
    await fs.writeFile(tmp, JSON.stringify(current, null, 2), 'utf8');
    await fs.rename(tmp, REJECTED_IDS_FILE);
  });

  await _flipStatus(id, envelope, 'rejected');
  return { status: 'rejected' };
}

// ── Internals ─────────────────────────────────────────────────────────

async function _flipStatus(id, envelope, newStatus) {
  // REVIEW H4 (Plan): explicit enum guard so a future caller bug can't
  // route an undefined through ProposalEnvelopeSchema's status default.
  if (!['pending', 'approved', 'rejected'].includes(newStatus)) {
    throw new TypeError(`_flipStatus: invalid newStatus ${JSON.stringify(newStatus)}`);
  }
  const updated = ProposalEnvelopeSchema.parse({ ...envelope, status: newStatus });
  const target = path.join(SUGGESTED_DIR, `${id}.json`);
  // REVIEW M1 (adv): UUID-suffixed tmp filename.
  const tmp = `${target}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  await fs.writeFile(tmp, JSON.stringify(updated, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

// ── Boot: load learned rules into the live classifier ─────────────────
//
// Top-level await mirrors multistep/siteAdapter.mjs pattern. Importing
// this module (e.g. from server.mjs) at boot is enough to wire learned
// rules into every classifyField sweep. Failure to load is logged but
// non-fatal (apply-flow still works on baseline rules).
try {
  await ensureLearnedRulesLoaded();
} catch (err) {
  console.warn(`applySuggestion: ensureLearnedRulesLoaded failed at boot: ${err.message}`);
}
