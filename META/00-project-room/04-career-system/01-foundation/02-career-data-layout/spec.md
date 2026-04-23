# data/career 布局

**Room ID**: `00-project-room/04-career-system/01-foundation/02-career-data-layout`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/01-foundation`  

## Intent

建立 data/career/ 目录结构 + .gitignore 规则，所有 career-system 子模块的本地存储底座

按 career-architecture/data-model.md 的文件清单初始化 data/career/ 各子目录 + README 占位 + 更新 .gitignore 白名单 / 黑名单规则。不写业务逻辑。

## Constraints

data/career/** 默认 gitignored，只有白名单配置/知识文件才 commit

identity.yml / outputs / drafts / qa-bank/legal.yml / qa-bank/history.jsonl / reports/ / .oauth.json 等敏感数据 MUST gitignored；preferences.yml / portals.yml / narrative.md / templates.md / story-bank.md / resumes/index.yml / metadata.yml / site-adapters MUST committed。任何新文件必须显式归类。

## Specs in this Room

- [intent-career-data-layout-001](specs/intent-career-data-layout-001.yaml) — 建立 data/career/ 目录结构 + .gitignore 规则
- [constraint-career-data-layout-001](specs/constraint-career-data-layout-001.yaml) — data/career/** 默认 gitignored，白名单外的都不 commit

## Milestones

Planned by plan-milestones skill on 2026-04-23 (Sprint 1 — Foundation, ~280 行, 2 milestones):

- ✅ **m1-dirs-and-gitignore** — 目录骨架 + .gitignore 白名单例外规则 + 顶层 README (实际 135 行)
- ⬜ **m2-readmes-and-examples** — 子目录 README + 示例/模板文件 + init 脚本 (~200 行)

Status: 1/2 milestones completed. See [progress.yaml](progress.yaml) for details.

---

_Generated 2026-04-22 by room-init._
