# Basecamp

> Personal command center — local-first knowledge base, GitHub work tracker, Claude Code usage analytics, and an AI-assisted career system in one dashboard.

## 技术栈
- **Frontend**: React 19 + Vite + React Router
- **Backend**: Node.js + Express (`server.mjs`)
- **Editor**: CodeMirror 6 + react-markdown + Mermaid
- **Charts**: Nivo · ECharts · Recharts
- **Browser Automation**: Playwright (career applier)
- **AI**: Claude API — Sonnet for complex, Haiku for cheap
- **Validation**: Zod
- **Data**: YAML + JSON files under `data/career/` and `META/`
- **Claude Code Usage**: ccusage + `~/.claude/projects/` session logs

## 当前阶段
`04-career-system` epic in_progress · 10/32 features shipped (31%)
最新可并行计划见 [META/00-project-room/04-career-system/parallel-plan.md](META/00-project-room/04-career-system/parallel-plan.md).

## 铁律
**先读 Spec，再写代码。**

## 开始工作
1. 读 [META/00-project-room/_tree.yaml](META/00-project-room/_tree.yaml) — 模块全景
2. 读对应 Room 的 `progress.yaml` + `room.yaml` — 当前进度 + 上下文
3. 读 `spec.md`（如有）— 设计意图
4. 用 `dev` / `commit-sync` skills 驱动开发，**不要直接** `git commit` / `git push`

## 项目结构
| 路径 | 用途 |
|------|------|
| `META/00-project-room/` | Feature Room 体系 — 模块拆分、specs、进度追踪 |
| `src/` | React 前端 — Learn / Tracker / Career 三个 app |
| `src/career/` | 职业系统 UI：resumes、settings、quality |
| `server.mjs` | Express 后端 — `/api/career/*` + GitHub/Claude usage 路由 |
| `data/career/` | 配置与状态：`identity.yml`、`preferences.yml`、`resumes/`、`pipeline.json` |
| `scripts/` | 一次性脚本（`init-career.sh`） |

> Feature Room skills 通过 [V1ctor2182/feature-room-plugin](https://github.com/V1ctor2182/feature-room-plugin) plugin 引入。一次性安装：
> ```
> /plugin marketplace add V1ctor2182/feature-room-plugin
> /plugin install feature-room
> ```

## 团队
| 成员 | 角色 | 负责 |
|------|------|------|
| Victor | Founder + fullstack | 全栈主驱动；当前在 `03-cv-engine/04-auto-select` m2 |
| Colleague | Backend | 起步：`03-cv-engine/02-google-docs-sync`（独立、无冲突） |

## Design System
当前没有锁定的 `DESIGN.md`。沿用 `src/` 现有视觉语言：暖色 + Lucide 图标 + 简洁卡片布局。
新组件参考最近的 [src/career/settings/Resumes.tsx](src/career/settings/Resumes.tsx) / [resumes.css](src/career/settings/resumes.css)；不要引入新调色板或新字体而不先和 Victor 对齐。

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

### Feature Room Skills (via `feature-room-plugin`)

| Skill | 触发词 |
|-------|--------|
| **commit-sync** | "提交", "commit", "push", 任何代码提交请求 |
| **dev** | "做 xxx m1", "开发 xxx", "下一个" — milestone 级开发主入口 |
| **room-status** | "项目状态", "全景", "哪些 room 在开发", "状态报告" |
| **room** | "给 xxx 加 room", "标记为 in-dev", "review draft specs", Room CRUD |
| **plan-milestones** | "拆 milestone", "重新拆分 xxx 步骤"（在 `dev` 之前用） |
| **prompt-gen** | "生成 prompt", "增强 prompt", "注入上下文" |
| **random-contexts** | 粘贴聊天记录/会议笔记, "记录这个决策" |
| **room-init** | "初始化项目", "init rooms", "从 PRD 创建 Room" |
| **timeline-init** | "生成时间线", "排期", "timeline" |

### 使用方式
1. 识别用户意图匹配上表触发词
2. 按 skill 中的步骤执行
3. **提交代码时必须用 `commit-sync`，不要直接 `git commit`**

### gstack Skills (外部工具链)

| 触发词 | Skill |
|--------|-------|
| Product ideas, brainstorming, "is this worth building" | `office-hours` |
| Bugs, errors, "why is this broken", 500 errors | `investigate` |
| Ship, deploy, push to main, create PR | `ship` |
| QA, test the site, find bugs | `qa` |
| Code review, check my diff | `review` |
| Update docs after shipping | `document-release` |
| Weekly retro | `retro` |
| Design system, brand | `design-consultation` |
| Visual audit, design polish | `design-review` |
| Architecture review | `plan-eng-review` |
| Save progress, checkpoint, resume | `checkpoint` |
| Code quality, health check | `health` |
