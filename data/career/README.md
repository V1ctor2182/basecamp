# data/career — Career System 本地存储

career-system 所有模块的本地数据根目录。架构见 [career-architecture/data-model.md](../../career-architecture/data-model.md)。

## 目录结构

```
data/career/
├── README.md               — 本文件
│
├── identity.yml            🔒 你是谁（姓名/邮箱/电话/visa/学历）
├── preferences.yml         ✅ 你想要什么（targets/hard_filters/scoring_weights）
├── narrative.md            ✅ 叙事定位 + 写作风格
├── proof-points.md         ✅ 项目指标 / 文章 / 开源贡献详细版
├── story-bank.md           ✅ STAR+R 行为面试故事累积库
├── cv.gdoc-id              ✅ Google Doc ID (pointer, no content)
│
├── applications.json       🔒 所有申请的当前状态 + timeline
├── pipeline.json           🔒 待评估岗位队列
├── scan-history.jsonl      🔒 已扫过 URL 去重
├── archive.jsonl           🔒 hard filter drop 记录
├── llm-costs.jsonl         🔒 LLM 调用成本日志
│
├── resumes/                — 多简历管理
│   ├── index.yml           ✅ resume 索引 + 元数据
│   └── {id}/               — 每个 base resume 一个目录
│       ├── base.md         🔒 简历正文 markdown
│       ├── base.gdoc-id    🔒 关联 Google Doc id
│       ├── metadata.yml    ✅ 定位 + match_rules + emphasize
│       └── versions/       🔒 自动版本快照
│
├── qa-bank/                — ATS 填表答案库
│   ├── legal.yml           🔒 法律/EEO 固定答案
│   ├── templates.md        ✅ 开放题模板
│   └── history.jsonl       🔒 每次投递 Q&A append log（飞轮数据源）
│
├── site-adapters/          — ATS 站点特化策略
│   └── *.yml               ✅ greenhouse.yml / ashby.yml / workday.yml etc.
│
├── reports/                🔒 Evaluator 产出的 Block A-G 报告 (*.md)
├── output/                 🔒 Renderer 产出的定制 PDF (*.pdf)
├── drafts/                 🔒 Applier 产出的填表方案 (*.json)
├── feedback/               🔒 4 条飞轮回流数据 (*.jsonl)
├── apply-sessions/         🔒 Applier 多步 session state ({jobId}.json)
└── .playwright/            🔒 Playwright 独立 Chromium profile（运行时创建）
```

图例：✅ = committed to git（配置 + 可复用知识），🔒 = gitignored（敏感 / 易变 / 大量）

## Git 策略

详见 [../../.gitignore](../../.gitignore) 里的 "Career System" 段。核心原则：

- **committed**：偏好 / 模板 / 原型 / 故事库 —— 泄露无所谓，反而 git 能追踪演化
- **gitignored**：联系方式 / visa / OAuth token / 申请历史 / PDF / 任何个人数据 —— 绝不能 push

**加新文件前**：显式决定归类，写进 `.gitignore` 的 career-system 段，不能默认裸露。

## 初始化

首次使用（在 `02-readmes-and-examples` milestone 完成后）：

```bash
npm run init:career
```

会从 `*.example.yml` 复制出真实文件（`preferences.yml` / `portals.yml` / `qa-bank/legal.yml`），你再手动填。

## 各子目录的详细说明

见各子目录下的 README.md（`02-readmes-and-examples` milestone 产出）。

---

_Created by 01-foundation/02-career-data-layout/m1. Updated structure in later milestones._
