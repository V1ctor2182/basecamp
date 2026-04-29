// CV HTML/CSS template assembler. Combines:
//   - identity.yml header (name + city + contacts)
//   - markdown body already converted via markdownToTemplateHtml()
//   - inline CSS template (no external resources — Playwright headless
//     doesn't fetch network content reliably; everything must be inline)
//
// Output is a complete <!DOCTYPE html>...</html> string ready for
// page.setContent() in htmlToPdf.mjs.
//
// Style choices (locked long-term-best, see plan-milestones decisions):
//   - Single-column layout (ATS parser-friendly; double-column often gets
//     re-ordered wrong).
//   - system-ui sans-serif (works offline; no Google Fonts dependency).
//   - 11pt body / 22pt name / 13pt h2 — ~600 words per Letter page.
//   - Configurable accent color (default GitHub blue #0969da) for h2 / a /
//     header border.

const DEFAULT_ACCENT = '#0969da'

// Escape user-supplied strings before splicing into HTML attributes / text.
// identity.yml is user-authored but defensive coding here costs nothing and
// would catch a future case (e.g., someone pastes a name with `"` or `<`).
function escapeHtml(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function isNonEmpty(s) {
  return typeof s === 'string' && s.trim().length > 0
}

// Build the right-hand contacts column. Order is the on-paper convention:
// email · phone · linkedin · github · portfolio. Empty fields skipped silently.
function buildContacts(identity) {
  const links = identity?.links ?? {}
  const items = []
  if (isNonEmpty(identity?.email)) {
    items.push(`<a href="mailto:${escapeHtml(identity.email)}">${escapeHtml(identity.email)}</a>`)
  }
  if (isNonEmpty(identity?.phone)) {
    items.push(escapeHtml(identity.phone))
  }
  if (isNonEmpty(links.linkedin)) {
    items.push(`<a href="${escapeHtml(links.linkedin)}">LinkedIn</a>`)
  }
  if (isNonEmpty(links.github)) {
    items.push(`<a href="${escapeHtml(links.github)}">GitHub</a>`)
  }
  if (isNonEmpty(links.portfolio)) {
    items.push(`<a href="${escapeHtml(links.portfolio)}">Portfolio</a>`)
  }
  return items.join(' &middot; ')
}

function buildLocation(identity) {
  const loc = identity?.location ?? {}
  const parts = []
  if (isNonEmpty(loc.current_city)) parts.push(loc.current_city)
  if (isNonEmpty(loc.current_country)) parts.push(loc.current_country)
  return escapeHtml(parts.join(', '))
}

function buildHeader(identity, accentColor) {
  const name = isNonEmpty(identity?.name) ? escapeHtml(identity.name) : ''
  const location = buildLocation(identity)
  const contacts = buildContacts(identity)
  return `
    <header>
      <div class="header-left">
        <h1>${name}</h1>
        ${location ? `<div class="location">${location}</div>` : ''}
      </div>
      ${contacts ? `<div class="contacts">${contacts}</div>` : ''}
    </header>`
}

function buildCss(accentColor) {
  return `
    @page { size: Letter; margin: 0.5in; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 11pt;
      line-height: 1.5;
      color: #1a1a1a;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 16pt;
      margin-bottom: 16pt;
      padding-bottom: 8pt;
      border-bottom: 2pt solid ${accentColor};
    }
    .header-left h1 {
      font-size: 22pt;
      font-weight: 600;
      margin: 0;
      letter-spacing: -0.01em;
    }
    .header-left .location {
      font-size: 10pt;
      color: #555;
      margin-top: 2pt;
    }
    .contacts {
      font-size: 10pt;
      color: #555;
      text-align: right;
      line-height: 1.4;
    }
    .contacts a {
      color: #555;
      text-decoration: none;
    }
    main h1 {
      /* Resume body shouldn't have h1 (header already has the name).
         Style defensively in case a markdown source slips one in. */
      font-size: 14pt;
      font-weight: 600;
      margin: 14pt 0 4pt;
    }
    main h2 {
      font-size: 13pt;
      font-weight: 600;
      margin: 14pt 0 4pt;
      color: ${accentColor};
      border-bottom: 1pt solid #d0d7de;
      padding-bottom: 2pt;
      page-break-after: avoid;
      break-after: avoid;
    }
    main h3 {
      font-size: 11pt;
      font-weight: 600;
      margin: 8pt 0 2pt;
    }
    main h4, main h5, main h6 {
      font-size: 11pt;
      font-weight: 600;
      margin: 6pt 0 2pt;
    }
    main p { margin: 4pt 0; }
    main ul, main ol { padding-left: 18pt; margin: 4pt 0; }
    main li { margin: 2pt 0; }
    main strong { font-weight: 600; }
    main em { font-style: italic; }
    main a {
      color: ${accentColor};
      text-decoration: none;
    }
    main code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 10pt;
      background: #f4f4f4;
      padding: 1pt 4pt;
      border-radius: 3pt;
    }
    main hr {
      border: 0;
      border-top: 1pt solid #d0d7de;
      margin: 12pt 0;
    }
  `
}

export function composeCvHtml({ identity = {}, body_html = '', options = {} } = {}) {
  const accentColor = options.accent_color ?? DEFAULT_ACCENT
  const name = isNonEmpty(identity?.name) ? identity.name : 'Resume'
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(name)} &mdash; Resume</title>
<style>${buildCss(accentColor)}</style>
</head>
<body>
${buildHeader(identity, accentColor)}
<main>${body_html}</main>
</body>
</html>`
}

// Exported for downstream sanitization audits / debugging.
export { escapeHtml, buildHeader, buildCss }
