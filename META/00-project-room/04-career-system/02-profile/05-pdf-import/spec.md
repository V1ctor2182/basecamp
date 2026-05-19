# PDF Import (resume → identity 自动填充)

**Room ID**: `00-project-room/04-career-system/02-profile/05-pdf-import`
**Type**: feature
**Lifecycle**: planning
**Owner**: fullstack
**Parent**: `00-project-room/04-career-system/02-profile`

## Intent

在 Settings → Identity 页加一个 "Drop PDF here" 区域：用户扔一份**简历 PDF** 进来 → 后端用 Claude 解析 → 自动填充 identity.yml 的字段（姓名 / 邮箱 / 电话 / LinkedIn / GitHub / portfolio / 学历 / 语言 / 工作地点等）→ 弹 diff modal 让用户 review → confirm 后写入。

**核心价值**：第一次配置 identity.yml 要手填十几个字段太烦人。一份 PDF 简历 已经包含 90% 的信息，让 AI 干这活。

## Constraints (硬铁律)

- **C1 [MUST]** PDF 上传到本地 server，不发第三方文件存储；解析过程中只把**纯文本**发给 Anthropic API（不发原 PDF binary）
- **C2 [MUST]** 写入 identity.yml 之前 **必须** 弹 diff modal：左边当前值 / 右边 AI 提取值 / 用户逐字段勾选要不要采用。不能一键全 overwrite
- **C3 [MUST]** 提取出错的字段（confidence=low 或缺失）默认 **不勾选**，强制用户手填或跳过
- **C4 [MUST]** Anthropic API 调用计入 daily_budget_usd（同 Stage A/B 那条预算）；预算用尽则 fallback "请手填"，不静默失败
- **C5 [MUST]** PDF 临时存在 `data/career/uploads/`（gitignored），解析完成后**保留 7 天**（debug + 重跑解析），超过 TTL 自动删

## Open Questions

| ID | 问题 | 推荐 |
|----|------|------|
| Q1 | PDF → 文本怎么提取？ | 用 `pdf-parse` (node-only, no deps on system libs)；超过 50 页 / 5MB 截断 |
| Q2 | 哪个 Claude 模型？ | Haiku 4.5 (足够，~$0.001/份)。Sonnet 留给 Stage B 用 |
| Q3 | 提取后**自动应用**还是 **diff modal review**？ | diff modal (C2) — 简历跟 identity.yml 字段语义不一定一一对应 |
| Q4 | 学历 / 工作历史这种 array 类型，AI 提取出 3 条但 identity 现有 1 条怎么办？ | 默认显示 "替换 / 合并 / 保留原" 三选一；推荐替换（identity.yml 是当前状态快照） |
| Q5 | 多份简历（不同岗位定制版）扔进来要不要分别记录？ | V1 不记录上传历史，每次扔覆盖前次；多版本简历归 03-cv-engine 管 |
| Q6 | 是否同时填 narrative.md (你的故事)？ | V1 不动 narrative —— 简历里没有 "story" 维度，AI 容易脑补。narrative 维持手填 |
| Q7 | 失败处理：PDF 是图片型扫描件（无 OCR 文本层）怎么办？ | 检测到 `pdf-parse` 返回字符数 <100 → 直接报错 "PDF appears to be a scanned image without OCR text layer. Please use a text-based PDF or fill in manually." |

## Specs in this Room

- [intent-pdf-import-001](specs/intent-pdf-import-001.yaml) — top-level intent

## Estimated scope

~250 LOC backend (upload endpoint + pdf-parse + Claude prompt + diff API) + ~200 LOC React (Drop zone + DiffModal) + ~100 LOC smoke. **~3 milestones**.

## 建议 Milestones (lock at plan-milestones)

| m | 内容 | LOC |
|---|------|-----|
| m1 | Backend: POST /api/career/identity/parse-pdf (multipart upload → pdf-parse → Claude Haiku → return parsed fields). + Zod schema for ParsedIdentity. + budget check. + smoke. | ~250 |
| m2 | Frontend: Drop zone in Identity.tsx + DiffModal (per-field checkbox + radio for arrays per Q4) + apply flow. | ~250 |
| m3 | Cleanup: `data/career/uploads/` TTL gc cron + ROOM COMPLETE. | ~50 |

## 验收 (locked at plan-milestones — Q&A 完成后)

- (a) 扔一份 3 页的 SWE 简历 PDF → diff modal 在 ≤5s 内显示 8+ 字段提取结果
- (b) Confidence=high 的字段（姓名 / 邮箱 / LinkedIn URL）默认勾选；confidence=medium/low 默认不勾选（C3）
- (c) 用户取消 modal 不写 identity.yml（什么都不动）
- (d) 用户 confirm 6 字段 → identity.yml 只更新这 6 个字段，其他保留
- (e) 一份扫描图片 PDF → 报错 "scanned image without OCR text layer"
- (f) 同一文件重复扔 → 复用已存的 parse 结果（hash dedup），不重复烧 token

## Open follow-up (out of V1 scope)

- 从 PDF 同步生成新的 resume entry 进 `data/career/resumes/`（让 03-cv-engine 后续可以 tailor 这版简历）—— 跨 Room 协作，留给 03-cv-engine 的 follow-up
- LinkedIn URL → 自动 fetch profile（违反 LinkedIn ToS，pass）

---

_Generated 2026-05-19 — user-requested follow-up to find-jobs-redesign m1 (Portals UX). Planning only — implementation pending plan-milestones lock._
