// Special controls: CAPTCHA, rich text editors, slider, shadow DOM,
// iframe forms.
//
// 07-applier/05-non-standard-controls m4.
//
// Constraints (room spec):
//   #3: CAPTCHA detected → MUST pause immediately. NEVER attempt any fill
//       (any automated CAPTCHA solving violates ToS).
//   #4: Rich text (TinyMCE / Quill / Draft.js) → ALWAYS MANUAL by default.
//       DOM varies per version + altInput patterns; force-fill loses format.
//
// These two paths never call any locator.* method — the strategy
// returns MANUAL outright. Slider/shadow/iframe attempt a best-effort
// fill but fail to MANUAL on any error so the user can finish in the
// browser.

import { ControlType, Confidence, registerStrategy, registerDetectionRule } from '../controlRouter.mjs';

const _MANUAL = (suggested, error) => ({
  filled: false,
  confidence: Confidence.MANUAL,
  manual: true,
  suggestedValue: suggested,
  error,
});

// ─── CAPTCHA (Constraint #3) ──────────────────────────────────────────

const CAPTCHA_CLASS_TOKENS = ['g-recaptcha', 'h-captcha', 'cf-turnstile', 'recaptcha', 'hcaptcha'];

/**
 * Detect a CAPTCHA container. Exported for the dashboard so it can
 * pre-flight refuse to start a machine on a form behind a CAPTCHA.
 *
 * Checks (cheap → expensive):
 *   1. data-sitekey attribute (reCAPTCHA + hCaptcha standard hook)
 *   2. Class tokens matching known CAPTCHA frameworks (token-aware,
 *      avoids false-positive on `recaptcha-skin-helper` etc.)
 *
 * @param {object|null} info — sniffElement output ({ className, dataset, attrs })
 * @returns {boolean}
 */
export function detectCaptcha(info) {
  if (!info) return false;
  const sitekey = info?.attrs?.['data-sitekey'];
  if (typeof sitekey === 'string' && sitekey.trim().length > 0) return true;
  // dataset.sitekey is the camelCase form populated by HTML parsing
  if (info?.dataset && typeof info.dataset.sitekey === 'string' && info.dataset.sitekey) {
    return true;
  }
  if (typeof info.className !== 'string') return false;
  const tokens = info.className.toLowerCase().split(/\s+/);
  return CAPTCHA_CLASS_TOKENS.some((needle) => tokens.includes(needle));
}

async function fillCaptcha(_page, _locator, classifiedField, _value) {
  // Constraint #3: NEVER attempt any action. Strategy is a hard route to
  // MANUAL — user solves the CAPTCHA in browser, then the dashboard's
  // Continue button resumes the machine.
  return _MANUAL(
    classifiedField?.suggested_value ?? null,
    'captcha detected — user must solve in browser (constraint #3: never bypass)',
  );
}

// ─── Rich text (Constraint #4) ────────────────────────────────────────

// Review fix CRITICAL C2: `notranslate` was removed. It's a Google
// Translate hint widely used on plain <input>/<textarea> for email +
// name fields on i18n'd ATS sites (Workday/Greenhouse). Including it
// routed every translatable form field to MANUAL — Constraint #4
// false-positive that broke the entire fill experience for
// international sites. Draft.js is fully covered by the
// public-DraftEditor-* + DraftEditor-root tokens below.
const RICH_TEXT_CLASS_TOKENS = [
  'ql-editor', // Quill
  'tox-tinymce', // TinyMCE v5+
  'mce-content-body', // TinyMCE v4 / classic
  'public-DraftEditor-content', // Draft.js
  'public-draftEditor-content',
  'DraftEditor-root',
  'ProseMirror', // ProseMirror / TipTap
];

function _hasExactToken(info, needle) {
  if (!info || typeof info.className !== 'string') return false;
  const tokens = info.className.split(/\s+/);
  return tokens.includes(needle);
}

function _looksLikeRichText(info) {
  if (!info) return false;
  // contenteditable=true is the universal signal for a rich-text root.
  // We accept it as definitive UNLESS the element is also a plain
  // textbox role (m1 already handles those).
  if (info?.attrs?.contenteditable === 'true') return true;
  return RICH_TEXT_CLASS_TOKENS.some((t) => _hasExactToken(info, t));
}

async function fillRichText(_page, _locator, classifiedField, _value) {
  // Constraint #4: always MANUAL by default. The dashboard surfaces
  // suggested_value as Copy-to-Clipboard so the user can paste-and-
  // format in the rich editor.
  return _MANUAL(
    classifiedField?.suggested_value ?? null,
    'rich_text: editor DOM varies per library version — force-fill loses format (constraint #4)',
  );
}

// ─── Slider / range ───────────────────────────────────────────────────

async function fillSliderRange(_page, locator, _field, value) {
  if (value == null || value === '') return _MANUAL(value, 'slider_range: empty value');
  // Coerce to numeric string so locator.fill (Playwright's range-input
  // path) accepts it. NaN/non-numeric → MANUAL since we can't position
  // the thumb sensibly.
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return _MANUAL(value, `slider_range: non-numeric value ${JSON.stringify(value)}`);
  }
  try {
    await locator.fill(String(num));
    return { filled: true, confidence: Confidence.MEDIUM, manual: false, suggestedValue: null };
  } catch (err) {
    return _MANUAL(value, `slider_range: ${err?.message ?? err}`);
  }
}

// ─── Shadow DOM ───────────────────────────────────────────────────────

async function fillShadowDom(_page, locator, _field, value) {
  if (value == null || value === '') return _MANUAL(value, 'shadow_dom: empty value');
  try {
    // Review fix HIGH H1: Playwright's default CSS engine auto-pierces
    // open shadow DOM. The previous `:host >> css=...` syntax is
    // invalid (`:host` is a stylesheet-only pseudo-class) and was
    // throwing on every real shadow-DOM field. Closed shadow roots
    // cannot be pierced — those fail the locator chain and return
    // MANUAL via the catch below.
    const inner = locator.locator('input, textarea, select').first();
    await inner.fill(String(value));
    return { filled: true, confidence: Confidence.MEDIUM, manual: false, suggestedValue: null };
  } catch (err) {
    return _MANUAL(value, `shadow_dom: ${err?.message ?? err}`);
  }
}

// ─── iframe form ──────────────────────────────────────────────────────

async function fillIframeForm(_page, locator, classifiedField, value) {
  if (value == null || value === '') return _MANUAL(value, 'iframe_form: empty value');
  try {
    const frame = typeof locator.contentFrame === 'function' ? await locator.contentFrame() : null;
    if (!frame) {
      return _MANUAL(value, 'iframe_form: contentFrame() returned null (frame detached?)');
    }
    if (typeof frame.getByRole !== 'function') {
      return _MANUAL(value, 'iframe_form: frame has no getByRole (detached?)');
    }
    // Review fix HIGH H2: match by accessible name so we don't blindly
    // fill the first textbox in a multi-input iframe (e.g. Workday's
    // inner form has email + first name + last name + sometimes
    // password). The old `.first()` typed the user's value into
    // whichever textbox happened to be DOM-first.
    const targetName = classifiedField?.label || classifiedField?.name || '';
    let inner;
    if (typeof targetName === 'string' && targetName.trim()) {
      inner = frame.getByRole('textbox', { name: targetName.trim(), exact: true }).first();
      try {
        const count = await inner.count();
        if (count !== 1) {
          // Either no match or multiple matches — ambiguous, defer to user.
          return _MANUAL(
            value,
            `iframe_form: ${count} textboxes matched name=${JSON.stringify(targetName)}`,
          );
        }
      } catch {
        // Older Playwright versions may not support .count() on
        // role-based locators; fall through to the unnamed lookup
        // below as a best-effort.
        inner = frame.getByRole('textbox').first();
      }
    } else {
      // No classifier label — single-textbox iframes are common
      // enough that we attempt .first() but downgrade confidence.
      inner = frame.getByRole('textbox').first();
    }
    await inner.fill(String(value));
    return {
      filled: true,
      confidence: targetName ? Confidence.MEDIUM : Confidence.LOW,
      manual: false,
      suggestedValue: null,
    };
  } catch (err) {
    return _MANUAL(value, `iframe_form: ${err?.message ?? err}`);
  }
}

// ─── Detection rule ───────────────────────────────────────────────────

function specialDetectionRule(entry, info, _classifiedField) {
  if (!info) return null;
  // CAPTCHA wins above everything else — constraint #3 mandates we
  // never even try to interact.
  if (detectCaptcha(info)) return ControlType.CAPTCHA;
  // Rich text — contenteditable=true OR known editor class.
  if (_looksLikeRichText(info)) return ControlType.RICH_TEXT;
  // Slider / range — <input type=range>.
  if (info.tagName === 'INPUT' && info.type === 'range') {
    return ControlType.SLIDER_RANGE;
  }
  // ARIA slider role on a non-INPUT element (custom slider widget).
  if (entry?.role === 'slider' && info.tagName !== 'INPUT') {
    return ControlType.SLIDER_RANGE;
  }
  // Shadow DOM — element has its own shadowRoot.
  if (info.hasShadow === true) return ControlType.SHADOW_DOM;
  // iframe — tagName signals it. Inner content navigation is the
  // strategy's job.
  if (info.tagName === 'IFRAME') return ControlType.IFRAME_FORM;
  return null;
}

// ─── Registration ─────────────────────────────────────────────────────

export function registerSpecialStrategies() {
  registerStrategy(ControlType.CAPTCHA, { fill: fillCaptcha });
  registerStrategy(ControlType.RICH_TEXT, { fill: fillRichText });
  registerStrategy(ControlType.SLIDER_RANGE, { fill: fillSliderRange });
  registerStrategy(ControlType.SHADOW_DOM, { fill: fillShadowDom });
  registerStrategy(ControlType.IFRAME_FORM, { fill: fillIframeForm });
  registerDetectionRule(specialDetectionRule);
}

registerSpecialStrategies();

export const _testing = {
  fillCaptcha,
  fillRichText,
  fillSliderRange,
  fillShadowDom,
  fillIframeForm,
  specialDetectionRule,
};
