# Google Docs 同步

**Room ID**: `00-project-room/04-career-system/03-cv-engine/02-google-docs-sync`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/03-cv-engine`  

## Intent

Google Docs OAuth + 按 resume 粒度 Sync（Doc → base.md markdown）

为 source: google_doc 的 base resume 提供一键同步能力：点 UI "Sync Now" → 调 Google Docs API files.export(gdoc_id, 'text/markdown') → 覆盖对应 resumes/{id}/base.md，同步前先快照到 versions/{timestamp}.md，记录 last_synced_at。OAuth 2.0 Desktop App flow：第一次引导用户授权（打开浏览器 → 用户登录 Google → 拿回 refresh token 存到 data/career/.oauth.json，永久 gitignored）；之后每次 sync 用 refresh token 自动刷 access token。后端 POST /api/career/resumes/:id/sync；前端每份 resume 卡片的 "Sync Now" 按钮触发。Google Doc 是这份 resume 的 source of truth（不要两边都改会冲突）。验收：配好 OAuth 后点 Sync 一份 Google Doc 关联的 resume，base.md 内容更新为 Doc 最新；versions/ 留下上一版快照。

## Constraints

Sync 前必须快照 + OAuth token 必须 gitignored

(1) 每次 Sync 之前 MUST 把当前 resumes/{id}/base.md copy 到 resumes/{id}/versions/{timestamp}.md（防止 Google Doc 错误覆盖本地的回滚能力）；(2) data/career/.oauth.json（refresh token）MUST 在 .gitignore，绝不能 push 到任何 remote；(3) Google Doc 是该 resume 的 source of truth — 如果某份 resume 是 source: google_doc，则不能同时在 UI 的 in-ui-editor 编辑（避免两边改造成冲突），UI 层禁用该 resume 的编辑按钮；(4) OAuth 失败时提示用户重新授权，不能静默失败。

## Specs in this Room

- [intent-google-docs-sync-001](specs/intent-google-docs-sync-001.yaml) — Google Docs OAuth + 按 resume 粒度 Sync（Doc → base.md markdown）
- [constraint-google-docs-sync-001](specs/constraint-google-docs-sync-001.yaml) — Sync 前必须快照 + OAuth token 必须 gitignored

---

_Generated 2026-04-22 by room-init._
