# Identity (你是谁)

**Room ID**: `00-project-room/04-career-system/02-profile/01-identity`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/02-profile`  

## Intent

identity.yml CRUD + Settings → Identity 页（填表用的稳定身份信息）

提供 Applier 填表 / CV Renderer 产 PDF 头的稳定身份数据源：姓名 / 邮箱 / 电话 / LinkedIn / GitHub / portfolio(个人网站 URL) / 当前地点 / visa 状态 (F-1 OPT / needs_sponsorship) / 学历（Columbia MS + Michigan BS）/ 语言。一年才改几次，但是所有下游读它。server.mjs 加 GET/PUT /api/career/identity；前端 Settings → Identity 页用 CodeMirror 编辑 YAML 或结构化表单（推荐表单，带字段校验）。identity.yml 必须 gitignored。验收：UI 改完保存 → 文件更新 → 重启后加载正确；Applier 读到正确值。

## Specs in this Room

- [intent-identity-001](specs/intent-identity-001.yaml) — identity.yml CRUD + Settings → Identity 页（填表用的稳定身份信息）
- [change-2026-04-23-m1-identity-backend](specs/change-2026-04-23-m1-identity-backend.yaml) — m1 backend API

## Milestones

Planned by plan-milestones skill on 2026-04-23 (Sprint 2 — Profile, ~360 行, 2 milestones):

- ✅ **m1-identity-backend** — Backend GET/PUT + zod schema + yaml IO (实际 90 行)
- ⬜ **m2-identity-form-ui** — ATS 风格结构化表单 + 6 sections (~280 行)

Decisions locked (from plan-milestones interactive):
- Q1: 结构化表单 (不是 CodeMirror YAML) + **模仿真实 ATS application form 样式**
- Q2: Education/Languages 加减行 widget
- Q3: 显式 Save 按钮
- Q4: **全部字段必填**（除 education.gpa 可选）— Applier 需要完整 identity 才能填表

**ATS 风格设计要点**: Label 在字段上方 + `*` 标必填 / 灰边白底 focus 蓝边 / 错误红边 + 行内 error / sticky bottom submit bar / disabled until all valid。

CSS 文件 `ats-form.css` 后续 Preferences / QA Bank / Narrative 等 settings 子页复用。

Status: milestones planned, dev not started. See [progress.yaml](progress.yaml) for details.

---

_Generated 2026-04-22 by room-init._
