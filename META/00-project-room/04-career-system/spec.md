# Career System

**Room ID**: `00-project-room/04-career-system`  
**Type**: epic  
**Lifecycle**: planning  
**Owner**: fullstack  
**Parent**: `00-project-room`  

## Intent

AI 求职自动化系统 — 多简历定制、AI 评分、半自动填表、全本地数据

个人向的端到端求职自动化系统，集成进 learn-dashboard。核心能力：(1) 找岗位自动化（Finder：扫 Greenhouse/Ashby/Lever API + GitHub 社区 repo + 手动粘）；(2) AI 评估 + 两阶段打分（Evaluator：Haiku 快评 + Sonnet 深评，产出 Block A-G 完整报告）；(3) 多简历针对 JD 定制（CV Engine：backend/applied-ai/fullstack 等多份 base resume，Google Docs 同步，Tailor Engine 改写 + Renderer 产出 PDF）；(4) ATS 表单半自动填（Applier：Mode 1 Simplify Hybrid 复制粘贴 / Mode 2 Playwright 全自动）；(5) 申请追踪 + follow-up + 面试准备（Tracker）；(6) 永远不自动 Submit — Human Gate 在每个关键节点（接 Simplify、Tailor 产出、Apply draft）都需要用户审批。所有数据本地 data/career/，不上云。

## Specs in this Room

- [intent-career-system-001](specs/intent-career-system-001.yaml) — AI 求职自动化系统 — 多简历定制、AI 评分、半自动填表、全本地数据

## Child Rooms

- [Career 基础层](01-foundation/spec.md) — sub-epic, planning
- [Profile](02-profile/spec.md) — sub-epic, planning
- [CV Engine](03-cv-engine/spec.md) — sub-epic, planning
- [PDF Renderer](04-renderer/spec.md) — sub-epic, planning
- [Finder](05-finder/spec.md) — sub-epic, planning
- [Evaluator](06-evaluator/spec.md) — sub-epic, planning
- [Applier](07-applier/spec.md) — sub-epic, backlog
- [Human Gate + Tracker](08-human-gate-tracker/spec.md) — sub-epic, planning

---

_Generated 2026-04-22 by room-init._
