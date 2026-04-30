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

## 当前进度 — Plan 完成 (2026-04-30)

3 milestones, ~900 行, 全部 long-term-best 决策已锁定:

- ⏳ **m1-dedupe-and-history** (~150 行) — `scan-history.jsonl` append-only + `dedupeJobs()` + `markIdsAsSeen()` + smoke 6
- ⏳ **m2-hard-filter-engine** (~530 行) — 9 rules + matchUtils (contains/whole_word/regex) + COUNTRY_MAP + `archive.jsonl` 写入 + smoke ~50
- ⏳ **m3-integration-and-dryrun** (~220 行) — scanRunner 接入 + POST `/dry-run-filter` + Preferences UI Preview button (ROOM COMPLETE)

### Locked design (long-term-best, all defaults)

| Decision | Choice |
|----------|--------|
| `scan-history.jsonl` retention | append-only forever, 永不 rotate (1M rows ~50MB cheap) |
| `archive.jsonl` entry | full job snapshot (id/company/role/source/url/location) + rule_id + matched_value + ts |
| Drop philosophy | **conservative** — ambiguity → keep (don't lose jobs on data gaps) |
| Match modes | `contains` (default), `whole_word` (\\b regex), `regex` (raw pattern) |
| Bad regex pattern | console.warn + always-false matcher (don't crash scan) |
| Case-sensitivity | global default false (no per-rule override yet) |
| Empty rule | no-op skip |
| `location` "Remote" | bypasses location filter |
| Country inference | US 50 states + CA 13 provinces map (95% coverage) |
| `seniority` extraction | regex `\b(Intern|Junior|IC[1-7]|Senior|Staff|Principal|Lead|Director)\b` from role; unknown → keep |
| `comp_floor` missing comp_hint | keep (大部分 job 没 comp_hint, drop 太激进) |
| `comp_floor` currency mismatch | keep (无汇率推断) |
| `jd_text_blocklist` description=null | keep (defer post-enrich) |
| `posted_within_days: 0` | no-op skip |
| dedupe scope | scan-history 包括 dropped jobs (避免下次 fetch 同 dropped) |
| `pipeline.json` | 仅含 kept; archive 单独 jsonl |
| Dry-run | 单独 endpoint POST `/dry-run-filter`, 无 writes, prefs 可临时 override |
| Rule order (固定短路) | source → company → title-block → title-allow → location → seniority → posted → comp → jd-text |

### 下游 contracts

- **`04-jd-enrich`**: 处理 `description===null` jobs in `pipeline.json` (manual + github-md)
- **`05-scan-scheduler`**: setInterval 调 POST `/scan` — dedupe 保证安全重复调用
- **`06-evaluator`**: 消费 kept-only `pipeline.json`

---

_Generated 2026-04-22 by room-init. Plan refined 2026-04-30 by plan-milestones._
