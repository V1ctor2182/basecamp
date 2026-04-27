# Narrative & Proof

**Room ID**: `00-project-room/04-career-system/02-profile/03-narrative-proof`  
**Type**: feature  
**Lifecycle**: in_progress  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/02-profile`  

## Intent

narrative.md + proof-points.md 的 CodeMirror 编辑器 + Settings 页

两份 markdown 文件的用户级编辑界面：(1) narrative.md — 原型 / 超能力 / 职业 north star / 个性表达偏好（Applier 起草开放题时读它学风格、Evaluator Stage B 深评时读它判断 north-star alignment）；(2) proof-points.md — 具体项目指标 / 文章 / 开源贡献的详细版（Evaluator 防止幻觉时可以反查，CV Tailor 生成简历时可引用）。前端复用 KB 的 markdown viewer/editor 组件（已有）。两份都 commit 进 git（偏好/方法论类知识，不含个人敏感）。验收：UI 改完保存 → 文件更新 → Evaluator Stage B 能读到新内容；narrative 变了下次 apply 开放题起草风格随之变。

## Specs in this Room

- [intent-narrative-proof-001](specs/intent-narrative-proof-001.yaml) — narrative.md + proof-points.md 的 CodeMirror 编辑器 + Settings 页
- [change-2026-04-27-m1-narrative-proof-backend](specs/change-2026-04-27-m1-narrative-proof-backend.yaml) — m1 backend 4 endpoints + atomic write + skeleton templates
- [change-2026-04-25-m2-narrative-editor-split-pane](specs/change-2026-04-25-m2-narrative-editor-split-pane.yaml) — m2 Narrative.tsx CodeMirror + ReactMarkdown split-pane

## 当前进度

2/3 完成。Pattern: "先一份能跑 (m2) 后抽象 (m3)"。

- **m1** ✅ Backend GET/PUT for narrative.md + proof-points.md + 骨架模板（110 行 / 1 file）
- **m2** ✅ Narrative.tsx CodeMirror + ReactMarkdown split-pane（204 行 / 2 files: Narrative.tsx + ats-form.css 追加 split-pane styles）
- **m3** — 抽 MarkdownDocEditor 共享组件 + 接入 ProofPoints 路由（pending → ROOM COMPLETE）

**下游契约**：骨架 H2 section 名（`## North Star` / `## Shipped Projects` 等）是 Evaluator Stage B 和 CV Tailor 抽取段落的锚点 — 改 section 名前要看下游消费者。

---

_Generated 2026-04-22 by room-init. Milestones planned 2026-04-27 by plan-milestones._
