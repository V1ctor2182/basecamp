# HTML Template Renderer

**Room ID**: `00-project-room/04-career-system/04-renderer/01-html-template`  
**Type**: feature  
**Lifecycle**: active ✅  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/04-renderer`  

## Intent

HTML + CSS 模板 + Playwright 渲染 PDF（主 renderer 实现）

career-system 的默认 PDF 渲染器。Pipeline: 调 `markdownToTemplateHtml()` 把 markdown 转成正文 HTML → `composeCvHtml()` 注入到 inline CSS 模板 + identity 头部 → Playwright headless 渲染成 PDF。模板单列 ATS-friendly，system-ui 字体（无 Google Fonts 依赖）。

## Implementation Summary

**2 milestones 完成**（2026-04-28）— ~353 lines net + 真实 PDF 输出已可用:

- ✅ **m1-playwright-html-to-pdf** (`289cc52`, 122 lines) — Playwright 基础设施: lazy singleton browser + 30s idle close + `htmlToPdf(html, options)` Promise<Buffer> + SIGTERM/SIGINT cleanup + `_test-html-to-pdf` smoke endpoint
- ✅ **m2-cv-template-render** (TBD, 231 lines, ROOM COMPLETE) — `cvTemplate.mjs` (`composeCvHtml` + identity-driven header + ~120 行 inline CSS) + `POST /api/career/render/pdf` (markdown → identity header → CV HTML → PDF stream)

## Backend API

### `POST /api/career/render/pdf`
**Body**: `{ resume_markdown: string, options?: { format?, margin?, accent_color? } }`
- `resume_markdown` — required string, ≤500KB (256KB express cap on `/api/career/*` is real first-line)
- `options.format` — `'Letter'` (default) | `'A4'`
- `options.margin` — `{top, right, bottom, left}` (default `'0.5in'` all sides)
- `options.accent_color` — hex string (default `'#0969da'`)

**Behavior**: reads `identity.yml` automatically → composes header (name+city left / contacts right) → embeds inline CSS → `markdownToTemplateHtml(resume_markdown)` body → `htmlToPdf(html)` → streams `application/pdf` (Content-Disposition: inline so iframe `src=` 直接预览).

**Errors**: 400 typeof / 413 too big / 503 browser launch fail.

### `POST /api/career/render/_test-html-to-pdf` (dev tool)
Smoke endpoint for low-level Playwright pipeline debugging. Body `{ html, format?, margin? }`. Caller passes ready-made HTML; renderer returns PDF.

## Frontend integration (downstream)

- `03-cv-engine/03-in-ui-editor` — iframe `src=POST /api/career/render/pdf` (debounced re-render on edit)
- `03-cv-engine/05-tailor-engine` — fetch render-pdf 给用户预览 tailored 版本
- `07-applier` — 上传 PDF 到 ATS portal 直接读这个 endpoint

## CSS Template (locked design)

| Style | Choice | Rationale |
|---|---|---|
| Layout | **Single-column** | ATS parser 友好（双列易被错切 reading order） |
| Font | **system-ui sans-serif** | 离线可用；无 Google Fonts CDN 依赖 |
| Body size | **11pt / line-height 1.5** | ~600 词每页 Letter |
| Name | **22pt 600 weight** | 视觉锚点 |
| h2 | **13pt accent color + bottom border + page-break-after: avoid** | section 标题不和后续内容分页 |
| Color | **`-webkit-print-color-adjust: exact`** | accent border 不被 print-optimization 去掉 |
| Accent | **`#0969da` default, configurable** | 后续按公司风格切 |
| Page | **Letter @0.5in margin** | US 求职默认；可 override |

## Locked Design Decisions (long-term-best, plan-milestones)

| Q | Choice | Rationale |
|---|---|---|
| Browser lifecycle | **Lazy singleton + 30s idle close** | ~50ms reuse vs ~1.5s relaunch; auto-cleanup prevents zombies |
| PDF response | **Stream `application/pdf` (inline disposition)** | iframe preview 直接显示; caller decides save |
| Identity source | **Read `identity.yml` automatically** | renderer 无 storage 概念；tailor-engine 不该 override identity |
| API shape | **POST `/api/career/render/pdf` `{ resume_markdown, options? }`** | Stateless re: storage; works pre-multi-resume |
| Header escape | **Always `escapeHtml`** | Defensive even though identity is user-authored |
| h2 page-break | **`avoid` on both legacy + modern attr** | Section 不和内容分页 |
| Browser install | **Manual `npx playwright install chromium` (one-time)** | 不在 npm install 自动跑 (Playwright 设计如此) |

## Specs in this Room

- [intent-html-template-001](specs/intent-html-template-001.yaml) — HTML + CSS 模板 + Playwright 渲染 PDF（主 renderer 实现）
- [change-2026-04-28-m1-playwright-html-to-pdf](specs/change-2026-04-28-m1-playwright-html-to-pdf.yaml) — m1 Playwright 基础设施
- [change-2026-04-28-m2-cv-template-render](specs/change-2026-04-28-m2-cv-template-render.yaml) — m2 CV template + render-pdf endpoint (ROOM COMPLETE)

## Sprint 3 — Renderer DONE 🎉

`04-renderer` sub-epic 2/2 features ✅:
- ✅ 02-markdown-to-template (single-milestone, transformer)
- ✅ 01-html-template (this ROOM, 2 milestones, full PDF pipeline)

下一个 Sprint 3 子任务: `03-cv-engine` (5 features — multi-resume management, Google Docs sync, in-UI editor, auto-select, tailor-engine).

---

_Completed 2026-04-28 via dev skill (2 milestones × plan-milestones)._
