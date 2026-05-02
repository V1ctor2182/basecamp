# Scan Scheduler

**Room ID**: `00-project-room/04-career-system/05-finder/05-scan-scheduler`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/05-finder`  

## Intent

定时 scan 调度 + 每 source type 独立 cadence + pipeline.json 入队

串起所有 finder 子模块的调度层。server.mjs 启动时用 setInterval 按 portals.yml.scan_cadence 为每个 source type 独立调度：github-md 每 24h（更新快）、greenhouse/ashby/lever 每 72h、scrape 每 168h（一周一次，反爬风险小）。每轮：1-多源并行拉取 → 2-normalize → 3-dedupe → 4-hard_filter → 5-jd_enrich → 6-append 到 data/career/pipeline.json（状态 Pending）。UI 也提供 "Scan Now" 按钮（POST /api/career/scan 手动触发）和 "Scan One Source" 调试接口。所有 LLM 成本调用（本阶段无 LLM）都走 01-foundation/03-llm-cost-observability 记录。错误处理：某个 source fetch 失败不影响其他；某条 Job normalize 失败只跳过那一条；整个流程幂等（重复跑不产生副作用）。验收：跑一轮完整 scan 能看到 pipeline.json 增加新的 Pending 岗位；scan-history.jsonl 记录本次所有扫到的 id；archive.jsonl 记录所有 drop。

## Specs in this Room

- [intent-scan-scheduler-001](specs/intent-scan-scheduler-001.yaml) — 定时 scan 调度 + 每 source type 独立 cadence + pipeline.json 入队

## 当前进度 — Plan 完成 (2026-05-01)

3 milestones, ~700 行. 全部 OQs locked at recommended values:

- ⏳ **m1-per-type-runner-and-cadence-state** (~250 行) — `runScanCore({types?})` filter + new `cadenceState.mjs` (`parseCadence`/`isDue`/`updateForTypes`) + `scan-cadence-state.json` persistence + smoke 12
- ⏳ **m2-scheduler-bootstrap-and-tick** (~200 行) — new `scheduler.mjs` master-tick (60s) + server.mjs bootstrap + SIGTERM teardown + hot-reload cadence + DI-driven smoke 10
- ⏳ **m3-debug-endpoint-ui-and-room-complete** (~250 行) — POST `/api/career/finder/scan/source` (type-only) + GET `/api/career/finder/scheduler/status` + `SchedulerPanel.tsx` on Pipeline tab + smoke 7 + ROOM COMPLETE → **05-finder EPIC COMPLETE 5/5** 🎉

### Locked design (long-term-best, all defaults)

| Decision | Choice |
|----------|--------|
| Cadence granularity (OQ-1) | **per-source-type** — keys are `SOURCE_TYPES` values (greenhouse / ashby / lever / github-md / scrape / rss / manual) |
| Scheduler topology (OQ-2) | **single master tick** every 60s — re-reads portals.yml each tick (free hot-reload), single timer to manage |
| Boot behavior (OQ-3) | **catch-up on first tick** (60s after `app.listen`) — past-due types fire then; reset-on-boot would lose continuity |
| Disable env (OQ-4) | `DISABLE_SCAN_SCHEDULER=1` skips bootstrap (for dev / tests) |
| Cadence hot-reload (OQ-5) | **yes** — master tick re-reads cadence each tick; UI edit takes effect within 60s |
| Master tick interval (OQ-6) | **60s** (minimal overhead, hour-scale cadences need no faster) |
| UI surface (OQ-7) | **Pipeline tab** — primary consumer; renders next-run/last-run table + per-type "Run Now" |
| Debug endpoint signature (OQ-8) | `{ type }` only — runs all sources of that type |
| Cadence string format | `Nh` / `Nm` / `Nd` / `Ns` — match `portals.yml` existing convention |
| Mutex semantics | scheduler skips tick if `scanState.running` OR `pipelineMutex.enriching` — re-evaluates next tick (no queueing; preserves pipelineMutex from 04-jd-enrich) |
| Failure mode | scheduler NEVER throws; per-tick errors warn + tick continues; per-source errors surface in `last_error` of cadence state |
| State file | `data/career/scan-cadence-state.json` — atomic-rename writes; missing keys default to "never run" → catch-up |

### 下游 contracts

- **`06-evaluator`**: `pipeline.json` continuously refreshed by scheduler; no manual scan trigger needed. Evaluator polls `pipeline.json` for kept jobs awaiting evaluation.

---

_Generated 2026-04-22 by room-init. Plan refined 2026-05-01 by plan-milestones._
