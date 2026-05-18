# Iteration Dashboard

UX layer for the [07-applier/self-iteration](../../../META/00-project-room/04-career-system/07-applier/self-iteration) sub-epic.
The page lives at `/career/iteration` and visualises three things:

- **Health** — last-30-day apply count, success rate, failures, snapshot calibration, pending counts
- **Event stream** — paginated timeline aggregated over existing JSONL stores (no new persistent log)
- **Pending Actions** — Promote queue (failures → fixtures), PR review (Haiku-induced suggestions), Tier 2/3 placeholders

Coverage detail (collapsible) shows the eval-fixture corpus + tuner status.

## Architecture

```
                          ┌──────────────────────────┐
                          │  src/career/Iteration.tsx │  ← React page (m2 + m3)
                          └──────────────┬───────────┘
                                         │ 30s poll (D2)
                          ┌──────────────┴───────────┐
                          │  /api/career/iteration/* │  ← 5 endpoints (m1)
                          └──────────────┬───────────┘
                                         │ pure file IO (D5)
       ┌──────────────────┬──────────────┼──────────────┬──────────────────┐
       │                  │              │              │                  │
 site-failures      field-edits     suggested/*   tuner-log.json    apply-sessions/
   (02 m1)           (02 m1)         (02 m2)       (01 m3)          (existing)
       │                                                                  │
       └──────────────────────────────┬───────────────────────────────────┘
                                      ▼
                          src/career/iteration/eventStream.mjs
                              ↑ normalizes to unified Event[]
```

## Source-of-truth modules

| File | Purpose |
|------|---------|
| `eventStream.mjs` | `readEvents` / `buildHealth` / `buildPending` / `buildCoverage` + `stableId` |
| `promote.mjs` | `promoteEvidence(id)` — write stub yaml to `data/career/eval-fixtures/promote-queue/` |
| `../Iteration.tsx` | React page consuming the endpoints |

## Endpoints (all GET unless noted)

| Path | Returns |
|------|---------|
| `/api/career/iteration/health` | 30d counts + rates + pending counts |
| `/api/career/iteration/events?limit&before_ts&before_id&since` | paginated event timeline |
| `/api/career/iteration/pending` | promote + pr_review + tier2/3 queues |
| `/api/career/iteration/coverage` | fixtures list + last tuner-log snapshot |
| `POST /api/career/iteration/promote/:evidenceId` | write stub yaml → 201/200/400/404 |

## Hard constraints (locked at spec)

| ID  | Constraint                                                                         | Enforcement |
|-----|------------------------------------------------------------------------------------|-------------|
| D1  | No new color palette                                                                | All `c-iter-*` hexes are already in `learning.css` (17 unique, all reused)
| D2  | 30s polling + AbortController cleanup                                              | `setInterval` + outer `AbortController` aborted on unmount
| D3  | Promote modal MUST review truth.yml stub before write                              | `PromoteModal` renders the stub yaml + capture-fixture command BEFORE POST
| D4  | No `[Run Tuner]` button — tuner is operator-driven via terminal                   | No POST endpoint to trigger tuner; modal only LINKS to `npm run tune:snapshot`
| D5  | 0 LLM calls on render                                                              | All endpoints are pure file IO over append-only JSONLs

## Spec overrides (locked at plan-milestones 2026-05-18)

- **Q2 → real-time aggregate, no new `events.jsonl`** — existing stores ARE the event log; aggregating on read avoids modifying frozen 01+02 emit-event paths
- **m1-OQ → promote writes stub yaml only** — HTML capture is operator-driven via `capture-fixture.mjs` (snapshot_excerpt is schema-capped at 400 chars, insufficient for a fixture)
- **m3-OQ → Tier 2/3 placeholder** — pattern clustering deferred; spec acceptance (c) explicitly descoped

## Operator promote flow

1. Page polls `/api/career/iteration/pending` every 30s → site-failures surface in the Promote queue
2. Click **Promote** → modal renders stub yaml preview + the capture-fixture command (D3 review-before-write)
3. Click **Confirm promote** → POST `/api/career/iteration/promote/:id` → stub yaml lands in `data/career/eval-fixtures/promote-queue/` (gitignored)
4. Run the capture-fixture command shown in the modal (locally, in terminal) to fill the HTML + scaffold `truth.yml`
5. Hand-annotate the `must_detect` / `must_not_detect` entries (EH3 — no LLM gen)
6. Run `npm run eval:snapshot` to verify the new fixture's score
7. Delete the corresponding `promote-queue/*.yml` once the real fixture is committed

## Smoke tests (all green at ROOM COMPLETE)

| Script | Asserts | Coverage |
|--------|---------|----------|
| `scripts/smoke-iteration-endpoints.mjs` | 23 | stableId, EVIDENCE_ID_RE, readEvents shape + pagination + cursor ties, buildHealth/Pending/Coverage, promote idempotency + path-traversal guard + concurrent mutex |
| `scripts/smoke-iteration-tsx-build.mjs` | 3 | tsc + vite build success, dist/index.html valid, bundle contains the Iteration page |
| `scripts/smoke-iteration-promote.mjs` | 5 | m3 build still passes, bundle contains m3 strings (Confirm promote / Coverage detail / Promote evidence), backend round-trip, yaml grep-ability |

Total: **31 asserts** across the Room. Run all with:
```
SMOKE=1 node scripts/smoke-iteration-endpoints.mjs
SMOKE=1 node scripts/smoke-iteration-tsx-build.mjs
SMOKE=1 node scripts/smoke-iteration-promote.mjs
```
