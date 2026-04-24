# Human Gate + Tracker

**Room ID**: `00-project-room/04-career-system/08-human-gate-tracker`  
**Type**: sub-epic  
**Lifecycle**: planning  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system`  

## Intent

Human Gate + 申请追踪：状态机 + Dashboard 视图 + 面试准备 + Follow-up

4 个 feature 的申请全生命周期管理：(1) 01-application-state — applications.json schema + 状态机 + timeline append-only（所有 career-system 申请的 source of truth）；(2) 02-career-dashboard-views — Overview / Shortlist / Applied / Reports 四个核心页面；(3) 03-interview-prep — Interview 状态的公司自动聚合 story-bank + deep research + 模拟行为题答案；(4) 04-followup-cadence — 按状态 + timeline 自动计算下次跟进时间 + 邮件模板（不自动发）。Human Gate 在整个系统体现为：每次状态流转都需要用户动作（"Mark submitted" 按钮 / 面试邀请收到后手动改状态等）。消费 applications.json 由 Evaluator / Applier 共同写入；产出 UI 视图 + 跟进提醒。

## Specs in this Room

- [intent-human-gate-tracker-001](specs/intent-human-gate-tracker-001.yaml) — Human Gate + 申请追踪：状态机 + Dashboard 视图 + 面试准备 + Follow-up

## Child Rooms

- [Application State](01-application-state/spec.md) — feature, planning
- [Career Dashboard Views](02-career-dashboard-views/spec.md) — feature, planning
- [Interview Prep](03-interview-prep/spec.md) — feature, planning
- [Follow-up Cadence](04-followup-cadence/spec.md) — feature, planning

---

_Generated 2026-04-22 by room-init._
