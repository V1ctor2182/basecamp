# QA Bank

**Room ID**: `00-project-room/04-career-system/02-profile/04-qa-bank`  
**Type**: feature  
**Lifecycle**: active ✅  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/02-profile`  

## Intent

三层 QA Bank：`legal.yml`（固定答案） + `templates.md`（开放题模板） + `history.jsonl`（历史累积）

为 Applier 填表 + Evaluator Stage B 提供稳定的问答材料。
- **legal.yml** — 法律 / EEO / visa 固定答案（纯查表不走 LLM，答案 100% 一致）
- **templates.md** — 开放题模板库（Why us / Why role / Expected salary / Weakness 等）+ 变量来源注释
- **history.jsonl** — 每次 apply 的 Q&A append-only 记录（飞轮数据源）

`legal.yml` + `history.jsonl` gitignored（敏感）；`templates.md` committed。

## Implementation Summary

**3 milestones 完成**（2026-04-28）— ~822 lines net + nested routes + 飞轮数据源:

- ✅ **m1-qa-bank-backend** (`6e1140f`, 160 lines) — `server.mjs` 6 endpoints (legal Zod permissive + templates markdown + history jsonl append-only)
- ✅ **m2-qa-bank-ui-legal-and-templates** (`e406b8d`, 444 lines) — Settings → QA Bank 用 **nested routes** (`/qa-bank/{legal|templates|history}`); Legal ATS form 4 sections + Templates 复用 MarkdownDocEditor + History 占位
- ✅ **m3-qa-bank-history-table** (`TBD`, 218 lines, ROOM COMPLETE = Sprint 2 done) — read-only table + client-side search + field_type badges

## Backend API (6 endpoints)

| Endpoint | Behavior |
|---|---|
| `GET /api/career/qa-bank/legal` | 返回当前或 `defaultLegal()`（4 个空 group 兜底） |
| `PUT /api/career/qa-bank/legal` | Zod permissive partial-save (全字段 `.optional()`) + 400 on Zod error |
| `GET /api/career/qa-bank/templates` | 返回 `{ content }`，文件不存在返空字符串 |
| `PUT /api/career/qa-bank/templates` | body `{ content }`，typeof string + length < 500KB |
| `POST /api/career/qa-bank/history` | Zod `HistoryRecordSchema`（field_type required enum）+ ts auto-fill; append jsonl line |
| `GET /api/career/qa-bank/history?limit=&q=` | 读最后 N 行 (cap 1000) + 可选 client-side text filter on q+a_final+a_draft，newest-first |

**HistoryRecord schema**:
```
{ ts?, job_id?, company?, role?, field_type: 'legal'|'open'|'eeo'|'other',
  q (max 2000), a_draft? (max 5000), a_final? (max 5000),
  edit_distance?, template_used?, model_used? }
```

## Frontend UI (`/career/settings/qa-bank/*`)

**Nested routes** (3 sub-tabs，URL 可分享 / refresh-stable / browser back works):

| Route | Component | What |
|---|---|---|
| `/legal` (default) | `Legal.tsx` | ATS form 4 section (Work Auth + EEO dropdowns + Personal + How did you hear) — partial-save，BoolRadio + dropdown + number input + travel_willing_percent 0-100 范围 check |
| `/templates` | `Templates.tsx` | thin wrapper 复用 `MarkdownDocEditor` (split-pane CodeMirror + ReactMarkdown) |
| `/history` | `History.tsx` | read-only table + client-side search + field_type colored badges (legal=灰 / open=蓝 / eeo=黄 / other=灰) + empty state |

**File structure**:
```
src/career/settings/
  QABank.tsx                      ← shim: re-export QABankLayout (legacy import paths)
  qa-bank/
    QABankLayout.tsx              ← top tab bar (NavLink) + <Outlet />
    Legal.tsx                     ← ATS form 4 section
    Templates.tsx                 ← MarkdownDocEditor wrapper
    History.tsx                   ← read-only table + search
```

CSS 全部追加到 `ats-form.css`：`.c-qa-tabs` (top tab bar with bottom underline) + `.c-qa-history-*` (table + badges + empty state)。

## Locked Design Decisions (long-term-best, plan-milestones Phase 3)

| Q | Choice | Rationale |
|---|---|---|
| Q1 Tabs | **Nested routes** | URL 可分享 / refresh-stable / browser back works |
| Q2 history schema | `+ field_type + model_used` (skip cost — dup with `llm-costs.jsonl`) | 飞轮按 Class 聚合 + cost-vs-quality 分析需要 |
| Q3 history search | **Client-side** (useMemo on rows) | <1000 rows 性能足够；前端已传 `?q=` 易升级 server-side |
| Q4 Branch | **Branched off `narrative-proof`** | 1 PR/Room 节奏；narrative-proof merge 后 rebase clean |

**Validation pattern**: partial-save (missing 不阻塞 save，malformed 阻塞)，和 Identity/Preferences 一致。Legal 字段全 `.optional()` — curl `PUT {}` 不 400。

## Specs in this Room

- [intent-qa-bank-001](specs/intent-qa-bank-001.yaml) — 三层 QA Bank：legal.yml + templates.md + history.jsonl
- [change-2026-04-28-m1-qa-bank-backend](specs/change-2026-04-28-m1-qa-bank-backend.yaml) — m1 backend 6 endpoints
- [change-2026-04-28-m2-qa-bank-ui-legal-templates](specs/change-2026-04-28-m2-qa-bank-ui-legal-templates.yaml) — m2 nested routes + Legal/Templates UI + History 占位
- [change-2026-04-28-m3-qa-bank-history-table](specs/change-2026-04-28-m3-qa-bank-history-table.yaml) — m3 History table + search (ROOM COMPLETE)

## Downstream Callers

- **`07-applier/03-field-classifier` (Class 2 Legal)** → `GET /api/career/qa-bank/legal` 返回固定值，纯查表不走 LLM
- **`07-applier/03-field-classifier` (Class 3 Open)** → `GET /api/career/qa-bank/templates` 模板匹配 + 填变量 + LLM 润色
- **`07-applier/*` (apply 完成)** → `POST /api/career/qa-bank/history` 追加 Q&A record (飞轮数据源)
- **未来 Applier 飞轮 features**:
  - Few-shot prompt: 起草新答案前读最近 5 条同 `field_type` 的 history
  - `edit_distance` 分析: 识别哪些 template 经常被重写
  - `model_used` + `edit_distance` 散点: quality-vs-cost analysis

**⚠️ 重要**: 本 feature 是 partial-save permissive backend — 下游消费者 MUST re-check completeness at use-time（Applier 启动 apply 前检查 legal 必要字段是否填完，否则不能去填 ATS）。

## Sprint 2 — Profile DONE 🎉

`02-profile` 4/4 features ✅:
- ✅ 01-identity (3 milestones)
- ✅ 02-preferences (3 milestones)
- ✅ 03-narrative-proof (3 milestones)
- ✅ 04-qa-bank (3 milestones, this ROOM)

共 ~3500 lines, 12 milestones. Sprint 3 起手: `03-cv-engine` + `04-renderer` (多简历 + PDF 生成)。

---

_Completed 2026-04-28 via dev skill (3 milestones × plan-milestones)._
