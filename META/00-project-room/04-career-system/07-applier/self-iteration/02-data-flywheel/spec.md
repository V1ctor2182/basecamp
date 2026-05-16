# Data Flywheel (was Feedback Flywheel)

**Room ID**: `00-project-room/04-career-system/07-applier/self-iteration/02-data-flywheel`  
**Type**: feature  
**Lifecycle**: planning (Mode 2 LOCKED 2026-05-11)  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/07-applier/self-iteration`  

## Intent

4 条回流数据飞轮 + Learning tab + 阈值触发 AI 归纳

Applier 越用越准的核心机制：每次 apply 的失败和修正都回流到系统，下次遇到类似场景 agent 更准。4 条回流数据（存 data/career/feedback/）：(1) 字段识别失败 field-misclassified.jsonl — 每 5 个同 site 错误触发 AI 归纳 classifier 规则建议（Workday 字段重复性高，小批量够）；(2) 开放题答案回流 qa-bank/history.jsonl — 用户 a_final 和 LLM a_draft 的 diff，用于 few-shot prompting + template 迭代；(3) 字段修正回流 field-edits.jsonl — 统计最常改的 pattern，加到 narrative.md 的 "Writing style preferences" 段；(4) Site Adapter 增强 site-failures.jsonl — 同一 domain 累积 5 次失败触发 AI 归纳生成新 site-adapter yaml。UI Learning tab：过去 30 天反馈数据统计 / 分类器准确率趋势图（ECharts）/ AI 建议的新规则列表（你 approve/reject）/ 写作风格自动归纳 / site adapter 覆盖度。所有飞轮数据本地存，不上传，不训练第三方模型。冷启动预估：前 5 次 ~50% 准确率、5-20 次 ~70%、20+ 次 ~85-90%。验收：跑 5 次 apply 后 Learning tab 出现 feedback 统计；触发阈值后看到 AI 建议新 classifier 规则 / site adapter，approve 后下次生效。

## Specs in this Room

- [intent-data-flywheel-001](specs/intent-data-flywheel-001.yaml) — 4 条回流数据飞轮 + Learning tab + 阈值触发 AI 归纳

## 当前进度 — 🟢 planning (milestones locked 2026-05-17)

**Plan A 锁定**. 4 milestones (~2250 LOC + ~800 smoke):

| m | 内容 | LOC | 解锁 |
|---|------|-----|------|
| **m1** | 3 JSONL stores + Zod schemas + 4 capture hooks (endpoint/classifier) | ~650 (400 + 250 smoke) | 真实 apply 开始产生 flywheel 数据 |
| **m2** | Haiku induction worker + threshold(5) + proposal 持久化 | ~550 (350 + 200 smoke) | AI 归纳 classifier 规则 + 新 site-adapter YAML 提案 |
| **m3** | Approve/Reject seam — applySuggestion 写 learned-classifier-rules.yml / 新 site-adapter.yml + REST | ~450 (250 + 200 smoke) | Approved suggestion in-process 立即生效 |
| **m4** | Learning tab UI (React + ECharts) + stats endpoints + ROOM COMPLETE | ~600 (450 + 150 smoke) | self-iteration/01 + /03 |

### Locked OQ

| OQ | 决定 | 理由 |
|----|------|------|
| Q1 Induction model | Haiku w/ Sonnet retry on Zod fail | Input ≤20 行 (~2k tokens), pattern extraction is Haiku 强项 |
| Q2 Threshold | Fixed 5 per spec | Configurable UI 推后 Phase 2 |
| Q3 Approve flow | Manual review (UI button) | Per spec: never auto-apply |
| Q4 Cold start | Lazy-create JSONL on first append | 比 init-career.sh 改动小 |
| Q5 history.jsonl 复用 | Reuse `qa-bank/history.jsonl`, skip duplicate `open-question-diffs.jsonl` | 现有 schema 已覆盖 q/a_draft/a_final/edit_distance/company/role |
| Q6 Induction trigger | Server-side check on apply close + manual button | 便宜的 groupBy + ad-hoc |
| Q7 Classifier 应用 seam | Write to `learned-classifier-rules.yml`, 03 boot 时 via 06 m2's `registerExtraRules` 注册 | 避免改 regexRules.mjs 核心代码, 持久 + 可热加载 |

### 与已 shipped 基础的关系

```
03-field-classifier (ROOM COMPLETE) — regexRules.mjs HARD/LEGAL/etc + registerExtraRules seam
  ↓ m3 写 learned-classifier-rules.yml; classifyField sweep 包含 EXTRA_RULES
06-site-adapters (ROOM COMPLETE) — siteAdapters/loader.mjs + activateAdapter
  ↓ m3 写 data/career/site-adapters/{domain}.yml; loader 自动 mtime invalidate
04-multi-step-state-machine (ROOM COMPLETE) — endpoint.mjs lifecycle
  ↓ m1 capture hooks: approve-step (field-edits) + error path (site-failures)
qa-bank/history.jsonl (existing) — Mark Submitted log
  ↓ m2 induction reads directly (no duplicate file)
02-data-flywheel (this Room)
  ↓ data/career/feedback/ — 3 JSONL + suggested/ + learned-classifier-rules.yml
  ↓ Learning tab UI in CareerApp (after Settings tab)
```

---

_Generated 2026-04-22 by room-init. Plan refined 2026-05-17 by plan-milestones._
