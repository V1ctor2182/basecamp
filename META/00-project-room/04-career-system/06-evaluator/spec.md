# Evaluator

**Room ID**: `00-project-room/04-career-system/06-evaluator`  
**Type**: sub-epic  
**Lifecycle**: planning  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system`  

## Intent

两阶段 LLM 评估（Haiku 快评 + Sonnet 深评）+ Block 开关 + 成本管控 + UI 控制

5 个 feature 的评估管道：(1) 01-stage-a-haiku — Haiku 对 pipeline 里所有 Job 打 1-5 分，< 3.5 默认归档（~$0.01/个）；(2) 02-stage-b-sonnet — Sonnet 对通过的 ~30 个深评，产出 Block A-G 完整报告 + 总分（~$0.15-0.30/个，带 prompt caching）；(3) 03-block-toggles — 用户可配哪些 Block 启用（Block B/E 必开，D/F 可关省钱）；(4) 04-budget-gate — daily_budget_usd 限制 + 超预算暂停 Stage B + UI banner（消费 01-foundation/03 的 cost infra）；(5) 05-pipeline-ui — Pipeline 列表 + 下拉 action + 批量 + shortlist 过滤器。漏斗：100 pipeline → Stage A 过滤 → 30 深评 → 4.0+ 进 shortlist。总成本约 $7/100 岗位 vs career-ops $20（优化 3x）。消费 cv.md / narrative.md / preferences.yml；产出 reports/{jobId}.md 给 Tailor Engine + applications.json 给 Tracker。

## Specs in this Room

- [intent-evaluator-001](specs/intent-evaluator-001.yaml) — 两阶段 LLM 评估（Haiku 快评 + Sonnet 深评）+ Block 开关 + 成本管控 + UI 控制

## Child Rooms

- [Stage A - Haiku](01-stage-a-haiku/spec.md) — feature, planning
- [Stage B - Sonnet](02-stage-b-sonnet/spec.md) — feature, planning
- [Block Toggles](03-block-toggles/spec.md) — feature, planning
- [Budget Gate](04-budget-gate/spec.md) — feature, planning
- [Pipeline UI](05-pipeline-ui/spec.md) — feature, planning

---

_Generated 2026-04-22 by room-init._
