# Markdown-to-Template Converter

**Room ID**: `00-project-room/04-career-system/04-renderer/02-markdown-to-template`  
**Type**: feature  
**Lifecycle**: active ✅  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/04-renderer`  

## Intent

轻量 markdown → 模板正文 HTML 转换器（CV 专用子集）

把 resume markdown 转成适合 CV 模板的 HTML 片段。不用 pandoc 这种全套 markdown 引擎（太重 + 输出 HTML 带默认样式冲突模板）。只支持 CV 里真正用到的子集：# / ## / ### headings、无序列表（项目 bullets）、粗体、斜体、链接、段落。解析完成后输出**纯语义 HTML**（h1/h2/ul/li/strong/em/a/p），没有任何样式类（样式由 01-html-template 的 CSS 模板统一管）。这样 template 和 content 两层解耦：换模板只改 CSS，改内容只改 markdown。提供 markdownToTemplateHtml(md: string) → string 的纯函数，后端和前端都能用（前端 PDF 预览时也走同一条转换路径）。验收：喂一份典型 CV markdown（有 summary 段、experience 段含 bullets、projects 段有多层 heading），产出 HTML 能被 CSS 模板正常渲染，视觉符合预期。

## Milestones (planned 2026-04-28)

**1 milestone 完成**（~130 lines 估算 / 73 lines 实际 — overestimated since marked 干掉很多手写代码）:

- ✅ **m1-markdown-to-template-html** (`TBD`, 73 lines, ROOM COMPLETE) —
  - `package.json` 加 `marked@^16.x`
  - `src/career/lib/markdownToTemplateHtml.mjs` (纯 ESM)
    - `markdownToTemplateHtml(md: string): string` 纯函数
    - `marked` instance + `gfm: false` + tokenizer.html/htmlInline 短路 (XSS-safe)
    - 输出语义 HTML（h1-h6 / p / ul / ol / li / strong / em / a / code / hr / br）— **无 class / id / style**（CSS 由 01-html-template 模板层管）
  - `server.mjs` `POST /api/career/render/markdown` debug endpoint（smoke + dev tool；04-renderer/01 后续直接函数调用不走 HTTP）

**Locked design decisions** (long-term-best, no questions to user):

| Q | Choice | Rationale |
|---|---|---|
| 库 | **`marked`** | ~20KB, no transitive deps, server+browser native, well-maintained |
| HTML in MD | **Disabled at tokenizer level** | Resume 不该有 raw HTML; XSS-safe by construction; 不引入 dompurify/jsdom |
| 文件位置 | **`src/career/lib/markdownToTemplateHtml.mjs`** | 纯 ESM, Vite frontend 和 Node server 共用 (将来前端预览可改用同 transformer 让 print 和 preview 100% 一致) |
| Debug endpoint | **`POST /api/career/render/markdown`** | Smoke + dev tool; 01-html-template 直接函数调用不必走 HTTP |
| Allowed tags | h1-h6 / p / ul / ol / li / strong / em / a / code / hr / br | CV-only subset; 无 table/footnote/blockquote/img |

**输出契约**: 输出**纯语义 HTML**（无 class / id / style）— 模板和内容完全解耦；换模板只改 CSS，改内容只改 markdown。

## Specs in this Room

- [intent-markdown-to-template-001](specs/intent-markdown-to-template-001.yaml) — 轻量 markdown → 模板正文 HTML 转换器（CV 专用子集）
- [change-2026-04-28-m1-markdown-to-template-html](specs/change-2026-04-28-m1-markdown-to-template-html.yaml) — m1 marked-based transformer + debug endpoint (ROOM COMPLETE)

---

_Milestones planned 2026-04-28 via plan-milestones skill._
