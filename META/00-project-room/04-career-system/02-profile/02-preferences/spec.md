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

## Specs in this Room

- [intent-preferences-001](specs/intent-preferences-001.yaml) — preferences.yml CRUD + Settings → Preferences 页（含 hard_filters 编辑器）
- [constraint-preferences-001](specs/constraint-preferences-001.yaml) — hard_filters 必须按短路顺序评估 + 任一 drop 立刻 archive

---

_Generated 2026-04-22 by room-init._
