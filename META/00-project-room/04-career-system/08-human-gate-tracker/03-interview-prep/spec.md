# Interview Prep

**Room ID**: `00-project-room/04-career-system/08-human-gate-tracker/03-interview-prep`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/08-human-gate-tracker`  

## Intent

对 Interview 状态的公司聚合 story-bank 匹配 + company deep research 的面试准备页

一旦某个 application 状态变为 Interview，自动触发聚合面试准备材料生成到 /career/prep/:company。内容：(1) 公司背景摘要 — 从 reports/deep-{company}.md 抽（如果之前跑过 /career-ops deep 的等价流程）或现调 Sonnet + WebSearch 生成；(2) 历史故事库匹配 — 查 qa-bank/story-bank.md 里以往累积的 STAR+R 故事，按 JD 的 Block F 要求匹配 top 5-10 个；(3) 常见行为面试题模拟答案 — "Tell me about a time..." / "How did you handle..." / "What's your biggest weakness?" 等，用模板 + 你的 narrative.md + proof-points.md 定制；(4) 技术问题预测 — 基于 JD 的 tech stack 列出可能被问的 ~10 个技术题；(5) 谈薪 prep — 从 reports/{jobId}.md Block D 拿市场数据 + 你的 preferences.comp_target 算目标区间。前端 Prep 页支持打印 PDF 带去面试。验收：某 application 状态改为 Interview 后点 /career/prep/{company} 能看到完整页面；故事匹配合理；谈薪区间和 preferences 一致。

## Specs in this Room

- [intent-interview-prep-001](specs/intent-interview-prep-001.yaml) — 对 Interview 状态的公司聚合 story-bank 匹配 + company deep research 的面试准备页

---

_Generated 2026-04-22 by room-init._
