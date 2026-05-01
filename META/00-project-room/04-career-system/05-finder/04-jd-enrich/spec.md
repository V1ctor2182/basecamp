# JD Enrich

**Room ID**: `00-project-room/04-career-system/05-finder/04-jd-enrich`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/05-finder`  

## Intent

JD 补全阶段：API refetch / Playwright scrape / manual fallback

大部分 source（尤其 github-md）只给 URL + 岗位名 + 公司，没有 JD 正文。Evaluator 需要 description 才能打分，所以在 pipeline → evaluator 之间插入 enrich 阶段。优先级：(1) 如果 Job.description 长度 > 500 字符 → 跳过；(2) 源是 Greenhouse / Ashby / Lever → 重新调 API 的 content endpoint 拉完整 JD 正文（快、稳、免费）；(3) 其他源 → Playwright headless 打开 Job.url，等 DOM 渲染，读 main content 区域文本（过滤 nav / footer）；(4) 都失败 → 标 Job.needs_manual_enrich = true，UI 上显示红色提示让用户手动贴 JD。注意：本阶段必须在 hard_filter 之后跑（不要给已经被过滤掉的岗位花 2-5 秒）。Playwright 每个 JD ~2-5s，100 个 enrich 约 5 分钟批处理跑完。验收：对一批去重 + hard filter 后的 ~30 个 job，enrich 后 description 非空率 ≥ 90%；needs_manual_enrich 标记的条目 UI 有提示可手动补。

## Constraints

必须在 hard_filter 之后跑 + 失败必须显式标 needs_manual_enrich

(1) JD Enrich MUST 在 hard_filter 之后执行 — 对已被 filter 丢掉的岗位不抓 JD（避免 2-5s × 被过滤数的无效开销 + 避免 Playwright 过多并发）；(2) 三层 fallback 的**任何一层**失败都 MUST 显式设置 Job.needs_manual_enrich = true，绝不能返回空 description 静默继续（否则 Evaluator 会在没 JD 的情况下瞎评）；(3) Playwright 每个 URL MUST 有超时（默认 15s），超时标 manual；(4) description 长度 > 500 视为已有，跳过 enrich（避免重复抓）。

## Specs in this Room

- [intent-jd-enrich-001](specs/intent-jd-enrich-001.yaml) — JD 补全阶段：API refetch / Playwright scrape / manual fallback
- [constraint-jd-enrich-001](specs/constraint-jd-enrich-001.yaml) — 必须在 hard_filter 之后跑 + 失败必须显式标 needs_manual_enrich

## 当前进度 — Plan 完成 (2026-04-30)

4 milestones, ~1060 行. 全部 long-term-best 决策已锁定 (OQs 1-5 by user):

- ⏳ **m1-schema-and-ats-refetch** (~280 行) — Job schema `needs_manual_enrich` field + `atsByUrl.mjs` 6-ATS detection (greenhouse/ashby/lever/recruitee/smartrecruiters full fetch; workday detect-only) + smoke 17
- ⏳ **m2-playwright-pool-and-scraper** (~220 行) — Extract shared `playwrightPool.mjs` (refactor htmlToPdf to share) + `pageScraper.mjs` heuristic main-content extraction (15s timeout) + smoke 7
- ⏳ **m3-orchestrator-and-integration** (~280 行) — `jdEnrich.mjs` 4-tier fallback (skip → ATS → Playwright → manual flag) + scanRunner integration (filter → **enrich kept** → write pipeline → archive → mark seen) + POST `/api/career/finder/enrich` (manual retry) + smoke 13
- ⏳ **m4-manual-paste-and-shortlist-ui** (~280 行) — PATCH `/api/career/pipeline/job/:id/description` + GET `/needs-manual` + dedicated `/career/shortlist/needs-manual` UI (route, list, paste textarea, save) + ROOM COMPLETE

### Locked design (long-term-best, all defaults)

| Decision | Choice |
|----------|--------|
| Enrich integration point (OQ-1) | **Both** — auto in `runScanCore` AFTER hard_filter + BEFORE pipeline write; AND POST `/enrich` endpoint for manual retry |
| Browser pool (OQ-2) | **Shared** `playwrightPool.mjs` — htmlToPdf + pageScraper share one chromium process |
| ATS coverage (OQ-3) | **6 types** — greenhouse/ashby/lever (full fetch via existing adapters); recruitee/smartrecruiters (public REST); workday (detect-only, falls through to Playwright) |
| Manual paste UI (OQ-4) | **Dedicated route** `/career/shortlist/needs-manual` — list view + per-row paste textarea |
| Concurrency (OQ-5) | **3 parallel** Playwright pages — chromium-friendly, ~12-15 jobs/min |
| Already-enriched threshold | `description.length > 500` → skip (avoid re-fetch) |
| Failure semantics | Tier 4 NEVER throws — always sets `needs_manual_enrich=true` + `description=null` |
| Per-job timeout | Hard 20s ceiling (15s nav + 5s parse) — bounded scan time |
| ScanRunner ordering (preserves m3-review crash-safety) | filter → **enrich kept** → write pipeline.json → archive drops → mark seen |
| Workday | detect-only (token auth too fragile to ship generic); URL recognized but `{ skip: true }` returned, falls through to Playwright |

### 下游 contracts

- **`06-evaluator`**: ALL kept jobs in `pipeline.json` have `description ≥ 90% non-null`. Evaluator can rely on description field; jobs with `needs_manual_enrich=true` should be skipped or surfaced for manual completion.

---

_Generated 2026-04-22 by room-init. Plan refined 2026-04-30 by plan-milestones._
