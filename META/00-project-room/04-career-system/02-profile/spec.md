# Profile

**Room ID**: `00-project-room/04-career-system/02-profile`  
**Type**: sub-epic  
**Lifecycle**: planning  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system`  

## Intent

Profile 层：你是谁（identity） + 你想要什么（preferences） + 叙事 + QA Bank

career-system 所有下游模块的上下文来源，4 个 feature：(1) 01-identity — identity.yml（填表事实信息，稳定，一年改几次，敏感 gitignored）；(2) 02-preferences — preferences.yml（偏好 + hard_filters + 评分权重，持续迭代，可 commit 追踪演化）；(3) 03-narrative-proof — narrative.md + proof-points.md（叙事定位 + 项目指标详细版，markdown 编辑）；(4) 04-qa-bank — legal.yml + templates.md + history.jsonl 三层 QA Bank（Applier 填表的答案源）。分成两文件的核心思路：identity 稳定敏感 vs preferences 迭代可 commit（两者所有权和变化频率不同）。Applier 只读 identity + qa-bank；Evaluator 只读 preferences + narrative + proof-points + cv.md（权限分离）。

## Specs in this Room

- [intent-profile-001](specs/intent-profile-001.yaml) — Profile 层：你是谁（identity） + 你想要什么（preferences） + 叙事 + QA Bank

## Child Rooms

- [Identity (你是谁)](01-identity/spec.md) — feature, planning
- [Preferences (你想要什么)](02-preferences/spec.md) — feature, planning
- [Narrative & Proof](03-narrative-proof/spec.md) — feature, planning
- [QA Bank](04-qa-bank/spec.md) — feature, planning

---

_Generated 2026-04-22 by room-init._
