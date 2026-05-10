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

## 当前进度 — m1/2 (2026-05-10, 50%)

2 milestones, ~600 LOC + ~130 smoke. **Scope reduced** from original 4-page spec — Shortlist (06-evaluator/05-pipeline-ui m2) + Reports (m3) **already shipped**. This Room only needs Overview + Applied (both currently stubs).

**Heavy reuse of already-shipped infra:**
- `GET /api/career/applications` (?status filter, sorted by timeline.ts desc) — 08/01 m2
- `GET /api/career/shortlist` + `GET /api/career/evaluate/stage-b/results` + `GET /api/career/llm-costs`
- `applications.json` schema (id/company/role/url/score/status/legitimacy/timeline[]/followup?)
- Nivo charts (`@nivo/pie`, `@nivo/bar`, `@nivo/line`) already in deps
- `ScoreBadge` + filter-chip patterns from Shortlist.tsx
- Native `confirm()` mutation pattern from Mode 1 Mark Submitted

**0 open questions.** Chart library, polling cadence, follow-up threshold, and quick-action confirmation pattern all locked from spec + existing patterns.

- ✅ **m1-applied-page-full-rewrite** (~365 + smoke ~205, **5/5 green**) — Applied.tsx full rewrite from 9-line stub. 30s polling of /applications. 7-chip filter strip (All excludes Evaluated). Per-row card: ScoreBadge (strong/worth/consider/na) + role·company + 12-hex id + 8-status pill (color-coded) + horizontal timeline stepper (each event = colored dot with hover tooltip showing formatRelative + event type + from/to + note) + followup highlight (≤3d yellow / past-due red / >3d muted) + Quick actions: [Report] → /career/reports/{jobId-prefix}, [Job] external link, [Advance status] dropdown with VALID_TRANSITIONS[currentStatus] legal-next-only + native confirm() + 400 with allowed_next surfaces inline. VALID_TRANSITIONS hardcoded client-side (mirror of store.mjs; .mjs uses Zod/fs unbundlable into browser). NEW applied.css (~260 lines, `ad-` prefix, zero collisions). Plan-agent review: 0 CRITICAL + 0 HIGH + 0 MEDIUM + 5 minor (all low/acceptable per locked design). 0 fixes required.
- ⏳ **m2-overview-page-and-room-complete** (~330 + smoke ~50) — Overview.tsx full rewrite. 3-parallel-fetch aggregator (/applications + /shortlist + /llm-costs). 4 stat cards (Total / This-week / Active in funnel / Today's spend tinted red if >$5). Nivo pie (8 statuses, color-tiered green/amber/red). Nivo bar (last 7 days, stacked by event type). Next-7-days followup list with highlights. Nivo line (last 14 days cost trend + daily_budget_usd reference line). NEW overview.css with `ov-` prefix. + ROOM COMPLETE rollups: room.yaml planning→active, _tree.yaml synced, 08-human-gate-tracker 25%→50% (2/4), 04-career-system 84%→87%.

### Locked design (single recommended path)

| Decision | Choice |
|----------|--------|
| Chart library | Nivo (already in deps; lighter than ECharts for 3 simple charts) |
| Polling cadence | 30s (matches Shortlist + Pipeline + Applied) |
| Status transition UX | Native `confirm()` per [Advance status] (matches Mode 1 Mark Submitted) |
| Followup threshold | ≤3 days = yellow, past-due = red, >3 days = muted gray |
| Pie slice grouping | 8 status values, NOT alphabetical — semantic tiers (won/active/lost/archive) |
| Bar stack | event type (created vs status_changed) over 7-day window ending today |
| Cost trend reference | daily_budget_usd from prefs (live-read) |

### Deferred (out of scope this Room)

- ECharts heatmap of weekly activity (Nivo bar is sufficient)
- Per-role sankey of state-machine flow (would need more design + may not be high-value vs other Rooms)
- Customizable filter combinations beyond the 7 chips (Shortlist has the full filter UX — Applied is intentionally simpler)

### 下游 contracts

- **`08-human-gate-tracker/03-interview-prep`** — separate Room handling Interview state transition + STAR story prep flow (consumes applications.json Interview rows)
- **`08-human-gate-tracker/04-followup-cadence`** — separate Room with the followup.nextAt setter UI + reminder cron job (this Room only DISPLAYS followup, doesn't SET it)

---

_Generated 2026-04-22 by room-init. Plan refined 2026-05-10 by plan-milestones._
