# Block Toggles

**Room ID**: `00-project-room/04-career-system/06-evaluator/03-block-toggles`  
**Type**: feature  
**Lifecycle**: active (ROOM COMPLETE 2026-05-08)  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/06-evaluator`  

## Intent

UI 可配的 Block A-G 启用开关 + 预估 token / 成本差实时显示

让用户通过 preferences.yml.evaluator_strategy.stage_b_blocks 控制 Stage B 产出哪些 Block。每个 Block 可独立 enabled true/false：A Role Summary / B CV Match（必开）/ C Level Strategy / D Comp Demand（最省钱，关掉省 WebSearch $0.05-0.10）/ E Personalization（必开，Tailor 依赖）/ F Interview Plan（最长 block，早期关掉、拿到面试再开）/ G Posting Legitimacy。关掉的 block 在 prompt 里跳过 → Sonnet 调用更短 → 成本降低 + 输出更聚焦。支持细化配置：D 可以单独关 tools_allowed.websearch（只基于 JD 推断）、F 可以调 story_count（默认 6-10）、G 可以关 tools_allowed.playwright（只基于 posted_at 推断）。UI Settings → Evaluator → Report Blocks 页：checkbox 列表每项显示预估 token 数 + 依赖工具；右下角实时预估每次 Sonnet 调用成本（对比全开）。验收：关闭 D + F 后下次跑 Stage B，reports/{jobId}.md 里只有 A/B/C/E/G 五个 block；总 token 和成本明显降低。

## Specs in this Room

- [intent-block-toggles-001](specs/intent-block-toggles-001.yaml) — UI 可配的 Block A-G 启用开关 + 预估 token / 成本差实时显示

## 当前进度 — 🎉 ROOM COMPLETE (2026-05-08, 3/3 milestones, 100%)

3 milestones, ~550 LOC + ~250 smoke. **复用 already-shipped infra**: `BLOCK_META` 7-card UI grid + `EvaluatorStrategySchema.stage_b.blocks` zod 校验 + `resolveEnabledBlocks(prefs)` in stageBPrompt.mjs + `anthropicPricing.mjs`. 0 open questions. 单方案路径. Closes 06-evaluator at 100% (5/5 ROOMs ✅).

**Re-scoped from raw intent** based on already-shipped infrastructure:
- **Block A-G toggles**: already shipped in 02-stage-b-sonnet (`block_b/c/d/e/f/g` schema) + Preferences.tsx (`BLOCK_META` 7-card grid with lock state for A/B/E)
- **This Room only adds**: (1) fine-grained sub-toggles for D/F/G; (2) per-block cost estimates display; (3) total cost projection card

- ✅ **m1-fine-grained-subtoggles** (~190 + smoke ~150, **14/14 green**) — 3 flat schema keys nested under `prefs.evaluator_strategy.stage_b.blocks`: `block_d_websearch` (bool, default true; off → JD inference only, saves ~$0.05/call), `block_f_story_count` (int 3-20, default 8 — controls Block F STAR+R count), `block_g_playwright` (bool, default true; off → posted_at heuristic only). NEW `resolveStageBToolPolicy(prefs)` returns `{websearch_for_d, playwright_for_g, story_count}` with clamping + non-integer fallback. NEW `renderSubToggleOverrides()` injects per-block override instructions when sub-toggles diverge from defaults — gated on `enabled.has(letter)` so disabled parents skip child overrides. Spread-conditional injection preserves byte-equality with pre-m1 prompt on the all-defaults path (preserves Anthropic prompt-cache). Plan-agent review: 0 CRITICAL + 1 HIGH (cache-key regression — fixed) + 2 MEDIUM + 2 LOW.
- ✅ **m2-block-cost-estimates-module** (~165 + smoke ~210, **9/9 green**) — Pure-constants ESM module `blockCostEstimates.mjs`: deep-frozen `BLOCK_TOKEN_ESTIMATES` per letter + `TOOL_COST_ADD` (web_search $0.05, playwright $0) + `estimateStageBCost(prefs)` helper returning `{model, pricing_available, per_block, cached_input, total_per_call_current, total_per_call_all_on, delta_savings_usd, delta_savings_pct}`. Pure function — render-path safe. All-on baseline is FIXED reference (always assumes every block + tool on) so disabling a tool shows as savings. F story_count uses live policy for both current AND baseline. `pricing_available` flag surfaces missing MODEL_PRICING entry. Plan-agent review: 0 CRITICAL + 1 HIGH (shallow freeze — fixed with deepFreeze) + 2 MEDIUM (pricing miss → flag; smoke gaps → added G-disabled + G-playwright-off + empty-prefs).
- ✅ **m3-preferences-ui-cost-preview-and-room-complete** (~135 + smoke ~150, **3/3 green**) — Wired m2's `estimateStageBCost` into Preferences.tsx Stage B Blocks section. Per-card cost badge (+$X.XXXX/call enabled, strikethrough $X.XXXX saved when disabled). Three sub-controls inside D/F/G cards: D web_search checkbox (saves ~$0.05/call when off), F story_count integer input (3-20, default 8, onChange clamps + integer-coerces), G Playwright checkbox (local $0 marginal). Sub-controls disabled when parent block off. Cost projection card below grid: per-call current vs all-on baseline + savings line + caveat (first-call write surcharge + pricing_available warning when MODEL_PRICING missing). NEW `blockCostEstimates.d.ts` for discriminated per-letter type narrowing in TS consumers. Plan-agent review: 0 CRITICAL + 1 HIGH (.d.ts type widening — fixed) + 3 MEDIUM (useMemo dep narrowed; savings-zero wording fixed; F input acceptable) + 6 LOW. ROOM COMPLETE rollups: room.yaml planning→active, _tree.yaml synced, 06-evaluator 80%→100% (5/5 ROOMs ✅), 04-career-system 74%→78%.

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
