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

---

_Generated 2026-04-22 by room-init._
