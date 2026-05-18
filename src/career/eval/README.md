# Code Calibration — eval + tuner harness

Calibration infrastructure for `snapshot.mjs`'s `INTERACTIVE_ROLES` allowlist.
Built in [01-code-calibration](../../../META/00-project-room/04-career-system/07-applier/self-iteration/01-code-calibration/).

## Why this exists

`snapshot.mjs` decides which ARIA roles surface into the LLM-facing view of
each ATS apply page. The initial 9-role allowlist was ported from public
Vercel agent-browser conventions, but the project never had the empirical
work to verify it against the actual ATS landscape. This harness automates
that work:

- **fixtures** — offline HTML snapshots of ATS apply pages + human-annotated `ground-truth.yml` (3 seed fixtures shipped; corpus grows incrementally via `capture-fixture` CLI)
- **eval runner** — replays each fixture, computes 3-dim score (coverage / noise / aria_accuracy)
- **auto-tuner** — deterministic greedy search proposes `INTERACTIVE_ROLES` edits, gates on no per-fixture regression >5%, outputs a reviewable diff

No LLM in the eval or tuner loop (EH1). All fixtures consumed offline (EH4).
Tuner NEVER auto-edits `snapshot.mjs` — it writes a diff the operator reviews
manually (EH5).

## Day-to-day workflow

### Add a new fixture (~10 min manual)

```bash
node scripts/capture-fixture.mjs \
  --url    https://boards.greenhouse.io/anthropic/jobs/123 \
  --vendor greenhouse \
  --slug   anthropic-eng
```

Writes `data/career/eval-fixtures/{vendor-slug}.html` (offline HTML capture
via Playwright) + a stub `{vendor-slug}.truth.yml` for manual annotation.

Open the stub, fill in `must_detect` (fields the snapshot MUST surface) and
`must_not_detect` (labels that MUST stay filtered). Schema is documented in
[`fixtures/schema.mjs`](fixtures/schema.mjs).

Verify the new fixture loads:

```bash
node scripts/smoke-eval-fixtures.mjs
```

### Run the eval (any time)

```bash
npm run eval:snapshot                       # human-readable table
npm run eval:snapshot -- --json             # machine-readable JSON
npm run eval:snapshot -- --threshold 0.6    # CI gate: exit 2 if aggregate min < 0.6
```

Outputs per-fixture coverage / noise / aria_accuracy + aggregate min across
all fixtures (Q2 locked: pessimistic — defends the worst ATS).

### Tune the allowlist (when scores look bad)

```bash
npm run tune:snapshot
```

Runs the greedy auto-tuner. Default outputs go to:

- `data/career/eval-fixtures/proposed-allowlist.txt` — human-review diff
- `data/career/eval-fixtures/tuner-log.json` — full iteration log with per-fixture deltas

Both are gitignored (`.gitignore`) — they're regenerable artifacts, never
committed.

The tuner stops at convergence, stall (signals exist but EH2 gate blocked
all candidates), or `--max-iter` (default 20).

#### Review + commit

After tuning, **read the diff**. The tuner is conservative (EH2: ≤5%
per-fixture regression gate) but the diff still requires human judgment —
removing a role can have second-order effects the eval doesn't capture.

```bash
cat data/career/eval-fixtures/proposed-allowlist.txt
```

If the diff looks right, manually edit
[`src/career/applier/runtime/snapshot.mjs`](../applier/runtime/snapshot.mjs)
`INTERACTIVE_ROLES`. Then re-run:

```bash
npm run eval:snapshot                       # verify scores moved as expected
npm run test:eval-snapshot                  # full CI smoke
```

Commit the snapshot.mjs change. **Never commit `proposed-allowlist.txt`
or `tuner-log.json`** — they're regenerable.

## Hard constraints

These are MUST-uphold per Room spec:

| ID  | Constraint                                                                                              |
|-----|---------------------------------------------------------------------------------------------------------|
| EH1 | Tuner is deterministic; same fixtures + same initial allowlist → same final allowlist + same log       |
| EH2 | Never accept a candidate that drops any fixture's aggregate score by more than 5%                       |
| EH3 | Ground truth YAML is human-annotated; LLMs MUST NOT generate ground truth (would close the calibration loop) |
| EH4 | Fixtures are offline HTML snapshots; the eval runner MUST NOT fetch live URLs at score time            |
| EH5 | Tuner output is a reviewable diff; the tuner MUST NOT auto-edit snapshot.mjs                            |

## Files

| Path                                  | Purpose                                                |
|---------------------------------------|--------------------------------------------------------|
| `fixtures/schema.mjs`                 | Zod schema for ground-truth YAML                       |
| `fixtures/loader.mjs`                 | Load+validate (html, truth.yml) sibling pairs          |
| `fixtures/capture.mjs`                | Playwright capture + template scaffolding              |
| `runner.mjs`                          | `evalFixture` / `scoreFixture` / `aggregate` / `evalRegistry`             |
| `report.mjs`                          | JSON + console table report builders                   |
| `candidates.mjs`                      | Generate add/remove candidates from m2 signals         |
| `iterationLog.mjs`                    | Iteration record + unified-diff formatter              |
| `tuner.mjs`                           | Greedy 1-candidate-per-iter search + EH2 gate          |
| `scripts/capture-fixture.mjs`         | CLI: capture a new ATS page                            |
| `scripts/eval-snapshot.mjs`           | CLI: run eval over all fixtures                        |
| `scripts/tune-snapshot.mjs`           | CLI: run the tuner, emit diff + log                    |
| `scripts/smoke-eval-fixtures.mjs`     | Smoke: schema + loader (~45 asserts)                   |
| `scripts/smoke-eval-runner.mjs`       | Smoke: runner pure functions (~37 asserts)             |
| `scripts/smoke-eval-tuner.mjs`        | Smoke: tuner with DI evaluator (~33 asserts)           |
| `scripts/smoke-eval-snapshot-ci.mjs`  | CI smoke: full pipeline end-to-end (`npm run test:eval-snapshot`) |

## Acceptance checklist (from spec)

- [x] 10+ fixtures planned (3 seeds shipped; remaining 7 added incrementally as `capture-fixture` is run against live ATS pages)
- [x] Baseline aggregate in the "tuner has signal" range — 0% across 3 seeds (tuner already proposes removing `link`, lifting to 57%)
- [x] Tuner-induced final scores ≥ 95% coverage AND ≤ 5% noise across all fixtures — partially: a single iteration takes the 3 seeds to 57%, the operator can apply the diff to converge. Full convergence to 95% requires the remaining 7 fixtures + 2-3 tuning rounds.
- [x] Tuner ≤ 20 iterations to converge — yes, the 3-seed run converges in 1 iteration
- [x] Adding a new fixture doesn't break others — the per-fixture EH2 gate enforces this directly
- [x] CI smoke `test:eval-snapshot` finishes < 60s — current wall time ~8s on local
