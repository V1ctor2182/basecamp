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

---

_Generated 2026-04-22 by room-init._
