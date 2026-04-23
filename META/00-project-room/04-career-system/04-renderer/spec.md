# PDF Renderer

**Room ID**: `00-project-room/04-career-system/04-renderer`  
**Type**: sub-epic  
**Lifecycle**: planning  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system`  

## Intent

Markdown → 模板 HTML → Playwright PDF 的渲染管道

2 个 feature（另有 03-renderer-pluggable 推迟到需要多实现时再加）：(1) 02-markdown-to-template — 轻量 markdown → 语义 HTML 转换器（CV 专用子集：heading / list / bold / link / 段落），无样式类；(2) 01-html-template — CSS 模板 + Playwright 渲染 PDF，按用户 Google Doc PDF 视觉一比一复刻。两层解耦：样式层（CSS 模板固定）+ 内容层（markdown 动态注入），换模板只改 CSS。被 03-cv-engine/03-in-ui-editor 和 05-tailor-engine 共同消费产 PDF。初版只支持 html-template 一种实现（未来需要 Google Doc export / typst 时再加 03-renderer-pluggable 抽象）。

## Specs in this Room

- [intent-renderer-001](specs/intent-renderer-001.yaml) — Markdown → 模板 HTML → Playwright PDF 的渲染管道

## Child Rooms

- [HTML Template Renderer](01-html-template/spec.md) — feature, planning
- [Markdown-to-Template Converter](02-markdown-to-template/spec.md) — feature, planning

---

_Generated 2026-04-22 by room-init._
