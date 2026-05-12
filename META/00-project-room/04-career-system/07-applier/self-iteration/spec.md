# Self-Iteration

**Room ID**: `00-project-room/04-career-system/07-applier/self-iteration`
**Type**: sub-epic
**Lifecycle**: planning (LOCKED 2026-05-11)
**Owner**: fullstack
**Parent**: `00-project-room/04-career-system/07-applier`

## Intent

Applier 自我迭代体系：代码层闭环 + 数据层闭环 + 可视化看板

把 applier "越用越准"从口号变成具体架构。**改数据 vs 改代码 = 安全边界 + 审核成本边界**：

| | 02-data-flywheel | 01-code-calibration |
|---|---|---|
| 改什么 | qa-bank/heuristics/recovery (YAML) | filter.mjs/actions.mjs/serializer.mjs (TS) |
| 触发 | 每次 apply 后自动 | escalation from 02 OR 周期性 tune |
| 频率 | 几十次/天 | 几次/月 |
| 失败半径 | 一个 apply 错 | 所有 future apply 错 |
| 审核 | 数据 diff 自动 (异常才人审) | 必须人审 + smoke + PR |

## 三个子 Room

| Room | 职责 | 改什么 | Was |
|---|---|---|---|
| **[01-code-calibration](01-code-calibration/spec.md)** | "agent 看得到所有字段 / 能 act on 任何 control" | `.mjs` 源码 | 09-snapshot-eval-harness |
| **[02-data-flywheel](02-data-flywheel/spec.md)** | "agent 知道每个字段该填什么" | YAML 数据 | 07-feedback-flywheel |
| **[03-iteration-dashboard](03-iteration-dashboard/spec.md)** | 把两个闭环可视化 + manual touchpoint UI | React UI | NEW |

## Cross-cutting contract — Evidence Store

```
data/career/applier/evidence/
├── {jobId}-{ts}.html      ← 失败时的页面快照
└── {jobId}-{ts}.json      ← 元数据 (step / 失败点 / 缺失字段)

写者: 02-data-flywheel (production runtime 自动捕获失败)
读者: 01-code-calibration (你 Promote → fixture corpus)
读者: 03-iteration-dashboard (时间线展示)
30 天 GC
```

## Escalation 协议 (02 → 01)

```
apply fail
  ↓
02 自查 qa-bank → 能解决?
  ├─ 能 → DONE (qa-bank 学新答案 / 调权重 / 学 heuristic — 全数据层闭环)
  └─ 不能 → 写入 evidence + 03-dashboard 标红 "🔴 Needs Code Fix"
                ↓ (你点 Promote)
            01 接手 (HTML → fixture corpus → tuner → propose .mjs diff → PR → merge)
```

## 收敛曲线 (你最关心的 100% 路径)

```
01 (有限收敛 — ARIA spec 锁定上限):
  fixture 10:    coverage 85%
  fixture 20:    coverage 95%
  fixture 30:    coverage 98%
  fixture 50+:   coverage 100% (饱和)

02 (渐近收敛 — 长尾问题持续出现):
  apply 10:     cache hit 40%
  apply 50:     cache hit 75%
  apply 100:    cache hit 90%
  apply 200:    cache hit 95%

整体成功率 ≈ min(01 coverage, 02 cache hit):
  Month 1:  ~65%
  Month 3:  ~85%
  Month 6:  ~92%
  Month 12: ~97%
```

## 你的 manual touchpoint (其他全自动)

1. Apply 一个 job (低频)
2. Review agent draft + Submit (每次)
3. Promote evidence (失败时, 偶尔)
4. Review ground truth (Promote 后, Claude Code 起草, 你 ~2 分钟)
5. Review tuner PR (一行 diff, ~30 秒)
6. Investigate Tier 2/3 pattern (复杂失败时, 偶发, ~1-3 小时)

**80% 完全自动，15% 你点几下按钮，5% 真要写代码**。

## Specs in this Room

- [intent-self-iteration-001](specs/intent-self-iteration-001.yaml) — Applier 自我迭代体系顶层 intent

---

_Generated 2026-05-11 by manual restructure (synthesis of 07-feedback-flywheel + 09-snapshot-eval-harness + new iteration-dashboard)._
