# Tailor Engine

**Room ID**: `00-project-room/04-career-system/03-cv-engine/05-tailor-engine`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/03-cv-engine`  

## Intent

读 base.md + Block E 改写建议 → 定制 markdown + 渲染 PDF

针对某个具体 Job 把 base resume 微调后产出 tailored 版本。流程：(1) 解析 resumeId（传入或 Auto-Select 选）；(2) 读 resumes/{resumeId}/base.md + metadata.yml 的 emphasize 字段；(3) 读 reports/{jobId}.md 的 Block E（Personalization Plan）；(4) 调 Claude Sonnet：按 JD 关键词重排经历顺序 / 改写 Summary 注入 2-3 个 JD 核心关键词 / 在 bullet 里注入 ATS 关键词（**不改变事实**）/ 遵守 emphasize 侧重；(5) 输出 output/{jobId}-{resumeId}.md（tailored markdown）；(6) 调 04-renderer/01-html-template 产出 output/{jobId}-{resumeId}.pdf。Prompt 硬约束："If a metric or claim is not in the source base.md or proof-points.md, DO NOT invent it."；产出后 UI 显示 base vs tailored 的 diff 让用户审。后端 POST /api/career/cv/tailor { jobId, resumeId?, reportId }。验收：对 shortlist 4.0+ 的一个岗位跑 tailor，产出 markdown 里明显反映 Block E 的建议（关键词注入 / 排序 / Summary 改写），但所有指标和经历都能在 base.md 里找到出处。

## Constraints

MUST NOT 捏造经历或指标；产出后必须显示 diff 给用户审

(1) Prompt 硬编码："If a metric or claim is not in the source base.md or proof-points.md, DO NOT invent it. Only reorganize or rephrase existing content."；(2) 产出 output/{jobId}-{resumeId}.md 后 UI MUST 在渲染 PDF 前展示 base.md vs tailored 的 markdown diff 让用户审批；(3) 用户拒绝后可以给 LLM 补 hint 重跑（例 "不要动 Summary"）；(4) 只有用户明确 Approve 后才触发 PDF 渲染。(5) 测试：给一份 base.md 明确没有 "10x performance" 这种指标，tailor 产出里不能出现这类数字。

## Specs in this Room

- [intent-tailor-engine-001](specs/intent-tailor-engine-001.yaml) — 读 base.md + Block E 改写建议 → 定制 markdown + 渲染 PDF
- [constraint-tailor-engine-001](specs/constraint-tailor-engine-001.yaml) — MUST NOT 捏造经历或指标；产出后必须显示 diff 给用户审

---

_Generated 2026-04-22 by room-init._
