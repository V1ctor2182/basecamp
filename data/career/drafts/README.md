# drafts/ — Applier 填表方案草稿

Applier 为每次 apply 产出的字段填充方案 JSON。全部 gitignored。

## 文件格式

```
drafts/
└── {jobId}.json    🔒 每个 Job 一份填表草稿
```

JSON schema：
```json
{
  "jobId": "...",
  "mode": "simplify-hybrid" | "full-agent",
  "createdAt": "...",
  "fields": [
    {
      "id": "firstName",
      "label": "First Name",
      "class": "hard-info" | "legal" | "open-ended" | "file",
      "suggested_value": "...",
      "confidence": "High" | "Medium" | "Low" | "Manual",
      "source_ref": "identity.yml:name" | "qa-bank/legal.yml:sponsor" | "llm" | "...",
      "user_final": "...",     // 用户 review 后编辑的最终值 (append 到 history.jsonl)
      "approved": true
    }
  ]
}
```

## 生命周期

1. 用户点 "Apply" → Applier 启动（Mode 1 或 Mode 2）
2. Mode 2: Playwright 扫 DOM 识别字段；Mode 1: 预测常见 ATS 字段
3. 字段分类 + 起草建议值 → 写入 `drafts/{jobId}.json`
4. UI 展示给用户 review + 编辑
5. 用户批准 → Mode 2 自动填 / Mode 1 用户复制粘贴
6. 用户 Mark submitted → `user_final` 回填 history.jsonl

## 谁读 / 谁写

| 动作 | 谁 |
|---|---|
| 写入 | 07-applier/03-field-classifier + 07-applier/01-mode1-simplify-hybrid |
| 读取 | UI apply 页 + 飞轮归纳（读 suggested_value vs user_final diff） |

## 下游 feature

- `07-applier/01-mode1-simplify-hybrid` — 简化版
- `07-applier/04-multi-step-state-machine` — 多步（Workday / iCIMS）
- `07-applier/07-feedback-flywheel` — 从 user_final vs suggested_value 归纳
