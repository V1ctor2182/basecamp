# Applier

**Room ID**: `00-project-room/04-career-system/07-applier`  
**Type**: sub-epic  
**Lifecycle**: planning (Mode 2 LOCKED 2026-05-11)  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system`  

## Intent

ATS 填表：Mode 1 Simplify Hybrid + Mode 2 Full Agent + 飞轮学习

9 个 feature 组成的填表 agent 系统。**Mode 2 决策 LOCKED 2026-05-11** — 跳过 plan-ceo-review，直接全力实施 Mode 2 全部 sub-Rooms (02-09)。(1) 01-mode1-simplify-hybrid — 开放题 draft + 用户 Simplify + 手动 Submit + Mark submitted（推荐日常用） ✅ ROOM COMPLETE；(2) 02-playwright-runtime — 独立 Chromium + 持久化 profile + 反检测底座（Mode 2 根基，0 deps，next to dev）；(3) 03-field-classifier — 4 class 字段分类器（Hard/Legal/Open/File）路由到不同填充策略；(4) 04-multi-step-state-machine — Workday / iCIMS 多步表单状态机 + 中断恢复；(5) 05-non-standard-controls — 21 种控件策略 + 置信度分级 + Manual fallback；(6) 06-site-adapters — 按 ATS domain 配特化策略的 yaml；(7) 07-feedback-flywheel — 4 条回流数据驱动 Applier 越用越准（runtime 自迭代）；(8) 08-snapshot-refs-layer — token-efficient LLM-facing page abstraction (借鉴 Vercel agent-browser snapshot+refs 模式，~93% token 节省 vs Playwright MCP)，foundation for 03/04/05/06；(9) 09-snapshot-eval-harness — ATS fixture corpus + deterministic auto-tuner，calibration for 08，fixture corpus 横向给 03/04/06 共用（dev-time 自迭代）。核心铁律：永远不自动点 Submit（Human Gate）。消费 identity.yml / qa-bank / Tailor PDF / reports；产出 drafts/{jobId}.json + qa-bank/history.jsonl 回流。

## 依赖图（决定开发顺序）

```
02-playwright-runtime  (0 deps — Mode 2 根基)
   ↓
08-snapshot-refs-layer (deps 02)
   ↓
09-snapshot-eval-harness (deps 08)
   ↓
03-field-classifier (deps 08+09)
   ↓
05-non-standard-controls (deps 03+08)
   ↓
04-multi-step-state-machine (deps 03+05+08)
   ↓
06-site-adapters (deps 03+04+05)
   ↓
07-feedback-flywheel (deps 全部 — production 自迭代闭环)
```

## Specs in this Room

- [intent-applier-001](specs/intent-applier-001.yaml) — ATS 填表：Mode 1 Simplify Hybrid + Mode 2 Full Agent + 飞轮学习

## Child Rooms

- [Mode 1 - Simplify Hybrid](01-mode1-simplify-hybrid/spec.md) — feature, ✅ COMPLETE
- [Playwright Runtime](02-playwright-runtime/spec.md) — feature, planning (NEXT to dev)
- [Field Classifier](03-field-classifier/spec.md) — feature, planning
- [Multi-Step State Machine](04-multi-step-state-machine/spec.md) — feature, planning
- [Non-Standard Controls](05-non-standard-controls/spec.md) — feature, planning
- [Site Adapters](06-site-adapters/spec.md) — feature, planning
- [Feedback Flywheel](07-feedback-flywheel/spec.md) — feature, planning
- [Snapshot+Refs Layer](08-snapshot-refs-layer/spec.md) — feature, planning (NEW 2026-05-11; foundation for 03/04/05/06)
- [Snapshot Eval Harness](09-snapshot-eval-harness/spec.md) — feature, planning (NEW 2026-05-11; calibration for 08, fixture-shared with 03/04/06)

---

_Generated 2026-04-22 by room-init._
