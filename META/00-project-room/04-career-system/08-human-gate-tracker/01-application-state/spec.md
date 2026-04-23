# Application State

**Room ID**: `00-project-room/04-career-system/08-human-gate-tracker/01-application-state`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/08-human-gate-tracker`  

## Intent

applications.json schema + 状态机 + timeline append-only

所有 career-system 申请的单一 source of truth。数据模型 data/career/applications.json（数组）每条：id (jobId + date 构成) / company / role / url / score (Evaluator 打的总分) / status (Evaluated / Applied / Responded / Interview / Offer / Rejected / Discarded / SKIP) / legitimacy (Block G 判定: High Confidence / Proceed with Caution / Suspicious) / reportPath / pdfPath / resumeId / timeline (append-only event log: {ts, event, note?}) / followup ({nextAt, reason})。状态机：Evaluated → Applied → Responded → Interview → (Offer|Rejected)。不能跳过中间态；timeline 事件 append-only 绝不改历史。后端 GET /api/career/applications (list) + POST /api/career/applications/:id (update status + 自动 append timeline event)。写操作要原子（file lock 或 atomic rename 避免并发破坏）。Evaluator Stage B 完成后自动 insert 一条 status=Evaluated；Applier Mode 1 "Mark submitted" 后升为 Applied。验收：跑 20 个岗位评估 + 3 个 apply，applications.json 内容完整 + status 正确；手动修改某条的 status 经由 API → timeline 自动多一条事件记录。

## Constraints

状态按规范流转 + timeline append-only + 写操作原子

(1) applications.json 的 status 转换 MUST 按合法顺序：Evaluated → Applied → Responded → Interview → (Offer | Rejected)；此外 Discarded / SKIP 可从任何非终态转入。MUST NOT 跳过中间态（例 不能从 Evaluated 直接 → Interview），否则 timeline 信息丢失；(2) timeline 事件 MUST append-only — 历史事件一旦写入不能删 / 改，保证审计留痕；如果需要更正（例 打错日期）用新事件 `correction` 类型覆盖而不是改旧事件；(3) 写 applications.json MUST 原子 — 用 atomic rename (write to .tmp + rename) 或 file lock，避免多个 API 并发写造成 json 损坏（Evaluator + Applier + 用户手改可能同时发生）；(4) 每个 status 转换 MUST 自动 append 一条 timeline event（{ts, event: "status_changed", from, to}），不需要调用方额外写。

## Specs in this Room

- [intent-application-state-001](specs/intent-application-state-001.yaml) — applications.json schema + 状态机 + timeline append-only
- [constraint-application-state-001](specs/constraint-application-state-001.yaml) — 状态按规范流转 + timeline append-only + 写操作原子

---

_Generated 2026-04-22 by room-init._
