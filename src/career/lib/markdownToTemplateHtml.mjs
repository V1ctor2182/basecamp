// Markdown → CV template body HTML transformer.
//
// Pure ESM module: server.mjs (Playwright PDF pipeline) and the Vite frontend
// both import from here. Shared so print and preview can stay 1:1 if/when the
// frontend swaps from react-markdown.
//
// Output contract: clean semantic HTML (h1-h6 / p / ul / ol / li / strong /
// em / a / code / hr / br). No class, id, or inline style — those belong to
// the CSS template layer (04-renderer/01-html-template).
//
// XSS posture: raw HTML inside markdown is dropped at tokenizer level. The
// resume.md is user-authored content with no need for HTML passthrough; this
// avoids pulling jsdom + dompurify just to sanitize after-the-fact.

import { Marked } from 'marked'

// One Marked instance, configured once at module load. `gfm: false` turns off
// tables, task lists, autolinks, strikethrough — none used by CVs and they
// add output we'd have to strip anyway.
const marked = new Marked({
  gfm: false,
  breaks: false,
  pedantic: false,
})

// Renderer-level drop of raw HTML tokens (both block and inline). Resume
// markdown is plain text + a small subset of markdown — there is no use case
// for embedded HTML, and dropping it avoids pulling jsdom + dompurify just
// to sanitize after-the-fact. <script>alert()</script> in source becomes "".
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
]

export function markdownToTemplateHtml(md) {
  if (typeof md !== 'string' || md.length === 0) return ''
  const html = marked.parse(md, { async: false })
  return typeof html === 'string' ? html : ''
}
