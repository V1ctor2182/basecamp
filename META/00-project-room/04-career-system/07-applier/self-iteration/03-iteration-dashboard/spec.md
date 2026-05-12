# Iteration Dashboard

**Room ID**: `00-project-room/04-career-system/07-applier/self-iteration/03-iteration-dashboard`
**Type**: feature
**Lifecycle**: planning
**Owner**: fullstack
**Parent**: `00-project-room/04-career-system/07-applier/self-iteration`

## Intent

`/career/iteration` UI — 把 01 + 02 闭环可视化 + manual touchpoint 操作面板

Self-iteration sub-epic 的 UX 层。让"applier 正在进化"可观察：(a) 系统背后自动做了什么 (cache hit / 权重调整 / heuristic 学习 / evidence 捕获)；(b) 系统等用户做什么 (promote evidence / review tuner PR / Tier 2-3 设计)。新页面 `/career/iteration`。5 个 UI 区: A. Health 顶栏 (apply 数 / success rate / 01 cover / 02 cache hit / pending counts)；B. **进化事件流** (反时序，事件类型 🟢 qa-bank 学新答案 / 🟡 cache 命中 reinforce / 🔴 evidence 捕获 / 🟣 tuner run / 🟤 fixture 加入)；C. Pending Actions 队列 (🔴 promote / 🟠 PR review / ⚪ Tier 2 设计 / ⚫ Tier 3)；D. 覆盖率详情 (fixture corpus per-fixture table + qa-bank by-category)；E. Trend charts (V2 可选)。后端新增 5 个 API endpoint 聚合 evidence store + qa-bank changelog + tuner log。复用 STATUS_COLORS / 30s polling / formatRelative 跟现有 dashboard 对齐。

## Constraints

- **D1 [MUST]** 复用现有调色板，不引入新颜色
- **D2 [MUST]** Polling 30s 跟 Applied/Overview 对齐 + AbortController cleanup
- **D3 [MUST]** Promote 必须弹窗 review truth.yml 后执行 (不能一键跳过)
- **D4 [MUST]** Dashboard 不直接触发 tuner run (避免 IPC race)；[Run Tuner] 只 link 到命令
- **D5 [MUST]** Render path 0 LLM call (AI summary 走后台 cron 预算定时刷新)

## Open Questions

| ID | 问题 | 推荐 |
|----|------|------|
| Q1 | Dashboard 是否需 [Run Tuner] 按钮？ | 否 — 只 link 命令 (D4) |
| Q2 | 事件流 backing store? | JSONL append-only (matches llm-costs.jsonl) |
| Q3 | Pending action 点击跳哪？ | 混合: Promote 内 modal / PR review 跳 GitHub |

## Specs in this Room

- [intent-iteration-dashboard-001](specs/intent-iteration-dashboard-001.yaml) — `/career/iteration` UI 顶层 intent

## Estimated scope

~400 LOC React (Iteration.tsx + iteration.css + 4 component) + ~120 LOC server.mjs (5 个新 endpoint) + ~100 LOC smoke. ~3 milestones.

## 验收

- (a) 10 次 apply 后页面渲染: 顶栏数字正确 / 事件流 ≥ 20 条 / pending queue 真实数
- (b) 完整 manual promote 流程跑通: 点 Promote → 弹窗 review → confirm → fixture 进 corpus → tuner PR notification
- (c) Tier 2 pattern 至少捕获 1 类并显示 (eg "iframe nesting")
- (d) 30s polling 不跟 Applied/Overview 冲突
- (e) 0 新调色板 / 复用 STATUS_COLORS

---

_Generated 2026-05-11 — UX layer of self-iteration sub-epic._
