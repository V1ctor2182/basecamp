# Dedupe + Hard Filter

**Room ID**: `00-project-room/04-career-system/05-finder/03-dedupe-hard-filter`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/05-finder`  

## Intent

scan-history.jsonl 跨源去重 + 9 种 hard filter 规则（零 LLM 成本）

scan 流程中 step 3 + 4。(1) 去重：所有 adapter 产出 Job 后按 Job.id 查 data/career/scan-history.jsonl（记录已见过的 id + seen_at），只保留新见到的 + append 新 id 到 history；(2) Hard filter：按 preferences.yml 的 hard_filters 配置，按短路顺序 source_filter → company_blocklist → title_blocklist → title_allowlist → location → seniority → posted_within_days → comp_floor → jd_text_blocklist（最后因为要 enrich）过滤。任一规则判定 drop → 立即写 archive.jsonl（含 job 基本信息 + 命中的规则）+ 归档，不进入下游。每种规则支持 match_mode: contains / whole_word / regex；case_sensitive: false 默认。验收：给一批 100 条 raw jobs，跑完去重后剩 ~60（假设重复率 40%），再过 hard filter 后剩 ~30（假设硬性规则滤掉 50%），archive.jsonl 里 30 条 drop 记录能解释每条被哪个规则拒绝。

## Constraints

短路顺序锁定 + archive.jsonl 必写 + id 稳定性保证

(1) hard filter 规则 MUST 按 constraint-preferences-001 定义的 8 步短路顺序执行（不可打乱，否则成本激增）；(2) 每次 drop MUST append 一条 record 到 data/career/archive.jsonl（含 job_id / matched_rule_id / matched_value / timestamp）；不能"静默 drop"；(3) Job.id 的稳定性 MUST 保证：同一岗位不同时间被扫，id 必须一致（规范：hash(company-slug + role-slug + normalized-url)，URL 里去 tracking params 如 utm_*、ref 等）。否则去重失效；(4) scan-history.jsonl MUST append-only（不能 rewrite），否则去重状态丢失。

## Specs in this Room

- [intent-dedupe-hard-filter-001](specs/intent-dedupe-hard-filter-001.yaml) — scan-history.jsonl 跨源去重 + 9 种 hard filter 规则（零 LLM 成本）
- [constraint-dedupe-hard-filter-001](specs/constraint-dedupe-hard-filter-001.yaml) — 短路顺序锁定 + archive.jsonl 必写 + id 稳定性保证

---

_Generated 2026-04-22 by room-init._
