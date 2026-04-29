# Auto-Select

**Room ID**: `00-project-room/04-career-system/03-cv-engine/04-auto-select`  
**Type**: feature  
**Lifecycle**: in_progress  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/03-cv-engine`  

## Intent

基于 metadata.match_rules 的自动选 base resume 逻辑 + UI override

投某个 Job 时自动选最匹配的 base resume。打分规则：遍历所有 resume 的 metadata.match_rules，role_keywords 命中 Job.role → +10 分；jd_keywords 命中 Job.description（每条）→ +2 分；negative_keywords 命中 → -20 分。选分数最高的那份（tie-break 按 index.yml 顺序）。如果最高分 < 10，用 is_default=true 的那份。后端 GET /api/career/cv/auto-select?jobId=xxx 返回 {resumeId, score, hits: [命中的 keyword 列表]}。UI 在 Pipeline / Apply 页显示 "当前选用 resume: backend（匹配分 18：命中 backend / distributed / microservices / kafka）"，下拉可一键 override 到其他 resume。验收：对 3 个不同方向的 Job 分别跑 auto-select，得到对应 backend / applied-ai / fullstack 的推荐 + 合理的分数解释；手动 override 成功写入。

## Milestones (planned 2026-04-29)

**2 milestones 规划完成**（~360 lines 估算，1/2 完成，all defaults 长期最优锁定）:

- ✅ **m1-auto-select-backend** (TBD, 110 lines 实际, server.mjs) — pure keyword scoring + endpoint:
  - `AutoSelectRequestSchema` body `{ jd_text, role? }`
  - `scoreResume` per resume: `+1 × role_kw matched in role` + `+1 × jd_kw matched in jd_text` − `2 × negative_kw matched in jd_text`
  - Sort by score desc → is_default first → created_at asc
  - `POST /api/career/resumes/auto-select` returns `{ picked, picked_score, picked_reason, fallback_to_default, rankings: [{id, title, score, matched: {role_keywords[], jd_keywords[], negative_keywords[]}}] }`
- **m2-auto-select-tester-ui** (~200 lines, ROOM COMPLETE) — Resumes Gallery toolbar 折叠区:
  - JD textarea + role input + Run button
  - Result: large picked card + reason + folded rankings table (per-resume score + matched keywords as colored pills)

**Locked design decisions** (long-term-best, no questions to user):

| Q | Choice | Why |
|---|---|---|
| Algorithm | **Keyword-based scoring (not LLM)** | 3-5 base resumes 不需 LLM 细微; transparent + free + deterministic + 用户可 debug |
| Score formula | **+1 role_kw / +1 jd_kw / −2 negative_kw** (linear) | Simple + 易理解 + 不调参 |
| Same kw multiple matches | **Count once** | 防 jd 灌水关键词刷分 |
| Negative keywords | **Soft penalty (−2), not hard exclude** | Overridable; user can still pick anyway |
| Tie-breaker | **`is_default` first → `created_at` asc** | Established resume 优先 |
| String match | **Case-insensitive substring** (no `\b`) | 跑 "k8s" 匹配 "k8s/" cheap; keyword 是 slug-y 不会 false positive |
| No-match fallback | **Always returns one picked** + `fallback_to_default: true` flag | 前端不用处理 "无 picked" 状态 |
| Tester UI placement | **Toolbar 折叠区, NOT modal** | 不打断 gallery 节奏 |
| Persist tester input | **No localStorage** | 测试性质 |
| Branch | **Off `in-ui-editor`** (PR #11 pending) | 1 PR/Room rhythm |

**输出契约**: 这是 03-cv-engine 第 3 个 ROOM；完成后 03-cv-engine 60% (3/5 features). 后续 05-tailor-engine 调本 endpoint 选 base 后做 LLM 改写。

## Specs in this Room

- [intent-auto-select-001](specs/intent-auto-select-001.yaml) — 基于 metadata.match_rules 的自动选 base resume 逻辑 + UI override
- [change-2026-04-29-m1-auto-select-backend](specs/change-2026-04-29-m1-auto-select-backend.yaml) — m1 keyword scoring algorithm + endpoint

---

_Milestones planned 2026-04-29 via plan-milestones skill._
