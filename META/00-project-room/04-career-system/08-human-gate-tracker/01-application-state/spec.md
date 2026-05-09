# Application State

**Room ID**: `00-project-room/04-career-system/08-human-gate-tracker/01-application-state`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/08-human-gate-tracker`  

## Intent

applications.json schema + 状态机 + timeline append-only

所有 career-system 申请的单一 source of truth。数据模型 data/career/applications.json（数组）每条：id (jobId + date 构成) / company / role / url / score (Evaluator 打的总分) / status (Evaluated / Applied / Responded / Interview / Offer / Rejected / Discarded / SKIP) / legitimacy (Block G 判定: High Confidence / Proceed with Caution / Suspicious) / reportPath / pdfPath / resumeId / timeline (append-only event log: {ts, event, note?}) / followup ({nextAt, reason})。状态机：Evaluated → Applied → Responded → Interview → (Offer|Rejected)。不能跳过中间态；timeline 事件 append-only 绝不改历史。后端 GET /api/career/applications (list) + POST /api/career/applications/:id (update status + 自动 append timeline event)。写操作要原子（file lock 或 atomic rename 避免并发破坏）。Evaluator Stage B 完成后自动 insert 一条 status=Evaluated；Applier Mode 1 "Mark submitted" 后升为 Applied。验收：跑 20 个岗位评估 + 3 个 apply，applications.json 内容完整 + status 正确；手动修改某条的 status 经由 API → timeline 自动多一条事件记录。

## Constraints

状态按规范流转 + timeline append-only + 写操作原子

(1) applications.json 的 status 转换 MUST 按合法顺序：Evaluated → Applied → Responded → Interview → (Offer | Rejected)；此外 Discarded / SKIP 可从任何非终态转入。MUST NOT 跳过中间态（例 不能从 Evaluated 直接 → Interview），否则 timeline 信息丢失；(2) timeline 事件 MUST append-only — 历史事件一旦写入不能删 / 改，保证审计留痕；如果需要更正（例 打错日期）用新事件 `correction` 类型覆盖而不是改旧事件；(3) 写 applications.json MUST 原子 — 用 atomic rename (write to .tmp + rename) 或 file lock，避免多个 API 并发写造成 json 损坏（Evaluator + Applier + 用户手改可能同时发生）；(4) 每个 status 转换 MUST 自动 append 一条 timeline event（{ts, event: "status_changed", from, to}），不需要调用方额外写。

## Specs in this Room

- [intent-application-state-001](specs/intent-application-state-001.yaml) — applications.json schema + 状态机 + timeline append-only
- [constraint-application-state-001](specs/constraint-application-state-001.yaml) — 状态按规范流转 + timeline append-only + 写操作原子

## 当前进度 — m2/3 (2026-05-08, 67%)

3 milestones, ~520 LOC + ~280 smoke. **复用 already-shipped infra**: Zod schemas + atomic-rename write pattern from cv-engine output writes + pipelineMutex pattern from server.mjs. **0 open questions**. 单方案路径. Closes 1/4 children of 08-human-gate-tracker; unblocks 07-applier/01-mode1-simplify-hybrid + 02/03/04 siblings.

**Re-routed from a "plan milestone 07-applier" request** — 07-applier/01-mode1 hard-depends on this Room's applications.json state machine + Mark Submitted transition, so this Room ships first.

- ✅ **m1-applications-store-module** (~310 + smoke ~290, **20/20 green**) — Pure-Node ESM store at `src/career/applications/store.mjs`. Zod ApplicationSchema (id `{12-hex}-{YYYYMMDD}`; 8-status enum; 4-legitimacy enum default 'Unknown'; non-empty timeline; optional followup; .strict() on all sub-schemas). VALID_TRANSITIONS frozen state machine + STATUS_RANK for idempotency. atomicWriteJson via .tmp + fs.rename (precedent: scanRunner). 3 typed errors (InvalidTransitionError carries current_status + allowed_next for m2 UX, ApplicationNotFoundError, TimelineOrderError). upsertApplication idempotent (special `partial.creationNote` becomes the 'created' event note); transitionStatus appends status_changed event with from/to; appendTimelineEvent rejects backdated ts AND reserved internal events ('status_changed' + 'created'). All public helpers JSDoc'd as NOT in-process concurrent-safe — m2 will add applicationsMutex at endpoints. Plan-agent review: 0 CRITICAL + 0 HIGH + 3 MEDIUM (all 3 applied: concurrent-safety doc; 'created' event rejection + smoke; partial.creationNote JSDoc).
- ✅ **m2-applications-rest-endpoints** (~190 + smoke ~250, **11/11 green**) — 4 endpoints in server.mjs: `GET /api/career/applications` (?status=CSV filter, sorted by max(timeline.ts) desc with defensive copy before sort) + `GET /:id` (400 regex / 404 missing) + `POST /:id/status` (Zod body; mutex; structured 400 with `current_status` + `allowed_next` on illegal; 404 missing; 409 contention) + `POST /:id/timeline` (Zod USER_TIMELINE_EVENTS excludes reserved internal events; backdated ts → 400 TimelineOrderError; default ts = now). NEW `applicationsMutex` in store.mjs — independent of pipelineMutex. Plan-agent review: 0 CRITICAL + 0 HIGH + 1 MEDIUM (sort mutation safety — fixed via defensive copy) + 4 LOW (1 applied: empty CSV filter → 400).
- ⏳ **m3-stage-b-auto-insert-and-room-complete** (~140 + smoke ~30) — `stageBRunner.mjs` auto-upserts an Evaluated row after every successful eval (jobId+YYYYMMDD id, score=total_score, legitimacy='Unknown', reportPath populated). Idempotent — preserves later user-set states. Wrapped in try/catch (auxiliary write; doesn't crash Stage B). + ROOM COMPLETE rollups: room.yaml planning→active, _tree.yaml synced, 08-human-gate-tracker 0% → 25% (1/4), 04-career-system 78% → 81%.

### Locked design (single recommended path)

| Decision | Choice |
|----------|--------|
| ID format | `{12-hex jobId}-{YYYYMMDD}` per intent |
| legitimacy default | `'Unknown'` (Block G text-parsing deferred to a future Room) |
| Idempotency rule | `STATUS_RANK[current] >= Evaluated` → upsert no-op (preserves user-set later states) |
| Mutex scope | NEW `applicationsMutex` (independent of pipelineMutex — applications writes don't block scans) |
| Atomic write | `.tmp + fs.rename` (POSIX-atomic; same pattern as cv-engine output writes) |
| Offer→Rejected | Allowed (declined offer scenario) |
| Discarded/SKIP | Terminal-from-any-non-terminal per constraint #1 |
| Stage B integration | Default-on, no feature flag (this IS the source of truth) |
| Stage B failure mode | applications.json upsert failure logged + swallowed; doesn't crash the eval |

### Deferred (out of scope this Room)

- Block G legitimacy parsing (deferred to 02-career-dashboard-views or a future Room — m3 writes `'Unknown'`)
- followup field population (handled by 04-followup-cadence Room)
- pdfPath / resumeId population (handled by 07-applier when Tailor outputs are linked to applications)
- Applied.tsx UI rewrite (handled by 02-career-dashboard-views Room)

### 下游 contracts

- **`07-applier/01-mode1-simplify-hybrid`** consumes `POST /:id/status {Applied}` for the Mark Submitted button + history.jsonl append flow
- **`08-human-gate-tracker/02-career-dashboard-views`** consumes `GET /applications` for the Applied + Pipeline + Reports tabs
- **`08-human-gate-tracker/03-interview-prep`** consumes the Interview transition
- **`08-human-gate-tracker/04-followup-cadence`** consumes the followup field

---

_Generated 2026-04-22 by room-init. Plan refined 2026-05-08 by plan-milestones._
