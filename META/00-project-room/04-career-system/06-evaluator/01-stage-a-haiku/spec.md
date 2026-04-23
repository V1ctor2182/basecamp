# Stage A - Haiku

**Room ID**: `00-project-room/04-career-system/06-evaluator/01-stage-a-haiku`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/06-evaluator`  

## Intent

Haiku 快评（Stage A）：1-5 分 + 一句话理由，低于阈值归档

Evaluator 三阶段漏斗中的 Stage A。输入：JD 全文 + preferences.yml（targets / hard_filters / thresholds）+ 简版 CV（base.md 的 headlines + 经历 1-2 行，不读全文避免贵）。输出：单个岗位的 score (1.0-5.0, 1 位小数) + 一句话 reason（如 "3.0 — 要求 5+ 年经验，候选人只有 2 年" 或 "4.3 — 强匹配 AI infra 方向，薪资范围合适"）。调 claude-haiku-4-5-20251001，每个 ~$0.01。记成本走 01-foundation/03-llm-cost-observability。默认阈值 < 3.5 归档（preferences.yml.thresholds.skip_below 可 override）。归档的 Job 保留结果但状态置为 Archived，UI 上用户可以 "Force Sonnet" override。支持批量：POST /api/career/evaluate/stage-a { jobIds: [...] } → 并发 3（p-queue 限速避免 rate limit） + prompt caching 共用简版 CV。验收：跑一批 60 个 Pending 岗位，总成本 < $1，~30 个进入阈值之上（等待 Stage B 或用户选择）。

## Constraints

阈值可 override + 归档不是删除 + Force Sonnet 永远可用

(1) 默认阈值 3.5 MUST 可在 preferences.yml.thresholds.skip_below 里 override，不能硬编码；(2) Stage A < 阈值的 Job MUST 状态改为 Archived 但保留记录（applications.json 或 pipeline.json 里可查）——绝不删除，用户可能想回头翻；(3) UI MUST 永远提供 "Force Sonnet" override — 即使 Haiku 评 1.5，用户也能强制跑 Stage B（前提是今日预算未超）。因为 Haiku 有时会错（你比 Haiku 更了解自己）；(4) Stage A 的 reason 字段 MUST 保存 — 后续用户 review 低分岗位时能看到 LLM 的判断理由。

## Specs in this Room

- [intent-stage-a-haiku-001](specs/intent-stage-a-haiku-001.yaml) — Haiku 快评（Stage A）：1-5 分 + 一句话理由，低于阈值归档
- [constraint-stage-a-haiku-001](specs/constraint-stage-a-haiku-001.yaml) — 阈值可 override + 归档不是删除 + Force Sonnet 永远可用

---

_Generated 2026-04-22 by room-init._
