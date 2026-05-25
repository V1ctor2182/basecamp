// CV HTML/CSS template assembler. Combines:
//   - identity.yml header (name + city + contacts) rendered classic-LaTeX-
//     style: centered, serif, thin rule below.
//   - markdown body already converted via markdownToTemplateHtml()
//   - inline CSS (Playwright headless can't reliably fetch network resources).
//
// Style choices (Classic LaTeX SWE Resume — Jake's Resume / Awesome-CV
// lineage):
//   - Single column (ATS-parser friendly).
//   - Times New Roman serif. Falls back to Liberation Serif on Linux + the
//     generic `serif` keyword so any reasonable PDF backend has a glyph.
//   - 10.5pt body, 1.3 line-height, 18pt centered name, 11pt all-caps h2
//     with a thin rule below. Tight vertical spacing — fits ~650 words/page
//     vs. system-ui template's ~600.
//   - Mostly monochrome. The per-resume accent color (metadata.renderer.
//     accent_color) is applied only to links, so the print is dignified
//     while the operator's brand color still shows on hyperlinks.
//   - Tab-separated "row" layout (left bold, right italic dates) handled by
//     <div class="row"><span class="row-left">…</span><span class="row-right">
//     …</span></div> produced by markdownToTemplateHtml's tab encoder.

const DEFAULT_ACCENT = '#0969da'

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
  return items.join(' &nbsp;|&nbsp; ')
}

function buildLocation(identity) {
  const loc = identity?.location ?? {}
  const parts = []
  if (isNonEmpty(loc.current_city)) parts.push(loc.current_city)
  if (isNonEmpty(loc.current_country)) parts.push(loc.current_country)
  return escapeHtml(parts.join(', '))
}

function buildHeader(identity) {
  const name = isNonEmpty(identity?.name) ? escapeHtml(identity.name) : ''
  const location = buildLocation(identity)
  const contacts = buildContacts(identity)
  // Contacts row: location · email · phone · LinkedIn · GitHub · Portfolio.
  // All on one centered line under the name — classic LaTeX SWE convention.
  const contactPieces = []
  if (location) contactPieces.push(location)
  if (contacts) contactPieces.push(contacts)
  return `
    <header>
      <h1>${name}</h1>
      ${contactPieces.length ? `<div class="contacts">${contactPieces.join(' &nbsp;|&nbsp; ')}</div>` : ''}
    </header>`
}

function buildCss(accentColor) {
  return `
    @page { size: Letter; margin: 0.5in 0.6in; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: 'Times New Roman', Times, 'Liberation Serif', 'Nimbus Roman', serif;
      font-size: 10.5pt;
      line-height: 1.3;
      color: #000;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    /* ── Header (identity-derived) ───────────────────────────────────── */
    header {
      text-align: center;
      margin-bottom: 6pt;
    }
    header h1 {
      font-size: 20pt;
      font-weight: 700;
      margin: 0 0 2pt;
      letter-spacing: 0.02em;
    }
    header .contacts {
      font-size: 9.5pt;
      color: #000;
    }
    header .contacts a {
      color: ${accentColor};
      text-decoration: none;
    }

    /* ── Section headings (h2 — promoted from **SECTION**) ───────────── */
    main h1 {
      /* Defensive: resume body shouldn't have h1. */
      font-size: 12pt;
      font-weight: 700;
      margin: 8pt 0 2pt;
    }
    main h2 {
      font-size: 11pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin: 8pt 0 2pt;
      padding-bottom: 1pt;
      border-bottom: 0.5pt solid #000;
      page-break-after: avoid;
      break-after: avoid;
    }
    main h3 {
      font-size: 10.5pt;
      font-weight: 700;
      margin: 4pt 0 1pt;
    }
    main h4, main h5, main h6 {
      font-size: 10.5pt;
      font-weight: 700;
      margin: 4pt 0 1pt;
    }

    /* ── Paragraphs & lists ──────────────────────────────────────────── */
    main p { margin: 2pt 0; }
    main ul, main ol {
      padding-left: 16pt;
      margin: 2pt 0 4pt;
    }
    main li {
      margin: 1pt 0;
      padding-left: 0;
    }
    main ul { list-style-type: disc; }
    main strong { font-weight: 700; }
    main em { font-style: italic; }
    main a {
      color: ${accentColor};
      text-decoration: none;
    }

    /* ── Tab-row layout (left bold heading + right italic dates) ─────── */
    main .row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12pt;
      margin: 1pt 0;
    }
    main .row .row-left {
      flex: 1 1 auto;
      min-width: 0;
    }
    main .row .row-right {
      flex: 0 0 auto;
      white-space: nowrap;
      font-style: italic;
      color: #000;
    }

    /* ── Misc ────────────────────────────────────────────────────────── */
    main code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 9.5pt;
      background: #f4f4f4;
      padding: 0 3pt;
      border-radius: 2pt;
    }
    main hr {
      border: 0;
      border-top: 0.5pt solid #000;
      margin: 6pt 0;
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
${buildHeader(identity)}
<main>${body_html}</main>
</body>
</html>`
}

export { escapeHtml, buildHeader, buildCss }
