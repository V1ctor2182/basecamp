# Career Dashboard Views

**Room ID**: `00-project-room/04-career-system/08-human-gate-tracker/02-career-dashboard-views`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: frontend  
**Parent**: `00-project-room/04-career-system/08-human-gate-tracker`  

## Intent

Overview / Shortlist / Applied / Reports 各核心页面 UI

career-system 的主要用户入口页面（不含 Settings 子页，那些归各 profile/cv-engine feature）。(1) /career/overview — 总览仪表盘：总申请数 / 按状态分布饼图 / 本周活跃柱状图 / 下次 follow-up 列表 / 成本趋势（ECharts 复用）；(2) /career/shortlist — 已评估 score ≥ 4.0 的岗位（来自 06-evaluator/05-pipeline-ui）；(3) /career/applied — 已 Mark submitted 的岗位 + 时间线可视化（每条 timeline.event 一个节点）+ follow-up 提醒高亮（< 3 天内的标黄）；(4) /career/reports/:id — 单个报告 markdown 渲染（复用 LearnApp 的 markdown viewer），支持左侧 Block A-G 目录导航 + 右侧正文；配套 actions：Tailor CV / Start Apply / Re-evaluate。复用现有组件：LearnApp markdown viewer、TrackerApp 时间线样式、ECharts 图表库。验收：Overview 能从 applications.json 聚合出数字和图；Shortlist 按分数倒序显示 10 条；Applied 点进去能看到完整 timeline；Reports 单页渲染 Block A-G 清晰。

## Specs in this Room

- [intent-career-dashboard-views-001](specs/intent-career-dashboard-views-001.yaml) — Overview / Shortlist / Applied / Reports 各核心页面 UI

---

_Generated 2026-04-22 by room-init._
