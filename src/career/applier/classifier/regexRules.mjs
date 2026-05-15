// Field classifier — regex rules engine.
//
// 07-applier/03-field-classifier m1.
//
// Pure-function module. Takes a snapshot entry (from 08-snapshot-refs-layer:
// { refId, role, name, occurrenceIndex, ... }) and returns a classification
// + lookup key + subclass + confidence hint. Priority dispatch:
//
//   Hard > Legal > File > Open > Unknown
//
// lookupKey is the dot-path INTO the data file (identity.yml or legal.yml).
// Callers (m1 identityLookup / legalLookup) resolve the value.
//
// Patterns are CONSERVATIVE (anchored, narrow) for high-precision class
// assignment. Names that don't match any HARD/LEGAL/FILE pattern but match
// a textbox role + an OPEN pattern → 'open'. Everything else → 'unknown'.
//
// 09-snapshot-eval-harness will tune these patterns against real ATS
// fixtures post-ROOM-COMPLETE. m1 ships conservative defaults that nail
// the 8 fields all ATS share.

// ── HARD: deterministic identity.yml lookups ──────────────────────────
// lookupKey is the dot-path into identity.yml. null = "regex matches but
// identity.yml doesn't have this field — caller routes to confidence='manual'".
export const HARD_PATTERNS = Object.freeze([
  // Name (priority: full > first/last alone)
  { regex: /^(full|legal) ?name$/i, lookupKey: 'name', subclass: 'full-name' },
  { regex: /^(first|given) ?name$/i, lookupKey: 'name.split[0]', subclass: 'first-name' },
  { regex: /^(last|family|sur) ?name$/i, lookupKey: 'name.split[-1]', subclass: 'last-name' },
  { regex: /^name$/i, lookupKey: 'name', subclass: 'full-name' },
  // Contact — H3 fix from review: broader phone variants (Workday "Primary
  // Phone" / iCIMS "Contact Number" / Lever "Tel")
  { regex: /e[-_ ]?mail/i, lookupKey: 'email', subclass: 'email' },
  {
    regex: /\b(phone|mobile|cell|telephone|tel)\b|phone ?number|contact ?(number|phone)/i,
    lookupKey: 'phone',
    subclass: 'phone',
  },
  // Links — H1 fix from review: GitHub and GitLab are different sites. We
  // only have a GitHub URL in identity.yml, so GitLab patterns shouldn't
  // route here (would fill GitHub URL into GitLab field). GitLab field
  // falls through to OPEN/unknown for now.
  { regex: /linkedin/i, lookupKey: 'links.linkedin', subclass: 'linkedin' },
  { regex: /\bgithub\b/i, lookupKey: 'links.github', subclass: 'github' },
  { regex: /portfolio|personal ?(site|website|page)|^website$/i, lookupKey: 'links.portfolio', subclass: 'portfolio' },
  // Location — M2 fix: broader country variants (Workday "Country/Region",
  // ATS "Country of Residence")
  { regex: /^city$|current ?city|city of residence/i, lookupKey: 'location.current_city', subclass: 'city' },
  {
    regex: /^country$|current ?country|country ?of ?residence|country\/region/i,
    lookupKey: 'location.current_country',
    subclass: 'country',
  },
  // Education (identity.yml doesn't ship these yet — lookupKey:null signals
  // "user must extend identity.yml to fill"; classifier returns manual)
  { regex: /^(school|university|college)$|highest.*(school|institution)/i, lookupKey: null, subclass: 'school' },
  { regex: /^degree$|highest.*degree/i, lookupKey: null, subclass: 'degree' },
  { regex: /\bgpa\b/i, lookupKey: null, subclass: 'gpa' },
  // H4 fix: years-experience phrasings (years AFTER experience, "total
  // experience", etc)
  {
    regex: /years.*(of )?(relevant )?(experience|exp)|(experience|exp).*\byears\b|total experience/i,
    lookupKey: null,
    subclass: 'years-experience',
  },
]);

// ── LEGAL: deterministic legal.yml lookups ────────────────────────────
// EEO categories: legal.yml already ships "Decline to answer" defaults, so
// we just read the value. eeoDefault is the fallback if the YAML key is
// somehow missing (defensive).
export const LEGAL_PATTERNS = Object.freeze([
  // Work authorization / visa / sponsorship (most-asked category)
  // H8 fix: add visa status (Workday phrasing)
  {
    regex: /sponsor(ship)?|visa.*(now|future)|require.*sponsor|need.*sponsor|visa ?(status|type|category)|h-?1b/i,
    lookupKey: 'work_authorization.requires_sponsorship_now',
    subclass: 'sponsorship',
  },
  // H11 fix: cover Lever "lawfully" phrasing
  {
    regex: /authoriz.*work|legally authorized|authorized.*lawful|right to work|work.*authoriz/i,
    lookupKey: 'work_authorization.authorized_us_yes_no',
    subclass: 'work-authorization',
  },
  {
    regex: /citizen(ship)?|country of (birth|origin)/i,
    lookupKey: 'work_authorization.citizenship',
    subclass: 'citizenship',
  },
  // EEO category (all default to "Decline to answer" in legal.yml)
  {
    regex: /\bgender\b/i,
    lookupKey: 'eeo.gender',
    subclass: 'gender',
    eeoDefault: 'Decline to answer',
  },
  {
    regex: /\brace\b|ethnicity|ethnic origin/i,
    lookupKey: 'eeo.ethnicity',
    subclass: 'ethnicity',
    eeoDefault: 'Decline to answer',
  },
  {
    regex: /veteran/i,
    lookupKey: 'eeo.veteran',
    subclass: 'veteran',
    eeoDefault: 'Decline to answer',
  },
  {
    regex: /disability|disabled/i,
    lookupKey: 'eeo.disability',
    subclass: 'disability',
    eeoDefault: 'Decline to answer',
  },
  {
    // M3 fix: word boundary on both sides (avoid matching "pronouncement")
    regex: /\bpronouns?\b/i,
    lookupKey: 'eeo.pronouns',
    subclass: 'pronouns',
    eeoDefault: 'Decline to answer',
  },
  // Personal / behavioral
  // M4 fix: broader felony/conviction patterns
  {
    regex: /felony|convict(ion|ed)|criminal (record|history|background)/i,
    lookupKey: 'personal.criminal_record',
    subclass: 'felony',
  },
  {
    regex: /relocate|willing.*move/i,
    lookupKey: 'personal.relocate_willing',
    subclass: 'relocate',
  },
  {
    regex: /background check/i,
    lookupKey: 'personal.can_pass_background_check',
    subclass: 'background-check',
  },
  // "How did you hear about us" — broad coverage for variant phrasing
  // H9 fix: Lever uses bare "Source" / "Referral Source"
  {
    regex: /how (did )?you (hear|find|learn|come across|discover)|hear about (this|us|the position|the role|this job)|referred by|where (did )?you (hear|find|learn)|^source$|referral ?source/i,
    lookupKey: 'how_did_you_hear_default',
    subclass: 'how-did-you-hear',
  },
]);

// ── FILE: file-upload routing ─────────────────────────────────────────
// FILE pattern matches happen ONLY when the snapshot's role is button
// with name like "Upload"/"Choose File" OR the field's explicit subclass
// signal (resume/cv/cover-letter). m1's classifier prioritizes the name
// regex — m2's fileFiller resolves to actual paths.
export const FILE_PATTERNS = Object.freeze([
  { regex: /\b(resume|cv|curriculum vitae)\b/i, subclass: 'resume' },
  { regex: /cover ?letter/i, subclass: 'cover-letter' },
  { regex: /work ?samples?|portfolio.*file/i, subclass: 'work-samples' },
  { regex: /transcript/i, subclass: 'transcript' },
]);

// ── OPEN: LLM-routed long-form answers ────────────────────────────────
// Pattern → subclass mapping. m2's openFiller composes the prompt per
// subclass. 'unknown-open' is the catch-all for textbox-role fields with
// names not matching any specific OPEN subclass.
export const OPEN_PATTERNS = Object.freeze([
  { regex: /why.*(this )?(company|us|here)|reason.*join.*(company|us)/i, subclass: 'why-company' },
  { regex: /why.*(this )?(role|position|opportunity|join the team)|interested in (this )?(role|position)/i, subclass: 'why-role' },
  { regex: /tell.*(about|me about) (you|yourself|your)/i, subclass: 'tell-me-about' },
  { regex: /weakness/i, subclass: 'weakness' },
  { regex: /strength/i, subclass: 'strength' },
  { regex: /salary|compensation|pay expectation/i, subclass: 'salary-expectation' },
  { regex: /start ?date|when.*(available|start|join)|earliest.*start/i, subclass: 'start-date' },
  { regex: /notice ?period|how.*notice/i, subclass: 'notice-period' },
  { regex: /reason.*(leaving|leave)|why.*leaving/i, subclass: 'reason-for-leaving' },
  { regex: /\bcover letter\b/i, subclass: 'cover-letter-text' }, // text field, not file
]);

// Heuristic: when a name doesn't match any specific OPEN pattern but the
// role is textbox, we still classify as 'open' (subclass='unknown-open')
// so m2's openFiller has a chance to provide a generic LLM answer.

// ── EXTRA RULES: per-adapter known_fields injection ────────────────────
//
// 07-applier/06-site-adapters m2 adds a seam for site adapters to
// prepend per-ATS classification rules (e.g. greenhouse-specific labels)
// onto the regex sweep without touching the HARD/LEGAL/FILE/OPEN arrays
// above.
//
// Per OQ2 (locked at planning): augment, not override. Extra rules try
// FIRST; a no-match falls through to the standard HARD → LEGAL → FILE →
// OPEN pipeline. This keeps the safety property: a typo'd adapter
// known_field can't break the generic detector — worst case it just
// doesn't fire.
//
// Each extra rule shape:
//   { labelRegex: RegExp, class: 'hard'|'legal'|'open'|'file',
//     lookupKey: string|null, subclass?: string,
//     confidenceHint: 'high'|'medium'|'low' }
//
// Registered as a batch keyed by an opaque token so the caller (m2's
// activateAdapter) can revert exactly its own injection. Tokens are
// strings so callers can stash them on a DeactivationToken object
// without juggling references.

/** @type {Map<string, ReadonlyArray<{labelRegex: RegExp, class: string, lookupKey: string|null, subclass?: string, confidenceHint: string}>>} */
const _EXTRA_RULES = new Map();
let _extraTokenCounter = 1;

/**
 * Register a batch of per-adapter rules. Returns an opaque token used
 * by clearExtraRules. Rules are PRE-PENDED to the classifier sweep —
 * they try before the standard HARD/LEGAL/FILE/OPEN patterns.
 *
 * @param {ReadonlyArray<{labelRegex: RegExp, class: string, lookupKey: string|null, subclass?: string, confidenceHint: string}>} rules
 * @returns {string} token for clearExtraRules
 */
export function registerExtraRules(rules) {
  if (!Array.isArray(rules)) {
    throw new TypeError('registerExtraRules: rules must be an array');
  }
  for (const r of rules) {
    if (!r || !(r.labelRegex instanceof RegExp)) {
      throw new TypeError('registerExtraRules: each rule needs a labelRegex RegExp');
    }
    if (!['hard', 'legal', 'open', 'file'].includes(r.class)) {
      throw new TypeError(`registerExtraRules: invalid class ${r.class}`);
    }
    // REVIEW M2 fix: validate confidenceHint too. Bad enum value would
    // flow through to draftsStore / UI as an unknown tier.
    if (!['high', 'medium', 'low'].includes(r.confidenceHint)) {
      throw new TypeError(`registerExtraRules: invalid confidenceHint ${r.confidenceHint}`);
    }
  }
  const token = `_extra_${_extraTokenCounter++}`;
  _EXTRA_RULES.set(token, Object.freeze([...rules]));
  return token;
}

/**
 * Revert a prior registerExtraRules call. Throws if the token is unknown
 * (catches double-revert / typo). Idempotent only across distinct tokens.
 *
 * @param {string} token returned from registerExtraRules
 */
export function clearExtraRules(token) {
  if (!_EXTRA_RULES.has(token)) {
    throw new Error(`clearExtraRules: unknown token ${JSON.stringify(token)}`);
  }
  _EXTRA_RULES.delete(token);
}

/** Test-only: wipe all extra rules. */
export function _clearAllExtraRules() {
  _EXTRA_RULES.clear();
}

/** Diagnostic: count of registered extra-rule batches. */
export function _extraRulesSize() {
  return _EXTRA_RULES.size;
}

/**
 * Classify a snapshot entry into one of the 4 classes.
 *
 * @param {{ role: string, name: string, refId?: string, ... }} entry
 * @returns {{
 *   class: 'hard' | 'legal' | 'file' | 'open' | 'unknown',
 *   subclass?: string,
 *   lookupKey?: string | null,
 *   eeoDefault?: string,
 *   confidenceHint: 'high' | 'medium' | 'low' | null,
 * }}
 */
export function classifyField(entry) {
  const { role, name } = entry;
  if (!name || typeof name !== 'string') {
    return { class: 'unknown', confidenceHint: null };
  }

  // EXTRA RULES (per-adapter known_fields) — try first per OQ2 augment-prepend.
  // Insertion order across registerExtraRules batches.
  for (const batch of _EXTRA_RULES.values()) {
    for (const p of batch) {
      if (p.labelRegex.test(name)) {
        // FILE class is gated by role in the standard sweep — preserve
        // the same gate here so an adapter known_field claiming a
        // textbox field is file-class doesn't fire setInputFiles on a
        // text input. Falls through to next rule on miss.
        if (p.class === 'file' && role !== 'button' && role !== 'link') continue;
        return {
          class: p.class,
          subclass: p.subclass || `adapter:${p.lookupKey || 'unknown'}`,
          lookupKey: p.lookupKey,
          confidenceHint: p.confidenceHint,
          source: 'adapter-known-field',
        };
      }
    }
  }

  // HARD has highest priority — these are deterministic and high-confidence
  for (const p of HARD_PATTERNS) {
    if (p.regex.test(name)) {
      return {
        class: 'hard',
        subclass: p.subclass,
        lookupKey: p.lookupKey,
        // If identity.yml has this field: high; if pattern matches but
        // lookupKey=null (e.g. school): the caller routes to 'manual' but
        // class is still 'hard' so 04/05 can request user-extension of
        // identity.yml.
        confidenceHint: p.lookupKey ? 'high' : 'medium',
      };
    }
  }

  // LEGAL — next priority. legal.yml ships with EEO defaults already in
  // place so high-confidence by construction.
  for (const p of LEGAL_PATTERNS) {
    if (p.regex.test(name)) {
      return {
        class: 'legal',
        subclass: p.subclass,
        lookupKey: p.lookupKey,
        eeoDefault: p.eeoDefault,
        confidenceHint: 'high',
      };
    }
  }

  // FILE — match by name BUT gate on role (C2 fix from review): only
  // upload buttons / file inputs route here. A textbox named "Cover Letter"
  // (Lever's inline cover-letter textarea) must NOT classify as file —
  // fall through so OPEN picks it up.
  const isFileRole = role === 'button' || role === 'link';
  if (isFileRole) {
    for (const p of FILE_PATTERNS) {
      if (p.regex.test(name)) {
        return {
          class: 'file',
          subclass: p.subclass,
          // m2 fileFiller computes path from jobId + resumeId in ctx
          lookupKey: null,
          confidenceHint: p.subclass === 'resume' ? 'high' : 'medium',
        };
      }
    }
  }

  // OPEN — match by name first; if textbox role with no specific match,
  // still mark as open (subclass='unknown-open') for m2 LLM fallback.
  for (const p of OPEN_PATTERNS) {
    if (p.regex.test(name)) {
      return {
        class: 'open',
        subclass: p.subclass,
        lookupKey: null, // m2 openFiller generates value via Sonnet
        confidenceHint: 'medium',
      };
    }
  }

  // Textbox/textarea fall-through: probably a free-form question we
  // didn't anticipate. Mark as open with unknown subclass.
  if (role === 'textbox') {
    return {
      class: 'open',
      subclass: 'unknown-open',
      lookupKey: null,
      confidenceHint: 'low',
    };
  }

  // Truly unclassifiable (decorative heading, link, etc.)
  return { class: 'unknown', confidenceHint: null };
}
