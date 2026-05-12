# Applier

**Room ID**: `00-project-room/04-career-system/07-applier`
**Type**: sub-epic
**Lifecycle**: planning (Mode 2 LOCKED 2026-05-11; self-iteration sub-epic restructured 2026-05-11)
**Owner**: fullstack
**Parent**: `00-project-room/04-career-system`

## Intent

ATS 填表：Mode 1 Simplify Hybrid + Mode 2 Full Agent + Self-Iteration

8 个 children (6 feature + 1 sub-epic + 1 ROOM COMPLETE)。**Mode 2 决策 LOCKED 2026-05-11** — 跳过 plan-ceo-review，直接全力实施 Mode 2。**Self-iteration sub-epic 重构 2026-05-11** — 把原 07-feedback-flywheel + 09-snapshot-eval-harness 合并 + 加 03-iteration-dashboard。

| # | Child | Type | 职责 |
|---|---|---|---|
| 01 | 01-mode1-simplify-hybrid | feature | ✅ COMPLETE — 开放题 draft + 手动 Submit + Mark submitted |
| 02 | 02-playwright-runtime | feature | NEXT — 独立 Chromium + 持久化 profile + 反检测 (Mode 2 根基) |
| 03 | 03-field-classifier | feature | 4 class 字段分类器 (Hard/Legal/Open/File) |
| 04 | 04-multi-step-state-machine | feature | Workday / iCIMS 多步表单状态机 + 中断恢复 |
| 05 | 05-non-standard-controls | feature | 21 种控件策略 + 置信度分级 + Manual fallback |
| 06 | 06-site-adapters | feature | 按 ATS domain 配特化策略 yaml |
| _07_ | _(gap — old 07-feedback-flywheel 移至 self-iteration/02-data-flywheel)_ | — | — |
| 08 | 08-snapshot-refs-layer | feature | token-efficient LLM-facing 抽象 (snapshot+refs 模式) |
| — | **self-iteration/** | **sub-epic** | **改代码 + 改数据 + 可视化 (3 子 Room)** |

核心铁律：永远不自动点 Submit（Human Gate）。消费 identity.yml / qa-bank / Tailor PDF / reports；产出 drafts/{jobId}.json + qa-bank/history.jsonl 回流。

## 依赖图（决定开发顺序）

```
02-playwright-runtime  (0 deps — Mode 2 根基, NEXT)
   ↓
08-snapshot-refs-layer (deps 02)
   ↓
self-iteration/        (deps 02 + 08)
  ├── 01-code-calibration    (改 .mjs)
  ├── 02-data-flywheel       (改 YAML)
  └── 03-iteration-dashboard (UI, depends on 01 + 02)
   ↓
03-field-classifier (deps 08 + self-iteration/01)
   ↓
05-non-standard-controls (deps 03 + 08)
   ↓
04-multi-step-state-machine (deps 03 + 05 + 08)
   ↓
06-site-adapters (deps 03 + 04 + 05)
```

## Self-Iteration sub-epic — 重构说明 (2026-05-11)

**Before**: 9 个 sibling feature Rooms (01-09).
**After**: 6 feature + 1 sub-epic.

| 老结构 | 新位置 | 原因 |
|---|---|---|
| `07-feedback-flywheel` | `self-iteration/02-data-flywheel` | 改 YAML 数据闭环 |
| `09-snapshot-eval-harness` | `self-iteration/01-code-calibration` | 改 .mjs 代码闭环 |
| — | `self-iteration/03-iteration-dashboard` (NEW) | UI 可视化两个闭环 |

**为什么 sub-epic 而不是分散三个 sibling**：三者**共享 evidence-store contract** + **概念上是同一系统的三个面 (改代码 / 改数据 / 看板)**。分组让边界清晰，便于未来加 04-XX 时不混淆。

详见 [self-iteration/spec.md](self-iteration/spec.md).

## 编号 gap 说明

- **07 留空** — 原 07-feedback-flywheel 已移至 `self-iteration/02-data-flywheel`，保留编号 gap 让 git history 可追溯，不强行重编以免破坏其他文档外链
- **09 留空** — 原 09-snapshot-eval-harness 已移至 `self-iteration/01-code-calibration`，同上

## Specs in this Room

- [intent-applier-001](specs/intent-applier-001.yaml) — ATS 填表：Mode 1 Simplify Hybrid + Mode 2 Full Agent + Self-Iteration

## Child Rooms

- [Mode 1 - Simplify Hybrid](01-mode1-simplify-hybrid/spec.md) — feature, ✅ COMPLETE
- [Playwright Runtime](02-playwright-runtime/spec.md) — feature, planning (NEXT)
- [Field Classifier](03-field-classifier/spec.md) — feature, planning
- [Multi-Step State Machine](04-multi-step-state-machine/spec.md) — feature, planning
- [Non-Standard Controls](05-non-standard-controls/spec.md) — feature, planning
- [Site Adapters](06-site-adapters/spec.md) — feature, planning
- [Snapshot+Refs Layer](08-snapshot-refs-layer/spec.md) — feature, planning
- [Self-Iteration](self-iteration/spec.md) — **sub-epic, planning** (3 子 Rooms)

---

_Generated 2026-04-22 by room-init; restructured 2026-05-11 (Mode 2 lock + self-iteration sub-epic)._
