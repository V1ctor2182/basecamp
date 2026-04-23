# Identity (你是谁)

**Room ID**: `00-project-room/04-career-system/02-profile/01-identity`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/02-profile`  

## Intent

identity.yml CRUD + Settings → Identity 页（填表用的稳定身份信息）

提供 Applier 填表 / CV Renderer 产 PDF 头的稳定身份数据源：姓名 / 邮箱 / 电话 / LinkedIn / GitHub / portfolio(个人网站 URL) / 当前地点 / visa 状态 (F-1 OPT / needs_sponsorship) / 学历（Columbia MS + Michigan BS）/ 语言。一年才改几次，但是所有下游读它。server.mjs 加 GET/PUT /api/career/identity；前端 Settings → Identity 页用 CodeMirror 编辑 YAML 或结构化表单（推荐表单，带字段校验）。identity.yml 必须 gitignored。验收：UI 改完保存 → 文件更新 → 重启后加载正确；Applier 读到正确值。

## Specs in this Room

- [intent-identity-001](specs/intent-identity-001.yaml) — identity.yml CRUD + Settings → Identity 页（填表用的稳定身份信息）

---

_Generated 2026-04-22 by room-init._
