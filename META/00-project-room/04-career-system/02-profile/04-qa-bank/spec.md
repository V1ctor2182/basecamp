# QA Bank

**Room ID**: `00-project-room/04-career-system/02-profile/04-qa-bank`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/02-profile`  

## Intent

三层 QA Bank：legal.yml（固定答案） + templates.md（开放题模板） + history.jsonl（历史累积）

为 Applier 填表 + Evaluator Stage B 提供稳定的问答材料。(1) qa-bank/legal.yml — 法律/EEO/visa 固定答案（work_authorization / eeo / personal / how_did_you_hear_default），纯查表不走 LLM，答案 100% 一致；(2) qa-bank/templates.md — Why us / Why role / Expected salary / Start date / Weakness / Why leaving 等开放题的模板 + 变量来源注释；(3) qa-bank/history.jsonl — 每次 apply 完成的 Q&A append-only record（q / a_draft / a_final / edit_distance / template_used），Applier 飞轮的核心数据源之一，Applier 起草新答案时用最近 5 条做 few-shot。前端 Settings → QA Bank 页：三个 sub-tab 分别编辑 legal（结构化表单）、templates（markdown viewer/editor）、history（只读 table + 搜索）。legal.yml 和 history.jsonl gitignored（敏感），templates.md commit。验收：Applier draft 时能读到 legal 返回固定值；能读到 templates 做模板匹配；append history 后 jsonl 立即持久化。

## Specs in this Room

- [intent-qa-bank-001](specs/intent-qa-bank-001.yaml) — 三层 QA Bank：legal.yml（固定答案） + templates.md（开放题模板） + history.jsonl（历史累积）

---

_Generated 2026-04-22 by room-init._
