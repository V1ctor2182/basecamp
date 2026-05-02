# Stage A - Haiku

**Room ID**: `00-project-room/04-career-system/06-evaluator/01-stage-a-haiku`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/06-evaluator`  

## Intent

Haiku 快评（Stage A）：1-5 分 + 一句话理由，低于阈值归档

Evaluator 三阶段漏斗中的 Stage A。输入：JD 全文 + preferences.yml（targets / hard_filters / thresholds）+ 简版 CV（base.md 的 headlines + 经历 1-2 行，不读全文避免贵）。输出：单个岗位的 score (1.0-5.0, 1 位小数) + 一句话 reason（如 "3.0 — 要求 5+ 年经验，候选人只有 2 年" 或 "4.3 — 强匹配 AI infra 方向，薪资范围合适"）。调 claude-haiku-4-5-20251001，每个 ~$0.01。记成本走 01-foundation/03-llm-cost-observability。默认阈值 < 3.5 归档（preferences.yml.thresholds.skip_below 可 override）。归档的 Job 保留结果但状态置为 Archived，UI 上用户可以 "Force Sonnet" override。支持批量：POST /api/career/evaluate/stage-a { jobIds: [...] } → 并发 3（p-queue 限速避免 rate limit） + prompt caching 共用简版 CV。验收：跑一批 60 个 Pending 岗位，总成本 < $1，~30 个进入阈值之上（等待 Stage B 或用户选择）。

## Constraints

阈值可 override + 归档不是删除 + Force Sonnet 永远可用

(1) 默认阈值 3.5 MUST 可在 preferences.yml.thresholds.skip_below 里 override，不能硬编码；(2) Stage A < 阈值的 Job MUST 状态改为 Archived 但保留记录（applications.json 或 pipeline.json 里可查）——绝不删除，用户可能想回头翻；(3) UI MUST 永远提供 "Force Sonnet" override — 即使 Haiku 评 1.5，用户也能强制跑 Stage B（前提是今日预算未超）。因为 Haiku 有时会错（你比 Haiku 更了解自己）；(4) Stage A 的 reason 字段 MUST 保存 — 后续用户 review 低分岗位时能看到 LLM 的判断理由。

## Specs in this Room

- [intent-stage-a-haiku-001](specs/intent-stage-a-haiku-001.yaml) — Haiku 快评（Stage A）：1-5 分 + 一句话理由，低于阈值归档
- [constraint-stage-a-haiku-001](specs/constraint-stage-a-haiku-001.yaml) — 阈值可 override + 归档不是删除 + Force Sonnet 永远可用

## 当前进度 — Plan 完成 (2026-05-02)

4 milestones, ~950 行. **首次项目级 LLM 集成** (Anthropic SDK 之前未引入). 全部 10 OQs locked at recommended values:

- ⏳ **m1-anthropic-client-and-prompt** (~250) — `@anthropic-ai/sdk` install + `getClient()` + `stageAPrompt.mjs` (buildStageAPrompt + parseStageAResponse, prompt caching on system block) + smoke 10
- ⏳ **m2-stage-a-runner-and-cost** (~250) — `stageARunner.evaluateJobsStageA` worker-pool concurrency=3 + 2-retry 5xx/429 + per-call cost recording + smoke 10
- ⏳ **m3-endpoint-and-schema** (~200) — `Job.evaluation` zod schema migration + POST `/api/career/evaluate/stage-a` (4-way pipelineMutex + jobIds filter or all-pending) + smoke 6
- ⏳ **m4-pipeline-ui-and-room-complete** (~250) — `<StageABatch />` panel on Pipeline tab + ROOM COMPLETE → 06-evaluator parent 0% → 20%

### Locked design (long-term-best, all defaults)

| Decision | Choice |
|----------|--------|
| LLM SDK (OQ-1) | **`@anthropic-ai/sdk`** official npm package |
| API key (OQ-2) | `process.env.ANTHROPIC_API_KEY` (standard) |
| Eval result storage (OQ-3) | **in-place** `pipeline.json::jobs[i].evaluation.stage_a` |
| Prompt caching (OQ-4) | `cache_control: ephemeral` on system block (CV + prefs) — ~90% input token savings on calls 2..N within a batch |
| Concurrency (OQ-5) | **3** (matches jdEnrich; chromium-friendly equivalent) |
| Schema migration (OQ-6) | nullable + default null; existing pipeline jobs coerce to null on read |
| Endpoint payload (OQ-7) | `{jobIds?: string[]}` empty/null = all pending |
| Cost recording (OQ-8) | per-call append to `llm-costs.jsonl` (matches existing 01-foundation/03 contract) |
| Retry policy (OQ-9) | 2 retries with exp backoff (500ms, 2s) on 5xx + 429; fast-fail 4xx auth |
| Test mode (OQ-10) | `MOCK_ANTHROPIC=1` env returns canned response (smoke without spending real $) |
| Race protection | 4-way pipelineMutex: scan ∥ enrich ∥ manual-paste ∥ PATCH /:id/description ∥ /evaluate/stage-a |
| Threshold | from `prefs.thresholds.skip_below`; never hardcoded (constraint #1) |
| Score scale | 1.0-5.0 with 1 decimal; clamped at boundaries |

### 下游 contracts

- **`02-stage-b-sonnet`**: consumes `evaluation.stage_a.score >= prefs.thresholds.skip_below` to pick jobs for deep eval. Expects `evaluation.stage_a.status === 'evaluated'` (not `'archived'` or `'error'`).
- **`05-pipeline-ui`**: extends the Pipeline tab UI further; this Room ships a minimum viable view that 05 can replace.

---

_Generated 2026-04-22 by room-init. Plan refined 2026-05-02 by plan-milestones._
