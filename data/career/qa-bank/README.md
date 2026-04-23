# qa-bank/ — ATS 填表答案库（三层）

Applier 填表 + Evaluator Stage B 的稳定答案源。

## 结构

```
qa-bank/
├── legal.yml          🔒 法律/EEO 固定答案 (gitignored, 个人敏感)
├── legal.example.yml  ✅ 模板示例 (commit, init-career.sh 会 cp 成 legal.yml)
├── templates.md       ✅ 开放题模板库 (commit, 可复用知识)
└── history.jsonl      🔒 每次投递 Q&A append log (gitignored, 飞轮数据源)
```

## 三层设计

| 层 | 文件 | 用法 |
|---|---|---|
| **Legal/EEO** | `legal.yml` | 纯查表，不走 LLM。答案 100% 一致（sponsorship / race / veteran / felony 等）。用户自己填，Applier 直接读。 |
| **Templates** | `templates.md` | 开放题模板（Why us / Why role / Expected salary / Start date / Weakness / Why leaving）。带变量占位符 `{company}` / `{key_product}`，Applier 用模板 + 上下文 LLM 起草。 |
| **History** | `history.jsonl` | 每次 apply "Mark submitted" 后 append 一行（q/a_draft/a_final/edit_distance/company/role/template_used）。Applier 下次起草时做 few-shot；飞轮归纳风格到 narrative.md。 |

## 谁读 / 谁写

| 文件 | 写入者 | 读取者 |
|---|---|---|
| `legal.yml` | 用户 UI 表单（02-profile/04-qa-bank） | Applier 的 Class 2 Legal 分类路由 |
| `templates.md` | 用户 UI + AI 飞轮归纳建议 | Applier 的 Class 3 Open-Ended 分类路由 |
| `history.jsonl` | Applier（Mark submitted 时） | Applier（下次 few-shot） + 飞轮归纳 |

## 下游 feature

- `02-profile/04-qa-bank` — UI 编辑三层
- `07-applier/03-field-classifier` — 消费 legal + templates
- `07-applier/07-feedback-flywheel` — 读 history 归纳风格
