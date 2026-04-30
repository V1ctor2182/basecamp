// Compile a list of user-supplied keywords into a fast (text) → matched|null
// matcher. Used by the hard-filter engine for company / title / jd-text rules
// and (in the future) anywhere else we let the user provide string filters.
//
// Modes:
//   'contains'  — substring match (default). Fast, intuitive.
//   'whole_word' — substring with \b boundaries (regex internally).
//   'regex'     — raw user pattern. We try { new RegExp(...) } catch — bad
//                 pattern logs a warning and skips that single keyword (the
//                 rest of the list still works; the scan keeps going).
//
// Bad input policy: if compileMatcher gets a non-array or empty array, it
// returns a no-op matcher that always returns null. Callers don't need to
// short-circuit "is there a rule" themselves.

const FLAGS_CI = 'i';
const FLAGS_CS = '';

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileMatcher(keywords, mode = 'contains', caseSensitive = false) {
  if (!Array.isArray(keywords) || keywords.length === 0) {
    return () => null;
  }
  const list = keywords.filter((k) => typeof k === 'string' && k.length > 0);
  if (list.length === 0) return () => null;
  const flags = caseSensitive ? FLAGS_CS : FLAGS_CI;

  if (mode === 'contains') {
    if (caseSensitive) {
      return (text) => {
        if (typeof text !== 'string') return null;
        for (const kw of list) {
          if (text.includes(kw)) return kw;
        }
        return null;
      };
    }
    const lowered = list.map((k) => k.toLowerCase());
    return (text) => {
      if (typeof text !== 'string') return null;
      const t = text.toLowerCase();
      for (let i = 0; i < lowered.length; i++) {
        if (t.includes(lowered[i])) return list[i];
      }
      return null;
    };
  }

  if (mode === 'whole_word') {
    const compiled = [];
    for (const kw of list) {
      try {
        compiled.push({ kw, re: new RegExp(`\\b${escapeRegex(kw)}\\b`, flags) });
      } catch {
        // escapeRegex makes this practically unreachable; keep for safety.
        console.warn(`[matchUtils] whole_word kw "${kw}" failed to compile, skipping`);
      }
    }
    return (text) => {
      if (typeof text !== 'string') return null;
      for (const { kw, re } of compiled) {
        if (re.test(text)) return kw;
      }
      return null;
    };
  }

  if (mode === 'regex') {
    const compiled = [];
    for (const kw of list) {
      try {
        compiled.push({ kw, re: new RegExp(kw, flags) });
      } catch (e) {
        console.warn(`[matchUtils] regex kw "${kw}" invalid (${e.message}), skipping`);
      }
    }
    return (text) => {
      if (typeof text !== 'string') return null;
      for (const { kw, re } of compiled) {
        if (re.test(text)) return kw;
      }
      return null;
    };
  }

  // Unknown mode — fall back to contains, ci.
  console.warn(`[matchUtils] unknown mode "${mode}", falling back to contains`);
  return compileMatcher(list, 'contains', caseSensitive);
}
