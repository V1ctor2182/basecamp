# Iteration Dashboard

**Room ID**: `00-project-room/04-career-system/07-applier/self-iteration/03-iteration-dashboard`
**Type**: feature
**Lifecycle**: in_dev (milestones locked 2026-05-18, 3 spec overrides)
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

## Open Questions (LOCKED 2026-05-18)

| ID | 问题 | 决定 |
|----|------|------|
| Q1 | Dashboard 是否需 [Run Tuner] 按钮？ | **NO** — 只 link 到 `npm run tune:snapshot` (D4) |
| Q2 | 事件流 backing store? | **OVERRIDE spec recommendation** — real-time aggregate over existing JSONL stores (feedback/*.jsonl + eval-fixtures/tuner-log.json + qa-bank/history.jsonl + apply-sessions). NO new events.jsonl. Avoids modifying frozen 01+02 code to emit events; <500 records total → perf fine. |
| Q3 | Pending action 点击跳哪？ | **HYBRID** — Promote → in-page modal (local op); PR review → GitHub external |
| **m1-OQ** | Promote 怎么从 site-failure → 新 fixture? | **STUB ONLY** — Promote writes `{vendor-slug}.truth.yml` with url + reason metadata; operator runs `capture-fixture.mjs --url ...` manually to fill HTML. snapshot_excerpt is schema-capped at 400 chars, insufficient for full fixture. |
| **m3-OQ** | Tier 2/3 backlog 内容? | **PLACEHOLDER V1** — display `Tier 2 (0)` / `Tier 3 (0)` with tooltip "pattern clustering not in scope; future room". **Acceptance (c) DESCOPED.** |

## Specs in this Room

- [intent-iteration-dashboard-001](specs/intent-iteration-dashboard-001.yaml) — `/career/iteration` UI 顶层 intent

## Estimated scope

~400 LOC React (Iteration.tsx + iteration.css + 4 component) + ~120 LOC server.mjs (5 个新 endpoint) + ~100 LOC smoke. ~3 milestones.

## 验收 (status after plan-milestones)

- (a) ✅ achievable — health/events/pending all backed by existing stores; 10 applies → real numbers
- (b) ✅ achievable (with override) — Promote modal writes truth.yml stub; operator runs capture-fixture.mjs manually to fill HTML; then `npm run tune:snapshot` for PR
- (c) ⚠️ **DESCOPED** — Tier 2/3 placeholder only. Pattern-clustering left for a future room (e.g. `04-iteration-improver` if/when needed)
- (d) ✅ — D2 30s + AbortController
- (e) ✅ — D1 STATUS_COLORS reused, no new palette

## Milestones (LOCKED 2026-05-18)

| m | Content | LOC (corrected) |
|---|---------|-----|
| m1 | Event aggregator (`src/career/iteration/eventStream.mjs`) + 5 REST endpoints (`/health`, `/events`, `/pending`, `/coverage`, `POST /promote/:id`) + contract smoke | ~250 server + ~150 smoke |
| m2 | `Iteration.tsx` page (route + nav) + Health header + Event stream (paginated 30/page) + Pending Actions queue + iteration.css + 30s polling | ~280 React + 80 css + 80 smoke |
| m3 | Promote modal (review-truth.yml gate) + Coverage detail collapsible + UI smoke + ROOM COMPLETE | ~150 React + 50 smoke |

Total: ~1040 LOC. Spec ~620 under-counted by 1.7× for the 5-store event normalization (feedback/site-failures + field-edits + field-misclassified + suggested/* + eval-fixtures/tuner-log + apply-sessions/*) and multi-step promote flow.

Reuses [Learning.tsx](../../../../src/career/Learning.tsx) (483 LOC, shipped in 02-data-flywheel m4) visual tokens; Iteration is a sibling page (different audience: observability vs debug).

---

_Generated 2026-05-11 — UX layer of self-iteration sub-epic._
