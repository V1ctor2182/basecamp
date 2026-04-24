# Pipeline UI

**Room ID**: `00-project-room/04-career-system/06-evaluator/05-pipeline-ui`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: frontend  
**Parent**: `00-project-room/04-career-system/06-evaluator`  

## Intent

Pipeline / Shortlist 页 UI：列表 + 下拉 action + 批量 + 过滤器

两个核心 UI 页面：(1) /career/pipeline — 所有 Pending + Stage A 跑过的 Job 列表，每行显示 company / role / location / Stage（Haiku score 或 —）+ 下拉 action menu（Run Haiku / Run Haiku+Sonnet / Run Sonnet only / Force Sonnet / Archive）；支持多选 + 底部 "Bulk: Run Haiku / Run Sonnet on selected"；(2) /career/shortlist — Stage B 跑完且 score ≥ 4.0 的 Job，按分数排序，卡片显示分数 / 关键 gap / Block A 的 TL;DR；顶部 filter: "A ≥ 4.0 未跑 B" / "A 3.5-4.0 且公司=X" / "7 天前评估的可 Re-evaluate"。点岗位进 /career/reports/{jobId} 看完整 Block A-G 报告（markdown viewer 渲染）。复用 learn-dashboard 现有 ECharts 做评分分布图。验收：跑完 Stage A + B 后 pipeline 页能看到 ~30 条 Job，分层色标清楚；点某行 "Run Sonnet" 触发深评 + 产出报告 + 自动进 shortlist；批量操作选 5 个 Archive 成功。

## Specs in this Room

- [intent-pipeline-ui-001](specs/intent-pipeline-ui-001.yaml) — Pipeline / Shortlist 页 UI：列表 + 下拉 action + 批量 + 过滤器

---

_Generated 2026-04-22 by room-init._
