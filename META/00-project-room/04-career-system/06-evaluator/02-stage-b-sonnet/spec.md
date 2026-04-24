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

---

_Generated 2026-04-22 by room-init._
