# Mode 1 - Simplify Hybrid

**Room ID**: `00-project-room/04-career-system/07-applier/01-mode1-simplify-hybrid`  
**Type**: feature  
**Lifecycle**: active (ROOM COMPLETE 2026-05-10)  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/07-applier`  

## Intent

Mode 1 Simplify Hybrid：生成开放题 draft + 复制粘贴流程 + Mark submitted

最省时的 apply 流程，推荐日常用。用户装 Simplify Chrome 插件处理常规 ATS 字段（姓名 / 邮箱 / 学校 / 公司 / 日期 etc），本系统只处理 JD-specific 开放题 + 定制简历上传。流程：(1) 用户在 shortlist 点 Apply → 后端 POST /api/career/apply/draft { jobId } → 读 JD + reports/{jobId}.md + qa-bank/legal + templates + history → 产出 drafts/{jobId}.json（每字段一条：label / class / suggested_value / confidence / source_ref）；(2) 前端展示开放题建议答案（Why us / Tell us / Expected salary 等），每条有 [Copy] 按钮 + 可编辑；(3) 用户切到浏览器 Simplify autofill 常规字段 + 复制粘贴开放题答案 + 手动上传 output/{jobId}-{resumeId}.pdf + 手动点 Submit；(4) 回 UI 点 "Mark submitted" → POST /api/career/apply/submitted → 状态更新为 Applied + append 用户最终提交的答案到 qa-bank/history.jsonl（Applier 飞轮②的数据源）+ 更新 applications.json timeline。验收：跑一次真实申请，draft 里开放题答案质量能直接粘贴（<30% 改动）；mark submitted 后 applications.json 状态为 Applied + history.jsonl 多一条记录。

## Constraints

永远不自动点 Submit；状态只在用户明确 Mark submitted 后才改 Applied

(1) Mode 1 MUST NOT 实现任何自动提交逻辑 — 本 feature 只生成 drafts/{jobId}.json 供用户复制粘贴，绝不触发浏览器动作（即使未来加 Playwright 自动化，也归 Mode 2 的 feature，不能在 Mode 1 里悄悄做）；(2) applications.json 的 status Evaluated → Applied 的转换 MUST 且仅在用户点 UI 的 "Mark submitted" 按钮后发生，绝不能因为生成了 draft 就推测已投；(3) qa-bank/history.jsonl 的 append MUST 同时发生（"Mark submitted" 时一起），不能在生成 draft 时提前写（否则用户没投也会污染 few-shot 上下文）；(4) UI 的 "Mark submitted" 按钮 MUST 二次确认（modal "你确定已在浏览器点过 Submit 吗？"），防止误触。

## Specs in this Room

- [intent-mode1-simplify-hybrid-001](specs/intent-mode1-simplify-hybrid-001.yaml) — Mode 1 Simplify Hybrid：生成开放题 draft + 复制粘贴流程 + Mark submitted
- [constraint-mode1-simplify-hybrid-001](specs/constraint-mode1-simplify-hybrid-001.yaml) — 永远不自动点 Submit；状态只在用户明确 Mark submitted 后才改 Applied

## 当前进度 — 🎉 ROOM COMPLETE (2026-05-10, 5/5 milestones, 100%)

5 milestones, ~1010 LOC + ~410 smoke. **复用 heavy already-shipped infra**: 08/01 applications.json store + transitionStatus, qa-bank legal.yml/templates.md/history.jsonl, reports/{jobId}.md (02-stage-b-sonnet) Block A/E, Tailor PDF outputs (03-cv-engine/05), Anthropic prompt-cache pattern, 04-budget-gate's force flag. **0 open questions**. Closes 1/7 children of 07-applier; the other 6 (Mode 2 Playwright agent) flagged for plan-ceo-review ROI evaluation per parent intent.

- ✅ **m1-drafts-store-module** (~155 + smoke ~205, **12/12 green**) — Pure-Node ESM store at `src/career/applier/draftsStore.mjs`. Zod DraftSchema (jobId 12-hex regex; fields min(1)/max(50); generated_at ISO; model; cost_usd nonnegative+finite; .strict()) + DraftFieldSchema (label 1-200; 4-class enum hard/legal/open/file; suggested_value max 4000; 3-tier confidence high/medium/low; source_ref optional max 200; .strict()). Atomic CRUD via .tmp+rename (precedent: applications/store.mjs). readDraft (null on ENOENT) / writeDraft (jobId mismatch guard before Zod) / deleteDraft (ENOENT swallowed) / listDraftJobIds (anchored regex filter). Plan-agent review: 0 CRITICAL + 0 HIGH + 2 MEDIUM (1 verification PASS; 1 acceptable-to-defer rename-failure orphan branch — same gap as applications/store m1) + 3 LOW (all noted, no fixes needed).
- ✅ **m2-draft-prompt-and-runner** (~445 + smoke ~290, **16/16 green**) — Single-Sonnet draft pipeline. `draftPrompt.mjs`: APPLIER_MODEL + frozen CANONICAL_QUESTIONS + DRAFT_INSTRUCTIONS_HEAD with 4-class+3-tier rubric inlined; buildSystemBlock emits ONE cache_control:ephemeral text block (matches Stage A/B precedent); buildUserMessage threads pdfPath separately; parseDraftResponse extracts first balanced `{...}` (tolerates ```json wrap + preamble + falls back to raw text when fence content lacks `{`) → JSON.parse → per-field Zod with field-index error message. `draftRunner.mjs`: generateDraft NEVER throws; tagged errors `api:|parse:|validate:`; cost recorded BEFORE parse so 04-budget-gate accounting honors actual API spend; caller='applier:draft' (separate budget line); 3-attempt retry on 429/5xx/APIConnectionError. Plan-agent review: 0 CRITICAL + 0 HIGH + 2 MEDIUM (both applied: fence-extract fallback + ZodError field-index) + 8 LOW (1 applied: history newest-first JSDoc contract).
- ✅ **m3-apply-draft-endpoint** (~275 + smoke ~315, **9/9 green**) — NEW `applierBundle.mjs` loader (Mode 1 inputs from disk: reports + qa-bank + identity + Tailor PDF latest-by-mtime; defensive reads; history.jsonl reversed to newest-first per draftPrompt contract). server.mjs adds `POST /api/career/apply/draft` (Zod `.strict()` body; 402 budget gate w/ force=true; 404 on missing pipeline/job/report w/ hint; 502 on runner error; 500 on writeDraft Zod fail; outer try/catch matches Stage B+Tailor convention) + `GET /apply/draft/:jobId` (regex 400 / Zod-fail 500 / missing 404 / 200 stored draft). Plan-agent review: 0 CRITICAL + 1 HIGH (outer try/catch — applied) + 2 MEDIUM (verified, acceptable) + 5 LOW + 1 NIT.
- ✅ **m4-apply-submitted-endpoint** (~150 + smoke ~250, **7/7 green**) — server.mjs `POST /api/career/apply/submitted`. Zod ApplySubmittedBodySchema.strict() (jobId 12-hex; fields min(1)/max(50); final_answer max 2000; class enum; optional note max 1000). ID resolution: today's id first, fallback sorts cross-day matches DESC and picks newest. applicationsMutex around transitionStatus only (released before history appends so concurrent /status calls aren't blocked). InvalidTransitionError → 400 with current_status+allowed_next; ApplicationNotFoundError → 404; outer try/catch JSON 500. history.jsonl per-line appendFile with HISTORY_LINE_BYTE_LIMIT=4000 runtime guard (PIPE_BUF=4096 atomicity invariant load-bearing in code). Response includes `{application, history_lines_added, total_fields, partial}` for UI soft-warning. Plan-agent review: 0 CRITICAL + 0 HIGH + 3 MINOR (cross-day newest sort, partial flag, byte-size guard — all applied) + 1 NIT (smoke date via Date.now-86400000 — applied).
- ✅ **m5-apply-ui-and-room-complete** (~285 + smoke ~155, **3/3 green**) — Apply.tsx route page wires m1-m4 backend into copy/paste UI. On mount: GET draft → 404 auto-POST. Field cards by 4 classes (hard read-only + Copy / legal yellow-tinted + Copy + source_ref / open editable textarea spans 2 cols + Copy / file PDF path code-block + Copy). Confidence pill (green/amber/red). 'Generate fresh draft' button. 'Mark submitted' with native confirm() (constraint #4) + POST /apply/submitted + redirect to /career/applied. 400 with current_status/allowed_next surfaces inline. partial:true → soft-warning toast. NEW apply.css (ap- prefix). Shortlist.tsx Apply button (Send icon, stopPropagation+navigate) + CareerApp.tsx route. Smoke port 4598 (was 4597 collision with smoke-stage-b-endpoint — fixed). Plan-agent review: 0 CRITICAL + 0 HIGH + 0 MEDIUM + 1 LOW (setState-after-unmount on 404→generate path — dev-only React warning, acceptable per locked design) + 5 INFO (all probes clean). 0 fixes required. ROOM COMPLETE rollups: room.yaml planning→active, _tree.yaml synced, 07-applier 0%→14% (1/7), 04-career-system 81%→84%.

### Locked design (single recommended path)

| Decision | Choice |
|----------|--------|
| LLM call shape | SINGLE Sonnet call (Block E already does personalization; 2-pass would double cost without info gain) |
| Field taxonomy | 4 classes: hard / legal / open / file (per spec) |
| Confidence | 3-tier (high / medium / low — matches Block G legitimacy convention) |
| Draft regeneration | Latest draft replaces wholesale (no merge); user re-pulls anytime |
| history.jsonl append | All 4 classes (full picture for flywheel); each line ≤2KB; appendFile |
| Mark Submitted | Native confirm() (constraint #4) — UI doesn't auto-Submit |
| Budget gate | 402 + force=true override (parallel to Stage B + Tailor) |
| Cost recording | caller='applier:draft' (separate budget line for clarity) |
| ID resolution at submit | `${jobId}-${today}` first, fallback to any matching jobId prefix (handles cross-day re-eval consumer contract from 08/01 m3) |

### Deferred (out of scope this Room)

- Auto-Submit in browser (Mode 2 Playwright — separate feature flagged for plan-ceo-review)
- Field history learning (e.g. preferring user's last edit over template) — Applier flywheel ② Phase 2
- PDF version selector (m3 hardcodes the Tailor-engine output path; multi-resume per-job is future work in 07-applier siblings)
- Cover letter generation as a separate document (current scope: cover letter is one of the canonical questions, output as text, user copies into the ATS field)

### 下游 contracts

- `02-career-dashboard-views` (08-human-gate-tracker) consumes `drafts/{jobId}.json` + `history.jsonl` for Applied-tab insights
- `07-applier/02-playwright-runtime` (Mode 2) — flagged for plan-ceo-review ROI evaluation before starting; not in this Room's scope

---

_Generated 2026-04-22 by room-init. Plan refined 2026-05-08 by plan-milestones._
