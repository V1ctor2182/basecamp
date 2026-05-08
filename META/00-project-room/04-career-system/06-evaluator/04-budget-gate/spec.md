# Budget Gate

**Room ID**: `00-project-room/04-career-system/06-evaluator/04-budget-gate`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/06-evaluator`  

## Intent

daily_budget_usd + 实时成本条 + 超预算自动暂停 Stage B

消费 01-foundation/03-llm-cost-observability 的 cost log API 实现 budget 策略 + UI 展示。读 preferences.yml.evaluator_strategy.stage_b.daily_budget_usd（默认 $10）；每次 Stage B 调用前查今日累计成本，超过预算就暂停 Stage B（不动 Stage A，Haiku 本就便宜）+ Banner 提示 "今日 Sonnet 预算用尽，明天继续或去 Settings 提高上限"。Dashboard 顶部持续显示：`Today: Stage A × 47 ($0.47) | Stage B × 8 ($1.60) | Total: $2.07 / $10 budget`。后端 GET /api/career/evaluate/budget 返回今日聚合；前端 banner 以 30s polling 刷新。用户可通过 Settings 动态调 daily_budget_usd 立即生效。超预算暂停期间，用户仍可 "Force Sonnet" override 单个岗位（算会计入预算）。验收：模拟一天成本累计达阈值，下次 Stage B 调用被拒 + banner 出现；调高预算后恢复。

## Constraints

超预算只暂停 Stage B，不暂停 Stage A；banner 显式提示不静默

(1) daily_budget_usd 达到时 MUST 暂停 Stage B（贵的 Sonnet），但 Stage A (Haiku, ~$0.01/个) 继续可用 — Haiku 太便宜没必要限；(2) 超预算时 MUST 弹 Banner 提示"今日 Sonnet 预算 $10 用尽，明天继续或去 Settings 提高上限"，绝不能静默返回 error 让用户摸不着头脑；(3) 用户的 Force Sonnet override MUST 照算进今日成本（不给白嫖通道），但允许执行；(4) 跨日重置 MUST 按用户本地时区的 00:00（不是 UTC），避免用户在晚上 11 点以为还能跑但因为 UTC 换日导致预算早已重置超支。

## Specs in this Room

- [intent-budget-gate-001](specs/intent-budget-gate-001.yaml) — daily_budget_usd + 实时成本条 + 超预算自动暂停 Stage B
- [constraint-budget-gate-001](specs/constraint-budget-gate-001.yaml) — 超预算只暂停 Stage B，不暂停 Stage A；banner 显式提示不静默

## 当前进度 — 🎉 ROOM COMPLETE (2026-05-08, 3/3, 100%)

3 milestones, ~580 LOC source + ~550 smoke. **Reuses existing cost-log infrastructure** ([server.mjs:1140-1242](server.mjs#L1140-L1242) — `appendCostRecord` / `readCostRecords` / `aggregateCosts` / GET `/api/career/llm-costs` already shipped, including local-timezone day-start handling per constraint #4). All 9 OQs locked at recommended values. Closing this Room takes **06-evaluator 40% → 60%** (3/5 ROOMs ✅).

- ✅ **m1-schema-and-budget-endpoint** (server.mjs +75 + Preferences.tsx type sync + smoke ~290, **11/11 green**) — `daily_budget_usd: z.number().nonnegative().default(10)` added to `PreferencesSchema.evaluator_strategy.stage_b`. GET `/api/career/evaluate/budget` returns `{today_total_usd, daily_budget_usd, paused, warning, by_caller, day_start}` — pure projection over the existing `readCostRecords` + `aggregateCosts` helpers from 01-foundation/03-llm-cost-observability. Local-tz day-start (constraint #4 ✓). Plan-agent review: 0 CRITICAL + 0 HIGH actionable; 19 probes all non-issue.
- ✅ **m2-pre-call-gate** (server.mjs +75 + smoke ~360, **12/12 green**) — `checkBudgetGate()` helper + `force: z.boolean().optional()` on EvaluateStageBBodySchema + TailorRequestSchema + pre-call gate at POST `/evaluate/stage-b` and POST `/cv/tailor`. Gate inserted AFTER body parse (so 400 zod errors take precedence) + BEFORE pipeline.json read (no I/O waste when paused). 402 response shape `{error, banner_message, today_total_usd, daily_budget_usd}` is the UI banner contract. `body.force === true` bypasses; cost STILL records via existing runner (constraint #3). Stage A endpoint UNCHANGED (constraint #1). Plan-agent review: 0 CRITICAL + 0 HIGH actionable; 16 probes all verified including mutex-release on 402 path, $0-budget edge, jobIds-path interaction, 402 vs 412 ordering.
- ✅ **m3-ui-banner-and-room-complete** (BudgetBanner ~210 + css ~80 + Preferences input + Pipeline mount + smoke ~250, **6/6 green**) — `<BudgetBanner />` polls `/api/career/evaluate/budget` every 30s with AbortController; renders paused/warning/normal state derived from response. role=status + aria-live=polite. Lazy-init dismissedState (eliminates 1-frame flash). sessionStorage ops wrapped in try/catch (Safari private mode safe). Stale-data indicator when error && data. **Paused state is NOT dismissible** (constraint #2: hard block must surface — review fix CRITICAL). Warning is dismissible per-session. Preferences gets `daily_budget_usd` numeric input. Pipeline.tsx mounts banner above SchedulerPanel. Plan-agent review applied 1 CRITICAL + 4 HIGH; 6 deferred MEDIUM cosmetic.

### Locked design (long-term-best, all defaults)

| Decision | Choice |
|----------|--------|
| Default budget | $10/day per spec (~30 Sonnet calls) |
| Warning threshold | 80% (yellow at $8 of $10) |
| Budget covers | Total daily cost (incl. Haiku); gate predicate is `total >= budget` |
| Gated endpoints | `/evaluate/stage-b` AND `/cv/tailor` (both Sonnet); Stage A always open |
| Force override | `body.force === true` bypasses gate; cost STILL recorded (constraint #3) |
| HTTP status | 402 Payment Required (semantic clarity) |
| Banner mount | Pipeline tab top (not App-wide; matches user's mental model) |
| Banner dismiss | sessionStorage per-state; re-emerges on state transition / hard refresh |
| Force-Sonnet UI button | Deferred to 05-pipeline-ui Room (this Room ships only backend `force` flag) |

### 下游 contracts

- **`05-pipeline-ui`**: wires the per-row Force-Sonnet button using the backend `force` flag this Room ships
- **`03-block-toggles`**: may extend Preferences UI with per-block cost preview / disable-on-budget hints
- **Tailor / Stage B**: now budget-aware; banner is the canonical user surface for "why is X paused"

---

_Generated 2026-04-22 by room-init._
