// State machine for Mode 2 multi-step ATS application flow.
//
// 07-applier/04-multi-step-state-machine m3.
//
// Drives the per-step loop: SCAN_FIELDS → CLASSIFY_DRAFT → USER_APPROVE →
// FILL → DEPENDENT_FIELD_CHECK → NEXT_BUTTON_CLICK → WAIT_DOM_READY,
// then advances current_step until COMPLETE / paused / error.
//
// Locked design (planning OQs):
//   - Dependent fields detected via post-FILL re-snapshot DIFF (compare
//     (role, name, occurrenceIndex) tuples; refIds are minted per
//     snapshot so can't be compared by string)
//   - User approval = injected callback returning Promise<{approved, edits?}>
//   - field_memory hit short-circuits LLM AND approval — silent reuse
//     (per constraint #5 the SECOND approve fires only for genuinely
//     new dependent fields, not for memory-confirmed re-fills)
//   - Max iteration cap (default 20 steps) to prevent runaway
//   - All Page interactions are dependency-injected so the smoke runs
//     pure-Node (snapshot/classify/fill/click/wait/probe are all opts)
//   - writeSession lands behind withSessionLock from m1 — concurrent
//     m4 pause endpoint can't race the step transition

import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  buildInitialSession,
  readSession,
  writeSession,
  withSessionLock,
} from './applySessionsStore.mjs';
import { snapshot as realSnapshot } from '../runtime/snapshot.mjs';
import { classifyAndFill, toSourceRefString } from '../classifier/index.mjs';
// Canonical-value → form-option matcher. Used to remap a classifier's
// canonical value ("Decline to answer") onto a dropdown's real option
// text once the options have been captured.
import { bestOption } from '../nonstandard/strategies/selectionControls.mjs';
import {
  probeTotalSteps as realProbeTotalSteps,
  findNextButton as realFindNextButton,
  isOnSubmitStep as realIsOnSubmitStep,
} from './stepProbe.mjs';
import { applyMemoryHit, recordToMemory, normalizeLabel } from './fieldMemory.mjs';
// m6: submit-first error loop. runSubmitLoop is the helper invoked when
// the form is filled + final step approved; it owns submit → parse →
// fix → retry / escalate.
import { runSubmitLoop as runSubmitLoopHelper } from './submitLoop.mjs';

/** State machine node ids — for telemetry and error diagnostics. */
export const STATE = Object.freeze({
  INIT: 'INIT',
  DETECT_FLOW: 'DETECT_FLOW',
  SCAN_FIELDS: 'SCAN_FIELDS',
  CLASSIFY_DRAFT: 'CLASSIFY_DRAFT',
  USER_APPROVE: 'USER_APPROVE',
  FILL: 'FILL',
  DEPENDENT_FIELD_CHECK: 'DEPENDENT_FIELD_CHECK',
  NEXT_BUTTON_CLICK: 'NEXT_BUTTON_CLICK',
  WAIT_DOM_READY: 'WAIT_DOM_READY',
  COMPLETE: 'COMPLETE',
  PAUSED: 'PAUSED',
  ERROR: 'ERROR',
  // m6: submit-first error loop states (entered when isSubmit detected
  // AND prior steps have been filled+approved). These are internal to
  // runSubmitLoop in submitLoop.mjs — runMachine only sees the result
  // (an outcome enum) and doesn't track per-state transitions here.
  // Kept on STATE for documentation + future telemetry.
  SUBMITTING: 'SUBMITTING',
  PARSING_ERRORS: 'PARSING_ERRORS',
  RETRYING_FIX: 'RETRYING_FIX',
  SUBMITTED_SUCCESS: 'SUBMITTED_SUCCESS',
  ESCALATING_TO_USER: 'ESCALATING_TO_USER',
});

/** Terminal outcomes of runMachine. */
export const OUTCOME = Object.freeze({
  COMPLETED: 'completed',
  PAUSED: 'paused',
  ERROR: 'error',
  // m6: submit-first error loop exhausted retries / hit a fatal guard.
  // The machine successfully filled the form and clicked submit ≥ 1
  // time, but never reached a thank-you page. UI shows the post-fill
  // fallback (Phase 3 Apply.tsx cards) so the operator can finish in
  // the browser. Endpoint.mjs (Phase 1/m7) surfaces escalation_reason
  // alongside this outcome.
  ESCALATED: 'escalated',
});

export const DEFAULT_MAX_STEPS = 20;
export const DEFAULT_WAIT_DOM_MS = 5000;

/**
 * Build a Set of (role, name, occurrenceIndex, frameIdx) tuples for the
 * entries in a RefTable. Used for dependent-field diff — refIds are
 * minted per snapshot so we compare by the underlying a11y tuple.
 *
 * @param {object} table — RefTable-shaped object with refIds() + publicEntry()
 * @returns {Set<string>}
 */
function tupleSetFromTable(table) {
  const out = new Set();
  for (const refId of table.refIds()) {
    const e = table.publicEntry(refId);
    if (!e) continue;
    out.add(`${e.role}\u0000${e.name}\u0000${e.occurrenceIndex || 0}\u0000${e.frameIdx || 0}`);
  }
  return out;
}

function entryTuple(e) {
  return `${e.role}\u0000${e.name}\u0000${e.occurrenceIndex || 0}\u0000${e.frameIdx || 0}`;
}

// Real form-input roles. A field survives the chrome filter iff its
// a11y role is one of these (or it is a classified file-upload button).
// Filtering on role — not class — is correct because the snapshot's
// role allowlist also captures page chrome (nav links, section
// headings, logos), and that chrome can still match a HARD/LEGAL regex
// on its text ("Race & Ethnicity Definitions" link → legal). It also
// KEEPS real controls the classifier couldn't match — an unmatched
// dropdown is still a field the operator must handle.
const FORM_INPUT_ROLES = new Set(['textbox', 'checkbox', 'radio', 'combobox']);

// a11y roles that present a fixed option list. For these the machine
// opens the control during runStep and captures the real option texts,
// so the approval UI shows them and the operator picks an exact option
// — turning the fill into a deterministic match, not a fuzzy guess.
const DROPDOWN_ROLES = new Set(['combobox', 'listbox', 'menu']);

/**
 * For every dropdown-role field, open the control, read its real option
 * texts, close it, and stash them on `field.options`. Also remaps the
 * classifier's canonical suggested_value onto the closest real option
 * so the fill phase exact-matches instead of fuzzy-guessing.
 *
 * Fully defensive — never throws. Mock pages (smoke) lack getByRole and
 * are skipped wholesale, so the machine smoke is unaffected.
 */
async function captureDropdownOptions(page, table, classified) {
  if (!page || typeof page.getByRole !== 'function') return;
  if (!table || typeof table.resolve !== 'function') return;
  for (const f of classified) {
    if (!f || !DROPDOWN_ROLES.has(f.role)) continue;
    let loc;
    try {
      loc = table.resolve(f.refId, page);
    } catch {
      continue;
    }
    try {
      await loc.click({ timeout: 3000 });
      const optEls = page.getByRole('option');
      const n = await optEls.count();
      const opts = [];
      for (let i = 0; i < Math.min(n, 60); i++) {
        try {
          const t = (await optEls.nth(i).textContent()) || '';
          const trimmed = t.replace(/\s+/g, ' ').trim();
          if (trimmed) opts.push(trimmed);
        } catch {
          /* skip a bad option node */
        }
      }
      if (opts.length) {
        f.options = opts;
        // Remap the canonical value onto a real option — the approval
        // UI then pre-selects it and the fill is an exact match.
        if (f.suggested_value != null && f.suggested_value !== '') {
          const match = bestOption(f.suggested_value, opts);
          if (match) f.suggested_value = match;
        }
      }
      // Close the listbox so the next control opens cleanly.
      try {
        await page.keyboard.press('Escape');
      } catch {
        /* best-effort */
      }
    } catch {
      // Couldn't open this control — leave field.options undefined; the
      // fill phase still fuzzy-matches at fill time as a fallback.
    }
  }
}

// Locate the tailored resume PDF for a job. The tailor writes
// data/career/output/{jobId}-{resumeId}.pdf — we glob by jobId prefix
// so the apply doesn't need the resumeId plumbed through. Returns the
// absolute path when EXACTLY one match exists (ambiguous → null, the
// operator then uploads manually).
async function resolveResumePdf(jobId) {
  if (typeof jobId !== 'string' || !jobId) return null;
  try {
    const dir = path.resolve('data', 'career', 'output');
    const files = await fs.readdir(dir);
    const matches = files.filter(
      (f) => f.startsWith(`${jobId}-`) && f.toLowerCase().endsWith('.pdf'),
    );
    return matches.length === 1 ? path.join(dir, matches[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Detect file-upload controls and return them as synthetic file-class
 * fields. The a11y snapshot misses <input type=file> (no accessible
 * name), so this scans the DOM directly. Each field carries a
 * `_fileInputIndex` so the fill loop can setInputFiles() on it without
 * going through the refTable.
 *
 * Defensive — mock pages (smoke) lack page.locator and yield [].
 */
async function captureFileFields(page, session) {
  if (!page || typeof page.locator !== 'function') return [];
  let inputs;
  let n = 0;
  try {
    inputs = page.locator('input[type=file]');
    n = await inputs.count();
  } catch {
    return [];
  }
  const resumePdf = await resolveResumePdf(session?.jobId);
  const out = [];
  for (let i = 0; i < Math.min(n, 5); i++) {
    // First file input → resume (the universal case); extras are generic.
    const isResume = i === 0;
    const label = isResume ? 'Resume / CV upload' : `File upload ${i + 1}`;
    const subclass = isResume ? 'resume' : 'general-file';
    const found = isResume && resumePdf;
    const source = {
      kind: 'file',
      subclass,
      status: found ? 'found' : 'generate-first',
    };
    out.push({
      refId: `__file_${i}`,
      label,
      class: 'file',
      subclass,
      role: 'file',
      suggested_value: found ? resumePdf : null,
      confidence: found ? 'high' : 'manual',
      source,
      source_ref: toSourceRefString(source),
      // Marks this as a direct-selector file field — the fill loop uses
      // page.locator('input[type=file]').nth() instead of the refTable.
      _fileInputIndex: i,
    });
  }
  return out;
}

// ── Coverage + manual-blocker detection (M2) ────────────────────────────
//
// M1 verifies fields the machine touched. M2 catches the two remaining
// silent-error classes: form controls the snapshot never saw, and things
// only a human can do (CAPTCHA). No silent errors — a missed control
// becomes a visible `not_seen` row, a CAPTCHA a visible `manual` item.

function _normLabel(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[\s*:]*\((?:required|optional)\)[\s*:]*$/i, '')
    .replace(/[\s*:]+$/, '')
    .trim();
}

// Two normalized labels refer to the same field. EXACT match only —
// containment ("resume document" ⊂ "upload your resume document") can
// match unrelated fields, even across roles, and would silently suppress
// a real coverage gap. A near-miss instead surfaces as `not_seen`:
// visible noise is acceptable, a silent miss is not.
function _labelsSameField(a, b) {
  return !!a && !!b && a === b;
}

// Reconcile the live DOM's 1:1 form controls (text inputs, textareas,
// selects) against the draft. Any visible control whose label isn't in
// the draft is returned as a synthetic `not_seen` field — the snapshot
// missed it and the operator must fill it by hand. Radio/checkbox are
// excluded (N inputs = 1 logical field → counting them invites noise).
// Never throws.
async function captureCoverageGaps(page, classified) {
  if (!page || typeof page.evaluate !== 'function') return [];
  let controls;
  try {
    controls = await page.evaluate(() => {
      const SKIP = ['hidden', 'submit', 'button', 'reset', 'file', 'checkbox', 'radio', 'image'];
      const out = [];
      for (const el of document.querySelectorAll('input, textarea, select')) {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (tag === 'input' && SKIP.includes(type)) continue;
        if (el.offsetParent === null && window.getComputedStyle(el).position !== 'fixed') {
          continue; // not visible
        }
        let label = '';
        const id = el.getAttribute('id');
        if (id) {
          const esc = window.CSS && CSS.escape ? CSS.escape(id) : id;
          const l = document.querySelector(`label[for="${esc}"]`);
          if (l) label = l.innerText || l.textContent || '';
        }
        if (!label) {
          const l = el.closest('label');
          if (l) label = l.innerText || '';
        }
        if (!label) {
          label =
            el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            el.getAttribute('name') ||
            '';
        }
        out.push(String(label).replace(/\s+/g, ' ').trim().slice(0, 200));
      }
      return out;
    });
  } catch {
    return [];
  }
  const known = [];
  for (const f of classified) {
    if (f && f.label) known.push(_normLabel(f.label));
  }
  const gaps = [];
  const seen = new Set();
  for (const raw of controls) {
    const n = _normLabel(raw);
    const matched = n && known.some((k) => _labelsSameField(k, n));
    if (matched) continue;
    const key = n || `__unlabeled_${gaps.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    gaps.push({
      refId: `__notseen_${gaps.length}`,
      label: raw || '(unlabeled field)',
      class: 'unknown',
      role: 'textbox',
      suggested_value: null,
      confidence: 'manual',
      verify_status: 'not_seen',
      verify_detail: 'on the form but the machine did not capture it — fill it yourself',
      source_ref: 'coverage:not-seen',
    });
  }
  return gaps;
}

// Detect CAPTCHA / human-only blockers. Returns synthetic `manual`
// fields so the operator gets an explicit "only you can do this" item.
// CAPTCHA is never solved — just surfaced. Never throws.
async function detectManualBlockers(page) {
  if (!page || typeof page.locator !== 'function') return [];
  try {
    // Targeted CAPTCHA selectors. A bare [data-sitekey] is too broad
    // (Stripe / analytics tags use it) — would raise a false manual
    // blocker on a perfectly submittable form.
    const captcha = page.locator(
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], ' +
        'iframe[title*="captcha" i], .g-recaptcha, .h-captcha, .cf-turnstile',
    );
    if ((await captcha.count()) > 0) {
      return [
        {
          refId: '__captcha',
          label: 'CAPTCHA',
          class: 'manual',
          role: 'manual',
          suggested_value: null,
          confidence: 'manual',
          verify_status: 'manual',
          verify_detail: 'solve the CAPTCHA in the browser window before submitting',
          source_ref: 'manual:captcha',
        },
      ];
    }
  } catch {
    // detection failure is non-fatal
  }
  return [];
}

// ── Verification (M1 — post-fill read-back) ─────────────────────────────
//
// The machine is otherwise "fire-and-forget": it fills a field and assumes
// success if no exception was thrown. React forms routinely accept a
// Playwright fill at the API level without the component committing the
// value, so "filled" can be a lie. verifyStep re-reads each filled field
// from the live DOM and assigns an HONEST status — a field only becomes
// 'verified' via an explicit positive read-back. Core principle: no
// silent errors. verifyStep NEVER throws — every failure is recorded.

// Read a field's current value back from the live DOM, by control type.
// Returns a string (possibly '') or null when the value can't be read.
async function readFieldValue(page, table, f) {
  // Synthetic file field — resolved by index, not via the refTable.
  if (typeof f._fileInputIndex === 'number') {
    return page
      .locator('input[type=file]')
      .nth(f._fileInputIndex)
      .evaluate((el) => (el.files && el.files.length ? el.files[0].name : ''));
  }
  if (!table || typeof table.resolve !== 'function') return null;
  const loc = table.resolve(f.refId, page);
  const role = f.role;
  if (role === 'checkbox' || role === 'radio') {
    try {
      return (await loc.isChecked()) ? 'checked' : 'unchecked';
    } catch {
      const ac = await loc.getAttribute('aria-checked').catch(() => null);
      return ac === 'true' ? 'checked' : 'unchecked';
    }
  }
  const readInput = async () => {
    try {
      return await loc.inputValue();
    } catch {
      return null;
    }
  };
  const readText = async () => {
    try {
      const t = await loc.textContent();
      return t == null ? null : t;
    } catch {
      return null;
    }
  };
  // Combobox: the selected value lives in the element's text (React-Select
  // has no backing input value). Textbox: the input value.
  if (role === 'combobox' || role === 'listbox' || role === 'menu') {
    return (await readText()) ?? (await readInput());
  }
  return (await readInput()) ?? (await readText());
}

// Does the value read back from the DOM match what we intended to fill?
function verifyValueMatches(field, actual) {
  const role = field.role;
  if (role === 'radio') {
    // A radio field represents the chosen option — it ends up checked.
    return actual === 'checked';
  }
  if (role === 'checkbox') {
    // A negative intended value means the box should end up UNchecked
    // (defaultFillField uncheck()s on "No"/false). Derive the expectation
    // from the value — otherwise a correctly-unchecked "No" reads as a
    // mismatch every time.
    const v = String(field.suggested_value ?? '').trim().toLowerCase();
    const wantUnchecked = /^(no|false|off|unchecked|none|n|0)$/.test(v);
    return wantUnchecked ? actual === 'unchecked' : actual === 'checked';
  }
  if (typeof field._fileInputIndex === 'number') {
    // actual = the filename the <input type=file> reports. Require an
    // exact basename match — "any non-empty name" would green-light the
    // WRONG file (a silent error).
    if (!actual) return false;
    const wantName = String(field.suggested_value).split('/').pop();
    return actual === wantName;
  }
  const norm = (s) =>
    String(s ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  const want = norm(field.suggested_value);
  const got = norm(actual);
  if (!want) return true;
  // Empty form field + non-empty expected → the fill did NOT land. Guard
  // here: without it `want.includes('')` is always true (every string
  // contains '') and an empty field would falsely verify.
  if (!got) return false;
  // A combobox still showing its placeholder ("Select…") never committed.
  if (/^(select|choose|pick)\b/.test(got) && got.length < 30) return false;
  return got === want || got.includes(want) || want.includes(got);
}

// Re-read every field we attempted to fill and stamp field.verify_status:
//   verified     — read back, value landed
//   mismatch     — read back, value did NOT land (the silent-error catcher)
//   fill_error   — the fill itself threw (set by the FILL loop)
//   unverifiable — could not read the field back (stale ref / timeout)
// Fields with no value to fill are left untouched (no false 'verified').
// NEVER throws.
async function verifyStep(page, table, classified) {
  // Verification needs a real Playwright page. Smoke mock pages lack
  // `locator` — skip wholesale so a field stays unverified rather than
  // being falsely marked 'unverifiable' (keeps the machine smoke green).
  if (!page || typeof page.locator !== 'function') return;
  for (const f of classified) {
    if (!f) continue;
    // Manual-class fields (CAPTCHA, rich text, …) are never machine-
    // filled — tag them so the panel lists them as "only you can do".
    if (f.class === 'manual') {
      if (!f.verify_status) f.verify_status = 'manual';
      continue;
    }
    if (f.suggested_value == null || f.suggested_value === '') continue;
    if (f.verify_status === 'fill_error') continue; // already failed at fill
    let actual;
    try {
      actual = await readFieldValue(page, table, f);
    } catch (err) {
      f.verify_status = 'unverifiable';
      f.verify_detail = String(err?.message ?? err).slice(0, 200);
      continue;
    }
    if (actual == null) {
      f.verify_status = 'unverifiable';
      f.verify_detail = 'could not read the field value back from the form';
      continue;
    }
    if (verifyValueMatches(f, actual)) {
      f.verify_status = 'verified';
    } else {
      f.verify_status = 'mismatch';
      f.verify_detail =
        `expected ${JSON.stringify(String(f.suggested_value).slice(0, 80))}, ` +
        `form shows ${JSON.stringify(String(actual).slice(0, 80))}`;
    }
  }
}

/**
 * Build a per-step draft fragment from a list of classifier outputs.
 * Shape matches m1's PerStepDraftSchema (relaxed for in-progress drafts).
 */
function buildStepDraftFragment(stepIdx, classifiedFields) {
  return {
    step_idx: stepIdx,
    fields: classifiedFields.map((f) => {
      const out = {
        label: String(f.label || '').slice(0, 400),
        class: f.class,
        suggested_value:
          f.suggested_value == null ? null : String(f.suggested_value).slice(0, 8000),
      };
      // Only include OPTIONAL fields when defined — Zod catchall in
      // m1's PerStepDraftFieldSchema rejects explicit undefined values.
      if (f.refId) out.refId = f.refId;
      if (f.confidence) out.confidence = f.confidence;
      if (typeof f.source_ref === 'string' && f.source_ref) {
        out.source_ref = f.source_ref.slice(0, 400);
      }
      if (f.subclass) out.subclass = f.subclass;
      // Carry the control role through so the approval UI can show the
      // user whether a field is a dropdown / radio / checkbox / text.
      if (typeof f.role === 'string' && f.role) out.role = f.role;
      // Real option texts captured from the live dropdown — lets the
      // approval UI render an actual <select> the operator picks from.
      if (Array.isArray(f.options) && f.options.length) {
        out.options = f.options.slice(0, 80).map((o) => String(o).slice(0, 400));
      }
      // H7 fix from review: surface fill_error so m4/UI can show which
      // fields failed to fill (vs silently dropping them from telemetry).
      if (typeof f.fill_error === 'string' && f.fill_error) {
        out.fill_error = f.fill_error.slice(0, 400);
      }
      // M1: post-fill verification result — verified / mismatch /
      // fill_error / unverifiable. Surfaced so the UI never shows a
      // comforting "done" over a field that didn't actually land.
      if (typeof f.verify_status === 'string' && f.verify_status) {
        out.verify_status = f.verify_status;
      }
      if (typeof f.verify_detail === 'string' && f.verify_detail) {
        out.verify_detail = f.verify_detail.slice(0, 400);
      }
      return out;
    }),
    captured_at: new Date().toISOString(),
  };
}

/**
 * Apply caller-supplied edits to a draft. `edits` is an array of
 * { refId, suggested_value } entries; null/undefined refId or value is
 * skipped. Mutates `draft.fields` in place.
 */
function applyEditsToDraft(draft, edits) {
  if (!Array.isArray(edits) || !edits.length) return;
  const byRef = new Map();
  for (const e of edits) {
    if (!e || !e.refId) continue;
    byRef.set(e.refId, e.suggested_value);
  }
  for (const f of draft.fields) {
    if (byRef.has(f.refId)) {
      const v = byRef.get(f.refId);
      // L4 fix from review: cap user input length at the schema bound
      const capped = v == null ? null : String(v).slice(0, 8000);
      f.suggested_value = capped;
      // M2 fix from review: user edits are accepted at face value but
      // marked source.user_edited so downstream eval-harness / Mode 1
      // promotion can distinguish "deterministic identity lookup" from
      // "user-corrected an LLM output". Keep confidence='high' since
      // user-provided values are trusted, but tag the origin.
      f.confidence = 'high';
      f.source = { ...(f.source || {}), user_edited: true };
    }
  }
}

/**
 * Internal: classify every entry in a table against classifier ctx,
 * applying field_memory hits before invoking the classifier. Returns
 * an array of classifier-shaped objects (one per refId).
 *
 * Pre-applies memory: if the entry's label resolves to a memory key
 * already in session.field_memory, we synthesize a field WITHOUT calling
 * classifyAndFill — saves time + cost AND saves USER_APPROVE since
 * confidence='high' field values from memory are taken at face value
 * (the user already approved this answer in a prior step).
 */
async function classifyEntries(entries, ctx, fieldMemory, classifierFn) {
  const out = [];
  for (const entry of entries) {
    // Memory pre-check via normalized label. Misses source.key-keyed hits
    // (those are caught post-classify by applyMemoryHit on line ~205);
    // pre-check is purely a perf optimization. Documented in H5.
    const memHit = lookupMemoryByLabel(fieldMemory, entry.name);
    if (memHit != null) {
      out.push({
        refId: entry.refId,
        label: entry.name,
        class: 'hard', // memory hits are always-treated-as-known
        subclass: 'memory-hit',
        suggested_value: memHit,
        confidence: 'high',
        source: { kind: 'memory', memory_key: normalizeLabel(entry.name), status: 'found' },
        source_ref: `memory:${normalizeLabel(entry.name)}`,
        cost_usd: 0,
        used: 'memory',
        _fromMemory: true,
      });
      continue;
    }
    // No memory hit → invoke classifier
    let classified;
    try {
      classified = await classifierFn(entry, ctx);
    } catch (err) {
      classified = {
        refId: entry.refId,
        label: entry.name,
        class: 'open',
        subclass: 'classify-error',
        suggested_value: null,
        confidence: 'manual',
        source: { kind: 'llm', status: 'error', error: String(err?.message ?? err).slice(0, 200) },
        source_ref: 'error:classify-failed',
        cost_usd: 0,
        used: 'error',
      };
    }
    // Post-classify memory hit using classifier's lookupKey (more reliable
    // than label-based lookup)
    applyMemoryHit(fieldMemory, classified);
    out.push(classified);
  }
  return out;
}

/** Label-based memory lookup without going through classifier. */
function lookupMemoryByLabel(memory, label) {
  if (!memory || !label) return null;
  const key = normalizeLabel(label);
  if (!key) return null;
  const v = memory[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Decide whether a memory-pre-applied or classifier-emitted field needs
 * USER_APPROVE. Memory hits + high-confidence identity fields skip
 * approve (silent reuse / deterministic lookup). Everything else
 * requires approval per constraint #1.
 *
 * Per the planning spec: approve fires PER STEP, not per field. But
 * if ALL fields in a step are memory hits, we can skip the prompt
 * entirely (return false → run without approve). The state machine
 * checks this and only invokes approve when any field needs review.
 */
function stepNeedsApproval(classifiedFields) {
  for (const f of classifiedFields) {
    if (f._fromMemory) continue;
    // Class=hard/legal with high confidence from deterministic lookup
    // is silent (identity.email is always identity.email).
    if (
      (f.class === 'hard' || f.class === 'legal') &&
      f.confidence === 'high' &&
      f.suggested_value &&
      !(f.source && f.source.kind === 'llm')
    ) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Execute one step: snapshot → classify (or pick up pending) → (approve?)
 * → fill → re-snap diff → re-classify dependents → persist. Mutates
 * `session`. Caller is responsible for writeSession of the final state.
 *
 * @returns {Promise<{
 *   outcome: 'continue' | 'paused',  // M3 fix: explicit step outcome
 *   filled: number,
 *   skipped: number,
 *   errors: number,
 * }>}
 */
async function runStep(session, deps, ctx) {
  const {
    page,
    _snapshot,
    _classifyAndFill,
    _fillField,
    _waitDomStable,
    approve,
  } = deps;

  // M8 fix from review: wait for DOM stable BEFORE pre-snapshot (on
  // resume the page might be mid-render). Defensive; cheap.
  try {
    await _waitDomStable(page);
  } catch {
    // best-effort
  }

  // 1) Pre-snapshot
  const snapPre = await _snapshot(page);
  if (!snapPre || !snapPre.table) {
    throw new Error('runStep: snapshot returned no table');
  }
  const entriesPre = [];
  for (const refId of snapPre.table.refIds()) {
    const e = snapPre.table.publicEntry(refId);
    if (e) entriesPre.push(e);
  }

  const stepKey = String(session.current_step);

  if (!entriesPre.length) {
    // H8 fix from review: record skipped status + empty draft so resume
    // can distinguish "never visited" from "visited, no fields"
    session.per_step_status[stepKey] = 'skipped';
    session.per_step_draft[stepKey] = {
      step_idx: session.current_step,
      fields: [],
      captured_at: new Date().toISOString(),
    };
    return { outcome: 'continue', filled: 0, skipped: 0, errors: 0 };
  }

  // 2) Classify each entry (memory hits short-circuit). H1 fix from
  //    review: if a pending draft exists for this step (prior bail),
  //    apply its user-edited suggested_values onto the freshly-classified
  //    fields so we don't lose work. Reconciliation is by refId-or-label
  //    since refIds reset per snapshot.
  let classified = await classifyEntries(
    entriesPre,
    ctx.classifierCtx || {},
    session.field_memory,
    _classifyAndFill,
  );

  // Keep only real form controls. A single-page application URL
  // (greenhouse / lever / ashby) snapshots the WHOLE page, so nav links,
  // JD headings and logos arrive here too — and some of them match a
  // HARD/LEGAL regex on their text, so filtering on class is wrong.
  // Survive iff the a11y role is an actual input, or it is a classified
  // file-upload button. This drops page chrome AND keeps real controls
  // the classifier failed to match (an unmatched dropdown is still a
  // field the operator must fill — it surfaces as a manual field).
  classified = classified.filter(
    (c) =>
      c &&
      (FORM_INPUT_ROLES.has(c.role) || (c.role === 'button' && c.class === 'file')),
  );

  // Capture real dropdown options (open each → read → close) so the
  // approval UI shows them and the operator picks an exact option.
  await captureDropdownOptions(page, snapPre.table, classified);

  // Detect file-upload controls (the a11y snapshot misses <input
  // type=file>) and append them as synthetic file-class fields.
  const fileFields = await captureFileFields(page, session);
  if (fileFields.length) classified.push(...fileFields);

  // M2: coverage check — surface 1:1 form controls the snapshot missed
  // as `not_seen` fields, and CAPTCHA / manual-only blockers.
  const coverageGaps = await captureCoverageGaps(page, classified);
  if (coverageGaps.length) classified.push(...coverageGaps);
  const manualBlockers = await detectManualBlockers(page);
  if (manualBlockers.length) classified.push(...manualBlockers);

  const pendingDraft = session.per_step_draft[stepKey];
  if (
    pendingDraft &&
    session.per_step_status[stepKey] === 'pending' &&
    Array.isArray(pendingDraft.fields) &&
    pendingDraft.fields.length
  ) {
    reconcileFromPendingDraft(classified, pendingDraft);
  }

  // 3) USER_APPROVE (only when at least one field needs review)
  if (stepNeedsApproval(classified)) {
    const draft = buildStepDraftFragment(session.current_step, classified);
    const approval = await approve({
      stepIdx: session.current_step,
      totalSteps: session.total_steps,
      draft,
    });
    if (!approval || !approval.approved) {
      session.per_step_draft[stepKey] = draft;
      session.per_step_status[stepKey] = 'pending';
      session.status = 'paused';
      return { outcome: 'paused', filled: 0, skipped: classified.length, errors: 0 };
    }
    applyEditsToDraft(draft, approval.edits);
    // Sync edits back into classified (used by FILL)
    const editedByRef = new Map(draft.fields.map((f) => [f.refId, f]));
    classified = classified.map((c) => {
      const edited = editedByRef.get(c.refId);
      if (!edited) return c;
      return {
        ...c,
        suggested_value: edited.suggested_value,
        confidence: edited.confidence,
        source: edited.source || c.source,
      };
    });
  }

  // 4) FILL each field. Per-field errors don't sink the step.
  let filled = 0;
  let errors = 0;
  for (const f of classified) {
    if (f.suggested_value == null || f.suggested_value === '') continue;
    try {
      if (typeof f._fileInputIndex === 'number') {
        // Synthetic file field — upload straight onto the <input
        // type=file> by index (it isn't in the refTable).
        await page
          .locator('input[type=file]')
          .nth(f._fileInputIndex)
          .setInputFiles(f.suggested_value);
      } else {
        await _fillField(page, f.refId, f, snapPre.table);
      }
      recordToMemory(session.field_memory, f, f.suggested_value);
      filled++;
    } catch (err) {
      errors++;
      f.fill_error = String(err?.message ?? err).slice(0, 200);
      f.verify_status = 'fill_error';
    }
  }

  // 4b) VERIFY — read every filled field back from the live DOM. A field
  // only earns 'verified' via an explicit positive read; anything else
  // (mismatch / unverifiable / fill_error) surfaces. No silent success.
  await verifyStep(page, snapPre.table, classified);
  // Only a definite 'mismatch' blocks the step. 'unverifiable' (e.g. a
  // stale ref) still surfaces in the UI summary but doesn't force the
  // whole step to 'pending' — otherwise stale-ref churn makes 'pending'
  // the default and erodes the signal.
  const verifyFailures = classified.filter(
    (f) => f && f.verify_status === 'mismatch',
  ).length;

  // 5) Dependent-field check: re-snapshot, diff tuples
  const snapPost = await _snapshot(page);
  let dependentsMerged = false;
  if (snapPost && snapPost.table) {
    const preSet = tupleSetFromTable(snapPre.table);
    const dependents = [];
    for (const refId of snapPost.table.refIds()) {
      const e = snapPost.table.publicEntry(refId);
      if (!e) continue;
      if (!preSet.has(entryTuple(e))) dependents.push(e);
    }
    if (dependents.length) {
      const depClassified = (
        await classifyEntries(
          dependents,
          ctx.classifierCtx || {},
          session.field_memory,
          _classifyAndFill,
        )
      ).filter((c) => c && c.class !== 'unknown');
      if (stepNeedsApproval(depClassified)) {
        const depDraft = buildStepDraftFragment(session.current_step, depClassified);
        const approval2 = await approve({
          stepIdx: session.current_step,
          totalSteps: session.total_steps,
          draft: depDraft,
          isDependentRecheck: true,
        });
        if (!approval2 || !approval2.approved) {
          // H2 fix from review: persist BASE + DEPENDENT fields together,
          // not just dependents — declining the second prompt shouldn't
          // erase the user's first-approve work from the persisted draft.
          mergeDependentIntoDraft(session, depDraft, classified);
          session.per_step_status[stepKey] = 'pending';
          session.status = 'paused';
          return {
            outcome: 'paused',
            filled,
            skipped: depClassified.length,
            errors,
          };
        }
        applyEditsToDraft(depDraft, approval2.edits);
        for (const f of depDraft.fields) {
          if (f.suggested_value == null || f.suggested_value === '') continue;
          try {
            await _fillField(page, f.refId, f, snapPost.table);
            recordToMemory(session.field_memory, f, f.suggested_value);
            filled++;
          } catch (err) {
            errors++;
            f.fill_error = String(err?.message ?? err).slice(0, 200);
          }
        }
        mergeDependentIntoDraft(session, depDraft, classified);
        dependentsMerged = true;
      }
    }
  }

  // 6) Persist step draft. Skip when mergeDependentIntoDraft already
  //    wrote the merged shape.
  if (!dependentsMerged) {
    session.per_step_draft[stepKey] = buildStepDraftFragment(session.current_step, classified);
  }
  // H7-adjacent: if any fills errored OR failed post-fill verification,
  // surface via 'pending' status so resume / UI can re-prompt the user;
  // otherwise mark approved. A step with mismatches is NOT cleanly done.
  session.per_step_status[stepKey] =
    errors > 0 || verifyFailures > 0 ? 'pending' : 'approved';

  return { outcome: 'continue', filled, skipped: 0, errors };
}

/**
 * H1 fix from review: when resuming a step that had a pending draft,
 * apply prior user-edited values onto freshly-classified fields. Match
 * by refId first (works if snapshot order is stable across resume),
 * then by label fallback.
 */
function reconcileFromPendingDraft(classified, pendingDraft) {
  const byRefId = new Map();
  const byLabel = new Map();
  for (const f of pendingDraft.fields) {
    if (f.refId) byRefId.set(f.refId, f);
    if (f.label) byLabel.set(String(f.label).toLowerCase().trim(), f);
  }
  for (const c of classified) {
    const hit =
      (c.refId && byRefId.get(c.refId)) ||
      (c.label && byLabel.get(String(c.label).toLowerCase().trim()));
    if (!hit) continue;
    // Carry forward suggested_value + confidence + source.user_edited
    // tag if present. classifier-output IS still relevant for
    // source.key (for memory-key derivation), so we only override the
    // user-facing value + confidence fields.
    if (hit.suggested_value != null) c.suggested_value = hit.suggested_value;
    if (hit.confidence) c.confidence = hit.confidence;
    if (hit.source && hit.source.user_edited) {
      c.source = { ...(c.source || {}), user_edited: true };
    }
  }
}

/** Merge dependent draft fields into the step's accumulated per_step_draft. */
function mergeDependentIntoDraft(session, depDraft, baseClassified) {
  const key = String(session.current_step);
  const existing = session.per_step_draft[key];
  if (existing) {
    existing.fields.push(...depDraft.fields);
    existing.captured_at = new Date().toISOString();
  } else {
    session.per_step_draft[key] = {
      step_idx: session.current_step,
      fields: [
        ...(baseClassified ? buildStepDraftFragment(session.current_step, baseClassified).fields : []),
        ...depDraft.fields,
      ],
      captured_at: new Date().toISOString(),
    };
  }
}

/**
 * Run the multi-step machine for one job from current_step until
 * complete / paused / error. Caller must have a session already
 * persisted (or pass createIfMissing=true to bootstrap).
 *
 * @param {object} args
 * @param {string} args.jobId
 * @param {string} [args.jobUrl] — needed for INIT if no session exists
 * @param {string} [args.siteAdapter] — needed for INIT if no session exists
 * @param {object} args.page — Playwright Page (or smoke mock)
 * @param {(arg: {stepIdx, totalSteps, draft, isDependentRecheck?}) => Promise<{approved, edits?}>} args.approve
 * @param {object} [args.classifierCtx] — passed through to classifyAndFill
 * @param {number} [args.maxSteps=DEFAULT_MAX_STEPS]
 * @param {boolean} [args.createIfMissing=false]
 *
 * @param {object} [deps]
 * @param {Function} [deps._snapshot]
 * @param {Function} [deps._classifyAndFill]
 * @param {Function} [deps._fillField] — (page, refId, classifiedField, table) → Promise<void>
 * @param {Function} [deps._clickNext] — (page, locator) → Promise<void>
 * @param {Function} [deps._waitDomStable] — (page) → Promise<void>
 * @param {Function} [deps._probeTotalSteps]
 * @param {Function} [deps._findNextButton]
 * @param {Function} [deps._isOnSubmitStep]
 * @param {Function} [deps._readSession]
 * @param {Function} [deps._writeSession]
 *
 * @returns {Promise<{
 *   outcome: 'completed' | 'paused' | 'error',
 *   session: object,
 *   steps_run: number,
 *   error?: string,
 * }>}
 */
export async function runMachine(args, deps = {}) {
  const {
    jobId,
    jobUrl,
    siteAdapter,
    page,
    approve,
    classifierCtx,
    maxSteps = DEFAULT_MAX_STEPS,
    createIfMissing = false,
  } = args || {};

  if (!jobId) throw new Error('runMachine: jobId required');
  if (typeof approve !== 'function') {
    throw new Error('runMachine: approve callback required');
  }

  const resolved = {
    _snapshot: deps._snapshot || realSnapshot,
    _classifyAndFill: deps._classifyAndFill || classifyAndFill,
    _fillField: deps._fillField || defaultFillField,
    _clickNext: deps._clickNext || defaultClickNext,
    _waitDomStable: deps._waitDomStable || defaultWaitDomStable,
    _probeTotalSteps: deps._probeTotalSteps || realProbeTotalSteps,
    _findNextButton: deps._findNextButton || realFindNextButton,
    _isOnSubmitStep: deps._isOnSubmitStep || realIsOnSubmitStep,
    _readSession: deps._readSession || readSession,
    _writeSession: deps._writeSession || writeSession,
    // m6: submit-first error loop deps. Defaults THROW (Phase 2/m4+m5
    // primitives ship later). Smoke MUST inject mocks. Production code
    // wires the real Phase 2 helpers via endpoint.mjs.
    _submitForm: deps._submitForm || defaultSubmitForm,
    _parseFormErrors: deps._parseFormErrors || defaultParseFormErrors,
    _fixField: deps._fixField || defaultFixField,
  };

  // INIT — load or bootstrap session
  let session = await resolved._readSession(jobId);
  if (!session) {
    if (!createIfMissing) {
      return {
        outcome: OUTCOME.ERROR,
        session: null,
        steps_run: 0,
        error: 'no session for jobId; call with createIfMissing=true to bootstrap',
      };
    }
    if (!jobUrl || !siteAdapter) {
      return {
        outcome: OUTCOME.ERROR,
        session: null,
        steps_run: 0,
        error: 'createIfMissing=true requires jobUrl + siteAdapter',
      };
    }
    session = buildInitialSession({ jobId, jobUrl, siteAdapter });
  }
  if (session.status === 'abandoned' || session.status === 'completed') {
    return {
      outcome: session.status === 'completed' ? OUTCOME.COMPLETED : OUTCOME.ERROR,
      session,
      steps_run: 0,
      error: session.status === 'abandoned' ? 'session abandoned (>24h idle)' : undefined,
    };
  }
  // Resume bumps status back to active (was 'paused' from prior bail)
  session.status = 'active';

  // Persist the session NOW, before the STEP_LOOP. The loop otherwise
  // only writes after each step COMPLETES — so during a long step 0
  // (e.g. a single-page form paused at its approval gate) the status
  // endpoint readSession()s nothing and 404s, hiding the live machine.
  // Writing here makes the apply observable from step 0 onward.
  try {
    await withSessionLock(jobId, async () => {
      await resolved._writeSession(jobId, session);
    });
  } catch {
    // Non-fatal — the per-step persist below will retry.
  }

  // DETECT_FLOW — probe total steps if not yet known
  if (session.total_steps == null) {
    try {
      const probe = await resolved._probeTotalSteps(page, session.site_adapter);
      if (probe && probe.total != null && probe.total >= 1) {
        session.total_steps = probe.total;
      }
    } catch {
      // Probe failure → stay in exploratory mode (total_steps stays null)
    }
  }

  // STEP_LOOP
  const ctx = { classifierCtx };
  let stepsRun = 0;
  let outcome = null;
  let errorMsg;
  // m6: transient diagnostics from runSubmitLoop. NOT persisted (m1
  // session schema is .strict()) — attached only to the runMachine
  // return object so endpoint.mjs (Phase 1/m7) can surface
  // escalation_reason in GET /:jobId/status.
  let loopOutcomeMeta = null;

  try {
    for (let i = 0; i < maxSteps; i++) {
      // Submit-button detection. A visible Submit button means different
      // things depending on where we are:
      //   - step > 0  → a multi-step wizard's final Review/Submit step.
      //     Stop WITHOUT filling — the bulk was filled on prior steps and
      //     the operator submits. (Prevents auto-submitting a Workday
      //     Review page; preserves the original H3 review fix.)
      //   - step 0    → a SINGLE-PAGE form (greenhouse / lever / ashby):
      //     the whole form AND the Submit button live on one page. We
      //     must fill it first, so DON'T break here — fall through to
      //     runStep, then stop after filling (the isSubmit check below).
      // The machine never clicks Submit itself in either case.
      let isSubmit = false;
      try {
        isSubmit = await resolved._isOnSubmitStep(page, session.site_adapter);
      } catch {}
      if (isSubmit && session.current_step > 0) {
        // m6: multi-step Submit page. runSubmitLoop owns submit + errors.
        const loopRes = await runSubmitLoopHelper({
          jobId, session, page, siteAdapter: session.site_adapter, deps: resolved,
        });
        const d = dispatchLoopOutcome(loopRes);
        session = d.session;
        outcome = d.outcome;
        if (d.errorMsg) errorMsg = d.errorMsg;
        if (d.loopOutcomeMeta) loopOutcomeMeta = d.loopOutcomeMeta;
        break;
      }

      // Run one step
      const stepRes = await runStep(session, { page, ...resolved, approve }, ctx);
      stepsRun++;

      // C5 fix from review: persist after each step (under lock) so
      // crash mid-machine doesn't lose all prior step progress.
      try {
        await withSessionLock(jobId, async () => {
          await resolved._writeSession(jobId, session);
        });
      } catch (err) {
        // Persist failure is fatal — abort cleanly
        errorMsg = `persist after step ${session.current_step} failed: ${String(err?.message ?? err).slice(0, 200)}`;
        outcome = OUTCOME.ERROR;
        break;
      }

      // M3 fix from review: runStep returns explicit outcome enum
      if (stepRes.outcome === 'paused') {
        outcome = OUTCOME.PAUSED;
        break;
      }

      // Single-page form: the form is now filled and the Submit button
      // is right here. m6: the machine itself runs the submit-first
      // error loop instead of handing off to the operator. If the loop
      // can land submit, COMPLETED. If guards trip, ESCALATED (operator
      // takes over in browser).
      if (isSubmit) {
        // m6: single-page form post-runStep. Same dispatch as multi-step.
        const loopRes = await runSubmitLoopHelper({
          jobId, session, page, siteAdapter: session.site_adapter, deps: resolved,
        });
        const d = dispatchLoopOutcome(loopRes);
        session = d.session;
        outcome = d.outcome;
        if (d.errorMsg) errorMsg = d.errorMsg;
        if (d.loopOutcomeMeta) loopOutcomeMeta = d.loopOutcomeMeta;
        break;
      }

      // Find Next button + click
      const nextBtn = await resolved._findNextButton(page, session.site_adapter);
      if (!nextBtn) {
        session.status = 'completed';
        outcome = OUTCOME.COMPLETED;
        break;
      }
      try {
        await resolved._clickNext(page, nextBtn.locator);
      } catch (err) {
        errorMsg = `Next click failed at step ${session.current_step}: ${String(err?.message ?? err).slice(0, 200)}`;
        outcome = OUTCOME.ERROR;
        break;
      }

      // WAIT_DOM_READY
      try {
        await resolved._waitDomStable(page);
      } catch (err) {
        errorMsg = `WAIT_DOM_READY failed after step ${session.current_step}: ${String(err?.message ?? err).slice(0, 200)}`;
        outcome = OUTCOME.ERROR;
        break;
      }

      // Advance step counter
      session.current_step += 1;
      if (session.total_steps != null && session.current_step > session.total_steps) {
        session.status = 'completed';
        outcome = OUTCOME.COMPLETED;
        break;
      }
    }
    if (outcome == null) {
      errorMsg = `max-steps cap (${maxSteps}) reached without reaching Submit`;
      outcome = OUTCOME.ERROR;
    }
  } catch (err) {
    errorMsg = `runMachine threw: ${String(err?.message ?? err).slice(0, 200)}`;
    outcome = OUTCOME.ERROR;
  }

  // C4 fix from review: reconcile session.status with the final outcome
  // BEFORE the persist. status='active' must not be the disk state for an
  // error/completed/paused outcome. Map: completed→completed, paused→
  // paused (already set in runStep), error→paused (so resume can retry),
  // m6: escalated→paused (operator continues in browser; session is
  // resumable but the machine is done auto-submitting per OQ7).
  // We add a transient `last_error` field to the session for diagnostics
  // (m1 schema is .strict() so we DON'T persist that — we attach it to
  // the returned object only).
  if (outcome === OUTCOME.COMPLETED) {
    session.status = 'completed';
  } else if (outcome === OUTCOME.ERROR || outcome === OUTCOME.ESCALATED) {
    session.status = 'paused';
  }
  // (PAUSED was already set by runStep on declined approval)

  // H6 fix from review: wrap the final write so ZodError (e.g. field_memory
  // ballooned past cap) becomes a clean error outcome rather than
  // escaping runMachine as an uncaught rejection.
  try {
    await withSessionLock(jobId, async () => {
      await resolved._writeSession(jobId, session);
    });
  } catch (err) {
    const persistErr = `final writeSession failed: ${String(err?.message ?? err).slice(0, 200)}`;
    errorMsg = errorMsg ? `${errorMsg}; ${persistErr}` : persistErr;
    outcome = OUTCOME.ERROR;
  }

  return {
    outcome,
    session,
    steps_run: stepsRun,
    ...(errorMsg ? { error: errorMsg } : {}),
    // m6: include submit-loop diagnostics if the loop ran. Caller
    // (endpoint.mjs Phase 1/m7) merges escalation_reason into GET
    // /:jobId/status responses.
    ...(loopOutcomeMeta ? loopOutcomeMeta : {}),
  };
}

// ── Default Page-touching helpers ────────────────────────────────────
// These are the production defaults; m4 endpoint wires them via the
// real Playwright Page. Smoke replaces them with mocks.

// C1 + C2 caveat from review: defaultFillField is PROVISIONAL.
//   - It blindly tries fill → selectOption → check (in that order),
//     which is wrong for radio/checkbox/combobox state-mutating actions.
//   - It does NOT honor RefTable's pessimistic-invalidation contract
//     from 08-snapshot-refs-layer (each fill mutates the page; subsequent
//     fills against the same table can hit STALE_REF).
// m4 will replace this with the real 02-playwright-runtime action-verb
// layer that (a) routes by role + class, and (b) re-snapshots between
// fills when stale-ref fires. The smoke uses mocks; production usage
// SHOULD inject a fill_field that wraps the proper action verbs.
async function defaultFillField(page, refId, classifiedField, table) {
  if (!table || typeof table.resolve !== 'function') {
    throw new Error('defaultFillField: table.resolve not available');
  }
  const locator = table.resolve(refId, page);
  const value = classifiedField.suggested_value;

  // File class → upload via setInputFiles (only safe action for file inputs)
  if (classifiedField.class === 'file' && typeof value === 'string' && value) {
    await locator.setInputFiles(value);
    return;
  }

  // C1 partial fix: try in role-appropriate order WITHOUT falling through
  // to .check() on negative path (which would silently mis-toggle a radio).
  // Order: combobox/select → selectOption; textbox/textarea → fill;
  // checkbox → check/uncheck based on truthy value. We don't have role
  // info on the classifiedField shape — caller (m4 production wiring)
  // should pass role through; here we use heuristic by subclass + value.
  const isYes = String(value).trim().toLowerCase() === 'yes';
  const isNo = String(value).trim().toLowerCase() === 'no';

  // Try selectOption first (combobox / native select) — safe + idempotent
  try {
    await locator.selectOption(String(value));
    return;
  } catch {}
  // Then fill (textbox / textarea)
  try {
    await locator.fill(String(value));
    return;
  } catch {}
  // Finally, for boolean Yes/No legal questions, try check/uncheck
  if (classifiedField.class === 'legal' && (isYes || isNo)) {
    try {
      if (isYes) await locator.check();
      else await locator.uncheck();
      return;
    } catch {}
  }
  throw new Error(
    `defaultFillField: no action succeeded for refId=${refId} (class=${classifiedField.class}). ` +
      `Production wiring should inject _fillField that routes by role.`,
  );
}

async function defaultClickNext(page, locator) {
  await locator.click();
}

async function defaultWaitDomStable(page) {
  // Best-effort: networkidle with a bounded timeout. Falls back to a
  // short fixed delay if waitForLoadState isn't available (smoke).
  if (page && typeof page.waitForLoadState === 'function') {
    await page.waitForLoadState('networkidle', { timeout: DEFAULT_WAIT_DOM_MS });
    return;
  }
  await new Promise((r) => setTimeout(r, 200));
}

// m6 dispatch helper — translates runSubmitLoop result into the
// {session, outcome, errorMsg, loopOutcomeMeta} that the step-loop
// integration uses. Extracted (review H7) so both isSubmit branches
// in runMachine apply the same mapping; previous duplication was a
// bug multiplier (any future change to the mapping needs one edit).
//
// Mapping:
//   loopRes.outcome === 'submitted' → OUTCOME.COMPLETED, session.status='completed'
//   loopRes.outcome === 'escalated' → OUTCOME.ESCALATED, session.status='paused'
//                                       (loopOutcomeMeta carries escalation_reason
//                                        for endpoint Phase 1/m7 to surface)
//   loopRes.outcome === 'timeout'   → OUTCOME.ERROR, errorMsg includes detail
//                                       AND loopOutcomeMeta carries reason
//                                       (review L4 — was lost previously)
function dispatchLoopOutcome(loopRes) {
  const session = loopRes.final_session;
  let outcome;
  let errorMsg;
  let loopOutcomeMeta = null;
  if (loopRes.outcome === 'submitted') {
    if (session) session.status = 'completed';
    outcome = OUTCOME.COMPLETED;
    // [m14] forward the success signal so endpoint.mjs can surface
    // ctrl.submitDetectedBy → m10's autoMarkDecision.
    if (loopRes.submit_detected_by !== undefined) {
      loopOutcomeMeta = { submit_detected_by: loopRes.submit_detected_by };
    }
  } else if (loopRes.outcome === 'escalated') {
    if (session) session.status = 'paused';
    outcome = OUTCOME.ESCALATED;
    loopOutcomeMeta = {
      escalation_reason: loopRes.escalation_reason,
      submit_attempts_run: loopRes.attempts_run,
    };
  } else {
    // 'timeout' or unexpected — log diag both as errorMsg AND structured
    if (session) session.status = 'paused';
    outcome = OUTCOME.ERROR;
    errorMsg = `submitLoop ${loopRes.outcome}: ${loopRes.escalation_reason?.detail || 'no detail'}`;
    if (loopRes.escalation_reason) {
      loopOutcomeMeta = {
        escalation_reason: loopRes.escalation_reason,
        submit_attempts_run: loopRes.attempts_run,
      };
    }
  }
  return { session, outcome, errorMsg, loopOutcomeMeta };
}

// m6 default DIs — throw with a clear hint. Phase 2/m5 ships the real
// implementations (submitForm + parseFormErrors + detectSubmitSuccess in
// 02-playwright-runtime/submitFlow.mjs; fixField via fillWithFallback
// in 02-playwright-runtime/fillWithFallback.mjs). Until then production
// wiring in endpoint.mjs must inject deps explicitly OR runMachine will
// throw on the submit-first path. Smoke ALWAYS injects mocks.
async function defaultSubmitForm() {
  throw new Error(
    '_submitForm not injected — Phase 2/m5 02-playwright-runtime/submitFlow.mjs is not yet wired; ' +
      'endpoint.mjs must pass _submitForm in deps until then',
  );
}
async function defaultParseFormErrors() {
  throw new Error(
    '_parseFormErrors not injected — Phase 2/m5 02-playwright-runtime/submitFlow.mjs is not yet wired',
  );
}
async function defaultFixField() {
  throw new Error(
    '_fixField not injected — Phase 2/m4 02-playwright-runtime/fillWithFallback.mjs is not yet wired',
  );
}

// Re-export internals that smoke + m4 need
export { runStep, classifyEntries, tupleSetFromTable, entryTuple, stepNeedsApproval };
// [m14] dispatchLoopOutcome exported for smoke + flywheel sub-loop testing.
export { dispatchLoopOutcome };
// M1 + M2 verification layer — exported for the verify smoke.
export { verifyStep, verifyValueMatches, readFieldValue };
export { captureCoverageGaps, detectManualBlockers, _labelsSameField };
