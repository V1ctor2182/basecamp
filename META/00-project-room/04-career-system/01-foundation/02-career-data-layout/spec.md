# data/career 布局

**Room ID**: `00-project-room/04-career-system/01-foundation/02-career-data-layout`  
**Type**: feature  
**Lifecycle**: active ✅  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/01-foundation`  

## Intent

建立 data/career/ 目录结构 + .gitignore 规则，所有 career-system 子模块的本地存储底座

按 career-architecture/data-model.md 的文件清单初始化 data/career/ 各子目录 + README 占位 + 更新 .gitignore 白名单 / 黑名单规则。不写业务逻辑。

## Constraints

data/career/** 默认 gitignored，只有白名单配置/知识文件才 commit

identity.yml / outputs / drafts / qa-bank/legal.yml / qa-bank/history.jsonl / reports/ / .oauth.json 等敏感数据 MUST gitignored；preferences.yml / portals.yml / narrative.md / templates.md / story-bank.md / resumes/index.yml / metadata.yml / site-adapters MUST committed。任何新文件必须显式归类。

## Implementation Summary

**2 milestones 完成**（2026-04-23）:

- ✅ **m1-dirs-and-gitignore** (`fe23daf`) — 11 subdirs + .gitignore 白名单 + 顶层 README (135 行)
- ✅ **m2-readmes-and-examples** (`pending commit`) — 8 子 README + 4 examples + init script (actual ~350 行)

## Current State

**目录结构就位**（11 subdirs）：

```
data/career/
├── README.md                   ✅ 顶层索引
├── resumes/README.md           ✅ 多简历管理
├── qa-bank/README.md           ✅ 三层答案库
├── site-adapters/README.md     ✅ ATS 特化策略
├── reports/README.md           ✅ Block A-G 报告
├── output/README.md            ✅ tailored PDF
├── drafts/README.md            ✅ Applier 填表方案
├── feedback/README.md          ✅ 4 飞轮数据
└── apply-sessions/README.md    ✅ multi-step state
```

**示例模板就位**（`npm run init:career` 可一键 cp 成真实文件）：

- `preferences.example.yml` — targets / comp / hard_filters / scoring_weights / thresholds / evaluator_strategy
- `portals.example.yml` — 9 ATS + 3 github-md sources + global_filters + cadence
- `qa-bank/legal.example.yml` — visa / EEO / personal / how_did_you_hear
- `qa-bank/templates.md` — 6 开放题模板（Why us / Why role / STAR+R / Salary / Start / Weakness / Why leaving）
- `resumes/index.yml` — 空数组 + 填充示例注释

**Gitignore 规则**：21/21 验证通过（10 敏感 IGNORED + 11 白名单 TRACKED）。

**Init 脚本**：`npm run init:career` — 幂等 cp `.example.yml` → 真实文件。

## Specs in this Room

- [intent-career-data-layout-001](specs/intent-career-data-layout-001.yaml) — 建立 data/career/ 目录结构 + .gitignore 规则
- [constraint-career-data-layout-001](specs/constraint-career-data-layout-001.yaml) — data/career/** 默认 gitignored，白名单外的都不 commit
- [change-2026-04-23-m1-dirs-and-gitignore](specs/change-2026-04-23-m1-dirs-and-gitignore.yaml) — m1 change spec
- [change-2026-04-23-m2-readmes-and-examples](specs/change-2026-04-23-m2-readmes-and-examples.yaml) — m2 change spec

## Next Steps

本 feature 完成后，下游 feature 可以开始写 data/career/ 相关内容：

- `02-profile/01-identity` → 创建 + 编辑 `identity.yml`
- `02-profile/02-preferences` → UI 编辑 `preferences.yml`
- `02-profile/04-qa-bank` → UI 编辑 `qa-bank/*`
- `03-cv-engine/01-resume-index` → UI 管理 `resumes/index.yml` + `{id}/metadata.yml`
- `05-finder/*` → 往 `pipeline.json` / `scan-history.jsonl` / `archive.jsonl` 写
- `06-evaluator/*` → 写 `reports/{jobId}.md` + `applications.json` + `llm-costs.jsonl`
- `07-applier/*` → 写 `drafts/*` / `apply-sessions/*` / `feedback/*`

---

_Completed 2026-04-23 via dev skill (2 milestones × plan-milestones)._
