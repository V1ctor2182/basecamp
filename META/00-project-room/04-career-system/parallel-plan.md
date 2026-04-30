# Career System — Parallel Dispatch

> **Issue Nº 04 · 29 · 26** · Two-engineer cadence
> Repo · `basecamp` · Branch · `main`

A short briefing for synchronizing two engineers across the career-system epic — what's shipped, what's live, where the next hand-offs land.

---

## At a Glance

| | |
|---|---|
| **Active now (Victor)** | `03-cv-engine/04-auto-select` · m2 · 50% · unblocked |
| **Throughput** | 10 / 32 features shipped · 31% complete |
| **Ready for colleague** | `03-cv-engine/02-google-docs-sync` (backend, zero conflict) |
| **Critical path** | `05-tailor-engine` — awaits evaluator stage-b |

---

## § 01 — Rooms with No Blockers

| Room | Owner | Assignment | Note |
|---|---|---|---|
| `03-cv-engine/02-google-docs-sync` | backend | **Colleague** | Only feature both ready and free of overlap with current work |
| `06-evaluator/01-stage-a-haiku` | backend | Colleague · backup | Planning state — start with `plan-milestones` first |
| `06-evaluator/02-stage-b-sonnet` | backend | Colleague · backup | Unlocks downstream `tailor-engine` — high leverage |
| `05-finder/02-job-schema-normalize` | backend | Colleague · backup | Finder upstream; standalone, safe to start cold |

---

## § 02 — Timeline · Two-Lane Cadence

```mermaid
gantt
    title Career System — Now to Next Two Sprints
    dateFormat YYYY-MM-DD
    axisFormat %m-%d

    section Done
    01-foundation (3)             :done, f1, 2026-04-15, 5d
    02-profile (4)                :done, f2, 2026-04-18, 6d
    03-cv-engine/01-resume-index  :done, f3, 2026-04-23, 4d
    03-cv-engine/03-in-ui-editor  :done, f4, 2026-04-25, 4d
    04-renderer (2)               :done, f5, 2026-04-26, 3d

    section Victor
    cv-engine/04-auto-select m1     :done,    v1, 2026-04-28, 1d
    cv-engine/04-auto-select m2 UI  :active,  v2, 2026-04-29, 2d
    cv-engine/04-auto-select m3+    :         v3, after v2, 2d
    cv-engine/05-tailor-engine      :crit,    v4, after eb, 5d

    section Colleague
    cv-engine/02-google-docs-sync   :active,  c1, 2026-04-29, 4d
    evaluator/01-stage-a-haiku      :         c2, after c1, 3d
    evaluator/02-stage-b-sonnet     :         eb, after c2, 4d

    section Backlog
    finder (5 rooms)                :         bl1, after eb, 10d
    applier (7 rooms)               :         bl2, after bl1, 14d
    human-gate-tracker (4)          :         bl3, after bl1, 7d
```

---

## § 03 — Dependency Lattice

```mermaid
graph LR
    A["01-resume-index<br/>shipped"] --> B["03-in-ui-editor<br/>shipped"]
    A --> C["04-auto-select<br/>VICTOR"]
    A --> D["02-google-docs-sync<br/>COLLEAGUE"]
    C --> E["05-tailor-engine"]
    F["06-evaluator/02-stage-b<br/>COLLEAGUE"] --> E
    G["06-evaluator/01-stage-a<br/>COLLEAGUE"] --> F
    D -.optional.-> E
    E --> H["07-applier"]
    F --> I["05-finder"]
    I --> H

    classDef done fill:#dcd4c2,stroke:#2d4a1f,stroke-width:1.5px,color:#0c0a08;
    classDef victor fill:#fbe5d6,stroke:#bf3a06,stroke-width:2px,color:#0c0a08;
    classDef colleague fill:#dde6f0,stroke:#1a3a5c,stroke-width:1.5px,color:#0c0a08;
    classDef pending fill:#ebe6dc,stroke:#0c0a08,stroke-width:1px,color:#0c0a08;
    classDef downstream fill:#f4efe5,stroke:#6b6356,stroke-width:1px,stroke-dasharray:3 3,color:#2a2520;

    class A,B done;
    class C victor;
    class D,F,G colleague;
    class E pending;
    class H,I downstream;
```

---

## § 04 — Orders of Operation

**Order 01 — Start now**
Pick up `03-cv-engine/02-google-docs-sync` first.
Standalone, in the same sub-epic as `resume-index`, so context inherits cleanly. No conflict with Victor's work in flight.

**Order 02 — Up next**
Then `06-evaluator/01-stage-a-haiku` → `02-stage-b-sonnet`.
Highest-leverage sequence — unblocks Victor's `05-tailor-engine`, the bottleneck on the critical path.

**Order 03 — Hold**
Do not touch `05-tailor-engine`, finder, or applier.
Tailor-engine is gated on evaluator stage-b. Finder and applier are further downstream and not yet specced for parallel execution.

---

## § 05 — Colleague Onboarding

```bash
git clone git@github.com:V1ctor2182/basecamp.git
cd basecamp
npm install
# Open Claude Code in this dir, then:
#   /onboard
# 该 slash 命令会装 plugin、导览 repo、推荐第一个 room。
```

**First instruction to Claude:** `dev 02-google-docs-sync m1`

---

*Generated 2026-04-29 · Repo · `basecamp` / `main` · For the rendered version see [parallel-plan.html](./parallel-plan.html)*
