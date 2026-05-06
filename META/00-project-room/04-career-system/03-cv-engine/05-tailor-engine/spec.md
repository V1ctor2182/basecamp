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

## 当前进度 — m2/4 done (2026-05-05, 50%)

4 milestones, ~1000 LOC source + ~900 smoke. 4 OQs all locked at recommended values. **Depends on 06-evaluator/02-stage-b-sonnet ✅** (just merged PR #22 — Block E from `data/career/reports/{jobId}.md` is the primary input). Closing this Room takes **03-cv-engine 80% → 100%**.

- ✅ **m1-tailor-prompt-module** (~190 + smoke ~340, **25/25 green**) — `tailorPrompt.mjs`: TAILOR_MODEL=claude-sonnet-4-6, NO_FABRICATION_INSTRUCTION verbatim per constraint-spec, `buildSystemBlock` with cache_control:ephemeral leading with CONSTRAINT #1 + base.md + proof-points + emphasize (no identity — renderer's job), `buildUserMessage` carries JD + Block E + optional userHint, `parseTailorResponse` with local concatMarkdownBlocks (`\n\n` paragraph join, differs from Stage B's `\n` block separator), `extractBlockEFromReport` reuses stageBPrompt.extractBlocks. Plan-agent review applied 3 HIGH (whitespace-only userHint suppression, safer empty-baseMd sentinel, paragraph-preserving concat) + 1 MEDIUM (' | ' emphasize separator vs ', ') + 1 LOW (CONSTRAINT #1 leads system block).
- ✅ **m2-tailor-runner** (~265 + bundle ~95 + smoke ~410, **17/17 green**) — `tailorRunner.mjs` + `tailorBundle.mjs`: single-job orchestrator (no batch — user-driven). DI seam (`_client`/`_recordCost`/`_sleep`/`_writeOutput`/`bundle`), retry on 5xx/429/408, atomic tmp+rename, NEVER throws. **Early jobId+resumeId regex validation** before bundle load + API call (review fix HIGH — defends ~$0.01 wasted Anthropic call per malformed id). NO idempotency / NO mutex. `loadTailorBundle` reads 5 sources gracefully. Cost record carries `caller='cv-tailor'` + `job_id` + `resume_id`. Plan-agent review applied 1 HIGH (early id validation) + 1 new smoke verifying non-string ids skip the API entirely.
- ⏳ **m3-schema-and-endpoint** (~200) — `POST /api/career/cv/tailor` (Auto-Select fallback for resumeId; 412 if no stage_b; returns base_markdown for diff display) + `GET /output/:jobId/:resumeId` (path-traversal-safe disk read built from validated ids). No mutex needed. + smoke 10
- ⏳ **m4-ui-and-room-complete** (~300) — `<TailorPanel />` modal + `<DiffViewer />` (react-diff-viewer-continued) + Pipeline integration (Tailor button per StageBBatch row) + Approve→PDF / Reject→hint+rerun + ROOM COMPLETE rollups. + smoke 5

### Locked design (long-term-best, all defaults)

| Decision | Choice |
|----------|--------|
| Diff library (OQ-1) | `react-diff-viewer-continued` ~30KB gz; polished side-by-side, worth the dep for fabrication-detection UX |
| Cached corpus (OQ-2) | `base.md` + `proof-points.md` BOTH in cached system block (full fact-source for safety constraint) |
| Hint history (OQ-3) | deferred — v1 ephemeral hint per run; persistence in future feedback Room |
| Re-run policy (OQ-4) | overwrite — output uniquely keyed by (jobId, resumeId); user saves approved version externally |
| Model | `claude-sonnet-4-6` (Stage B pricing tier; cache_control on system) |
| Cost recording | shared `computeCostUsd` + `llm-costs.jsonl` with `caller: 'cv-tailor'` |
| Mutex | none — read-only on pipeline.json; output uniquely keyed |
| Idempotency | none — user-driven; re-run with hint is the expected path |
| Path-traversal defense | both jobId and resumeId regex-validated; built from validated ids in endpoint AND runner (defense in depth) |
| 412 on missing stage_b | Tailor depends on Block E; can't run without it |
| Diff vs PDF gate | UI MUST show diff before render (constraint #1); Approve enables PDF download |

### 下游 contracts

- **`07-applier`**: tailored PDFs feed the Applier upload flow
- **`08-human-gate-tracker`**: tailor-approved diffs enter the human-gate audit log
- **Future feedback Room**: hint-history persistence (OQ-3 deferred)

---

_Generated 2026-04-22 by room-init. Plan refined 2026-05-05 by plan-milestones._
