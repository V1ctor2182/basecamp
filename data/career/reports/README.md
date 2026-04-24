# reports/ — Evaluator Block A-G 报告

Stage B Sonnet 深评产出的完整评估报告。全部 gitignored（每份报告含 JD 正文、公司信息、个人匹配分析，算个人数据）。

## 文件格式

```
reports/
└── {jobId}.md    🔒 每个 Job 一份，含完整 Block A-G 报告（gitignored）
```

`{jobId}` 格式：`{company-slug}::{role-slug}::{source-type}::{source-native-id}` 的 hash，见 Finder Job Schema。

## Block 结构

每份报告包含（可通过 Block Toggles 关闭某些）：

| Block | 内容 |
|---|---|
| A | Role Summary — 岗位速览（archetype / seniority / 地点 / 团队规模） |
| B | **CV Match** — JD 每条要求 vs 简历证据 + gap 分析（必开，Tailor 依赖） |
| C | Level & Strategy — 级别匹配 + 面试定位话术 |
| D | Comp & Demand — Levels.fyi / Glassdoor 薪资比对 |
| E | **Personalization Plan** — CV 改写建议（必开，Tailor Engine 消费） |
| F | Interview Plan — 6–10 STAR+R 故事映射到 JD |
| G | Posting Legitimacy — High Confidence / Proceed with Caution / Suspicious |

## 谁读 / 谁写

| 动作 | 谁 |
|---|---|
| 写入 | 06-evaluator/02-stage-b-sonnet（Sonnet 产出后写入） |
| 读取 | 08-human-gate-tracker/02-career-dashboard-views（UI 渲染）/ 03-cv-engine/05-tailor-engine（读 Block E）/ 07-applier/01-mode1-simplify-hybrid（读 deep research 给开放题起草） |

## 下游 feature

- `06-evaluator/02-stage-b-sonnet` — 生产者
- `08-human-gate-tracker/02-career-dashboard-views` — UI /career/reports/:id 渲染
