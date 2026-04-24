# Finder

**Room ID**: `00-project-room/04-career-system/05-finder`  
**Type**: sub-epic  
**Lifecycle**: planning  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system`  

## Intent

岗位发现：6 源 adapter + 去重 + 9 种 hard filter + JD 补全 + 定时调度

5 个 feature 的扫描流水线：(1) 02-job-schema-normalize — 所有 adapter 产出契约 Job schema + Zod 校验；(2) 01-source-adapters — Greenhouse / Ashby / Lever / github-md (SimplifyJobs 等) / scrape / manual 6 种源，初版先做 3 ATS + github-md + manual；(3) 03-dedupe-hard-filter — scan-history.jsonl 跨源去重 + 9 种规则短路过滤（从便宜到贵：source → company → title → location → seniority → date → comp → jd_text）；(4) 04-jd-enrich — 为没有 JD 正文的 Job 做补全（API refetch / Playwright / manual fallback）；(5) 05-scan-scheduler — setInterval 按不同 source 独立 cadence 定时 scan 并写 pipeline.json。零 LLM 成本，纯 HTTP + 规则。消费 preferences.yml 的 hard_filters；产出 pipeline.json 给 Evaluator。

## Specs in this Room

- [intent-finder-001](specs/intent-finder-001.yaml) — 岗位发现：6 源 adapter + 去重 + 9 种 hard filter + JD 补全 + 定时调度

## Child Rooms

- [Source Adapters](01-source-adapters/spec.md) — feature, planning
- [Job Schema & Normalize](02-job-schema-normalize/spec.md) — feature, planning
- [Dedupe + Hard Filter](03-dedupe-hard-filter/spec.md) — feature, planning
- [JD Enrich](04-jd-enrich/spec.md) — feature, planning
- [Scan Scheduler](05-scan-scheduler/spec.md) — feature, planning

---

_Generated 2026-04-22 by room-init._
