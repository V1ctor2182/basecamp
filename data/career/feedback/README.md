# feedback/ — Applier 数据飞轮回流

4 条飞轮数据，让 Applier 越用越准。全部 gitignored。

## 4 条数据

```
feedback/
├── field-misclassified.jsonl   🔒 字段识别失败记录（阈值 5/site 触发归纳）
├── field-edits.jsonl           🔒 用户编辑 Low confidence 字段的记录（归纳写作风格）
├── open-question-diffs.jsonl   🔒 开放题 LLM draft vs user_final diff（模板迭代）
└── site-failures.jsonl         🔒 非标控件失败记录（阈值 5/domain 触发新 adapter）
```

## 数据格式

### field-misclassified.jsonl
```json
{"ts":"...","jobId":"...","field_label":"Preferred Pronouns","predicted_class":"unknown-open","actual_class":"legal","actual_mapping":"eeo.pronouns","site":"workday"}
```

### field-edits.jsonl
```json
{"ts":"...","jobId":"...","field_id":"whyUs","suggested":"...","user_final":"...","edit_distance":45}
```

### open-question-diffs.jsonl
```json
{"ts":"...","jobId":"...","template_used":"why_company","a_draft":"...","a_final":"...","edit_distance":82,"company":"Anthropic"}
```

### site-failures.jsonl
```json
{"ts":"...","site_domain":"careers.google.com","field_label":"Preferred Work Location","failure_type":"custom-dropdown-not-fillable","dom_snippet":"...","user_action":"manual"}
```

## 飞轮触发阈值

| 数据 | 阈值 | 动作 |
|---|---|---|
| field-misclassified | 5 / site | AI 归纳 classifier 规则建议 → 用户 approve → 写入 classifier-rules/custom.yml |
| field-edits | 持续 | 每 10 次归纳写作偏好到 narrative.md "Writing style preferences" 段 |
| open-question-diffs | 持续 | edit_distance 平均大的 template 触发"模板需更新"提示 |
| site-failures | 5 / domain | AI 生成初版 site-adapter YAML → 用户 review → 写入 site-adapters/ |

## 下游 feature

- `07-applier/07-feedback-flywheel` — 实现飞轮 + Learning tab UI
