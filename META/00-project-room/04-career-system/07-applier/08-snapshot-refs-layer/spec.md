# Snapshot+Refs Layer

**Room ID**: `00-project-room/04-career-system/07-applier/08-snapshot-refs-layer`
**Type**: feature
**Lifecycle**: backlog
**Owner**: backend
**Parent**: `00-project-room/04-career-system/07-applier`

## Intent

Token-efficient LLM-facing page abstraction — snapshot + symbolic refs (借鉴 Vercel agent-browser)

Mode 2 Full Agent 的 LLM-facing 抽象层，sits between 02-playwright-runtime (Chromium 底座) and 03-field-classifier / 04-multi-step-state-machine / 05-non-standard-controls (所有需要"看页面 → 决定动作"的消费者)。核心问题：传统方案让模型看完整 a11y 树 / DOM dump (~7000-8000 tokens 每个 apply 页面)，token 贵 + 模型瞎猜 selector。本 Room 实现 4 个层：(1) **snapshot(page, interactive=true)** 过滤 a11y 树到 interactive roles，每 node 一行 `- role "name" [ref=eN]` 压到 200-400 tokens (~20× 节省)；(2) **Ref table** 计数器 mint `eN`，server 端 Map `{ eN → ElementHandle }` per-session 维护；(3) **Symbolic action API** `click @e2` / `fill @e3 "value"` / `upload @e6 "/path.pdf"` — resolve `@eN` → 内部 handle，模型 NEVER sees DOM ids/classes/XPaths；(4) **Invalidation + stale-ref guard** — 监听 `framenavigated` / mutating action 后 mark stale，stale ref 引用返回 "snapshot expired" 强制 self-correct。daemon 单例常驻 server.mjs，per-call <200ms。下游 unblocked: 03 (字段分类) / 04 (多步状态机) / 05 (非标控件)。

## Specs in this Room

- [intent-snapshot-refs-layer-001](specs/intent-snapshot-refs-layer-001.yaml) — Token-efficient LLM-facing page abstraction — snapshot + symbolic refs (借鉴 Vercel agent-browser)

## Why this Room exists

研究 2026-05-11 — Vercel Labs 在 2026-01 发布 `agent-browser` (Rust CLI + CDP daemon)，引入 snapshot+refs prompt 模式，号称 vs Playwright MCP token ↓93%。结论 (见 plan-ceo-review-pending-07-applier)：**思路值钱，二进制不值钱** — 把这个 prompt 格式以 ~300-500 LOC TS 移植到我们自己 Playwright 上即可获得全部 token 收益 + 全部 selector 可靠性收益，不引入 4 个月新的 Rust 依赖 (Windows broken + Cloudflare 站点 fail + 社区未验证)。本 Room 是 07-applier 所有 LLM-driven 子 Room (03/04/05) 的 foundation。

## Estimated scope

~300-500 LOC TypeScript + ~150-200 LOC smoke (~2-3 milestones)，单独可测可独立 commit。

---

_Generated 2026-05-11 by manual add (research-driven; not from PRD)._
