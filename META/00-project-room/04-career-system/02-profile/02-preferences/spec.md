# Preferences (你想要什么)

**Room ID**: `00-project-room/04-career-system/02-profile/02-preferences`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/02-profile`  

## Intent

preferences.yml CRUD + Settings → Preferences 页（含 hard_filters 编辑器）

所有"主观判断 / 筛选规则 / 评分权重"的集中配置：targets（目标岗位 / seniority）、comp_target（薪资区间）、location（accept_any / remote_only / hybrid_max_days_onsite）、hard_filters（9 种规则：company_blocklist / title_blocklist / title_allowlist / jd_text_blocklist / location / seniority / posted_within_days / comp_floor / source_filter）、soft_preferences、scoring_weights、thresholds（strong/worth/consider/skip_below）、evaluator_strategy（stage_a/stage_b 配置 + Block 开关）。Finder、Evaluator、Shortlist UI 都读它。前端 Settings → Preferences 页：结构化表单编辑（tag input 组件用于关键词列表，CodeMirror 后门编辑完整 YAML），支持 preview dry-run（用当前 pipeline 最近 100 岗位跑一遍看 drop 变化）+ git 历史（追踪偏好演化）。preferences.yml commit 进 git。验收：修改 hard_filters 后 preview 能看到新增 drop 的岗位；保存后 Finder 下次 scan 用新规则。

## Constraints

hard_filters 必须按短路顺序评估 + 任一 drop 立刻 archive

9 种 hard filter 的评估顺序（从便宜到贵，MUST 按此顺序实现 short-circuit）：(1) source_filter（最先省掉整个源）→ (2) company_blocklist → (3) title_blocklist / title_allowlist → (4) location → (5) seniority → (6) posted_within_days → (7) comp_floor → (8) jd_text_blocklist（最后，依赖 JD Enrich 完成）。任一规则判定 drop → 立即写 archive.jsonl + 归档，不进入下游 / 不评估后续规则。这个顺序保证成本和速度最优（不读 JD 正文的规则先做）。archive 记录 MUST 写 {job_id, matched_rule_id, matched_value, ts}，便于回溯 "为什么这个岗位被过滤了"。

## Milestones (planned 2026-04-23)

**3 milestones 规划完成**（~600 lines 估算，1/3 完成）:

- ✅ **m1-preferences-backend** (`0b5b617`, 220 lines 实际) — `server.mjs` Zod PreferencesSchema (permissive, partial-save 风格) + GET/PUT `/api/career/preferences` + defaultPreferences() 兜底
- **m2-preferences-form-static** (~280 lines) — `Preferences.tsx` 前 6 Section (Target Roles / Compensation / Location / Soft Preferences / Scoring & Thresholds / Evaluator Strategy) + 新 `TagInput.tsx` 共享组件 + ats-form.css 追加样式
- **m3-hard-filters-editor** (~180 lines) — Section 7 Hard Filters (9 sub-sections, ordinal-labeled 短路顺序 ①–⑧) + Preview dry-run bar (UI + backend stub 返 mock breakdown)

**Locked design decisions** (plan-milestones Phase 3):

| Q | Choice | Rationale |
|---|---|---|
| Q1 scoring_weights UI | **(a) 5 manual sliders + sum-validate warning** | 简单直接；sum≠1.0 给红字警告但不 block save（partial-save 精神） |
| Q2 stage_b_blocks UI | **(c) cards with descriptions** | 6 Block 需要说明用途；Block B/E card disabled + "Required by Tailor" badge |
| Q3 Preview dry-run | **(a) UI + backend stub (mock data)** | 先把 UX 上完整；真实逻辑等 05-finder/03-dedupe-hard-filter；stub response 带 `stub: true` 让前端显示 ⚠️ |
| Q4 TagInput 位置 | **(a) 共享 `src/career/TagInput.tsx`** | 后续 QA Bank / site-adapters / narrative 都要用 |

**Validation pattern**: 和 m3-identity 一致的 partial-save — missing 不阻塞 save，malformed (format 错) 阻塞。Applier / Finder / Evaluator use-time 必须 re-check completeness。

## Specs in this Room

- [intent-preferences-001](specs/intent-preferences-001.yaml) — preferences.yml CRUD + Settings → Preferences 页（含 hard_filters 编辑器）
- [constraint-preferences-001](specs/constraint-preferences-001.yaml) — hard_filters 必须按短路顺序评估 + 任一 drop 立刻 archive
- [change-2026-04-23-m1-preferences-backend](specs/change-2026-04-23-m1-preferences-backend.yaml) — m1 backend API (PreferencesSchema + GET/PUT + defaults)

---

_Milestones planned 2026-04-23 via plan-milestones skill._
