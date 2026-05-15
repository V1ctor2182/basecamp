// Cross-step field memory for Mode 2 multi-step state machine.
//
// 07-applier/04-multi-step-state-machine m3.
//
// field_memory is a flat string→string Map persisted inside the session
// JSON (per m1 schema). Step 1 fills 'identity.first_name' = 'Victor';
// Step 5 sees a "First Name (confirm)" field whose classifier output
// has the same lookupKey → memory hit → use the memorized value, skip
// the LLM/identity lookup AND the user-approval prompt.
//
// Key derivation (OQ7 locked at planning):
//   1. classifier output's source.key (when class is hard/legal — that's
//      the canonical lookupKey like 'identity.email' / 'legal.work_auth')
//   2. fallback to normalize(label) — lowercased, trimmed, punctuation
//      collapsed to single underscores
//
// Map is mutated in place (caller is the per-step orchestrator which
// holds the session.field_memory reference). Mutation matches m1's
// last-activity bump pattern.

/**
 * Derive a stable memory key for a classifier output.
 *
 * @param {object} classifiedField — output of classifyAndFill, shape:
 *   { label, class, suggested_value, confidence, source: { key?, ... } }
 * @returns {string} the memory key (never empty for valid fields)
 */
export function memoryKeyFor(classifiedField) {
  if (!classifiedField || typeof classifiedField !== 'object') return '';
  // Primary: classifier-emitted lookup key (hard / legal classes)
  const k = classifiedField.source && classifiedField.source.key;
  if (typeof k === 'string' && k.trim()) return k.trim();
  // Fallback: normalize the field label so step variants like
  // "First Name", "First Name *", "First Name (confirm)" collapse to
  // the same memory key when source.key isn't present.
  const label = String(classifiedField.label || '');
  return normalizeLabel(label);
}

/**
 * Normalize a free-form field label to a memory key. Lowercase, trim,
 * collapse non-word chars to single underscores, strip leading/trailing
 * underscores.
 *
 * Idempotent: normalizeLabel(normalizeLabel(x)) === normalizeLabel(x).
 *
 * @param {string} label
 * @returns {string}
 */
export function normalizeLabel(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^\w]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Look up a previously-recorded value for this classified field.
 *
 * @param {object} memory — session.field_memory map
 * @param {object} classifiedField
 * @returns {string|null} the memorized value, or null if no hit
 */
export function lookupMemory(memory, classifiedField) {
  if (!memory || typeof memory !== 'object') return null;
  const key = memoryKeyFor(classifiedField);
  if (!key) return null;
  const v = memory[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Record a (field → value) pairing into memory. Mutates `memory` in
 * place. No-op when key derivation yields empty or value is null/empty.
 *
 * @param {object} memory
 * @param {object} classifiedField
 * @param {string|null|undefined} value
 * @returns {boolean} true if a write occurred
 */
export function recordToMemory(memory, classifiedField, value) {
  if (!memory || typeof memory !== 'object') return false;
  if (value == null) return false;
  const str = String(value);
  if (!str.length) return false;
  const key = memoryKeyFor(classifiedField);
  if (!key) return false;
  memory[key] = str;
  return true;
}

/**
 * Apply memory to a classified field IN PLACE: if a memory hit exists,
 * overwrite suggested_value, set confidence='high', and mark source as
 * memory-hit so downstream tooling (UI, eval-harness) can attribute the
 * value's origin. No-op when no memory hit.
 *
 * Returns true if the field was updated from memory.
 */
export function applyMemoryHit(memory, classifiedField) {
  const hit = lookupMemory(memory, classifiedField);
  if (hit == null) return false;
  classifiedField.suggested_value = hit;
  classifiedField.confidence = 'high';
  // Preserve original source for debugging; tag the memory hit explicitly
  const prior = classifiedField.source || {};
  classifiedField.source = {
    ...prior,
    memory_hit: true,
    memory_key: memoryKeyFor(classifiedField),
  };
  return true;
}
