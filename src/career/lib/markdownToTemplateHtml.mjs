// Markdown → CV template body HTML transformer.
//
// Pure ESM module: server.mjs (Playwright PDF pipeline) and the Vite frontend
// both import from here. Shared so print and preview can stay 1:1 if/when the
// frontend swaps from react-markdown.
//
// Output contract: clean semantic HTML (h1-h6 / p / ul / ol / li / strong /
// em / a / code / hr / br / div / span). No class allowlist beyond the LaTeX
// row layout. XSS posture: raw HTML inside markdown is dropped at tokenizer
// level (resume content is user-authored, no need for HTML passthrough).
//
// Google Docs → Markdown export quirks this module compensates for:
//   1. Section headers come out as `**SECTION**` standalone bold paragraphs,
//      not `## h2`. Promote to h2 so the LaTeX-style template hooks in.
//   2. Right-aligned dates/locations use literal tabs (`\t`). Markdown
//      collapses whitespace, so we encode tabs as a sentinel before parsing,
//      then rebuild flex "rows" in the HTML post-pass.

import { Marked } from 'marked'

const marked = new Marked({
  gfm: false,
  breaks: false,
  pedantic: false,
})

marked.use({
  renderer: {
    html: () => '',
  },
})

export const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'ul', 'ol', 'li',
  'strong', 'em',
  'a', 'code',
  'hr', 'br',
  'div', 'span',
]

// Sentinel for tab markers. Picked from a Unicode control-char range so it
// can't collide with anything a real resume would contain.
const TAB_SENTINEL = 'ROW'

// Promote standalone all-caps bold lines (e.g. `**EDUCATION**`) to `## h2`.
// Matches: a line whose only content is `**` + uppercase tokens + `**`, with
// optional trailing whitespace/tabs (Google Docs adds those). Sub-sections
// inside a line like `**ALIBABA** *role*\tLocation` won't match — they need
// the row-layout, not h2 promotion.
function promoteAllCapsBoldToH2(md) {
  return md.replace(
    /^[ \t]*\*\*([A-Z0-9][A-Z0-9 &/\-]{1,60}[A-Z0-9])\*\*[ \t]*$/gm,
    '## $1',
  )
}

// Encode the FIRST `\t` on each line as a sentinel so it survives marked's
// whitespace normalization. Subsequent tabs on the same line collapse to a
// single space (matches LaTeX two-column convention: at most one tab stop).
function encodeTabRows(md) {
  return md.split('\n').map((line) => {
    if (!line.includes('\t')) return line
    const idx = line.indexOf('\t')
    return line.slice(0, idx) + TAB_SENTINEL + line.slice(idx + 1).replace(/\t/g, ' ')
  }).join('\n')
}

// Rebuild flex rows from sentinel-marked paragraphs. Splits multi-line
// paragraphs (joined by <br>) so each line can independently be a row.
function rebuildTabRows(html) {
  return html.replace(/<p>([\s\S]*?)<\/p>/g, (full, inner) => {
    if (!inner.includes(TAB_SENTINEL)) return full
    const parts = inner.split(/<br\s*\/?>/)
    return parts.map((part) => {
      if (!part.includes(TAB_SENTINEL)) return `<div class="row">${part.trim()}</div>`
      const idx = part.indexOf(TAB_SENTINEL)
      const left = part.slice(0, idx).trim()
      const right = part.slice(idx + TAB_SENTINEL.length).trim()
      return `<div class="row"><span class="row-left">${left}</span><span class="row-right">${right}</span></div>`
    }).join('')
  })
}

// Strip the leading paragraph block if it's just `**<name>**` followed by an
// optional contact line — the identity header in cvTemplate already renders
// that info, and Google Docs commonly puts the same data at the top. The
// match is intentionally narrow (must be the very first non-empty content)
// to avoid eating real bullets.
function stripLeadingNameBlock(md, name) {
  if (!name) return md
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Match: optional leading blank lines, then **Name**, then 0-N more lines
  // up to the first blank line.
  const re = new RegExp(`^\\s*\\*\\*${escaped}\\*\\*[\\s\\S]*?(?:\\n\\s*\\n|\\n*$)`, '')
  return md.replace(re, '')
}

export function markdownToTemplateHtml(md, options = {}) {
  if (typeof md !== 'string' || md.length === 0) return ''
  let prepped = md
  if (options.stripLeadingName) {
    prepped = stripLeadingNameBlock(prepped, options.stripLeadingName)
  }
  prepped = promoteAllCapsBoldToH2(prepped)
  prepped = encodeTabRows(prepped)
  const html = marked.parse(prepped, { async: false })
  if (typeof html !== 'string') return ''
  return rebuildTabRows(html)
}
