# Narrative & Proof

**Room ID**: `00-project-room/04-career-system/02-profile/03-narrative-proof`  
**Type**: feature  
**Lifecycle**: active ✅  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/02-profile`  

## Intent

`narrative.md` + `proof-points.md` 的 CodeMirror 编辑器 + Settings 页

两份 markdown 文件的用户级编辑界面：
- **narrative.md** — 原型 / 超能力 / 职业 north star / 个性表达偏好（Applier 起草开放题学风格、Evaluator Stage B 判断 north-star alignment）
- **proof-points.md** — 项目指标 / 文章 / 开源贡献的详细版（Evaluator 防幻觉反查、CV Tailor 生成简历时引用）

两份都 commit 进 git（偏好 / 方法论类知识，不含个人敏感）。

## Implementation Summary

**3 milestones 完成**（2026-04-25）— ~454 lines net + 共享 `MarkdownDocEditor` 组件:

- ✅ **m1-narrative-proof-backend** (`76503d4`, 110 lines) — server.mjs 4 endpoints (GET/PUT for both files) + atomicWriteFile (复用) + skeleton templates
- ✅ **m2-narrative-editor-split-pane** (`2ca61fb`, 204 lines) — Narrative.tsx CodeMirror + ReactMarkdown split-pane + ats-form.css 追加 split-pane styles
- ✅ **m3-shared-doc-editor** (`TBD`, 140 lines, ROOM COMPLETE) — 抽出 `MarkdownDocEditor` 共享组件 + ProofPoints.tsx 接入 + sidebar/route 配线

## Backend API

- `GET /api/career/narrative` → `{ content }` (文件不存在返带 H2 骨架的模板)
- `PUT /api/career/narrative` → body `{ content: string }` (校验 typeof string，长度 < 500KB)
- `GET /api/career/proof-points` → 同上
- `PUT /api/career/proof-points` → 同上

文件写入用 `atomicWriteFile`（tempfile + rename）— 复用 server.mjs 顶部的共享 helper（C1 hardening 引入）。

## Skeleton Templates (软契约)

首次 GET 不存在时返带 H2 骨架的模板。**H2 段名是和下游模块的软契约**，删段名前要看下游消费者：

- **narrative.md**: `## Origin` / `## Superpowers` / `## North Star` / `## Voice & Style`
- **proof-points.md**: `## Shipped Projects` / `## Writing` / `## Open Source` / `## Quantified Wins`

## Frontend UI

**`/career/settings/narrative`** + **`/career/settings/proof-points`** — 共享 `MarkdownDocEditor` 组件（`src/career/MarkdownDocEditor.tsx`）：

- Props: `{ apiPath, title, subtitle, saveLabel }`
- 左 CodeMirror 编辑（`@uiw/react-codemirror` + `@codemirror/lang-markdown`）+ 右 ReactMarkdown 实时预览
- Sticky save bar (复用 ats-form.css `.af-submit-bar`) — status 左 + Save button 右
- `beforeunload` 拦截未保存离开
- `useEffect(apiPath)` 重置 state — 路由切换时各自独立 dirty 状态

CSS 追加到 `ats-form.css`（m2 引入）：`.narrative-form` / `.narrative-split` / `.narrative-editor-pane` / `.narrative-preview-pane` + markdown typography (h1-3 / p / li / code / pre / blockquote / a) + `@media (max-width: 900px)` 单列 fallback。

## Specs in this Room

- [intent-narrative-proof-001](specs/intent-narrative-proof-001.yaml) — narrative.md + proof-points.md 编辑器 + Settings 页
- [change-2026-04-27-m1-narrative-proof-backend](specs/change-2026-04-27-m1-narrative-proof-backend.yaml) — m1 backend 4 endpoints + 骨架模板
- [change-2026-04-25-m2-narrative-editor-split-pane](specs/change-2026-04-25-m2-narrative-editor-split-pane.yaml) — m2 Narrative.tsx CodeMirror + ReactMarkdown split-pane
- [change-2026-04-25-m3-shared-doc-editor](specs/change-2026-04-25-m3-shared-doc-editor.yaml) — m3 抽 MarkdownDocEditor + ProofPoints (ROOM COMPLETE)

## Downstream Callers

- `06-evaluator/02-stage-b-sonnet` → 读 narrative.md `## North Star` 段 + proof-points.md 全文（防幻觉反查）
- `03-cv-engine/05-tailor-engine` → 读 proof-points.md `## Shipped Projects` + `## Quantified Wins` 段做改写参考
- `07-applier/01-mode1-simplify-hybrid` → 起草开放题时读 narrative.md `## Voice & Style` 学风格
- 未来其他 Settings 子页（QA Bank templates / Resume editor 等）有 markdown 全文编辑需求时复用 `MarkdownDocEditor`

---

_Completed 2026-04-25 via dev skill (3 milestones × plan-milestones)._
