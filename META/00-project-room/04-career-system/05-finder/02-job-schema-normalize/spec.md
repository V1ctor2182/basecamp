# Job Schema & Normalize

**Room ID**: `00-project-room/04-career-system/05-finder/02-job-schema-normalize`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/05-finder`  

## Intent

Job schema 定义 + Zod 校验 + normalize 层（所有 source adapter 统一契约）

Finder 所有下游（dedupe / hard filter / enrich / Evaluator / UI）共用的 Job 数据契约。字段：id (稳定哈希 company::role-slug::source-type::source-native-id) / source {type, name, url} / company / role / location (string[]) / url / description (string|null) / posted_at (ISO 8601|null) / scraped_at (ISO 8601) / comp_hint (object|null) / tags (string[]) / raw (any 留底)。用 Zod 定义 schema（src/career/finder/job-schema.ts 导出 JobSchema + Job type），所有 adapter 产出必须 parse 通过（不通过告警 + 跳过该条 + 记 source.type 的 parser 有问题）。提供 helpers: hashJobId(company, role, url)、stripHtml(htmlDescription)、parseLocation(rawLocationStr) 等。schema_version 字段支持将来向后兼容。不含任何 adapter 实现（归 01-source-adapters）。验收：定义一份 Zod schema + 10 条单元测试（缺字段 / 类型错 / 数组空 / null 允许 / 未知 type 报错）。

## Specs in this Room

- [intent-job-schema-normalize-001](specs/intent-job-schema-normalize-001.yaml) — Job schema 定义 + Zod 校验 + normalize 层（所有 source adapter 统一契约）

---

_Generated 2026-04-22 by room-init._
