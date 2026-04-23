# Career Tab Shell

**Room ID**: `00-project-room/04-career-system/01-foundation/01-career-tab-shell`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: frontend  
**Parent**: `00-project-room/04-career-system/01-foundation`  

## Intent

learn-dashboard 新增 /career tab 壳 + 子路由骨架

在现有 React app 里加一个 "Career" tab 作为 04-career-system 所有 feature 的 UI 入口。用 BrowserRouter 嵌套子路由（/career/overview、/pipeline、/shortlist、/reports/:id、/applied、/prep/:company、/settings/{identity,preferences,portals,qa-bank,narrative,resumes}）。本 feature 只负责壳和导航，不含业务逻辑。

## Specs in this Room

- [intent-career-tab-shell-001](specs/intent-career-tab-shell-001.yaml) — learn-dashboard 新增 /career tab 壳 + 子路由骨架

## Milestones

Planned by plan-milestones skill on 2026-04-23 (Sprint 1 — Foundation, ~350 行, 4 milestones):

- ✅ **m1-careerapp-shell** — CareerApp shell + /career 路由注册 + 顶部 header (实际 130 行, 3 files)
- ✅ **m2-top-level-tabs** — 6 顶级子路由 + Tab 导航 + 7 占位 (实际 220 行, 9 files)
- ✅ **m3-settings-nested** — Settings 嵌套子路由 + 左侧 sidebar + 6 子页占位 (实际 160 行, 9 files)
- ⬜ **m4-entry-point-and-polish** — LearnApp 入口 + 导航状态持久化 + 响应式 polish (~50 行)

Status: 3/4 milestones completed. See [progress.yaml](progress.yaml) for details.

---

_Generated 2026-04-22 by room-init._
