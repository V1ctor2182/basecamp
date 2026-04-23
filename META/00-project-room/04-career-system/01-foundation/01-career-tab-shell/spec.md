# Career Tab Shell

**Room ID**: `00-project-room/04-career-system/01-foundation/01-career-tab-shell`  
**Type**: feature  
**Lifecycle**: active ✅  
**Owner**: frontend  
**Parent**: `00-project-room/04-career-system/01-foundation`  

## Intent

learn-dashboard 新增 /career tab 壳 + 子路由骨架

在现有 React app 里加一个 "Career" tab 作为 04-career-system 所有 feature 的 UI 入口。用 BrowserRouter 嵌套子路由（/career/overview、/pipeline、/shortlist、/reports/:id、/applied、/prep/:company、/settings/{identity,preferences,portals,qa-bank,narrative,resumes}）。本 feature 只负责壳和导航，不含业务逻辑。

## Implementation Summary

**4 milestones, 690 行代码, 24 files created/modified**（2026-04-23 完成）:

- ✅ **m1-careerapp-shell** (`6f8de29`) — CareerApp shell + /career 路由注册 + 顶部 header (130 行)
- ✅ **m2-top-level-tabs** (`2304730`) — 6 顶级子路由 + Tab 导航 + 7 占位页 (220 行)
- ✅ **m3-settings-nested** (`81b75e9`) — Settings 嵌套子路由 + 左侧 sidebar + 6 子页占位 (160 行)
- ✅ **m4-entry-point-and-polish** (`cc07cf0` + 新 m4 commit) — LearnApp 入口 + localStorage 持久化 + 响应式 (75 行)

## Current State

**URL 空间全部就位**（13 routes）：

```
/career                      → redirect 到 localStorage 里的 lastCareerTab (fallback overview)
/career/overview             → Overview 占位
/career/pipeline             → Pipeline 占位
/career/shortlist            → Shortlist 占位
/career/applied              → Applied 占位
/career/prep                 → Prep empty state
/career/prep/:company        → Prep 带参数
/career/reports              → Reports empty state
/career/reports/:id          → Reports 带参数
/career/settings             → redirect /identity
/career/settings/identity    → Identity 占位
/career/settings/preferences → Preferences 占位
/career/settings/portals     → Portals 占位
/career/settings/qa-bank     → QABank 占位
/career/settings/narrative   → Narrative 占位
/career/settings/resumes     → Resumes 占位
/career/settings/*           → fallback /identity
/career/*                    → fallback /overview
```

**入口**：LearnApp 左侧 sidebar 在 "Work Tracker" 下方有 "Career" 链接（Briefcase icon）。

**响应式**：< 768px Settings sidebar 折叠为横向 pill bar。

## Specs in this Room

- [intent-career-tab-shell-001](specs/intent-career-tab-shell-001.yaml) — learn-dashboard 新增 /career tab 壳 + 子路由骨架

## Next Steps

本 feature 完成后，下游 feature 可开始 populate 占位页内容：

- `02-profile/01-identity` → Settings/Identity 页内容
- `02-profile/02-preferences` → Settings/Preferences 页内容
- `02-profile/03-narrative-proof` → Settings/Narrative 页内容
- `02-profile/04-qa-bank` → Settings/QABank 页内容
- `03-cv-engine/01-resume-index` → Settings/Resumes 页内容
- `05-finder/01-source-adapters` → Settings/Portals 页内容
- `06-evaluator/05-pipeline-ui` → /pipeline + /shortlist 页内容
- `08-human-gate-tracker/02-career-dashboard-views` → /overview + /applied + /reports 页内容
- `08-human-gate-tracker/03-interview-prep` → /prep/:company 页内容

---

_Completed 2026-04-23 via dev skill (4 milestones × plan-milestones)._
