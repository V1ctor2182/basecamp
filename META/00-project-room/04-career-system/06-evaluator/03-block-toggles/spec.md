# Block Toggles

**Room ID**: `00-project-room/04-career-system/06-evaluator/03-block-toggles`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/06-evaluator`  

## Intent

UI 可配的 Block A-G 启用开关 + 预估 token / 成本差实时显示

让用户通过 preferences.yml.evaluator_strategy.stage_b_blocks 控制 Stage B 产出哪些 Block。每个 Block 可独立 enabled true/false：A Role Summary / B CV Match（必开）/ C Level Strategy / D Comp Demand（最省钱，关掉省 WebSearch $0.05-0.10）/ E Personalization（必开，Tailor 依赖）/ F Interview Plan（最长 block，早期关掉、拿到面试再开）/ G Posting Legitimacy。关掉的 block 在 prompt 里跳过 → Sonnet 调用更短 → 成本降低 + 输出更聚焦。支持细化配置：D 可以单独关 tools_allowed.websearch（只基于 JD 推断）、F 可以调 story_count（默认 6-10）、G 可以关 tools_allowed.playwright（只基于 posted_at 推断）。UI Settings → Evaluator → Report Blocks 页：checkbox 列表每项显示预估 token 数 + 依赖工具；右下角实时预估每次 Sonnet 调用成本（对比全开）。验收：关闭 D + F 后下次跑 Stage B，reports/{jobId}.md 里只有 A/B/C/E/G 五个 block；总 token 和成本明显降低。

## Specs in this Room

- [intent-block-toggles-001](specs/intent-block-toggles-001.yaml) — UI 可配的 Block A-G 启用开关 + 预估 token / 成本差实时显示

## 当前进度 — m0/3 (planned 2026-05-08, 0%)

3 milestones, ~550 LOC + ~250 smoke. **复用 already-shipped infra**: `BLOCK_META` 7-card UI grid + `EvaluatorStrategySchema.stage_b.blocks` zod 校验 + `resolveEnabledBlocks(prefs)` in stageBPrompt.mjs + `anthropicPricing.mjs`. 0 open questions. 单方案路径. Closes 06-evaluator at 100% (5/5 ROOMs ✅).

**Re-scoped from raw intent** based on already-shipped infrastructure:
- **Block A-G toggles**: already shipped in 02-stage-b-sonnet (`block_b/c/d/e/f/g` schema) + Preferences.tsx (`BLOCK_META` 7-card grid with lock state for A/B/E)
- **This Room only adds**: (1) fine-grained sub-toggles for D/F/G; (2) per-block cost estimates display; (3) total cost projection card

- ⏳ **m1-fine-grained-subtoggles** (~180 + smoke ~110) — 3 flat schema keys: `block_d_websearch` (saves ~$0.05/call when off → JD inference only), `block_f_story_count` (3-20, default 8 — controls Block F STAR+R count), `block_g_playwright` (when off → posted_at heuristic only). Wired into stageBPrompt.mjs via new `resolveStageBToolPolicy(prefs)` + per-block instruction overrides.
- ⏳ **m2-block-cost-estimates-module** (~140 + smoke ~50) — Pure-constants ESM module `blockCostEstimates.mjs`: `BLOCK_TOKEN_ESTIMATES` per letter + `TOOL_COST_ADD` (web_search $0.05, playwright $0) + `estimateStageBCost(prefs)` helper returning `{per_block, cached_input, total_per_call_current, total_per_call_all_on, delta_savings}`. No new HTTP endpoint.
- ⏳ **m3-preferences-ui-cost-preview-and-room-complete** (~230 + smoke ~30) — Wire m2 helper into Preferences.tsx Stage B Blocks section: per-block cost badges (`+$0.XX/call` enabled, strikethrough disabled), 3 sub-controls (D websearch toggle, F story_count input, G playwright toggle), bottom-of-section projection card ("Per call: $0.XX (vs all-on $0.YY) → save $0.ZZ, NN%"). + ROOM COMPLETE rollups.

### Locked design (single recommended path)

| Decision | Choice |
|----------|--------|
| Sub-toggle nesting | Flat keys (`block_d_websearch` not `block_d.websearch`) — preserves YAML migration as default-fill |
| Cost estimate source | Pure constants module (illustrative); refining from `llm-costs.jsonl` history is future-work, not blocking |
| Cost projection display | "Per call $0.XX (vs all-on $0.YY → save $0.ZZ, NN%)" with explicit "Estimates only" caveat |
| F story_count range | 3-20, default 8 (replaces hardcoded "6-10" in current prompt) |
| Tool cost | web_search hosted ~$0.05, verify_job_posting Playwright local $0 |

### Deferred (out of scope this Room)

- Dynamic cost estimates from `llm-costs.jsonl` history (per-block cost projection from real runs)
- Per-block disable-on-budget hint (banner suggests which blocks to disable when paused — defer to a future budget-gate sibling Room or a 03-block-toggles followup)
- Block reordering / custom block letters

### 下游 contracts

- 06-evaluator sub-epic 100% closed after this Room (5/5 ROOMs ✅)
- 07-applier remains the next flagship sub-epic

---

_Generated 2026-04-22 by room-init. Plan refined 2026-05-08 by plan-milestones._
