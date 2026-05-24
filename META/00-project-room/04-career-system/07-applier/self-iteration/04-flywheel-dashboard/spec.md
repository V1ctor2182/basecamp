# Flywheel Dashboard — 数据飞轮统一呈现页

> Feature Room · `04-career-system/07-applier/self-iteration/04-flywheel-dashboard`
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

_(plan-milestones 锁定 2026-05-22)_

- **D1** — 新开一个独立页面 `/career/flywheel`，**不**复用现有的 Learning /
  Iteration 入口。m4 把旧的两个 "(debug)" tab 退役、路由重定向到新页面。
- **D2** — 自测报告**只读展示**最近一次（读 `applier-selftest-report.json`）。
  "从页面点按钮触发一次自测运行" → Deferred。
- **D3** — 待审提议在飞轮页内联 approve / reject，复用现有
  `/api/career/feedback/suggestions/:id/approve|reject` 端点。
- **D4** — 失败记录默认**近 30 天**窗口、**按 site 分组**（与 `feedback/stats`
  的 30 天窗口一致）。"看全部 / 不限窗口" → Deferred。

## Constraints

_(继承父 Room；本 Room 暂无新增)_

## Deferred

以后想要再单独排 milestone，不在本轮 4 个 milestone 内：

- **从飞轮页面触发一次自测运行** — 自测是 ~15 分钟无头批处理，网页触发需
  后台任务 + 进度轮询,是一块独立的活(D2)。
- **失败记录"看全部 / 不限时间窗口"视图** — 本轮只做近 30 天(D4)。

## 当前进度

🔄 **in dev** — 3/4 milestones 完成（2026-05-24）。

| # | milestone | 估 | 状态 |
|---|-----------|-----|------|
| m1 | Backend — verify-failures + 自测报告端点 | ~120 行 | ✅ done |
| m2 | Flywheel 页 — 失败记录 + 待审提议 | ~180 行 | ✅ done |
| m3 | Flywheel 页 — 规则历史 + 自测报告 | ~150 行 | ✅ done |
| m4 | 收编旧 Learning / Iteration debug tab | ~60 行 | pending |

m1 上线两个只读端点:`GET /api/career/feedback/verify-failures`
(按 status + site 聚合,默认 30 天窗口) 与
`GET /api/career/feedback/selftest-report`(读
`applier-selftest-report.json`;缺失→空壳,损坏→显式 `error`)。

m2 上线 `/career/flywheel` 页面 + nav 主入口。两块卡片:① 失败记录
(30d, by site) — verify-failures 表 + site-failures 表 + field-edits 计数;
② 待审 AI 提议 — 复用 `/feedback/suggestions` + `:id/approve|reject`。
Learning.tsx 的全部 review 修复都端口过来(per-section error gate / mid-
flight refresh skip / mountedRef / sanitize-for-display)。

m3 补齐后两块:③ 规则历史 — 复用现有 `/feedback/suggestions?status=
approved|rejected` 端点,applied/rejected 两列并排展示 type + group_key
+ 一行预览(`/regex/i → class (maps_to)` 或 `adapter_id · flow=type`)。
④ 自测报告 — 读 m1 的 `/feedback/selftest-report`,展示 `ran_at` + fixture
名 + `by_outcome` 标签 + totals strip + 每岗位
`verified/mismatch/fill_error/unverifiable/not_seen/manual` 表。
报告缺失 → 空状态指 `node scripts/applier-selftest.mjs` 命令;损坏 →
inline `selftestError` (沿用 m1 endpoint 的 `error` 字段)。

下一步：`dev 04-flywheel-dashboard/m4`。

## Contracts

_(无)_
