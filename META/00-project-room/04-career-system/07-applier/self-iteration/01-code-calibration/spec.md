# Code Calibration (was Snapshot Eval Harness)

**Room ID**: `00-project-room/04-career-system/07-applier/self-iteration/01-code-calibration`
**Type**: feature
**Lifecycle**: in_dev (milestones locked 2026-05-18)
**Owner**: backend
**Parent**: `00-project-room/04-career-system/07-applier/self-iteration`

## Intent

ATS fixture corpus + ground truth + deterministic auto-tuner for snapshot+refs role filter calibration

07-applier 的 calibration / eval 基础设施。08-snapshot-refs-layer 的 role filter 需要针对真实 ATS 调校 — Vercel agent-browser 团队大概率试过几十个 ATS 才定下他们的 allowlist。我们要复刻这个过程但**不能人肉每次开 Greenhouse 眼睛扫**。本 Room 提供**确定性 auto-tuner**（不烧 LLM token，纯算法），让 Claude Code 跑一句 `npm run tune-snapshot` 自动迭代直到所有 fixture 收敛。4 层架构：(1) **Fixture corpus** — 10-15 个真实 ATS apply 页 HTML 离线快照 (Greenhouse / Lever / Ashby / Workday / iCIMS / Smartrecruiters / Jobvite / Bamboo / 2 custom)；(2) **Ground truth schema** — per-fixture YAML 列 `must_detect` (字段+role+name+state) + `must_not_detect` (noise 例)；(3) **Eval runner** — Playwright 加载离线 HTML → 跑 snapshot → 三维 diff (coverage / noise / aria_accuracy) → 结构化报告；(4) **Auto-tuner** — 收集 missing element 的真实 a11y role → 生成候选 fix → 逐个 try → keep 改善的、revert 退化的 → 收敛/达 max iterations 停。Foundation_for: 同 fixture corpus 被 03-field-classifier (加 `field_class` ground truth)、04-multi-step-state-machine、06-site-adapters 复用。

## Constraints (硬铁律)

- **EH1 [MUST]** Tuner 确定性算法，**不调 LLM API** — 同 fixture + 同初始 allowlist 必须收敛到同样最终 allowlist
- **EH2 [MUST]** Apply 一个 fix 时 gate on "没有 fixture 退化超阈值 (5%)" — 不能为改善 A 让 B 从 95%→80%
- **EH3 [MUST]** Ground truth 人工标注，**不允许 LLM 生成** ground truth (会引入循环 bug)
- **EH4 [MUST]** Fixture 离线 HTML 快照，**不是 live URL fetch** — CI 不依赖外网 + 可 reproduce
- **EH5 [MUST]** Tuner 输出可 review 的 diff (不能直接 commit) — Claude Code 必须 review + smoke 确认后才 commit

## Open Questions (LOCKED 2026-05-18)

| ID | 问题 | 决定 |
|----|------|------|
| Q1 | Fixture HTML 放 repo / LFS / submodule? | **repo** — `data/career/eval-fixtures/{vendor}/page.html`，~300KB 总量在可接受范围 |
| Q2 | Aggregate score 用 mean / median / min? | **min** — 悲观聚合，防止某个 ATS 单 fixture 退化被 mean 掩盖 |
| Q3 | Tuner 候选 fix 支持复合规则? | **simple only V1** — add-role / remove-role / add-state 三类单步候选；复合规则待真实数据驱动后再启 |

## Specs in this Room

- [intent-code-calibration-001](specs/intent-code-calibration-001.yaml) — ATS fixture corpus + ground truth + deterministic auto-tuner

## Why this Room exists

08-snapshot-refs-layer review 时识别到的 **"5% 损失"** —— 我们端口 Vercel agent-browser 时，role filter 的调校经验拿不到，要自己复刻。本 Room 把"复刻调校"这件事**从人工活变成自动化基础设施** — 不只解决 08 的 calibration 问题，还顺手给 03/04/06 提供横向 fixture corpus。

## Estimated scope

~450 LOC TypeScript (loader + eval runner + tuner + smoke + CLI) + ~300KB fixture data + ~150 行 ground truth YAMLs (~3-4 milestones).

## Milestones (LOCKED 2026-05-18)

| m | 内容 | LOC (corrected) |
|---|------|-----|
| m1 | Fixture corpus + ground-truth schema + loader + capture CLI + 10 fixtures (8 vendor + 2 custom) | ~280 LOC TS + ~300KB HTML + ~150 LOC YAML |
| m2 | Eval runner + 3-dim score (coverage/noise/aria_accuracy, aggregate=min) + report | ~330 LOC + smoke |
| m3 | Deterministic auto-tuner + ≤5% per-fixture regression gate + iteration log + reviewable diff | ~480 LOC + smoke |
| m4 | npm scripts + CI smoke (test:eval-snapshot <60s) + README + ROOM COMPLETE | ~150 LOC |

Total: ~1240 LOC TS + ~300KB HTML + ~150 LOC YAML — 2.7× spec's original ~450 LOC estimate. Correction sources: first-of-kind Playwright offline-HTML capture infra (m1), 3-dim diff-matching with fuzzy-name edge cases (m2), greedy search + per-fixture gate machinery + reviewable-diff emitter (m3).

Tune target: [src/career/applier/runtime/snapshot.mjs](../../../../../src/career/applier/runtime/snapshot.mjs) `INTERACTIVE_ROLES` (9 roles) + `EMITTED_STATES` (5 states).

## 验收 criteria (locked)

- (a) 10 fixture 覆盖 8 主流 vendor + 2 custom
- (b) 初始 baseline score 60-80% (有 tuner 调校空间)
- (c) Tuner 收敛后所有 fixture coverage ≥ 95% AND noise ≤ 5%
- (d) ≤ 20 iterations 收敛；iteration log 可 reproduce
- (e) 加新 fixture 不破坏其他 fixture 分数
- (f) CI smoke `test:eval-snapshot` 全部 fixture < 60s

---

_Generated 2026-05-11 by manual add (follow-up to 08-snapshot-refs-layer review)._
