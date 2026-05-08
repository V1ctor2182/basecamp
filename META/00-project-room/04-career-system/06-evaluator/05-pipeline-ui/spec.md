# Pipeline UI

**Room ID**: `00-project-room/04-career-system/06-evaluator/05-pipeline-ui`  
**Type**: feature  
**Lifecycle**: active (ROOM COMPLETE 2026-05-08)  
**Owner**: frontend  
**Parent**: `00-project-room/04-career-system/06-evaluator`  

## Intent

Pipeline / Shortlist 页 UI：列表 + 下拉 action + 批量 + 过滤器

两个核心 UI 页面：(1) /career/pipeline — 所有 Pending + Stage A 跑过的 Job 列表，每行显示 company / role / location / Stage（Haiku score 或 —）+ 下拉 action menu（Run Haiku / Run Haiku+Sonnet / Run Sonnet only / Force Sonnet / Archive）；支持多选 + 底部 "Bulk: Run Haiku / Run Sonnet on selected"；(2) /career/shortlist — Stage B 跑完且 score ≥ 4.0 的 Job，按分数排序，卡片显示分数 / 关键 gap / Block A 的 TL;DR；顶部 filter: "A ≥ 4.0 未跑 B" / "A 3.5-4.0 且公司=X" / "7 天前评估的可 Re-evaluate"。点岗位进 /career/reports/{jobId} 看完整 Block A-G 报告（markdown viewer 渲染）。复用 learn-dashboard 现有 ECharts 做评分分布图。验收：跑完 Stage A + B 后 pipeline 页能看到 ~30 条 Job，分层色标清楚；点某行 "Run Sonnet" 触发深评 + 产出报告 + 自动进 shortlist；批量操作选 5 个 Archive 成功。

## Specs in this Room

- [intent-pipeline-ui-001](specs/intent-pipeline-ui-001.yaml) — Pipeline / Shortlist 页 UI：列表 + 下拉 action + 批量 + 过滤器

## 当前进度 — 🎉 ROOM COMPLETE (2026-05-08, 3/3 milestones, 100%)

3 milestones, ~700 LOC source + ~470 smoke. **Reuses just-shipped infrastructure**: `body.force` flag from 04-budget-gate (PR #24), `/api/career/evaluate/stage-b/report/:jobId` from 02-stage-b-sonnet/m4, `<TailorPanel />` from 03-cv-engine/05-tailor-engine/m4, react-markdown + remark-gfm already in deps. All 9 OQs locked at recommended values. Closing this Room takes **06-evaluator 60% → 80%** (4/5 ROOMs ✅).

**Re-scoped vs original spec** based on already-shipped infrastructure:
- **Pipeline tab**: per-stage panels (StageABatch + StageBBatch + BudgetBanner) already shipped; this Room only adds per-row Force Sonnet wiring (closes leftover TODO from earlier Rooms)
- **Shortlist page**: from-stub to full real implementation
- **Reports page**: from-stub to full markdown viewer + Block A-G nav
- **Bulk multi-select / Archive / ECharts histogram**: DEFERRED — per-panel batch covers bulk; archive is net-new mutation surface; histogram is cosmetic

- ✅ **m1-force-sonnet-wiring** (~140 + smoke ~280, **5/5 green**) — Force Sonnet button in StageABatch wired (replaces disabled stub from earlier Rooms) + per-row Force Re-eval in StageBBatch (RotateCcw amber). Both POST `/evaluate/stage-b` `{jobIds:[id], force:true}` bypassing budget-gate cap; native `confirm()` with cost projection. Server pre-clears `stage_b` on candidates when `{force:true && jobIds}` so runner's `shouldEvaluate` doesn't short-circuit. StageABatch poll now passes abort signal (consistency with StageBBatch). Plan-agent review: 0 CRITICAL + 0 HIGH actionable; reviewer's probe #3 (pre-cleared null persists) invalidated by reading runner code (errorResult always lands in result.results).
- ✅ **m2-shortlist-page** (~410 + smoke ~270, **10/10 green**) — `GET /api/career/shortlist` endpoint (projection over jobs with stage_b status='evaluated' AND `total_score >= prefs.thresholds.worth`, default 4.0; sort desc + evaluated_at desc tiebreaker; top-100 cap; readdir-driven `has_tailor_output`) + full Shortlist.tsx rewrite (5-chip filter strip, single CHIP_PREDICATES map shared by filteredResults useMemo + chipCounts useMemo, useNavigate-driven row clicks with role="link"+keyboard a11y, manual-refresh AbortController stored in ref + cleaned on unmount, polling 30s, manual-paste nudge preserved) + scoped sl- CSS. Plan-agent review: 0 CRITICAL + 0 HIGH; applied 1 MEDIUM (manual refresh ctrl ref/abort) + 1 LOW (chip count consolidation), 2 LOW deferred (forward-ref + esnext deps).
- ✅ **m3-reports-page-and-room-complete** (~390 + smoke ~210, **6/6 green**) — Reports.tsx full rewrite from stub. List view (no :id): table over `/evaluate/stage-b/results` including `status:'error'` rows so user can see why a deep eval failed; click → detail. Detail view (:id): `/report/:id` markdown via react-markdown + remark-gfm; sticky left sidebar auto-derives Block A-G nav via `/^## Block ([A-G])\b/gm` regex on raw content; ReactMarkdown h2 component override injects `id={block-X}` + `data-block={X}` when text matches; IntersectionObserver tracks current section (rootMargin `-80px 0px -60% 0px`); page actions: Tailor (mounts existing `<TailorPanel>`), Open in Pipeline, Print (window.print + @media print hides topbar+sidebar); header derives role+company+url from side-fetch of `/results` (50-row cap; falls back to `Report — {jobId}` when meta absent); 404 → friendly "Re-run from Pipeline" CTA. Plan-agent review: 0 CRITICAL + 0 HIGH; applied 3 fixes (consistent AbortController across both fetches; IntersectionObserver deps narrowed to [blocks]; removed dead print selectors).

### Locked design (long-term-best, all defaults)

| Decision | Choice |
|----------|--------|
| score_floor | `prefs.thresholds.worth` (default 4.0); live-read no caching |
| Sort | `total_score` desc, `evaluated_at` desc tiebreaker |
| Top cap | 100 rows on Shortlist (UI shows "showing 100 of N") |
| Filter chips | 4: Score 4.5+ / 4.0-4.4 / Stage A passers no B yet / Has tailor output |
| Block A-G nav | Sticky left sidebar; auto-derived via `/^## Block ([A-G])/gm`; IntersectionObserver highlights current |
| TailorPanel reuse | Imported into Reports page; signature already accepts external `jobId` + `onClose` (no refactor needed) |
| Force Sonnet UX | Native `confirm()` with cost projection (~$0.30) |
| Print support | `@media print` hides sidebar + actions; full-width content |

### Deferred (out of scope this Room)

- Pipeline-tab bulk multi-select with checkboxes (existing per-panel "Run on N pending" covers most cases)
- Manual Archive button on Pipeline rows (needs PATCH endpoint for stage_a.status; net-new mutation surface)
- ECharts score distribution histogram (cosmetic; sortable table covers ranking flow)
- 7-day re-evaluate filter chip (needs Re-evaluate action; separate scope)

### 下游 contracts

- **`03-block-toggles`**: only sibling Room left in 06-evaluator — extends Preferences with per-block cost preview / disable-on-budget hints
- **`07-applier`**: tailored PDF + report markdown both surfaced for Applier to consume; user clicks "Start Apply" from Reports page in a future Room

---

_Generated 2026-04-22 by room-init. Plan refined 2026-05-08 by plan-milestones._
