# In-UI 简历编辑器

**Room ID**: `00-project-room/04-career-system/03-cv-engine/03-in-ui-editor`  
**Type**: feature  
**Lifecycle**: in_progress  
**Owner**: frontend  
**Parent**: `00-project-room/04-career-system/03-cv-engine`  

## Intent

source: manual 简历的 CodeMirror 编辑器 + 实时 PDF 预览 + versions 快照

让用户在 dashboard 里直接编辑 source: manual 类型的 base resume（不关联 Google Doc 的那些），配合右侧实时 PDF 预览验证视觉效果。左侧复用 LearnApp 现有的 markdown + CodeMirror 编辑组件（已支持语法高亮 + 保存），右侧用 Renderer 模块（04-renderer/01-html-template）产出 PDF 嵌入 iframe/object 实时渲染。每次保存前把当前 base.md 快照到 resumes/{id}/versions/{timestamp}.md；UI 提供回滚 dropdown（选择某个 timestamp → 预览 → 确认覆盖）。通过 editor 改出的 resume 不触发 Google Docs 同步（避免冲突）。验收：在 UI 编辑一份 manual resume，保存后 base.md 更新；右侧 PDF 预览反映最新；versions/ 里有旧版；能回滚到旧版。

## Milestones (planned 2026-04-29)

**3 milestones 规划完成**（~610 lines 估算，1/3 完成，all defaults 长期最优锁定）:

- ✅ **m1-content-versions-render-backend** (TBD, 185 lines 实际, server.mjs) — 4 endpoints:
  - `GET /api/career/resumes/:id/content` → `{ content, versions: [...] }`
  - `PUT /api/career/resumes/:id/content` (pre-write snapshot to `versions/${ISO}.md` + atomic write + FIFO cap 50)
  - `GET /api/career/resumes/:id/versions/:filename` → `{ content, ts, size }`
  - `GET /api/career/resumes/:id/render` (reads base.md + identity + metadata.renderer → composeCvHtml → htmlToPdf → stream `application/pdf`)
- **m2-resume-edit-page** (~280 lines) — full-page route `/career/settings/resumes/:id/edit`:
  - `Edit.tsx` + `edit.css`: CodeMirror left, iframe PDF preview right (split-pane); Save bar; beforeunload guard
  - Drawer "Edit content" link (m3-resume-index drawer 加 button)
  - Route placement: NOT under SettingsLayout (full-screen, no sidebar)
  - PDF iframe `src=...?v=${pdfRefreshKey}` cache-bust on Save + manual Refresh button
- **m3-versions-restore-ui** (~150 lines, ROOM COMPLETE) — toolbar Versions dropdown:
  - List of snapshots with timestamp + size + "Load" button
  - Load = fetch version content + setContent + setDirty (review-before-save UX)
  - Confirm before discard if dirty; close via outside-click / Escape

**Locked design decisions** (long-term-best, no questions to user):

| Q | Choice | Rationale |
|---|---|---|
| Edit UX | **Full-page route**, not embedded drawer | CV editing needs screen real estate; drawer keeps metadata edit |
| Save mechanism | **Explicit Save + dirty + beforeunload** | Same as Identity/Preferences; autosave adds race risk |
| PDF preview | **`GET /:id/render` from disk** + iframe `src=` + `?v=${ts}` cache bust on Save | Iframe simple GET; reflects ground truth; no blob-URL state |
| Live preview | **Refresh on Save** (not per-keystroke) | ~600ms render × debounce vs explicit Save; cleaner |
| Versions cap | **50 FIFO** | Years of casual editing; bounded disk |
| Restore | **Load into editor → Save creates new snapshot** | Reversible; user reviews before commit |
| google_doc resume editing | **Allowed; warn next Sync overwrites (versions/ saves it locally)** | Flexibility; reversible |
| Branch | **Off `resume-index`** (PR #10 pending) | Drawer "Edit content" needs m3 of resume-index |

**输出契约**: 这是 Sprint 3 视觉里程碑 — markdown ↔ PDF 实时编辑流跑通。完成后 04-renderer + 03-cv-engine 端到端可演示（pick base + edit + preview）。

## Specs in this Room

- [intent-in-ui-editor-001](specs/intent-in-ui-editor-001.yaml) — source: manual 简历的 CodeMirror 编辑器 + 实时 PDF 预览 + versions 快照
- [change-2026-04-29-m1-content-versions-render-backend](specs/change-2026-04-29-m1-content-versions-render-backend.yaml) — m1 backend: content / versions / render endpoints

---

_Milestones planned 2026-04-29 via plan-milestones skill._
