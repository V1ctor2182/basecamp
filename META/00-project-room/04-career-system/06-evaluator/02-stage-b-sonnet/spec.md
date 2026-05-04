# Stage B - Sonnet

**Room ID**: `00-project-room/04-career-system/06-evaluator/02-stage-b-sonnet`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/06-evaluator`  

## Intent

Sonnet 深评（Stage B）：完整 A-G Block 报告 + 总分 + prompt caching

Evaluator 三阶段漏斗中的 Stage B。输入：JD 全文 + 完整 cv.md（Auto-Select 或用户指定的 base）+ narrative.md + proof-points.md + identity.yml + preferences.yml + qa-bank（templates/history 作 few-shot 参考）。输出：reports/{jobId}.md — 7 个 Block 的完整报告（A Role Summary / B CV Match 现状 / C Level & Strategy / D Comp & Demand + WebSearch Levels.fyi-Glassdoor / E Personalization Plan — CV 改写建议 → Tailor Engine 消费 / F Interview Plan 6-10 STAR+R 故事 / G Posting Legitimacy + Playwright 验证岗位活跃度）+ 加权总分 X.X/5 按 preferences.scoring_weights。调 claude-sonnet-4-6，每个 ~$0.15-0.30。**Prompt caching 关键**：cv.md + narrative.md + proof-points.md + identity.yml 是大共享上下文，开 caching 省 90% 重复 token 成本。可选工具：WebSearch（Block D 用）、Playwright（Block G 用）都通过 tools API 传给 Sonnet。成本走 01-foundation/03-llm-cost-observability。支持批量 + 并发 3。验收：对 ~30 个 Stage A 通过的 Job 跑 Stage B，产出 reports/{jobId}.md 结构完整（A-G 7 block）+ 总分合理；Block E 的建议能被 Tailor Engine 消费；总成本 < $6。

## Constraints

Block B 和 Block E 必须始终启用（下游依赖） + prompt caching 必开

(1) Block B (CV Match) 和 Block E (Personalization Plan) MUST NOT 被关闭 —— Block B 是总分的核心依据，关了等于不打分；Block E 是 Tailor Engine 的唯一输入，关了多简历定制整个失效。UI Settings 里把这两项设为 disabled / locked 不可编辑；(2) Prompt caching MUST 开启 — cv.md + narrative.md + proof-points.md + identity.yml 作为 cache-control: ephemeral 标记，避免每次 Sonnet 重复读大上下文；(3) WebSearch / Playwright 工具调用 MUST 带超时（30s），失败后 Block D / Block G 降级为"基于 JD 文本推断 + 标注 confidence: low"，不能让整个评估挂掉；(4) 产出 reports/{jobId}.md MUST 符合标准 Block A-G 结构，Block 之间用固定 `## Block X — Title` 标题分隔（便于下游解析）。

## Specs in this Room

- [intent-stage-b-sonnet-001](specs/intent-stage-b-sonnet-001.yaml) — Sonnet 深评（Stage B）：完整 A-G Block 报告 + 总分 + prompt caching
- [constraint-stage-b-sonnet-001](specs/constraint-stage-b-sonnet-001.yaml) — Block B 和 Block E 必须始终启用（下游依赖） + prompt caching 必开

## 当前进度 — Plan 完成 (2026-05-04)

5 milestones, ~1530 行. 11 OQs all locked at recommended values. **First project use of Anthropic Tools API** (m3).

- ⏳ **m1-stage-b-prompt-module** (~350) — `stageBPrompt.mjs` (system block: 4 cached files + 5 qa-bank few-shot + STAGE_B_INSTRUCTIONS describing 7-block A-G format) + tool-use-aware parser + smoke 14
- ⏳ **m2-stage-b-runner-cost-reports** (~300) — `stageBRunner.mjs` worker-pool concurrency=3 + retry + atomic-write `data/career/reports/{jobId}.md` + cost via shared `computeCostUsd` + smoke 12
- ⏳ **m3-tools-websearch-playwright** (~350) — `stageBTools.mjs`: hosted `web_search_20250305` (Block D, ~$0.025/search) + local `verify_job_posting` handler (Block G, backed by `pageScraper.mjs` from m2-jd-enrich) + multi-turn tool-use loop + smoke 10
- ⏳ **m4-schema-and-endpoint** (~250) — `Job.evaluation.stage_b` schema (sibling to stage_a, spread-mutation preserves both) + POST `/api/career/evaluate/stage-b` (6-way pipelineMutex) + GET `/results` projection + GET `/report/:jobId` markdown serving + smoke 7
- ⏳ **m5-stage-b-ui-and-room-complete** (~280) — `<StageBBatch />` Pipeline-tab panel + `<ReportViewer />` modal + Preferences UI updated to canonical A-G block labels (B/E locked-on with "Required by Tailor" badge) + ROOM COMPLETE → 06-evaluator parent 20% → 40%

### Locked design (long-term-best, all defaults)

| Decision | Choice |
|----------|--------|
| Block naming (OQ-1) | spec wins: A Role Summary / B CV Match / C Level&Strategy / D Comp&Demand / E Personalization / F Interview Plan / G Posting Legitimacy |
| Block toggles (OQ-2) | A always-on (no toggle); B+E locked-on (Tailor depends, UI disabled); C/D/F/G user-toggleable |
| Reports path (OQ-3) | `data/career/reports/{jobId}.md` (gitignored, m4) |
| Total score (OQ-4) | Sonnet emits `**Total: X.X/5**` line per system-prompt instructions weighted by `prefs.scoring_weights`; m2 parser extracts |
| WebSearch (OQ-5) | Anthropic hosted `web_search_20250305` server-side tool (~$0.025/search) |
| Playwright (OQ-6) | Local `verify_job_posting(url)` tool handler backed by existing `pageScraper.mjs` (m2-jd-enrich shared chromium pool) |
| Concurrency (OQ-7) | 3 (matches Stage A) |
| CV source (OQ-8) | v1 = default resume's base.md; auto-select integration deferred to follow-up when 03-cv-engine/04 m2 ships |
| qa-bank few-shot (OQ-9) | up to 5 most recent `history.jsonl` entries cached in system block; better Block F STAR stories |
| Idempotency (OQ-10) | skip if `job.evaluation?.stage_b != null`; m5 UI clears field for retry |
| Budget enforcement (OQ-11) | none in v1 (m5 UI surfaces total cost as info); real enforcement in `04-budget-gate` |
| Tool failure semantics | tool error → `tool_result` with error field → Sonnet downgrades block to "confidence: low" per system-prompt instruction |
| Tool timeout | 30s per local tool call (constraint #3) |
| Tool round cap | 5 max tool rounds per job (defensive cap against runaway loops) |
| Threshold gate (m4 endpoint) | candidates filtered to `evaluation.stage_a.score >= prefs.thresholds.consider` (default 3.5) — only consider+ jobs get $0.30 deep eval |
| Mutex | 6-way pipelineMutex extends 5-way: scan + enrich + manual-paste + PATCH + /evaluate/stage-a + /evaluate/stage-b |
| Mutation | spread `{ ...evaluation, stage_b: result }` preserves stage_a sibling |
| Cost recording | per-job aggregate across all tool rounds; appended to `llm-costs.jsonl` with `caller: 'evaluator:stage-b'` |

### 下游 contracts

- **`03-block-toggles`**: extends Preferences UI; this Room ships canonical A-G labels with B/E locked. block-toggles Room may add per-block cost preview / disable-on-budget hints.
- **`04-budget-gate`**: enforces daily_budget_usd cap; consumes the per-call cost records in `llm-costs.jsonl` already written by m2.
- **`05-pipeline-ui`**: extends Pipeline tab UI further; this Room ships v1 minimum.
- **Tailor Engine** (future, separate epic): consumes `reports/{jobId}.md` Block E (Personalization Plan) for resume rewrite suggestions.

---

_Generated 2026-04-22 by room-init. Plan refined 2026-05-04 by plan-milestones._
