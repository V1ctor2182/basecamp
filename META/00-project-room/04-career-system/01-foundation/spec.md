# Career 基础层

**Room ID**: `00-project-room/04-career-system/01-foundation`  
**Type**: sub-epic  
**Lifecycle**: planning  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system`  

## Intent

career-system 的基础设施层：tab 壳 + 数据目录布局 + LLM 成本 infra

3 个 feature 共同组成 career-system 的底座：(1) 01-career-tab-shell — /career 路由骨架 + 子路由导航（所有 UI feature 挂这下面）；(2) 02-career-data-layout — data/career/ 目录结构 + gitignore 规则（所有后续 feature 的数据存储位置）；(3) 03-llm-cost-observability — llm-costs.jsonl append/read 通用 infra（所有 LLM 调用方共享的成本日志）。本 sub-epic 不含业务逻辑，只是基础设施 — 所有下游 sub-epic（02-profile 到 08-human-gate-tracker）都依赖它。Sprint 1 交付 = 本 sub-epic 全部完成 = career tab 能看见 + data 目录就绪 + 成本 infra 就位。

## Specs in this Room

- [intent-career-foundation-001](specs/intent-career-foundation-001.yaml) — career-system 的基础设施层：tab 壳 + 数据目录布局 + LLM 成本 infra

## Child Rooms

- [Career Tab Shell](01-career-tab-shell/spec.md) — feature, planning
- [data/career 布局](02-career-data-layout/spec.md) — feature, planning
- [LLM 成本观测](03-llm-cost-observability/spec.md) — feature, planning

---

_Generated 2026-04-22 by room-init._
