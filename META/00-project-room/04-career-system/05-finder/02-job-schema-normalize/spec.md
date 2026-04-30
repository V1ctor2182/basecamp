# Job Schema & Normalize

**Room ID**: `00-project-room/04-career-system/05-finder/02-job-schema-normalize`  
**Type**: feature  
**Lifecycle**: active (ROOM COMPLETE)  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/05-finder`  

## Intent

Job schema 定义 + Zod 校验 + normalize 层（所有 source adapter 统一契约）

Finder 所有下游（dedupe / hard filter / enrich / Evaluator / UI）共用的 Job 数据契约。字段：id (稳定哈希 company::role-slug::source-type::source-native-id) / source {type, name, url} / company / role / location (string[]) / url / description (string|null) / posted_at (ISO 8601|null) / scraped_at (ISO 8601) / comp_hint (object|null) / tags (string[]) / raw (any 留底)。用 Zod 定义 schema（src/career/finder/job-schema.ts 导出 JobSchema + Job type），所有 adapter 产出必须 parse 通过（不通过告警 + 跳过该条 + 记 source.type 的 parser 有问题）。提供 helpers: hashJobId(company, role, url)、stripHtml(htmlDescription)、parseLocation(rawLocationStr) 等。schema_version 字段支持将来向后兼容。不含任何 adapter 实现（归 01-source-adapters）。验收：定义一份 Zod schema + 10 条单元测试（缺字段 / 类型错 / 数组空 / null 允许 / 未知 type 报错）。

## Specs in this Room

- [intent-job-schema-normalize-001](specs/intent-job-schema-normalize-001.yaml) — Job schema 定义 + Zod 校验 + normalize 层（所有 source adapter 统一契约）

## 当前进度 — 🎉 ROOM COMPLETE (2026-04-30)

单 milestone Room, 1/1 ✅:

- ✅ **m1-job-schema** (commit TBD, 215 行) — Zod `JobSchema` + 5 helpers + smoke 17 断言全过

### 交付

**`src/career/lib/jobSchema.mjs`** (pure ESM, server-side):
- `JobSchema` — 13 字段 contract (id / source / company / role / location / url / description / posted_at / scraped_at / comp_hint / tags / raw / schema_version)
- `JobSourceSchema`, `JobCompHintSchema`, `SOURCE_TYPES` (7 enum)
- `slugify(s)`, `hashJobId(...)`, `stripHtml(html)`, `parseLocation(raw)`, `normalizeJob(partial)`

**`scripts/smoke-job-schema.mjs`**: `node scripts/smoke-job-schema.mjs` → 17/17 PASS

### Locked design (long-term-best)

| Decision | Choice | Why |
|----------|--------|-----|
| Job ID | sha256(slug(company)::slug(role)::source.type::source_native_id).slice(0,12) | 12 hex (~48 bit) 紧凑 + 1M jobs 碰撞 < 1e-6 |
| schema_version | number 1 | 升级写显式迁移 fn |
| comp_hint | {min?,max?,currency?(ISO 4217),period?('yr'\|'mo'\|'hr'\|'wk'),raw?}, nullable | 全部 optional 兼容部分抽取 |
| source.type | 7 enum (含 manual, 不含 LinkedIn/Indeed) | 合规 + finder constraint 禁止自动扫 |
| stripHtml | regex (`<[^>]+>` + 7 entity decode + collapse) | 0-dep, 描述给 LLM 容噪强 |
| 文件位置 | `src/career/lib/*.mjs` | 与 cvTemplate / htmlToPdf / markdownToTemplateHtml 一致 |
| node:crypto | namespace prefix + JSDoc 'server-only' | 防 frontend 误调用 |

### 下游 contracts

- **01-source-adapters**: 6 adapter 产出必须 `normalizeJob()` 通过
- **03-dedupe-hard-filter**: 用 `Job.id` 跨源去重
- **04-jd-enrich**: 检查 `description===null` 决定补全
- **06-evaluator**: 消费 Job 全字段评分

---

_Generated 2026-04-22 by room-init. Plan + ROOM COMPLETE 2026-04-30 by plan-milestones + dev._
