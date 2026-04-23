# Identity (你是谁)

**Room ID**: `00-project-room/04-career-system/02-profile/01-identity`  
**Type**: feature  
**Lifecycle**: active ✅  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/02-profile`  

## Intent

identity.yml CRUD + Settings → Identity 页（填表用的稳定身份信息）

提供 Applier 填表 / CV Renderer 产 PDF 头的稳定身份数据源：姓名 / 邮箱 / 电话 / LinkedIn / GitHub / portfolio(个人网站 URL) / 当前地点 / visa 状态 / 学历 / 语言。一年才改几次，但所有下游读它。identity.yml 必须 gitignored。

## Implementation Summary

**2 milestones 完成**（2026-04-23）— 660 实际代码行:

- ✅ **m1-identity-backend** (`829691d`) — Backend GET/PUT + Zod IdentitySchema + yaml IO (90 行)
- ✅ **m2-identity-form-ui** — ATS 风格 6-section form UI + ats-form.css 共享样式 (570 行)

## Backend API

### `GET /api/career/identity`
返回当前 identity 或 `null`（文件不存在）。

### `PUT /api/career/identity`
Body = 完整 identity。Zod 验证：
- `name` / `email` / `phone` — 必填字符串（email 格式）
- `links.{linkedin, github, portfolio}` — 必填 URL
- `location.{current_city, current_country}` — 必填
- `legal.{visa_status, visa_expiration, needs_sponsorship_now/future, authorized_us_yes_no, citizenship}` — 必填
- `education[]` 至少 1 条（school/degree/graduation 必填，gpa 可选）
- `languages[]` 至少 1 条（lang + level enum: Native/Fluent/Conversational/Basic）

成功 200 + 完整 record；失败 400 + zod issues。

## Frontend UI (Settings → Identity)

**模仿真实 ATS application form 风格** (Greenhouse / Workday)：

- Labels 在字段上方 + 红 `*` 标必填
- 白底 + `#d0d7de` 灰边 + `#0969da` focus 蓝环
- 错误态红边 + 行内 12px 红字
- 6 Sections 分隔线明显
- Sticky bottom submit bar (status 左 + 按钮右)
- Save 按钮 `!isValid || saving` 时 disabled
- `beforeunload` 拦截未保存离开

**6 Sections**：
1. Personal Information (name / email / phone)
2. Links (linkedin / github / portfolio URLs)
3. Location (city / country)
4. Work Authorization (visa + sponsorship radios + citizenship)
5. Education (加减行 widget, ≥1 条, gpa optional)
6. Languages (加减行 widget, ≥1 条, level dropdown)

## Shared CSS

**`src/career/settings/ats-form.css`** — ATS 风格表单共享样式。
- 未来 Preferences / QA Bank / Narrative / Portals 等 settings 子页复用
- 类 prefix `.af-*`（隔离 career.css 的 `.c-*`）

## Specs in this Room

- [intent-identity-001](specs/intent-identity-001.yaml) — identity.yml CRUD + Settings → Identity 页
- [change-2026-04-23-m1-identity-backend](specs/change-2026-04-23-m1-identity-backend.yaml) — m1 backend API
- [change-2026-04-23-m2-identity-form-ui](specs/change-2026-04-23-m2-identity-form-ui.yaml) — m2 form UI

## Downstream Callers

- `07-applier/03-field-classifier` → Class 1 Hard Info 直接读 `identity.name` / `email` / `links.linkedin` / 等
- `07-applier/03-field-classifier` → Class 2 Legal 读 `legal.needs_sponsorship_future` / `citizenship`
- `04-renderer/01-html-template` → PDF header 用 `name` / `email` / `phone` / `links`

---

_Completed 2026-04-23 via dev skill (2 milestones × plan-milestones)._
