# Flywheel Dashboard — 数据飞轮统一呈现页

> Feature Room · `04-career-system/07-applier/07-self-iteration/04-flywheel-dashboard`
> lifecycle: **planning** · owner: fullstack · created 2026-05-22

## Intent

一个独立页面，把数据飞轮的全部状态集中呈现。今天飞轮完全是后端（JSONL
记录 + `suggested/*.json` 提议文件），没有统一 UI；而新做的验证层
(07-applier M1–M4：`verify-failures` store + applier 自测 harness) 完全没有
UI 入口。现有零散呈现散落在 Learning tab 和 Iteration.tsx。

这个 Room 建一个独立页面,集中呈现 4 块：

1. **失败与修正记录** — `field-edits` / `site-failures` / `verify-failures`
   三个 feedback store，按网站聚类。
2. **待审提议** — `suggested/*.json`，可直接 approve / reject。
3. **已应用 + 已拒绝历史** — `learned-classifier-rules.yml` + `rejected-ids.json`。
4. **自测报告 + 验证统计** — `applier-selftest-report.json` 的
   verified / mismatch / not_seen 计数。

设计原则：**no silent errors** — 飞轮的每个失败、每条待审提议都要在页面上
看得见。

## Decisions

_(待 plan-milestones 锁定)_

## Constraints

_(继承父 Room；本 Room 暂无新增)_

## 当前进度

🔄 **planning** — Room 结构已建，milestones 待 `plan-milestones` 拆分。

intent spec 里有 4 个 open question（页面入口是否复用 Learning/Iteration、
能否从页面触发自测、approve/reject 是否就地做、记录展示窗口），需在
plan-milestones 阶段锁定。

## Contracts

_(无)_
