# LLM 成本观测

**Room ID**: `00-project-room/04-career-system/01-foundation/03-llm-cost-observability`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/01-foundation`  

## Intent

通用 data/career/llm-costs.jsonl append 写入 + 读取 API（纯 infra，无 LLM 调用）

为所有 LLM 调用方（06-evaluator、03-cv-engine/05-tailor、07-applier 等）共用的成本日志 infra。append-only jsonl + 读 API 支持按时间/caller/model 聚合。不含 budget 策略或 UI（归 06-evaluator/04-budget-gate）。

## Constraints

本 feature 只写 infra，不含任何 LLM 调用或 budget 策略

MUST NOT 调 Anthropic SDK / 决定阈值 / 渲染 UI banner —— 那些归 06-evaluator/04-budget-gate。边界是 append/read 一条 jsonl record。

## Specs in this Room

- [intent-llm-cost-observability-001](specs/intent-llm-cost-observability-001.yaml) — 通用 data/career/llm-costs.jsonl append 写入 + 读取 API
- [constraint-llm-cost-observability-001](specs/constraint-llm-cost-observability-001.yaml) — 本 feature 只写 infra，不含任何 LLM 调用或 budget 策略

---

_Generated 2026-04-22 by room-init._
