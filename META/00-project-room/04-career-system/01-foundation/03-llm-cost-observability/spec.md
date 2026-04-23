# LLM 成本观测

**Room ID**: `00-project-room/04-career-system/01-foundation/03-llm-cost-observability`  
**Type**: feature  
**Lifecycle**: active ✅  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/01-foundation`  

## Intent

通用 data/career/llm-costs.jsonl append 写入 + 读取 API（纯 infra，无 LLM 调用）

为所有 LLM 调用方（06-evaluator、03-cv-engine/05-tailor、07-applier 等）共用的成本日志 infra。append-only jsonl + 读 API 支持按时间/caller/model 聚合。不含 budget 策略或 UI（归 06-evaluator/04-budget-gate）。

## Constraints

本 feature 只写 infra，不含任何 LLM 调用或 budget 策略

MUST NOT 调 Anthropic SDK / 决定阈值 / 渲染 UI banner —— 那些归 06-evaluator/04-budget-gate。边界是 append/read 一条 jsonl record。

## Implementation Summary

**1 milestone 完成**（2026-04-23）— 115 实际代码行:

- ✅ **m1-llm-costs-infra** — Zod schema + helpers + 2 REST endpoints + 首次引入 zod

## API 速查

### Record Schema (zod)

```typescript
{
  caller: string,              // 'evaluator:stage-a' / 'tailor' / 'applier' / ...
  model: string,               // 'claude-haiku-4-5' / 'claude-sonnet-4-6' / ...
  input_tokens: number,        // int >= 0
  output_tokens: number,       // int >= 0
  cost_usd: number,            // >= 0, caller 自己算（model 价格表归 caller）
  session_id?: string,
  job_id?: string,
  // ts 由 server 自动填 (ISO 8601)
}
```

### POST /api/career/llm-costs

调用方在 LLM 请求后立刻 append。

```bash
curl -X POST http://localhost:8000/api/career/llm-costs \
  -H "Content-Type: application/json" \
  -d '{"caller":"evaluator:stage-a","model":"claude-haiku-4-5","input_tokens":1000,"output_tokens":200,"cost_usd":0.01,"job_id":"042-anthropic"}'
```

- 成功 → 201 + 完整 record (含自动填的 ts)
- 字段错 / 缺失 → 400 + `{error, details: ZodIssue[]}`

### GET /api/career/llm-costs

多种查询模式：

| Query | 返回 |
|---|---|
| (no query) | 今日聚合 `{total_cost, total_tokens, record_count}` |
| `?start=<ISO>&end=<ISO>` | 时间范围的 records (array) |
| `?caller=<X>` / `?model=<Y>` | 精确过滤 records |
| `?groupBy=day` | 按日期分组聚合 `{date: {total_cost, ...}}` |
| `?groupBy=caller` | 按 caller 分组聚合 |
| `?groupBy=model` | 按 model 分组聚合 |

## Specs in this Room

- [intent-llm-cost-observability-001](specs/intent-llm-cost-observability-001.yaml) — 通用 data/career/llm-costs.jsonl append 写入 + 读取 API
- [constraint-llm-cost-observability-001](specs/constraint-llm-cost-observability-001.yaml) — 本 feature 只写 infra，不含任何 LLM 调用或 budget 策略
- [change-2026-04-23-m1-llm-costs-infra](specs/change-2026-04-23-m1-llm-costs-infra.yaml) — m1 change spec

## Downstream Callers

本 feature 完成后，下游 LLM 调用方在每次 Anthropic SDK 调用后都应 POST 一条 record：

- `06-evaluator/01-stage-a-haiku` — caller: "evaluator:stage-a"
- `06-evaluator/02-stage-b-sonnet` — caller: "evaluator:stage-b"
- `03-cv-engine/05-tailor-engine` — caller: "tailor"
- `07-applier/01-mode1-simplify-hybrid` — caller: "applier:draft"
- `07-applier/03-field-classifier` — caller: "applier:classify"
- 任何未来有 LLM 调用的 feature

**消费者**：`06-evaluator/04-budget-gate` — GET 今日聚合驱动 UI banner + daily_budget_usd 检查。

---

_Completed 2026-04-23 via dev skill (1 milestone × plan-milestones)._
