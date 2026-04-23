# output/ — 定制后的 tailored 简历 PDF

CV Engine + Renderer 为每个 Job 产出的针对性 tailored 简历。全部 gitignored。

## 文件格式

```
output/
├── {jobId}-{resumeId}.md   🔒 tailored markdown（Tailor Engine 产出）
└── {jobId}-{resumeId}.pdf  🔒 渲染后 PDF（Renderer 产出）
```

- `{jobId}` — 对应 reports/{jobId}.md 的同一个 id
- `{resumeId}` — 用的是哪份 base resume（backend / applied-ai / fullstack / default）

同一个 Job 可以产出多个 tailored 版本（A/B 测试用不同 base）。

## 生命周期

1. User 在 UI shortlist 点 "Tailor CV for this job"
2. Tailor Engine Auto-Select base（或用户手动指定）→ 读 base.md + reports/{jobId}.md Block E
3. LLM 改写 markdown → 写入 `output/{jobId}-{resumeId}.md`
4. UI 显示 diff (base vs tailored)，用户 Approve
5. Renderer (04-renderer/01-html-template) 渲染 PDF → `output/{jobId}-{resumeId}.pdf`
6. Applier 上传该 PDF

## 谁读 / 谁写

| 动作 | 谁 |
|---|---|
| 写入 | 03-cv-engine/05-tailor-engine (markdown) / 04-renderer/01-html-template (PDF) |
| 读取 | 07-applier（上传给 ATS） |

## 下游 feature

- `03-cv-engine/05-tailor-engine` — 写 markdown
- `04-renderer/01-html-template` — 写 PDF
- `07-applier/01-mode1-simplify-hybrid` — 读 PDF 给用户手动上传
- `07-applier/04-multi-step-state-machine` — 读 PDF 自动 Playwright 上传
