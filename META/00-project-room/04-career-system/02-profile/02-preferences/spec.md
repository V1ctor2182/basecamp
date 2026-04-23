# Preferences (你想要什么)

**Room ID**: `00-project-room/04-career-system/02-profile/02-preferences`  
**Type**: feature  
**Lifecycle**: active ✅  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/02-profile`  

## Intent

preferences.yml CRUD + Settings → Preferences 页（含 hard_filters 编辑器）

所有"主观判断 / 筛选规则 / 评分权重"的集中配置：targets（目标岗位 / seniority）、comp_target、location（accept_any / remote_only / hybrid）、hard_filters（9 种规则）、soft_preferences、scoring_weights、thresholds、evaluator_strategy（stage_a/stage_b + Block 开关）。Finder / Evaluator / Shortlist UI 都读它。preferences.yml commit 进 git。

## Implementation Summary

**3 milestones 完成**（2026-04-23）— 1579 实际代码行:

- ✅ **m1-preferences-backend** (`0b5b617`, 220 lines) — Backend GET/PUT + Zod PreferencesSchema (permissive) + defaultPreferences()
- ✅ **m2-preferences-form-static** (`e17f096`, 864 lines) — 前 6 Section ATS 风格表单 + shared `TagInput.tsx` + ats-form.css 追加样式
- ✅ **m3-hard-filters-editor** (TBD, 495 lines, ROOM COMPLETE) — Section 7 Hard Filters (8 sub-sections, ordinal ①–⑧) + Preview dry-run bar + backend stub API

## Backend API

### `GET /api/career/preferences`
返回当前 preferences 或 `defaultPreferences()`（文件不存在）。

### `PUT /api/career/preferences`
Body = 完整 preferences。Zod 验证（permissive — partial-save 风格）：
- `targets[]` — 每条 {title, seniority, function?}
- `comp_target` — base/total min/max (都可选) + currency
- `location` — accept_any / remote_only / hybrid_max_days_onsite + cities / countries arrays
- `hard_filters` — 9 规则按短路顺序排列：source_filter → company_blocklist → title_blocklist/allowlist → location → seniority → posted_within_days → comp_floor → jd_text_blocklist
- `soft_preferences` — 6 个偏好 TagInput 数组
- `scoring_weights` — 5 项 weight (0-1)
- `thresholds` — strong / worth / consider / skip_below (1-5 scale)
- `evaluator_strategy` — stage_a/stage_b {enabled, model, threshold} + blocks {b..g}

成功 200 + 完整 record；失败 400 + zod issues。

### `POST /api/career/preferences/preview` (stub, m3)
Dry-run — body 发当前（可未保存）preferences；返回 mock drop breakdown:
```json
{
  "total_jobs": 100, "would_drop": 39, "would_pass": 61, "new_drops": 18,
  "breakdown": [
    {"rule": "source_filter", "drops": 6}, ...
  ],
  "stub": true,
  "note": "Mock data. Real pipeline dry-run ships with 05-finder/03-dedupe-hard-filter."
}
```

**⚠️ Stub only** — Heuristic counts based on non-empty filter entries. 真实逻辑 05-finder/03 实现，前端 UI shape 保持不变。

## Frontend UI (Settings → Preferences)

**ATS 风格 7 Sections** (复用 Identity 的 ats-form.css):

1. **Target Roles** — 加减行 widget (title* + seniority dropdown* + function?)
2. **Compensation** — base/total min/max + currency（全可选，格式错 block save）
3. **Location** — accept_any / remote_only toggle + hybrid days + TagInput cities/countries
4. **Soft Preferences** — 6 TagInput 2×3 grid (company_types / remote_culture / tech_stack / industries)
5. **Scoring & Thresholds** — 5 sliders (0-1) + sum-validate warning (`Sum: 1.00 ✓` / `(should be 1.00)`) + 4 threshold number inputs (strong≥worth≥consider≥skip_below 顺序 check)
6. **Evaluator Strategy** — stage_a/b enabled+model+threshold + **6 Block cards** (2-col grid, Block B/E disabled + "Required by Tailor" badge)
7. **Hard Filters** (8 sub-sections, ordinal-labeled 短路顺序):
   - ① source_filter TagInput
   - ② company_blocklist TagInput
   - ③ title_blocklist + title_allowlist (2 TagInputs 并列)
   - ④ location allowed/disallowed countries + cities
   - ⑤ seniority allowed
   - ⑥ posted_within_days number
   - ⑦ comp_floor base_min/total_min + currency
   - ⑧ jd_text_blocklist (⚠️ 需先 JD Enrich)
   - **Preview bar** at end: "Run Preview" button + 4-stat grid (Total/Drop/Pass/New drops) + collapsible per-rule breakdown + ⚠️ stub warning

**Validation pattern**: partial-save（和 m3-identity 一致）
- missing: targets 空 / 子字段空 → 不阻塞 save
- malformed: comp_target 负数 / thresholds 顺序不对 → 阻塞 save
- scoring_weights sum ≠ 1.0 → warning only (不阻塞)

**Sticky submit bar**: status 左 + "Save Preferences" 按钮右（disabled when `!canSave || saving || !dirty`）。beforeunload 拦截未保存。

## Shared CSS + Components

- **`src/career/TagInput.tsx`** — Enter/Tab/, commit, Backspace 删最后，× 单删；后续 QA Bank / site-adapters / narrative 复用
- **`src/career/settings/ats-form.css`** — 281 → 695 lines：扩展 TagInput / slider / block-card / toggle / strategy-row / subsection / filter-ordinal / preview 样式

## Locked Design Decisions (plan-milestones Phase 3)

| Q | Choice | Rationale |
|---|---|---|
| Q1 scoring_weights UI | **(a) 5 manual sliders + sum-validate warning** | 简单直接；sum≠1.0 给黄字警告但不 block save |
| Q2 stage_b_blocks UI | **(c) cards with descriptions** | 每 Block 需说明；B/E disabled + "Required by Tailor" badge |
| Q3 Preview dry-run | **(a) UI + backend stub** | UX 先上完整；真逻辑 05-finder/03 替换 |
| Q4 TagInput 位置 | **(a) 共享 `src/career/TagInput.tsx`** | 后续多处复用 |

## Specs in this Room

- [intent-preferences-001](specs/intent-preferences-001.yaml) — preferences.yml CRUD + Settings → Preferences 页
- [constraint-preferences-001](specs/constraint-preferences-001.yaml) — hard_filters 短路顺序 + archive
- [change-2026-04-23-m1-preferences-backend](specs/change-2026-04-23-m1-preferences-backend.yaml) — m1 backend API
- [change-2026-04-23-m2-preferences-form-static](specs/change-2026-04-23-m2-preferences-form-static.yaml) — m2 前 6 section + TagInput
- [change-2026-04-23-m3-hard-filters-editor](specs/change-2026-04-23-m3-hard-filters-editor.yaml) — m3 Section 7 + Preview stub (ROOM COMPLETE)

## Downstream Callers

- `05-finder/03-dedupe-hard-filter` → 读 hard_filters 按短路顺序评估（替换 preview stub 的真实实现）
- `05-finder/01-source-adapters` → 读 source_filter.blocked_sources 决定抓哪些源
- `06-evaluator/01-stage-a-haiku` → 读 evaluator_strategy.stage_a.threshold
- `06-evaluator/02-stage-b-sonnet` → 读 evaluator_strategy.stage_b.blocks 决定 prompt
- `06-evaluator/04-budget-gate` → 读 evaluator_strategy (Block 启用开关影响成本)
- `08-human-gate-tracker/02-career-dashboard-views` → 读 thresholds 决定 shortlist 归类

**⚠️ 重要（partial-save 后）**：本 feature 的 backend schema **不强制必填**（允许空字符串 + 空数组 + 缺字段）。下游调用方 **MUST re-check completeness at use-time**：
- Finder 评估 hard_filters 前，确认需要的 array 非空（或全跳过）
- Evaluator 读 thresholds 前，确认 strong ≥ worth ≥ consider（前端已 block malformed，但防御性 check）
- scoring_weights sum ≠ 1.0 时 Evaluator 应归一化（前端仅 warning，允许 save）

---

_Completed 2026-04-23 via dev skill (3 milestones × plan-milestones)._
