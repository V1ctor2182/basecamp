# Auto-Select

**Room ID**: `00-project-room/04-career-system/03-cv-engine/04-auto-select`  
**Type**: feature  
**Lifecycle**: active ✅  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/03-cv-engine`  

## Intent

基于 `metadata.match_rules` 的自动选 base resume 逻辑 + UI tester

投某个 Job 时自动选最匹配的 base resume — pure keyword scoring (no LLM): role_keywords 命中 role → +1, jd_keywords 命中 jd_text → +1, negative_keywords 命中 → −2. Tie-break: is_default first → created_at asc. 无正面命中 → fallback to is_default. 后端 endpoint + Resumes Gallery 内嵌 tester (paste JD + role → 看 picked + rankings + matched keywords).

## Implementation Summary

**2 milestones 完成**（2026-04-29）— ~520 lines net:

- ✅ **m1-auto-select-backend** (`765ed8a`, 110 lines, server.mjs) — `AutoSelectRequestSchema` + `matchKeywords` (case-insensitive substring, count-once) + `scoreResumeAgainstJd` + `buildPickReason` + `POST /api/career/resumes/auto-select`. 8/8 smoke ✓. 49KB JD < 12ms.
- ✅ **m2-auto-select-tester-ui** (TBD, 412 lines, ROOM COMPLETE) — Resumes Gallery 顶部 "Test auto-select" toggle button (Sparkles icon) → 折叠区 (role input + JD textarea + Run) → 结果: picked card + reason + fallback badge + 折叠 rankings table (per-resume score + matched keywords inline pills 绿正/红负).

## Backend API

### `POST /api/career/resumes/auto-select`
Body: `{ jd_text: string (max 50_000), role?: string (max 200) }`

Returns:
```json
{
  "picked": "backend",
  "picked_score": 6,
  "picked_reason": "Matched 2 role keywords, 4 jd keywords",
  "fallback_to_default": false,
  "rankings": [
    {
      "id": "backend",
      "title": "Backend SDE",
      "score": 6,
      "matched": {
        "role_keywords": ["Backend", "SDE"],
        "jd_keywords": ["k8s", "microservices", "grpc", "kafka"],
        "negative_keywords": []
      },
      "is_default": true,
      "created_at": "..."
    },
    ...
  ]
}
```

**Errors**: 400 Zod / 404 no resumes / 500 internal.

## Frontend UI (`/career/settings/resumes`)

**Toolbar adds "Test auto-select" button** (Sparkles icon, only when resumes exist) → expands `.c-resumes-tester-panel`:

- Help text: explains tester purpose + `match_rules` mention
- Inputs:
  - Role (text, max 200, optional)
  - JD textarea (max 50_000, mono font, char counter "{N} / 50,000")
  - Run button (disabled if !JD || loading)
- Result card (shown after Run):
  - **Picked**: title + mono `id` + big score
  - Reason text + fallback badge (yellow) when applicable
  - Toggle button "Show all rankings ({count})" with chevron
  - Rankings table (default collapsed): # / id / title / score / role kw / jd kw / negative
    - Picked row highlighted (blue bg + bold)
    - Matched keywords as inline pills (green positive / red negative, mono font)
- Close: X button or re-click toolbar

## Locked Design Decisions (long-term-best, plan-milestones)

| Q | Choice | Rationale |
|---|---|---|
| Algorithm | **Keyword scoring (not LLM)** | 3-5 base resumes 不需 LLM 细微; transparent + free + deterministic |
| Score formula | **+1 role / +1 jd / −2 negative** linear | Simple + 易理解; metadata.yml 后续可加 weight override 字段 |
| Same kw multi-match | **Count once** | 防 jd 灌水关键词刷分 |
| Negative kw | **Soft penalty (−2), not hard exclude** | Overridable; user can pick anyway |
| Tie-breaker | **`is_default` first → `created_at` asc** | Established resume 优先 |
| String match | **Case-insensitive substring** (no `\b`) | Cheap; keywords are slug-y |
| No-match fallback | **Always returns one picked** + `fallback_to_default` flag | 前端不用处理 "无 picked" 状态 |
| Tester UI | **Toolbar 折叠区, NOT modal** | 不打断 gallery 节奏 |
| Tester input persist | **No localStorage** | 测试性质 |
| Branch | **Off `in-ui-editor`** | 1 PR/Room rhythm |

## Specs in this Room

- [intent-auto-select-001](specs/intent-auto-select-001.yaml) — 基于 `metadata.match_rules` 的自动选 base resume 逻辑 + UI override
- [change-2026-04-29-m1-auto-select-backend](specs/change-2026-04-29-m1-auto-select-backend.yaml) — m1 backend
- [change-2026-04-29-m2-auto-select-tester-ui](specs/change-2026-04-29-m2-auto-select-tester-ui.yaml) — m2 tester UI (ROOM COMPLETE)

## Downstream Callers

- `03-cv-engine/05-tailor-engine` → 调本 endpoint 选 base 后 LLM 改写
- `06-evaluator/02-stage-b-sonnet` → 后续可参考 picked + matched 给 Block E (Resume Hooks) 提示
- `07-applier` → 真正 apply 时调本 endpoint
- (Optional) `08-human-gate-tracker` → Pipeline UI 显示 "auto-selected resume: X" 让用户 override

🎉 **3rd 03-cv-engine ROOM complete**. 03-cv-engine 60% (3/5 features ✅).

---

_Completed 2026-04-29 via dev skill (2 milestones × plan-milestones)._
