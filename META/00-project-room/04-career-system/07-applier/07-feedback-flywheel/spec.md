# Feedback Flywheel

**Room ID**: `00-project-room/04-career-system/07-applier/07-feedback-flywheel`  
**Type**: feature  
**Lifecycle**: backlog  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/07-applier`  

## Intent

4 条回流数据飞轮 + Learning tab + 阈值触发 AI 归纳

Applier 越用越准的核心机制：每次 apply 的失败和修正都回流到系统，下次遇到类似场景 agent 更准。4 条回流数据（存 data/career/feedback/）：(1) 字段识别失败 field-misclassified.jsonl — 每 5 个同 site 错误触发 AI 归纳 classifier 规则建议（Workday 字段重复性高，小批量够）；(2) 开放题答案回流 qa-bank/history.jsonl — 用户 a_final 和 LLM a_draft 的 diff，用于 few-shot prompting + template 迭代；(3) 字段修正回流 field-edits.jsonl — 统计最常改的 pattern，加到 narrative.md 的 "Writing style preferences" 段；(4) Site Adapter 增强 site-failures.jsonl — 同一 domain 累积 5 次失败触发 AI 归纳生成新 site-adapter yaml。UI Learning tab：过去 30 天反馈数据统计 / 分类器准确率趋势图（ECharts）/ AI 建议的新规则列表（你 approve/reject）/ 写作风格自动归纳 / site adapter 覆盖度。所有飞轮数据本地存，不上传，不训练第三方模型。冷启动预估：前 5 次 ~50% 准确率、5-20 次 ~70%、20+ 次 ~85-90%。验收：跑 5 次 apply 后 Learning tab 出现 feedback 统计；触发阈值后看到 AI 建议新 classifier 规则 / site adapter，approve 后下次生效。

## Specs in this Room

- [intent-feedback-flywheel-001](specs/intent-feedback-flywheel-001.yaml) — 4 条回流数据飞轮 + Learning tab + 阈值触发 AI 归纳

---

_Generated 2026-04-22 by room-init._
