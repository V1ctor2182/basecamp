# resumes/ — 多 base 简历管理

多份方向化 base 简历 + 每个 Job 针对性 tailor 产出物。

## 结构

```
resumes/
├── index.yml              ✅ 所有 base resume 的元数据索引 (commit)
└── {id}/                  — 每份 base 一个目录 (id: backend / applied-ai / fullstack / default)
    ├── base.md            🔒 简历 markdown 正文 (gitignored, 从 Google Doc 同步或手动编辑)
    ├── base.gdoc-id       🔒 关联的 Google Doc ID (gitignored)
    ├── metadata.yml       ✅ 定位 / match_rules / emphasize / renderer 配置 (commit)
    └── versions/          🔒 每次 Sync / Edit 的自动快照 (gitignored)
        └── YYYY-MM-DD-HH-MM.md
```

## 谁读 / 谁写

| 文件 | 写入者 | 读取者 |
|---|---|---|
| `index.yml` | CV Engine (UI / Auto-Select) | 所有 resume UI + Tailor |
| `base.md` | Google Docs Sync OR In-UI Editor | Evaluator Stage B / Tailor Engine |
| `metadata.yml` | 用户（UI 表单或手动）+ AI（Auto-Select 建议） | Auto-Select / Tailor（emphasize） |
| `versions/*.md` | CV Engine（sync / save 前快照） | 回滚 UI |

## 下游 feature

- `03-cv-engine/01-resume-index` → Gallery UI + index.yml CRUD
- `03-cv-engine/02-google-docs-sync` → OAuth + Sync to base.md
- `03-cv-engine/03-in-ui-editor` → CodeMirror 编辑 manual base
- `03-cv-engine/04-auto-select` → 基于 metadata.match_rules 选 base
- `03-cv-engine/05-tailor-engine` → 读 base + Block E 产出 output/{jobId}-{id}.pdf
