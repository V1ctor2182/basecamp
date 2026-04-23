# site-adapters/ — ATS 站点特化策略

Applier Mode 2 按 ATS domain 配的 YAML 特化策略。初版内建 Greenhouse / Ashby / Lever，其他通过飞轮积累。

## 结构

```
site-adapters/
├── _common.yml          ✅ 跨站点通用 wait / retry / anti-bot 配置 (commit)
├── greenhouse.yml       ✅ Greenhouse 特化 (commit, 初版内建)
├── ashby.yml            ✅ Ashby 特化 (commit, 初版内建)
├── lever.yml            ✅ Lever 特化 (commit, 初版内建)
├── workday.yml          ✅ Workday (多步 + Shadow DOM) (commit, 飞轮生成)
├── icims.yml            ✅ iCIMS (iframe) (commit, 飞轮生成)
├── google-careers.yml   ✅ 公司自建 (commit, 按需)
└── default.yml          ✅ 匹配不到时 fallback (commit)
```

全部 commit — 站点策略是可复用知识，团队（或未来开源贡献者）都能受益。

## YAML 结构

每份 adapter：
- `name` / `priority`
- `detection`: url_patterns (regex[]) + dom_signatures (selector[])
- `flow`: type (single-step / multi-step) + next_button + submit_button
- `controls`: date_picker / address_autocomplete / custom_dropdown / file_upload 每项 strategy
- `quirks`: 自由文本 tips
- `known_fields`: label → class + maps_to 快速映射

详见 `career-architecture/06-applier.md#6.5-site-adapter-层`。

## 下游 feature

- `07-applier/06-site-adapters` — 实现 adapter 加载 + 生效
- `07-applier/07-feedback-flywheel` — 累积 5 次同 domain 失败自动生成新 adapter 建议
