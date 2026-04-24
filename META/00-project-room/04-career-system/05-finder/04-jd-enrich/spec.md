# JD Enrich

**Room ID**: `00-project-room/04-career-system/05-finder/04-jd-enrich`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/05-finder`  

## Intent

JD 补全阶段：API refetch / Playwright scrape / manual fallback

大部分 source（尤其 github-md）只给 URL + 岗位名 + 公司，没有 JD 正文。Evaluator 需要 description 才能打分，所以在 pipeline → evaluator 之间插入 enrich 阶段。优先级：(1) 如果 Job.description 长度 > 500 字符 → 跳过；(2) 源是 Greenhouse / Ashby / Lever → 重新调 API 的 content endpoint 拉完整 JD 正文（快、稳、免费）；(3) 其他源 → Playwright headless 打开 Job.url，等 DOM 渲染，读 main content 区域文本（过滤 nav / footer）；(4) 都失败 → 标 Job.needs_manual_enrich = true，UI 上显示红色提示让用户手动贴 JD。注意：本阶段必须在 hard_filter 之后跑（不要给已经被过滤掉的岗位花 2-5 秒）。Playwright 每个 JD ~2-5s，100 个 enrich 约 5 分钟批处理跑完。验收：对一批去重 + hard filter 后的 ~30 个 job，enrich 后 description 非空率 ≥ 90%；needs_manual_enrich 标记的条目 UI 有提示可手动补。

## Constraints

必须在 hard_filter 之后跑 + 失败必须显式标 needs_manual_enrich

(1) JD Enrich MUST 在 hard_filter 之后执行 — 对已被 filter 丢掉的岗位不抓 JD（避免 2-5s × 被过滤数的无效开销 + 避免 Playwright 过多并发）；(2) 三层 fallback 的**任何一层**失败都 MUST 显式设置 Job.needs_manual_enrich = true，绝不能返回空 description 静默继续（否则 Evaluator 会在没 JD 的情况下瞎评）；(3) Playwright 每个 URL MUST 有超时（默认 15s），超时标 manual；(4) description 长度 > 500 视为已有，跳过 enrich（避免重复抓）。

## Specs in this Room

- [intent-jd-enrich-001](specs/intent-jd-enrich-001.yaml) — JD 补全阶段：API refetch / Playwright scrape / manual fallback
- [constraint-jd-enrich-001](specs/constraint-jd-enrich-001.yaml) — 必须在 hard_filter 之后跑 + 失败必须显式标 needs_manual_enrich

---

_Generated 2026-04-22 by room-init._
