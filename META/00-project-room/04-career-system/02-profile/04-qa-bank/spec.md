# QA Bank

**Room ID**: `00-project-room/04-career-system/02-profile/04-qa-bank`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/02-profile`  

## Intent

三层 QA Bank：legal.yml（固定答案） + templates.md（开放题模板） + history.jsonl（历史累积）

为 Applier 填表 + Evaluator Stage B 提供稳定的问答材料。(1) qa-bank/legal.yml — 法律/EEO/visa 固定答案（work_authorization / eeo / personal / how_did_you_hear_default），纯查表不走 LLM，答案 100% 一致；(2) qa-bank/templates.md — Why us / Why role / Expected salary / Start date / Weakness / Why leaving 等开放题的模板 + 变量来源注释；(3) qa-bank/history.jsonl — 每次 apply 完成的 Q&A append-only record（q / a_draft / a_final / edit_distance / template_used），Applier 飞轮的核心数据源之一，Applier 起草新答案时用最近 5 条做 few-shot。前端 Settings → QA Bank 页：三个 sub-tab 分别编辑 legal（结构化表单）、templates（markdown viewer/editor）、history（只读 table + 搜索）。legal.yml 和 history.jsonl gitignored（敏感），templates.md commit。验收：Applier draft 时能读到 legal 返回固定值；能读到 templates 做模板匹配；append history 后 jsonl 立即持久化。

## Milestones (planned 2026-04-28)

**3 milestones 规划完成**（~660 lines 估算，2/3 完成，all defaults 长期最优锁定）:

- ✅ **m1-qa-bank-backend** (`6e1140f`, 160 lines 实际) — `server.mjs` 4+1 endpoints:
  - GET/PUT `/api/career/qa-bank/legal` (Zod permissive partial-save 同 Identity)
  - GET/PUT `/api/career/qa-bank/templates` (markdown 文本，复用 narrative pattern)
  - POST `/api/career/qa-bank/history` (append jsonl，HistoryRecordSchema)
  - GET `/api/career/qa-bank/history?limit=&q=` (recent N + 文本 filter)
- ✅ **m2-qa-bank-ui-legal-and-templates** (`e406b8d`, 444 lines 实际, +CSS) — Settings → QA Bank 用 **nested routes**:
  - `QABankLayout.tsx` (top tab bar with NavLink)
  - `qa-bank/Legal.tsx` (~210 行 ATS form 4 section: Work Auth / EEO / Personal / How did you hear)
  - `qa-bank/Templates.tsx` (~12 行 wraps `MarkdownDocEditor`)
  - `qa-bank/History.tsx` (m2 占位，m3 实现)
- **m3-qa-bank-history-table** (~160 lines) — History tab 只读 table + client-side search + field_type badge (ROOM COMPLETE)

**Locked design decisions** (long-term-best, no questions to user):

| Q | Choice | Long-term rationale |
|---|---|---|
| Q1 Tabs | **Nested routes** (`/career/settings/qa-bank/legal\|templates\|history`) | Shareable URLs / refresh-stable / browser back works. +10 lines route config buys 永久 UX. |
| Q2 history schema | `{ts, job_id, company, role, field_type, q, a_draft, a_final, edit_distance, template_used, model_used}` | `field_type` 飞轮按类型聚合分析需要；`model_used` 后续 quality-vs-cost 分析；cost 字段不重复（已在 `llm-costs.jsonl`）。 |
| Q3 history search | **Client-side** | jsonl <1000 entries 内绰绰有余；前端已传 `?q=` 易后期升级 server-side。 |
| Q4 Branch | **Branched off `narrative-proof`** | 1 PR/Room 节奏；narrative-proof merge 后 rebase clean。 |

**Validation pattern**: partial-save (missing 不阻塞 save，malformed 阻塞)，和 Identity/Preferences 一致。Legal 字段全 `.optional()` — curl `PUT {}` 不 400。

## Specs in this Room

- [intent-qa-bank-001](specs/intent-qa-bank-001.yaml) — 三层 QA Bank：legal.yml + templates.md + history.jsonl
- [change-2026-04-28-m1-qa-bank-backend](specs/change-2026-04-28-m1-qa-bank-backend.yaml) — m1 backend 6 endpoints (legal Zod permissive + templates + history jsonl)
- [change-2026-04-28-m2-qa-bank-ui-legal-templates](specs/change-2026-04-28-m2-qa-bank-ui-legal-templates.yaml) — m2 nested routes + Legal ATS form + Templates wrapper + History 占位

---

_Milestones planned 2026-04-28 via plan-milestones skill._
