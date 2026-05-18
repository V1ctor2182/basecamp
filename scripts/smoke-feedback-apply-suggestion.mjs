#!/usr/bin/env node
// Smoke for 07-applier/self-iteration/02-data-flywheel m3:
// applySuggestion.mjs (approve / reject / ensureLearnedRulesLoaded) +
// boot-time wire-up of learned classifier rules.
//
// Pure-Node — no HTTP server (server.mjs routes are tested by direct
// call to the underlying functions; the route handlers are thin
// translation layers verified via shape inspection).

import assert from 'node:assert/strict';
import { promises as fs, existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

import { FEEDBACK_DIR, recordFieldMisclassified, recordSiteFailure } from '../src/career/feedback/stores.mjs';
import {
  SUGGESTED_DIR,
  savePending,
  listSuggestions,
  readSuggestion,
  readMarkers,
  readRejectedIds,
  REJECTED_IDS_FILE,
} from '../src/career/feedback/suggestionStore.mjs';
import {
  approveSuggestion,
  rejectSuggestion,
  ensureLearnedRulesLoaded,
  LEARNED_RULES_FILE,
} from '../src/career/feedback/applySuggestion.mjs';
import { maybeInduce } from '../src/career/feedback/induce.mjs';
import { classifyField, _clearAllExtraRules } from '../src/career/applier/classifier/regexRules.mjs';
import {
  loadAdapters,
  _clearCache as _clearAdaptersCache,
  DEFAULT_ADAPTERS_DIR,
} from '../src/career/applier/siteAdapters/loader.mjs';
import { detectSiteAdapter } from '../src/career/applier/siteAdapters/detector.mjs';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    failed++;
  }
}

// ── Fixture isolation ─────────────────────────────────────────────────
//
// We swap aside ALL state that approveSuggestion can touch:
//   - data/career/feedback/      (suggested/, markers, rejected-ids, learned-rules)
//   - data/career/site-adapters/ (approve site-adapter writes here)
// Restore on exit.

const FEEDBACK_BACKUP = FEEDBACK_DIR + `.smoke-m3-backup.${process.pid}`;
const ADAPTERS_BACKUP = DEFAULT_ADAPTERS_DIR + `.smoke-m3-backup.${process.pid}`;

function setupFixtures() {
  if (existsSync(FEEDBACK_DIR)) renameSync(FEEDBACK_DIR, FEEDBACK_BACKUP);
  if (existsSync(DEFAULT_ADAPTERS_DIR)) renameSync(DEFAULT_ADAPTERS_DIR, ADAPTERS_BACKUP);
}
function restoreFixtures() {
  if (existsSync(FEEDBACK_DIR)) rmSync(FEEDBACK_DIR, { recursive: true, force: true });
  if (existsSync(FEEDBACK_BACKUP)) renameSync(FEEDBACK_BACKUP, FEEDBACK_DIR);
  if (existsSync(DEFAULT_ADAPTERS_DIR)) rmSync(DEFAULT_ADAPTERS_DIR, { recursive: true, force: true });
  if (existsSync(ADAPTERS_BACKUP)) renameSync(ADAPTERS_BACKUP, DEFAULT_ADAPTERS_DIR);
}
setupFixtures();
process.on('exit', restoreFixtures);
process.on('uncaughtException', (e) => {
  restoreFixtures();
  console.error('uncaught:', e);
  process.exit(2);
});

async function clearAllState() {
  if (existsSync(FEEDBACK_DIR)) rmSync(FEEDBACK_DIR, { recursive: true, force: true });
  if (existsSync(DEFAULT_ADAPTERS_DIR)) rmSync(DEFAULT_ADAPTERS_DIR, { recursive: true, force: true });
  _clearAllExtraRules();
  _clearAdaptersCache();
}

async function seedDefaultAdapter() {
  // The m1 loader requires a default.yml. Restore a minimal one for tests
  // that exercise approve(site-adapter).
  await fs.mkdir(DEFAULT_ADAPTERS_DIR, { recursive: true });
  await fs.writeFile(
    path.join(DEFAULT_ADAPTERS_DIR, 'default.yml'),
    yaml.dump({
      name: 'Default',
      id: 'default',
      priority: 0,
      detection: { url_patterns: ['.*'] },
      flow: { type: 'single-step' },
    }),
    'utf8',
  );
}

async function saveTestProposal(overrides = {}) {
  return savePending({
    type: 'classifier-rule',
    group_key: 'workday',
    feedback_type: 'field-misclassified',
    source_records: [{ ts: new Date().toISOString(), field_label: 'Preferred Pronouns' }],
    proposal: {
      regex: '\\b(preferred )?pronouns?\\b',
      class: 'legal',
      maps_to: 'eeo.pronouns',
      confidence: 'high',
      rationale: 'pronoun fields are EEO legal class',
    },
    ...overrides,
  });
}

async function saveSiteAdapterProposal(overrides = {}) {
  return savePending({
    type: 'site-adapter',
    group_key: 'jobs.acme.com',
    feedback_type: 'site-failures',
    source_records: [{ ts: new Date().toISOString(), step_idx: 0 }],
    proposal: {
      name: 'Acme',
      id: 'acme',
      priority: 100,
      detection: { url_patterns: ['jobs\\.acme\\.com'], dom_signatures: [] },
      flow: {
        type: 'multi-step',
        next_button: { selectors: [], name_hints: ['Next'] },
        submit_button: { selectors: [], name_hints: ['Submit'] },
        progress_bar: { selectors: [], name_hints: [] },
        step_list: { selectors: [], name_hints: [] },
      },
      controls: {},
      known_fields: [],
      quirks: [],
    },
    ...overrides,
  });
}

// ── 1. Approve classifier-rule → live effect ──────────────────────────

await test('approveSuggestion(classifier-rule): YAML appended + classifyField sees new label live', async () => {
  await clearAllState();
  const id = await saveTestProposal();

  // Baseline: classifyField on "Preferred Pronouns" goes via standard
  // LEGAL pattern (matches /pronouns?/ → eeo.pronouns).
  // To prove the LEARNED rule is in effect, we use a label that
  // standard patterns do NOT match.
  // First seed a custom-label proposal.
  await clearAllState();
  const customId = await saveTestProposal({
    proposal: {
      regex: '^company quirk question$',
      class: 'open',
      maps_to: 'qa-bank.csq',
      confidence: 'medium',
      rationale: 'this label only exists for our test',
    },
  });
  // Before approve: classifyField on the label returns 'unknown-open'
  // (textbox fall-through) or 'unknown'.
  const before = classifyField({ role: 'textbox', name: 'Company Quirk Question' });
  assert.notEqual(before.lookupKey, 'qa-bank.csq', 'pre-approve: no learned rule');

  const result = await approveSuggestion(customId);
  assert.equal(result.status, 'approved');
  assert.equal(result.applied, 'classifier-rule');
  assert.equal(result.path, LEARNED_RULES_FILE);

  // Post-approve: same label now routes via the learned rule.
  const after = classifyField({ role: 'textbox', name: 'Company Quirk Question' });
  assert.equal(after.class, 'open');
  assert.equal(after.lookupKey, 'qa-bank.csq');
  assert.equal(after.source, 'adapter-known-field');
});

await test('approveSuggestion(classifier-rule): YAML on disk contains the rule', async () => {
  await clearAllState();
  const id = await saveTestProposal();
  await approveSuggestion(id);
  const raw = await fs.readFile(LEARNED_RULES_FILE, 'utf8');
  const parsed = yaml.load(raw);
  assert.equal(parsed.rules.length, 1);
  assert.equal(parsed.rules[0].maps_to, 'eeo.pronouns');
  assert.equal(parsed.rules[0].proposal_id, id);
  assert.ok(parsed.rules[0].approved_at);
});

await test('approveSuggestion(classifier-rule): proposal status flipped to approved', async () => {
  await clearAllState();
  const id = await saveTestProposal();
  await approveSuggestion(id);
  const envelope = await readSuggestion(id);
  assert.equal(envelope.status, 'approved');
});

await test('approveSuggestion: already-approved → 409', async () => {
  await clearAllState();
  const id = await saveTestProposal();
  await approveSuggestion(id);
  try {
    await approveSuggestion(id);
    assert.fail('expected 409');
  } catch (err) {
    assert.equal(err.status, 409);
    assert.match(err.message, /already approved/);
  }
});

await test('approveSuggestion: non-existent id → 404', async () => {
  await clearAllState();
  try {
    await approveSuggestion('nonexistent-12345');
    assert.fail('expected 404');
  } catch (err) {
    assert.equal(err.status, 404);
  }
});

// ── 2. Approve site-adapter → YAML written + loader picks up ──────────

await test('approveSuggestion(site-adapter): YAML at site-adapters/ + loader detects', async () => {
  await clearAllState();
  await seedDefaultAdapter();
  const id = await saveSiteAdapterProposal();
  const result = await approveSuggestion(id);
  assert.equal(result.applied, 'site-adapter');
  assert.equal(result.path, path.join(DEFAULT_ADAPTERS_DIR, 'acme.yml'));
  // File exists + parses
  const raw = await fs.readFile(result.path, 'utf8');
  const parsed = yaml.load(raw);
  assert.equal(parsed.id, 'acme');
  assert.equal(parsed.flow.type, 'multi-step');
  // Loader detects the new adapter (cache busted by approve)
  const reg = await loadAdapters();
  const acme = reg.adapters.find((a) => a.id === 'acme');
  assert.ok(acme, 'new adapter loaded');
  // Detector routes the matching URL
  const detected = detectSiteAdapter('https://jobs.acme.com/jobs/123', reg);
  assert.equal(detected.id, 'acme');
});

await test('approveSuggestion(site-adapter): id with bad chars → 400', async () => {
  await clearAllState();
  await seedDefaultAdapter();
  const id = await saveSiteAdapterProposal({
    proposal: {
      name: 'Bad',
      id: 'Bad Company!', // invalid slug
      priority: 100,
      detection: { url_patterns: ['x'], dom_signatures: [] },
      flow: {
        type: 'multi-step',
        next_button: { selectors: [], name_hints: ['Next'] },
        submit_button: { selectors: [], name_hints: ['Submit'] },
        progress_bar: { selectors: [], name_hints: [] },
        step_list: { selectors: [], name_hints: [] },
      },
      controls: {},
      known_fields: [],
      quirks: [],
    },
  });
  try {
    await approveSuggestion(id);
    assert.fail('expected 400');
  } catch (err) {
    assert.equal(err.status, 400);
    assert.match(err.message, /lowercase slug/);
  }
});

await test('approveSuggestion(site-adapter): id="default" → 409 (reserved)', async () => {
  await clearAllState();
  await seedDefaultAdapter();
  const id = await saveSiteAdapterProposal({
    proposal: {
      name: 'Default',
      id: 'default',
      priority: 0,
      detection: { url_patterns: ['.*'], dom_signatures: [] },
      flow: {
        type: 'single-step',
        next_button: { selectors: [], name_hints: [] },
        submit_button: { selectors: [], name_hints: [] },
        progress_bar: { selectors: [], name_hints: [] },
        step_list: { selectors: [], name_hints: [] },
      },
      controls: {},
      known_fields: [],
      quirks: [],
    },
  });
  try {
    await approveSuggestion(id);
    assert.fail('expected 409');
  } catch (err) {
    assert.equal(err.status, 409);
    assert.match(err.message, /reserved/);
  }
});

// ── 3. Reject path ────────────────────────────────────────────────────

await test('rejectSuggestion: id appended to rejected-ids.json + status=rejected', async () => {
  await clearAllState();
  const id = await saveTestProposal();
  const result = await rejectSuggestion(id);
  assert.equal(result.status, 'rejected');
  const envelope = await readSuggestion(id);
  assert.equal(envelope.status, 'rejected');
  const rejected = await readRejectedIds();
  assert.ok(rejected.has(id));
});

await test('rejectSuggestion: already-rejected → 409', async () => {
  await clearAllState();
  const id = await saveTestProposal();
  await rejectSuggestion(id);
  try {
    await rejectSuggestion(id);
    assert.fail('expected 409');
  } catch (err) {
    assert.equal(err.status, 409);
  }
});

// ── 4. ensureLearnedRulesLoaded — idempotent, malformed → graceful ────

await test('ensureLearnedRulesLoaded: missing file → ruleCount=0, no throw', async () => {
  await clearAllState();
  const { ruleCount } = await ensureLearnedRulesLoaded();
  assert.equal(ruleCount, 0);
});

await test('ensureLearnedRulesLoaded: idempotent (clears prior token on re-load)', async () => {
  await clearAllState();
  const id = await saveTestProposal();
  await approveSuggestion(id); // writes YAML + registers extras
  // Re-load — should NOT double-register.
  const first = await ensureLearnedRulesLoaded();
  const second = await ensureLearnedRulesLoaded();
  assert.equal(first.ruleCount, 1);
  assert.equal(second.ruleCount, 1);
  // Verify classifier still routes correctly (not double-registered).
  const result = classifyField({ role: 'textbox', name: 'Preferred Pronouns' });
  assert.equal(result.lookupKey, 'eeo.pronouns');
});

await test('ensureLearnedRulesLoaded: malformed YAML → warn + ruleCount=0 (no throw)', async () => {
  await clearAllState();
  await fs.mkdir(FEEDBACK_DIR, { recursive: true });
  await fs.writeFile(LEARNED_RULES_FILE, ':: not valid yaml :: ::', 'utf8');
  const { ruleCount } = await ensureLearnedRulesLoaded();
  assert.equal(ruleCount, 0);
});

await test('ensureLearnedRulesLoaded: schema-invalid row → skipped silently', async () => {
  await clearAllState();
  await fs.mkdir(FEEDBACK_DIR, { recursive: true });
  await fs.writeFile(
    LEARNED_RULES_FILE,
    yaml.dump({
      rules: [{ regex: '\\bgood\\b', class: 'bogus-class', maps_to: 'x', confidence: 'high' }],
    }),
    'utf8',
  );
  const { ruleCount } = await ensureLearnedRulesLoaded();
  assert.equal(ruleCount, 0, 'invalid row → entire file rejected');
});

await test('ensureLearnedRulesLoaded: regex-invalid row dropped, rest registered', async () => {
  await clearAllState();
  await fs.mkdir(FEEDBACK_DIR, { recursive: true });
  await fs.writeFile(
    LEARNED_RULES_FILE,
    yaml.dump({
      rules: [
        { regex: '[unclosed', class: 'hard', maps_to: 'identity.x', confidence: 'high' },
        { regex: '\\bgood\\b', class: 'hard', maps_to: 'identity.y', confidence: 'high' },
      ],
    }),
    'utf8',
  );
  const { ruleCount } = await ensureLearnedRulesLoaded();
  assert.equal(ruleCount, 1);
  const result = classifyField({ role: 'textbox', name: 'good' });
  assert.equal(result.lookupKey, 'identity.y');
});

// ── 5. End-to-end loop closure — m2 ↔ m3 ──────────────────────────────

await test('Loop closure: m2 induce → m3 reject → m2 skips re-induction', async () => {
  await clearAllState();
  // Seed enough records to trip threshold.
  for (let i = 0; i < 5; i++) {
    await recordFieldMisclassified({
      ts: new Date().toISOString(),
      jobId: '0123456789ab',
      field_label: `Pronouns ${i}`,
      refId: `e${i}`,
      predicted_class: 'open',
      actual_class: 'legal',
      actual_mapping: 'eeo.pronouns',
      site: 'workday',
    });
  }
  // Mock Haiku client (single canned response — same pattern as smoke-feedback-induce).
  const goodProposal = JSON.stringify({
    regex: '\\bpronouns?\\b',
    class: 'legal',
    maps_to: 'eeo.pronouns',
    confidence: 'high',
    rationale: 'pronoun fields are EEO legal class',
  });
  const mockClient = {
    messages: {
      async create() {
        return {
          model: 'claude-haiku-4-5-20251001',
          content: [{ type: 'text', text: goodProposal }],
          usage: { input_tokens: 800, output_tokens: 50, cache_creation_input_tokens: null, cache_read_input_tokens: null },
        };
      },
    },
  };
  const first = await maybeInduce('field-misclassified', { client: mockClient });
  assert.equal(first.length, 1);

  // User rejects via m3.
  await rejectSuggestion(first[0].id);

  // Seed 5 MORE records (would normally re-induce via delta gate).
  for (let i = 5; i < 10; i++) {
    await recordFieldMisclassified({
      ts: new Date().toISOString(),
      jobId: '0123456789ab',
      field_label: `Pronouns ${i}`,
      refId: `e${i}`,
      predicted_class: 'open',
      actual_class: 'legal',
      actual_mapping: 'eeo.pronouns',
      site: 'workday',
    });
  }
  // m2 maybeInduce now reads rejected-ids.json and skips this group.
  const second = await maybeInduce('field-misclassified', { client: mockClient });
  assert.equal(second.length, 0, 'rejected proposal id skips future induction');
});

await test('Loop closure: m2 induce → m3 approve → classifier sees live rule', async () => {
  await clearAllState();
  for (let i = 0; i < 5; i++) {
    await recordFieldMisclassified({
      ts: new Date().toISOString(),
      jobId: '0123456789ab',
      field_label: `Custom Field ${i}`,
      refId: `e${i}`,
      predicted_class: 'open',
      actual_class: 'hard',
      actual_mapping: 'identity.custom',
      site: 'workday',
    });
  }
  const good = JSON.stringify({
    regex: '^custom field \\d+$',
    class: 'hard',
    maps_to: 'identity.custom',
    confidence: 'high',
    rationale: 'r',
  });
  const mockClient = {
    messages: {
      async create() {
        return {
          model: 'claude-haiku-4-5-20251001',
          content: [{ type: 'text', text: good }],
          usage: { input_tokens: 800, output_tokens: 50, cache_creation_input_tokens: null, cache_read_input_tokens: null },
        };
      },
    },
  };
  const proposals = await maybeInduce('field-misclassified', { client: mockClient });
  assert.equal(proposals.length, 1);

  // Pre-approve: label doesn't match identity.custom.
  const before = classifyField({ role: 'textbox', name: 'Custom Field 7' });
  assert.notEqual(before.lookupKey, 'identity.custom');

  // Approve.
  await approveSuggestion(proposals[0].id);

  // Post-approve: classifier knows this label now.
  const after = classifyField({ role: 'textbox', name: 'Custom Field 7' });
  assert.equal(after.class, 'hard');
  assert.equal(after.lookupKey, 'identity.custom');
});

// ── 6. Review-driven regression tests ─────────────────────────────────

await test('REVIEW C1/C3: concurrent approve + reject for same id serialized (only one wins)', async () => {
  await clearAllState();
  const id = await saveTestProposal();
  // Fire approve and reject in parallel
  const [approveRes, rejectRes] = await Promise.all([
    approveSuggestion(id).catch((e) => ({ error: e.message, status: e.status })),
    rejectSuggestion(id).catch((e) => ({ error: e.message, status: e.status })),
  ]);
  // Exactly one should succeed and the other should 409
  const successes = [approveRes, rejectRes].filter((r) => !r.error);
  const failures = [approveRes, rejectRes].filter((r) => r.error);
  assert.equal(successes.length, 1, 'exactly one of approve/reject wins');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].status, 409);
});

await test('REVIEW C1 (Plan): approve site-adapter REFUSES to overwrite a pre-existing bundled adapter', async () => {
  await clearAllState();
  await seedDefaultAdapter();
  // Seed a bundled `workday.yml` to simulate the real shipped state.
  await fs.writeFile(
    path.join(DEFAULT_ADAPTERS_DIR, 'workday.yml'),
    yaml.dump({
      name: 'Workday',
      id: 'workday',
      priority: 110,
      detection: { url_patterns: ['myworkdayjobs\\.com'] },
      flow: { type: 'multi-step' },
    }),
    'utf8',
  );
  const id = await saveSiteAdapterProposal({
    proposal: {
      name: 'Workday (rogue)',
      id: 'workday', // same id as the bundled file
      priority: 100,
      detection: { url_patterns: ['evil\\.com'], dom_signatures: [] },
      flow: {
        type: 'multi-step',
        next_button: { selectors: [], name_hints: ['Next'] },
        submit_button: { selectors: [], name_hints: ['Submit'] },
        progress_bar: { selectors: [], name_hints: [] },
        step_list: { selectors: [], name_hints: [] },
      },
      controls: {},
      known_fields: [],
      quirks: [],
    },
  });
  try {
    await approveSuggestion(id);
    assert.fail('expected 409 — pre-existing file');
  } catch (err) {
    assert.equal(err.status, 409);
    assert.match(err.message, /already exists/);
  }
});

await test('REVIEW C1 (Plan) + L3 (adv): approve site-adapter REFUSES reserved id `_common`', async () => {
  await clearAllState();
  await seedDefaultAdapter();
  const id = await saveSiteAdapterProposal({
    proposal: {
      name: 'Common',
      id: '_common',
      priority: 100,
      detection: { url_patterns: ['.*'], dom_signatures: [] },
      flow: {
        type: 'multi-step',
        next_button: { selectors: [], name_hints: ['Next'] },
        submit_button: { selectors: [], name_hints: ['Submit'] },
        progress_bar: { selectors: [], name_hints: [] },
        step_list: { selectors: [], name_hints: [] },
      },
      controls: {},
      known_fields: [],
      quirks: [],
    },
  });
  try {
    await approveSuggestion(id);
    assert.fail('expected 409');
  } catch (err) {
    assert.equal(err.status, 409);
    assert.match(err.message, /reserved/);
  }
});

await test('REVIEW C2 (Plan) + M3 (adv): malformed learned-rules.yml on approve → backup + throw, prior rules NOT silently wiped', async () => {
  await clearAllState();
  // Approve one rule cleanly first.
  const firstId = await saveTestProposal();
  await approveSuggestion(firstId);
  const firstYaml = await fs.readFile(LEARNED_RULES_FILE, 'utf8');
  const firstParsed = yaml.load(firstYaml);
  assert.equal(firstParsed.rules.length, 1);

  // Corrupt the file.
  await fs.writeFile(LEARNED_RULES_FILE, ':: tortured ascii :: ::', 'utf8');

  // Approve a SECOND proposal — pre-fix this silently wiped the first
  // rule by resetting `current = { rules: [] }`. Post-fix: throws +
  // backs up the corrupt file.
  const secondId = await saveTestProposal({
    proposal: {
      regex: '^second$',
      class: 'open',
      maps_to: 'qa-bank.s',
      confidence: 'medium',
      rationale: 'r',
    },
  });
  try {
    await approveSuggestion(secondId);
    assert.fail('expected 500 on corrupt file');
  } catch (err) {
    assert.equal(err.status, 500);
    assert.match(err.message, /backed up/);
  }
  // Verify backup exists
  const dirEntries = await fs.readdir(FEEDBACK_DIR);
  const backups = dirEntries.filter((n) => n.startsWith('learned-classifier-rules.yml.corrupt-'));
  assert.equal(backups.length, 1, 'corrupt file backed up');
});

await test('REVIEW C2 (adv): re-approve same envelope idempotent — dedup by proposal_id (no duplicate rows)', async () => {
  await clearAllState();
  const id = await saveTestProposal();
  await approveSuggestion(id);
  // Force re-approve by directly clearing status (simulating partial-fail retry).
  const envelope = await readSuggestion(id);
  envelope.status = 'pending';
  await fs.writeFile(
    path.join(SUGGESTED_DIR, `${id}.json`),
    JSON.stringify(envelope, null, 2),
    'utf8',
  );
  // Re-approve — should NOT duplicate the rule.
  await approveSuggestion(id);
  const raw = await fs.readFile(LEARNED_RULES_FILE, 'utf8');
  const parsed = yaml.load(raw);
  assert.equal(parsed.rules.length, 1, 'dedup by proposal_id prevents duplicate row');
});

await test('REVIEW H5 (adv): approveSuggestion re-validates site-adapter proposal against SiteAdapterSchema', async () => {
  await clearAllState();
  await seedDefaultAdapter();
  const id = await saveSiteAdapterProposal({
    proposal: {
      // Missing required `name` field after hand-edit / corruption
      id: 'bad',
      priority: 100,
      detection: { url_patterns: ['x'], dom_signatures: [] },
      flow: { type: 'multi-step' },
      // truncated — strict schema rejects missing fields too
    },
  });
  try {
    await approveSuggestion(id);
    assert.fail('expected 400 — schema validation fails');
  } catch (err) {
    assert.equal(err.status, 400);
    assert.match(err.message, /SiteAdapterSchema/);
  }
});

await test('REVIEW H6 (adv): approveSuggestion clamps priority to ≤100 (so approved cannot shadow bundled)', async () => {
  await clearAllState();
  await seedDefaultAdapter();
  const id = await saveSiteAdapterProposal({
    proposal: {
      name: 'Hostile',
      id: 'hostile-priority',
      priority: 9999, // attempt to shadow bundled adapters
      detection: { url_patterns: ['hostile\\.example'], dom_signatures: [] },
      flow: {
        type: 'multi-step',
        next_button: { selectors: [], name_hints: ['Next'] },
        submit_button: { selectors: [], name_hints: ['Submit'] },
        progress_bar: { selectors: [], name_hints: [] },
        step_list: { selectors: [], name_hints: [] },
      },
      controls: {},
      known_fields: [],
      quirks: [],
    },
  });
  const result = await approveSuggestion(id);
  const raw = await fs.readFile(result.path, 'utf8');
  const parsed = yaml.load(raw);
  assert.equal(parsed.priority, 100, 'priority clamped to ceiling');
});

await test('REVIEW H4 (adv): ensureLearnedRulesLoaded tolerates unknown column in on-disk row (future schema)', async () => {
  await clearAllState();
  await fs.mkdir(FEEDBACK_DIR, { recursive: true });
  // Simulate a future m4 column added to the YAML.
  await fs.writeFile(
    LEARNED_RULES_FILE,
    yaml.dump({
      rules: [
        {
          regex: '\\bfutureguard\\b',
          class: 'hard',
          maps_to: 'identity.fg',
          confidence: 'high',
          last_hit_at: '2026-05-18T00:00:00Z', // future column
        },
      ],
    }),
    'utf8',
  );
  const { ruleCount } = await ensureLearnedRulesLoaded();
  assert.equal(ruleCount, 1, 'unknown columns tolerated (passthrough)');
  const result = classifyField({ role: 'textbox', name: 'futureguard' });
  assert.equal(result.lookupKey, 'identity.fg');
});

// ── Summary ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
