# HTML Template Renderer

**Room ID**: `00-project-room/04-career-system/04-renderer/01-html-template`  
**Type**: feature  
**Lifecycle**: in_progress  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/04-renderer`  

## Intent

HTML + CSS 模板 + Playwright 渲染 PDF（主 renderer 实现）

career-system 的默认 PDF 渲染器。输入：tailored markdown（或 base.md）+ resume 的 metadata.renderer 配置（template / font / accent_color）。流程：(1) 调 04-renderer/02-markdown-to-template 把 markdown 转成模板正文 HTML；(2) 注入到固定的 CSS 模板（样式层：字体 / 颜色 / 间距 / 分区样式）；(3) Playwright headless 打开 HTML 渲染成 PDF。模板初版按用户的 Google Doc PDF 视觉一比一复刻（~1 小时手工调 CSS）。后端 POST /api/career/cv/render { markdownPath, resumeId } → output/{name}.pdf。支持预览模式（返回 PDF blob 让前端 iframe/object 实时显示）。验收：给一份 tailored markdown 跑 render，产出的 PDF 视觉和 Google Doc 导出接近；支持至少 1 种模板变体（backend / applied-ai 不同 accent color）。

## Milestones (planned 2026-04-28)

**2 milestones 规划完成**（~450 lines 估算，1/2 完成，all defaults 长期最优锁定）:

- ✅ **m1-playwright-html-to-pdf** (TBD, 122 lines 实际) — Playwright 基础设施
  - `playwright@^1.x` (~10MB node_modules + ~300MB chromium browser to `~/.cache/ms-playwright/`)
  - `src/career/lib/htmlToPdf.mjs`: lazy-singleton browser + 30s idle close + `htmlToPdf(html, options)` Promise<Buffer>
  - `server.mjs`: SIGTERM/SIGINT cleanup + `POST /api/career/render/_test-html-to-pdf` smoke endpoint
- **m2-cv-template-render** (~280 lines, ROOM COMPLETE) — CV 模板 + 完整 PDF endpoint
  - `src/career/lib/cvTemplate.mjs`: `composeCvHtml({identity, body_html, options})` + identity-driven header (name+city left / contacts right) + ~120 lines inline CSS (single-column, system-ui, 11pt, accent border)
  - `server.mjs`: `POST /api/career/render/pdf` (reads identity.yml + calls markdownToTemplateHtml + composeCvHtml + htmlToPdf, streams `application/pdf`)

**Locked design decisions** (long-term-best, no questions to user):

| Q | Choice | Rationale |
|---|---|---|
| Browser lifecycle | **Lazy singleton + 30s idle close** | Saves ~1.5s per render; auto-cleanup prevents zombie process |
| PDF response | **Stream `application/pdf` (inline disposition)** | Caller decides save/preview; iframe `src=...` 直接预览; 简单测试 |
| Template style | **Clean modern single-column, system-ui sans-serif** | ATS parser 友好（双列易错切）；离线（不依赖 Google Fonts） |
| Header layout | **Name+location left, contacts right (flex justify-between)** | 节省垂直空间; 标准 tech-resume 惯例 |
| Page format | **US Letter default**, override via body | User 在美国求职; 选项保留 |
| Identity | **Read `identity.yml` automatically** | renderer 无 storage 概念; tailor-engine 无权改 identity |
| Accent color | **Default `#0969da`, configurable** | 长期允许按公司风格切换 |
| API shape | **POST `/api/career/render/pdf` `{ resume_markdown, options? }`** | Stateless re: storage; 调用方传内容 |
| Browser install | **Manual one-time `npx playwright install chromium`** | m1 不自动 install；README 说明 |

**Output contract (与 02-markdown-to-template 的契约)**: 03-cv-engine、07-applier 等下游通过 `POST /api/career/render/pdf` 拿 PDF；不读临时文件，不依赖 disk state。

## Specs in this Room

- [intent-html-template-001](specs/intent-html-template-001.yaml) — HTML + CSS 模板 + Playwright 渲染 PDF（主 renderer 实现）
- [change-2026-04-28-m1-playwright-html-to-pdf](specs/change-2026-04-28-m1-playwright-html-to-pdf.yaml) — m1 Playwright 基础设施 + htmlToPdf() helper + SIGTERM/SIGINT cleanup

---

_Milestones planned 2026-04-28 via plan-milestones skill._
