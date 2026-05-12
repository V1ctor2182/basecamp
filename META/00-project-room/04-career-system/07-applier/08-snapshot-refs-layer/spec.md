# Snapshot+Refs Layer

**Room ID**: `00-project-room/04-career-system/07-applier/08-snapshot-refs-layer`
**Type**: feature
**Lifecycle**: planning (Mode 2 LOCKED 2026-05-11)
**Owner**: backend
**Parent**: `00-project-room/04-career-system/07-applier`

## Intent

Token-efficient LLM-facing page abstraction — snapshot + symbolic refs (借鉴 Vercel agent-browser)

Mode 2 Full Agent 的 LLM-facing 抽象层，sits between 02-playwright-runtime (Chromium 底座) and 03-field-classifier / 04-multi-step-state-machine / 05-non-standard-controls / 06-site-adapters (所有需要"看页面 → 决定动作"的消费者)。核心问题：传统方案让模型看完整 a11y 树 / DOM dump (~7000-8000 tokens 每个 apply 页面)，token 贵 + 模型瞎猜 selector。本 Room 实现 7 层：(1) **snapshot(page, interactive=true)** 过滤 a11y 树到 interactive roles，每 node 一行 `- role "name" [ref=eN]` 压到 200-400 tokens (~20× 节省)；(2) **Ref table** 计数器 mint `eN`，server 端 Map `{ eN → ElementHandle }` per-Page 作用域 (跟 Playwright Page 生命周期对齐)；(3) **Symbolic action API** `click @e2` / `fill @e3 "value"` / `upload @e6 "/path.pdf"` — resolve `@eN` → 内部 handle，模型 NEVER sees DOM ids/classes/XPaths；(4) **Pessimistic invalidation** — 任何 mutating action 后立刻 mark stale (不依赖 framenavigated/domcontentloaded — SPA 路由会绕过它们，Greenhouse/Lever/Ashby/Workday 全是 SPA)；(5) **统一错误码** — Playwright 原生 errors 翻译成 `STALE_REF` / `UNKNOWN_REF` / `ELEMENT_GONE` / `ACTION_TIMEOUT`，每个带 "call snapshot first" hint；(6) **iframe inline-recurse** — V1 把 iframe 内容内联进父 snapshot，ref 全局编号 (Greenhouse 90% form 在 iframe 里，强制 LLM 切 frame 体验差)；(7) **Daemon warmth** — server.mjs 内 module 单例常驻，per-call <200ms。下游 unblocked: 03/04/05/06。

## Constraints (硬铁律)

- **C1 [MUST NOT]** 暴露 raw Playwright API 给 LLM tool surface (page.locator / page.eval / setInputFiles 等都不行)。Fallback 通道一旦存在，模型会偷懒回去写 selector，整层抽象失效
- **C2 [MUST NOT]** Snapshot 输出含 DOM id / class / XPath / CSS selector / inline-style / data-*。只允许 role / accessible-name / ref / 必要 ARIA state (checked/selected/expanded/disabled/required)
- **C3 [MUST]** 每个 mutating action 后 pessimistic invalidate ref table (不靠 framenavigated — SPA 会绕过)
- **C4 [MUST]** Playwright 原生 errors 翻译成统一错误码 + hint
- **C5 [MUST]** DOM-only V1，screenshot 是 explicit 命令不混入 snapshot
- **C6 [MUST NOT]** 自写 credential vault — 用 Playwright storage_state + 一次性 headful 手动登录

## Open Questions (plan-milestones 时锁)

| ID | 问题 | 推荐 |
|----|------|------|
| Q1 | iframe inline-recurse vs explicit frame switch? | inline-recurse (default) |
| Q2 | heading 节点保留作 navigation aid? | keep (Workday 多步表单需要) |
| Q3 | click/fill 默认 timeout? | 10s + per-action override |
| Q4 | Icon button (name='') 怎么处理? | fallback aria-label → title → skip |
| Q5 | Drag-drop file upload V1 支持? | V1 不支持 (归 06-site-adapters) |
| Q6 | Ref ID 格式 `e1` vs `[1]` vs `r1`? | `e1` (agent-browser parity) |

## Specs in this Room

- [intent-snapshot-refs-layer-001](specs/intent-snapshot-refs-layer-001.yaml) — Token-efficient LLM-facing page abstraction — snapshot + symbolic refs (借鉴 Vercel agent-browser)

## Why this Room exists

研究 2026-05-11 — Vercel Labs 在 2026-01 发布 `agent-browser` (Rust CLI + CDP daemon)，引入 snapshot+refs prompt 模式，号称 vs Playwright MCP token ↓93%。结论 (见 plan-ceo-review-pending-07-applier)：**思路值钱，二进制不值钱** — 把这个 prompt 格式以 ~300-500 LOC TS 移植到我们自己 Playwright 上即可获得全部 token 收益 + 全部 selector 可靠性收益，不引入 4 个月新的 Rust 依赖 (Windows broken + Cloudflare 站点 fail + 社区未验证)。本 Room 是 07-applier 所有 LLM-driven 子 Room (03/04/05/06) 的 foundation。

## Estimated scope

~300-500 LOC TypeScript + ~150-200 LOC smoke (~2-3 milestones)，单独可测可独立 commit。

## 验收 criteria (locked)

- (a) 真实 Greenhouse apply 页 URL (含 iframe), snapshot 输出 < 500 tokens 且 Sonnet 100% 识别 8 个核心字段
- (b) Workday 最坏 case 单步 30-50 fields, snapshot 输出 < 1500 tokens
- (c) ref click/fill 100% 命中 vs Playwright 直接 selector
- (d) DOM 变更 / detach / unknown ref 100% 触发对应错误码 (不 silent 误操作)
- (e) SPA 路由切换 (history.pushState) 后旧 ref 100% stale
- (f) 8 次 snapshot→act→re-snapshot 循环 Playwright context 内部 handle Map 不单调增长 (no leak)

---

_Generated 2026-05-11 by manual add (research-driven; not from PRD)._
