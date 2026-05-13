# Field Classifier

**Room ID**: `00-project-room/04-career-system/07-applier/03-field-classifier`  
**Type**: feature  
**Lifecycle**: planning (Mode 2 LOCKED 2026-05-11)  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/07-applier`  

## Intent

4 class 字段分类器 + 分类路由（Hard Info / Legal / Open-Ended / File）

Mode 2 Applier 的核心智能：把表单每个字段路由到不同填充策略。输入：DOM 扫描得到的 field list（id / label / type / required / placeholder / maxLength / options）。分类（按优先级 Hard > Legal > File > Open > Unknown）：(1) Class 1 Hard Info — 姓名/邮箱/电话/LinkedIn/GitHub/portfolio(URL 字段，非 file) / 学校 / 学位 / GPA 等，纯 regex 匹配 label，查 identity.yml 直接填；(2) Class 2 Legal — sponsor / visa / citizen / gender / race / veteran / felony / relocate / how-did-you-hear 等，查 qa-bank/legal.yml，EEO 默认 "Decline to answer"；(3) Class 3 Open-Ended — textarea 或 text maxLength≥100 或 label 含 Why/Tell/Describe 等，子分类 why-company / why-role / tell-me-about / weakness / salary-expectation / start-date / notice-period / reason-for-leaving / unknown-open，走 LLM + templates + history；(4) Class 4 File Upload — resume/cv 用 output/{jobId}-{resumeId}.pdf，cover letter 按需 LLM 生成，work-samples 不强制（有 URL 字段走 Class 1）。产出 drafts/{jobId}.json 给 Mode 1 复用 / Mode 2 Playwright 消费。置信度标记 High/Medium/Low/Manual（见 05-non-standard-controls）。验收：给一份 Greenhouse 申请表（~15 字段），classifier 产出 drafts JSON 里每字段的 class 和 suggested_value 正确率 ≥ 90%。

## Specs in this Room

- [intent-field-classifier-001](specs/intent-field-classifier-001.yaml) — 4 class 字段分类器 + 分类路由（Hard Info / Legal / Open-Ended / File）

## 当前进度 — 🟢 planning (milestones locked 2026-05-12)

**Plan A (foundation-first) accepted**. 3 milestones (~700 LOC + ~480 smoke):

| m | 内容 | LOC | 解锁 |
|---|------|-----|------|
| **m1** | Regex rule engine + identity.yml/legal.yml lookup (pure deterministic, 0 LLM) | ~280 + 180 smoke | 04/05/06 可早期 import classifier 函数 |
| m2 | Open-class LLM filler + file path resolver + qa-bank cache + budget gate | ~260 + 150 smoke | 完整分类 pipeline |
| m3 | Snapshot integration + Draft writer + ROOM COMPLETE | ~160 + 150 smoke | 04/05/06 + self-iteration/02 |

### Locked OQ

| OQ | 决定 |
|----|------|
| Q1 input source | snapshot output (从 08) — 跟 08 契约统一 |
| Q2 缺失 maxLength/placeholder | V1 用 name-regex 为主；09 暴露问题再加 `inspectRef(refId, ['placeholder', 'maxLength'])` helper |
| Q3 Open prompt | NEW Mode-2 prompt（不复用 01-mode1 draftPrompt） |
| Q4 qa-bank cache | fuzzy match `(role, name)` → weight ≥ medium 短路 LLM (0 token cost) |
| Q5 confidence tiers | high = regex hit + lookup 非空; medium = regex hit value 缺/cache low; low = LLM 产出模糊; manual = 需用户输入 |
| Q6 LLM 经过 budget gate | 是 — 每次 Open-class 调用过 04-budget-gate (402 → confidence='manual') |
| Q7 输出 vs 01-mode1 | 同 DraftSchema，不同来源 (01 proactive canonical / 03 reactive 真表单)；Mode 2 优先用 03 |

### 与已 shipped 基础的关系

```
02-playwright-runtime (ROOM COMPLETE)
  ↓ getBrowser/getPage
08-snapshot-refs-layer (ROOM COMPLETE)
  ↓ snapshot() → { text, table, skippedFrames }
  ↓ table.refIds() / table.publicEntry(refId)
03-field-classifier (this Room)
  ↓ classifyAndDraft(page, jobId, ctx)
  ↓ uses identity.yml + qa-bank/legal.yml + qa-bank/history.jsonl + Sonnet (Open) + output/{jobId}-{resumeId}.pdf
  ↓ writes drafts/{jobId}.json (DraftSchema from 01-mode1)
```

---

_Generated 2026-04-22 by room-init. Plan refined 2026-05-12 by plan-milestones._
