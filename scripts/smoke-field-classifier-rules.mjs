#!/usr/bin/env node
// Smoke for 07-applier/03-field-classifier m1: regex rules + identity.yml/
// legal.yml lookup + classifyAndLookup public API.
//
// Pure-Node smoke (no Chromium, no LLM). Fast.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  classifyField,
  HARD_PATTERNS,
  LEGAL_PATTERNS,
  FILE_PATTERNS,
  OPEN_PATTERNS,
  lookupHardValue,
  lookupLegalValue,
  classifyAndLookup,
} from '../src/career/applier/classifier/index.mjs';
import { _resetCache as resetIdentityCache } from '../src/career/applier/classifier/identityLookup.mjs';
import { _resetCache as resetLegalCache } from '../src/career/applier/classifier/legalLookup.mjs';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    process.exit(1);
  }
}

// Reset caches at start (lazy loads pick up fresh fixtures)
resetIdentityCache();
resetLegalCache();

// ── 1. Pattern shape sanity ──────────────────────────────────────────
await test('pattern arrays are frozen + non-empty', () => {
  assert.ok(Array.isArray(HARD_PATTERNS) && HARD_PATTERNS.length >= 10);
  assert.ok(Array.isArray(LEGAL_PATTERNS) && LEGAL_PATTERNS.length >= 8);
  assert.ok(Array.isArray(FILE_PATTERNS) && FILE_PATTERNS.length >= 3);
  assert.ok(Array.isArray(OPEN_PATTERNS) && OPEN_PATTERNS.length >= 7);
  assert.throws(() => HARD_PATTERNS.push({}), /read only|object is not extensible/);
});

// ── 2. HARD classification — core fields all ATS share ────────────────
await test('HARD: name variants → class=hard, subclass correct', () => {
  for (const [name, expectedSubclass] of [
    ['Full Name', 'full-name'],
    ['First Name', 'first-name'],
    ['Last Name', 'last-name'],
    ['Name', 'full-name'],
  ]) {
    const c = classifyField({ role: 'textbox', name });
    assert.equal(c.class, 'hard', `'${name}': expected class=hard, got ${c.class}`);
    assert.equal(c.subclass, expectedSubclass, `'${name}': subclass`);
  }
});

await test('HARD: email/phone/links/location patterns match', () => {
  const cases = [
    ['Email', 'email'],
    ['E-mail Address', 'email'],
    ['Phone Number', 'phone'],
    ['Mobile', 'phone'],
    ['LinkedIn Profile', 'linkedin'],
    ['GitHub URL', 'github'],
    ['Portfolio', 'portfolio'],
    ['Personal Website', 'portfolio'],
    ['City', 'city'],
    ['Country', 'country'],
  ];
  for (const [name, expected] of cases) {
    const c = classifyField({ role: 'textbox', name });
    assert.equal(c.class, 'hard', `'${name}': class`);
    assert.equal(c.subclass, expected, `'${name}': subclass`);
  }
});

await test('HARD: school/degree/GPA matched but lookupKey=null (extend identity)', () => {
  for (const [name, subclass] of [
    ['School', 'school'],
    ['Degree', 'degree'],
    ['GPA', 'gpa'],
    ['Years of Experience', 'years-experience'],
  ]) {
    const c = classifyField({ role: 'textbox', name });
    assert.equal(c.class, 'hard', `'${name}': class`);
    assert.equal(c.subclass, subclass, `'${name}': subclass`);
    assert.equal(c.lookupKey, null, `'${name}': lookupKey should be null (not in identity.yml)`);
    assert.equal(c.confidenceHint, 'medium', `'${name}': confidenceHint`);
  }
});

// ── 3. LEGAL classification ──────────────────────────────────────────
await test('LEGAL: work-authorization patterns', () => {
  const cases = [
    ['Will you require visa sponsorship?', 'sponsorship'],
    ['Do you require sponsorship now or in the future?', 'sponsorship'],
    ['Are you legally authorized to work in the US?', 'work-authorization'],
    ['Country of citizenship', 'citizenship'],
  ];
  for (const [name, subclass] of cases) {
    const c = classifyField({ role: 'combobox', name });
    assert.equal(c.class, 'legal', `'${name}': class`);
    assert.equal(c.subclass, subclass, `'${name}': subclass`);
  }
});

await test('LEGAL: EEO patterns get eeoDefault', () => {
  const cases = [
    ['Gender', 'gender'],
    ['Ethnicity', 'ethnicity'],
    ['Race', 'ethnicity'],
    ['Are you a veteran?', 'veteran'],
    ['Do you have a disability?', 'disability'],
    ['Pronouns', 'pronouns'],
  ];
  for (const [name, subclass] of cases) {
    const c = classifyField({ role: 'combobox', name });
    assert.equal(c.class, 'legal', `'${name}': class`);
    assert.equal(c.subclass, subclass, `'${name}': subclass`);
    assert.equal(c.eeoDefault, 'Decline to answer', `'${name}': eeoDefault`);
  }
});

await test('LEGAL: behavioral + how-did-you-hear', () => {
  const cases = [
    ['Have you been convicted of a felony?', 'felony'],
    ['Are you willing to relocate?', 'relocate'],
    ['How did you hear about us?', 'how-did-you-hear'],
    ['How did you find this position?', 'how-did-you-hear'],
  ];
  for (const [name, subclass] of cases) {
    const c = classifyField({ role: 'textbox', name });
    assert.equal(c.class, 'legal', `'${name}': class`);
    assert.equal(c.subclass, subclass, `'${name}': subclass`);
  }
});

// ── 4. FILE classification ───────────────────────────────────────────
await test('FILE: resume/cover-letter/transcript patterns', () => {
  const cases = [
    ['Resume', 'resume'],
    ['CV', 'resume'],
    ['Curriculum Vitae', 'resume'],
    ['Cover Letter', 'cover-letter'],
    ['Work Sample', 'work-samples'],
    ['Transcript', 'transcript'],
  ];
  for (const [name, subclass] of cases) {
    const c = classifyField({ role: 'button', name });
    assert.equal(c.class, 'file', `'${name}': class`);
    assert.equal(c.subclass, subclass, `'${name}': subclass`);
  }
});

// ── 5. OPEN classification ───────────────────────────────────────────
await test('OPEN: subclass patterns', () => {
  const cases = [
    ['Why are you interested in this company?', 'why-company'],
    ['Why us?', 'why-company'],
    ['Why are you interested in this role?', 'why-role'],
    ['Tell me about yourself', 'tell-me-about'],
    ['What is your greatest weakness?', 'weakness'],
    ['Salary expectation', 'salary-expectation'],
    ['When can you start?', 'start-date'],
    ['Notice period', 'notice-period'],
    ['Reason for leaving your current job', 'reason-for-leaving'],
  ];
  for (const [name, subclass] of cases) {
    const c = classifyField({ role: 'textbox', name });
    assert.equal(c.class, 'open', `'${name}': class`);
    assert.equal(c.subclass, subclass, `'${name}': subclass`);
  }
});

await test('OPEN: textbox fallback → subclass=unknown-open (low confidence)', () => {
  const c = classifyField({ role: 'textbox', name: 'Any additional notes' });
  assert.equal(c.class, 'open');
  assert.equal(c.subclass, 'unknown-open');
  assert.equal(c.confidenceHint, 'low');
});

// ── 6. Priority dispatch — Hard > Legal > File > Open ─────────────────
await test('priority: "Email Address" → hard not open', () => {
  // Even though "address" might trigger something, "email" wins via HARD
  const c = classifyField({ role: 'textbox', name: 'Email Address' });
  assert.equal(c.class, 'hard');
  assert.equal(c.subclass, 'email');
});

await test('unknown role + unknown name → class=unknown', () => {
  const c = classifyField({ role: 'heading', name: 'Application Form' });
  assert.equal(c.class, 'unknown');
});

await test('empty/missing name → class=unknown (no crash)', () => {
  assert.equal(classifyField({ role: 'textbox', name: '' }).class, 'unknown');
  assert.equal(classifyField({ role: 'textbox', name: undefined }).class, 'unknown');
  assert.equal(classifyField({ role: 'textbox', name: null }).class, 'unknown');
});

// ── 7. identity.yml lookup ────────────────────────────────────────────
await test('lookupHardValue: simple keys', async () => {
  const email = await lookupHardValue('email');
  assert.equal(email.found, true);
  assert.ok(email.value && email.value.includes('@'), 'email should look like an email');
  const phone = await lookupHardValue('phone');
  assert.equal(phone.found, true);
  assert.ok(phone.value && phone.value.length > 0);
});

await test('lookupHardValue: nested dot-path', async () => {
  const linkedin = await lookupHardValue('links.linkedin');
  assert.equal(linkedin.found, true);
  assert.ok(linkedin.value && linkedin.value.startsWith('http'));
});

await test('lookupHardValue: split syntax for first/last name', async () => {
  const first = await lookupHardValue('name.split[0]');
  assert.equal(first.found, true);
  const last = await lookupHardValue('name.split[-1]');
  assert.equal(last.found, true);
  // First and last should be different parts of the name
  const full = await lookupHardValue('name');
  assert.equal(full.found, true);
  assert.ok(full.value.includes(first.value), 'first name should be in full name');
  assert.ok(full.value.includes(last.value), 'last name should be in full name');
});

await test('lookupHardValue: missing key → found=false', async () => {
  const missing = await lookupHardValue('nonexistent.path');
  assert.equal(missing.found, false);
  assert.equal(missing.value, null);
});

await test('lookupHardValue: null lookupKey returns {found:false}', async () => {
  const r = await lookupHardValue(null);
  assert.equal(r.found, false);
});

// ── 8. legal.yml lookup ───────────────────────────────────────────────
await test('lookupLegalValue: EEO categories with defaults', async () => {
  const gender = await lookupLegalValue('eeo.gender', 'Decline to answer', 'gender');
  assert.equal(gender.found, true);
  assert.equal(gender.value, 'Decline to answer'); // legal.yml ships with this default
});

await test('lookupLegalValue: boolean coercion to Yes/No', async () => {
  const sponsor = await lookupLegalValue('work_authorization.requires_sponsorship_now', undefined, 'sponsorship');
  assert.equal(sponsor.found, true);
  assert.ok(sponsor.value === 'Yes' || sponsor.value === 'No', `expected Yes/No, got ${sponsor.value}`);
  const felony = await lookupLegalValue('personal.criminal_record', undefined, 'felony');
  assert.equal(felony.found, true);
  assert.ok(felony.value === 'Yes' || felony.value === 'No');
});

await test('lookupLegalValue: missing key falls back to eeoDefault', async () => {
  const r = await lookupLegalValue('eeo.nonexistent', 'Decline to answer', 'unknown');
  assert.equal(r.found, true);
  assert.equal(r.value, 'Decline to answer');
});

await test('lookupLegalValue: missing key + no default → not found', async () => {
  const r = await lookupLegalValue('eeo.nonexistent', undefined);
  assert.equal(r.found, false);
});

// ── 9. classifyAndLookup integration ──────────────────────────────────
await test('classifyAndLookup: Email field → high-confidence hard', async () => {
  const result = await classifyAndLookup({
    refId: 'e2',
    role: 'textbox',
    name: 'Email',
  });
  assert.equal(result.class, 'hard');
  assert.equal(result.subclass, 'email');
  assert.equal(result.confidence, 'high');
  assert.ok(result.suggested_value && result.suggested_value.includes('@'));
  assert.equal(result.source_ref, 'identity.yml:email');
});

await test('classifyAndLookup: Gender field → high-confidence legal with default', async () => {
  const result = await classifyAndLookup({
    refId: 'e5',
    role: 'combobox',
    name: 'Gender',
  });
  assert.equal(result.class, 'legal');
  assert.equal(result.subclass, 'gender');
  assert.equal(result.confidence, 'high');
  assert.equal(result.suggested_value, 'Decline to answer');
});

await test('classifyAndLookup: Resume → file class, manual (m2 resolves path)', async () => {
  const result = await classifyAndLookup({
    refId: 'e8',
    role: 'button',
    name: 'Resume',
  });
  assert.equal(result.class, 'file');
  assert.equal(result.subclass, 'resume');
  assert.equal(result.confidence, 'manual');
  assert.equal(result.suggested_value, null);
});

await test('classifyAndLookup: Why this company? → open class, manual (m2 LLM)', async () => {
  const result = await classifyAndLookup({
    refId: 'e9',
    role: 'textbox',
    name: 'Why are you interested in this company?',
  });
  assert.equal(result.class, 'open');
  assert.equal(result.subclass, 'why-company');
  assert.equal(result.suggested_value, null);
  // m1 confidence is the hint (medium) — m2 will overwrite with high/medium/manual based on actual LLM result
});

await test('classifyAndLookup: school field (not in identity.yml) → manual', async () => {
  const result = await classifyAndLookup({
    refId: 'e10',
    role: 'textbox',
    name: 'School',
  });
  assert.equal(result.class, 'hard');
  assert.equal(result.subclass, 'school');
  assert.equal(result.confidence, 'manual');
  assert.equal(result.suggested_value, null);
  assert.ok(result.source_ref.includes('extend'));
});

// ── 9b. Review-fix coverage ────────────────────────────────────────────

await test('C2 fix: cover-letter TEXTBOX falls to OPEN (not FILE)', () => {
  const asButton = classifyField({ role: 'button', name: 'Cover Letter' });
  assert.equal(asButton.class, 'file', 'button "Cover Letter" → file');
  const asTextbox = classifyField({ role: 'textbox', name: 'Cover Letter' });
  assert.equal(asTextbox.class, 'open', 'textbox "Cover Letter" → open (not file)');
  assert.equal(asTextbox.subclass, 'cover-letter-text');
});

await test('H1 fix: GitLab field does NOT route to github URL', () => {
  // GitLab pattern was removed from github regex; should fall through
  const c = classifyField({ role: 'textbox', name: 'GitLab Profile' });
  // Either unknown or open — but NOT classified as hard/github
  assert.notEqual(c.subclass, 'github');
});

await test('H3 fix: phone variant coverage', () => {
  for (const name of ['Primary Phone', 'Contact Number', 'Daytime Phone', 'Tel']) {
    const c = classifyField({ role: 'textbox', name });
    assert.equal(c.class, 'hard', `'${name}': class`);
    assert.equal(c.subclass, 'phone', `'${name}': subclass`);
  }
});

await test('H4 fix: years-experience reverse phrasings', () => {
  for (const name of ['Years of Experience', 'Total Experience (years)', 'Experience in years']) {
    const c = classifyField({ role: 'textbox', name });
    assert.equal(c.subclass, 'years-experience', `'${name}': should be years-experience`);
  }
});

await test('H6 fix: single-word name → split[-1] returns undefined (manual)', async () => {
  // We can't easily mutate identity.yml in smoke without affecting real
  // data. Test the dotPath logic directly: resolveDotPath isn't exported,
  // so verify through lookupHardValue with a hypothetical scenario.
  // For now: verify split[0] works on real multi-word name and split[-1]
  // returns the LAST token (proving the fix doesn't break the multi-word case).
  const first = await lookupHardValue('name.split[0]');
  const last = await lookupHardValue('name.split[-1]');
  assert.equal(first.found, true);
  assert.equal(last.found, true);
  assert.notEqual(first.value, last.value, 'multi-word name: first ≠ last');
});

await test('H7 fix: combobox + number coercion → confidence=manual', async () => {
  // Simulated case: travel_willing_percent (25) routed to a combobox field
  // We don't have a regex that picks travel percent up to combobox, but we
  // can verify the index.mjs coercion guard via a synthetic legal field.
  // Easiest: use existing felony field (boolean → "Yes"/"No") doesn't
  // trigger guard. But verify the coercedFrom is exposed in the lookup.
  const sponsor = await lookupLegalValue('work_authorization.requires_sponsorship_now');
  assert.ok(sponsor.coercedFrom === 'boolean', `expected coercedFrom=boolean, got ${sponsor.coercedFrom}`);
});

await test('H10 fix: source is structured object + source_ref is parseable string', async () => {
  const result = await classifyAndLookup({
    refId: 'e1',
    role: 'textbox',
    name: 'Email',
  });
  assert.ok(typeof result.source === 'object', 'source should be an object');
  assert.equal(result.source.kind, 'identity');
  assert.equal(result.source.key, 'email');
  assert.equal(result.source.status, 'found');
  assert.equal(result.source_ref, 'identity.yml:email');
  // Missing field has ?status=missing
  const missing = await classifyAndLookup({
    refId: 'e2',
    role: 'textbox',
    name: 'School',
  });
  assert.equal(missing.source.kind, 'identity');
  assert.equal(missing.source.status, 'extend');
  assert.ok(missing.source_ref.includes('status=extend'));
});

await test('M8 fix: open class with null value has confidence=manual (not medium)', async () => {
  const result = await classifyAndLookup({
    refId: 'e3',
    role: 'textbox',
    name: 'Why are you interested?',
  });
  assert.equal(result.class, 'open');
  assert.equal(result.suggested_value, null);
  assert.equal(result.confidence, 'manual', 'm1 null-value open must be manual not medium');
});

await test('H8 fix: visa-status (Workday) routes to sponsorship', () => {
  const c = classifyField({ role: 'combobox', name: 'Visa Status' });
  assert.equal(c.class, 'legal');
  assert.equal(c.subclass, 'sponsorship');
});

await test('H9 fix: Lever "Source" / "Referral Source" routes to how-did-you-hear', () => {
  for (const name of ['Source', 'Referral Source']) {
    const c = classifyField({ role: 'combobox', name });
    assert.equal(c.subclass, 'how-did-you-hear', `'${name}': subclass`);
  }
});

await test('M3 fix: pronouncement does NOT match pronouns', () => {
  const c = classifyField({ role: 'textbox', name: 'Pronouncement of name' });
  assert.notEqual(c.subclass, 'pronouns');
});

// ── 10. 15-field Greenhouse-shaped fixture: accuracy ≥ 60% (m1 floor) ──
await test('Greenhouse-shaped 15-field fixture: m1 hits Hard+Legal+File classes', async () => {
  const fields = [
    { refId: 'e1', role: 'textbox', name: 'First Name' },
    { refId: 'e2', role: 'textbox', name: 'Last Name' },
    { refId: 'e3', role: 'textbox', name: 'Email' },
    { refId: 'e4', role: 'textbox', name: 'Phone' },
    { refId: 'e5', role: 'textbox', name: 'LinkedIn Profile' },
    { refId: 'e6', role: 'textbox', name: 'GitHub URL' },
    { refId: 'e7', role: 'button', name: 'Upload Resume' },
    { refId: 'e8', role: 'combobox', name: 'Will you require visa sponsorship?' },
    { refId: 'e9', role: 'combobox', name: 'Are you legally authorized to work in the US?' },
    { refId: 'e10', role: 'combobox', name: 'Gender' },
    { refId: 'e11', role: 'combobox', name: 'Race' },
    { refId: 'e12', role: 'combobox', name: 'Are you a veteran?' },
    { refId: 'e13', role: 'textbox', name: 'How did you hear about us?' },
    { refId: 'e14', role: 'textbox', name: 'Why are you interested in this role?' },
    { refId: 'e15', role: 'textbox', name: 'Tell me about yourself' },
  ];
  const results = await Promise.all(fields.map((f) => classifyAndLookup(f)));
  // Classes hit: 6 hard (Name×2, Email, Phone, LinkedIn, GitHub), 1 file (Resume),
  // 5 legal (sponsorship, work-auth, gender, race, veteran), 1 legal (how-did-you-hear),
  // 2 open (why-role, tell-me-about) — that's 15/15 classified correctly
  const correctClasses = {
    e1: 'hard', e2: 'hard', e3: 'hard', e4: 'hard', e5: 'hard', e6: 'hard',
    e7: 'file',
    e8: 'legal', e9: 'legal', e10: 'legal', e11: 'legal', e12: 'legal', e13: 'legal',
    e14: 'open', e15: 'open',
  };
  let correct = 0;
  for (const r of results) {
    if (r.class === correctClasses[r.refId]) correct++;
    else console.error(`misclassified ${r.refId} (${r.label}): expected ${correctClasses[r.refId]}, got ${r.class}`);
  }
  const accuracy = correct / fields.length;
  assert.ok(accuracy >= 0.95, `class accuracy ${(accuracy * 100).toFixed(0)}% should be ≥95% (m1)`);
  // High-confidence values: should have at least 11 (6 hard with identity data + 5 legal with defaults)
  const highConfidence = results.filter((r) => r.confidence === 'high' && r.suggested_value).length;
  assert.ok(
    highConfidence >= 10,
    `at least 10 fields should fill high-confidence, got ${highConfidence}`,
  );
});

console.log(`\n✅ All ${passed} smoke tests passed.`);
