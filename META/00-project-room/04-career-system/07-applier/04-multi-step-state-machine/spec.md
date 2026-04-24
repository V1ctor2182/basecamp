# Multi-Step State Machine

**Room ID**: `00-project-room/04-career-system/07-applier/04-multi-step-state-machine`  
**Type**: feature  
**Lifecycle**: backlog  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/07-applier`  

## Intent

Workday / iCIMS 多步表单状态机 + field_memory + 中断恢复

处理 Workday / iCIMS / SuccessFactors 等分 5-8 步的表单。状态模型持久化到 data/career/apply-sessions/{jobId}.json：site_adapter / job_url / current_step / total_steps / per_step_draft / per_step_status (filled/pending) / field_memory (跨步复用已填值) / started_at / last_activity_at。状态机：INIT → DETECT_FLOW（识别 site adapter + 总步数）→ STEP_LOOP(SCAN_FIELDS → CLASSIFY+DRAFT → USER_APPROVE 每步独立批准 → FILL → NEXT_BUTTON_CLICK → WAIT_DOM_READY) → 重复直到遇到 Submit → COMPLETE。关键：(1) Total steps 探测 — UI progress indicator → 侧边栏 step 列表 → 探索式前进；(2) Next button — 存在 site adapter 里的 selector，fallback 到 has-text("Next|Continue")；(3) field_memory — Step 1 填的 firstName 在 Step 5 "First Name (confirm)" 直接复用不打扰用户；(4) 依赖字段 — 填完某字段后 MutationObserver 监听 DOM 变化，新字段加入当前 step 补一次批准；(5) 中断恢复 — dashboard 重启后看到 "Resumable session: Anthropic (step 3/7)" 点 Resume → 按 per_step_status 跳过已填步骤。超时 30 分钟保留 session 给下次。验收：对一个 Workday 岗位完整跑 5 步，每步独立批准 + 填 + Next，最终停在 Submit 按钮前；中途重启 dashboard 能 Resume 到 step 3。

## Constraints

每步独立批准 + field_memory 跨步复用 + 30 分钟 session 保留

(1) Multi-step 流程的每一步 MUST 独立让用户批准（不允许"一键完成所有步骤"—— 每步中间 DOM 状态不一样，漏 review 一步可能全盘错）；(2) field_memory 跨步复用 MUST 实现：Step 1 填的 firstName，Step 5 再出现 firstName-confirm 字段时直接用 memory 的值，不重复调 LLM 起草、不二次打扰用户；(3) 用户 30 分钟不操作 MUST 保留 session state（per_step_status / field_memory 写到 data/career/apply-sessions/{jobId}.json），下次 resume 能从 step N 继续；session > 24h 自动归档为 abandoned；(4) 每步 FILL 前 MUST 等 DOM 稳定（networkidle 或 selector present），不能盲填；(5) MutationObserver 观察到依赖字段出现后 MUST 重跑当前 step 的 classifier + 补一次批准（不能偷偷填新字段）。

## Specs in this Room

- [intent-multi-step-state-machine-001](specs/intent-multi-step-state-machine-001.yaml) — Workday / iCIMS 多步表单状态机 + field_memory + 中断恢复
- [constraint-multi-step-state-machine-001](specs/constraint-multi-step-state-machine-001.yaml) — 每步独立批准 + field_memory 跨步复用 + 30 分钟 session 保留

---

_Generated 2026-04-22 by room-init._
