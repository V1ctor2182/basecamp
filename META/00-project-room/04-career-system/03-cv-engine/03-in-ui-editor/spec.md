# In-UI 简历编辑器

**Room ID**: `00-project-room/04-career-system/03-cv-engine/03-in-ui-editor`  
**Type**: feature  
**Lifecycle**: active ✅  
**Owner**: frontend  
**Parent**: `00-project-room/04-career-system/03-cv-engine`  

## Intent

source: manual 简历的 CodeMirror 编辑器 + 实时 PDF 预览 + versions 快照

让用户在 dashboard 直接编辑 base.md，配合右侧 PDF 预览验证视觉效果。每次保存前自动快照到 `versions/`，UI 提供 Restore dropdown — 不慎改坏可以回滚。Sprint 3 视觉里程碑（markdown ↔ PDF 实时编辑流）。

## Implementation Summary

**3 milestones 完成**（2026-04-29）— ~735 lines net:

- ✅ **m1-content-versions-render-backend** (`7022263`, 185 lines, server.mjs) — 4 endpoints + helpers (slug + path-traversal defence, ISO snapshot filename, FIFO 50 cap)
- ✅ **m2-resume-edit-page** (`283cb55`, 335 lines) — full-page route `/career/settings/resumes/:id/edit` (NOT under SettingsLayout); CodeMirror left + iframe PDF right; Save bar + beforeunload guard; Drawer "Edit content" Link
- ✅ **m3-versions-restore-ui** (TBD, 215 lines, ROOM COMPLETE) — toolbar Versions dropdown + Restore (load → review → Save creates new snapshot)

## Backend API (4 endpoints)

| Endpoint | Behavior |
|---|---|
| `GET /api/career/resumes/:id/content` | `{ content, versions: [{filename, ts, size}] }` newest-first |
| `PUT /api/career/resumes/:id/content` | Pre-write snapshot to `versions/${ISO}.md` + atomic write base.md + FIFO prune to 50 |
| `GET /api/career/resumes/:id/versions/:filename` | Single snapshot read with 3-layer path traversal defence |
| `GET /api/career/resumes/:id/render` | Reads base.md + identity + metadata.renderer → composeCvHtml → htmlToPdf → stream `application/pdf` (iframe-friendly, `Content-Disposition: inline`) |

## Frontend UI (`/career/settings/resumes/:id/edit`)

**Full-page** (NOT under SettingsLayout — needs full viewport):

- **Toolbar**: ← Back to Resumes / mono `id` title / Versions dropdown ({count}) / status (Ready/Saving/Unsaved/✓ Saved at HH:MM) / Save button
- **Split-pane (1fr 1fr)**:
  - Left: CodeMirror with markdown extension (line numbers / foldGutter / highlightActiveLine)
  - Right: `<iframe key={pdfRefreshKey} src=".../render?v=${pdfRefreshKey}">` + Refresh PDF button
- **Versions popover** (320px wide, max-height 420):
  - Header: "Saved snapshots"
  - List rows: timestamp + size + Load button
  - Empty state: "No versions yet. Save the editor once to start the snapshot history."
  - Closes on outside-click / Escape / re-click button
- **Save flow**: Save → server pre-write snapshot → atomic write → frontend refreshes versions list + bumps `pdfRefreshKey` → iframe re-fetches PDF
- **Restore flow**: Load → confirm if dirty → setContent + setDirty → user reviews + Save → creates a new snapshot (pre-restore content captured)

**Entry**: Settings → Resumes → click card → Drawer expand → "Edit content" Pencil link.

## Locked Design Decisions (long-term-best, plan-milestones)

| Q | Choice | Rationale |
|---|---|---|
| Edit UX | **Full-page route**, not embedded drawer | CV editing needs screen real estate; drawer keeps metadata edit |
| Save mechanism | **Explicit Save + dirty + beforeunload** | Same as Identity/Preferences; no autosave race |
| PDF preview | **`GET /:id/render` from disk**, iframe `src=` + `?v=${ts}` cache bust + `key={ts}` force-rebuild | Reflects ground truth; no client blob URL state |
| Live preview | **Refresh on Save** (not per-keystroke) | ~600ms render × debounce vs explicit Save |
| Versions cap | **50 FIFO** | Years of casual editing; bounded disk |
| Restore | **Load into editor → user Saves** (creates new snapshot) | Reversible; review before commit; window.confirm if dirty |
| Popover close | **outside-click + Escape + re-click button** | Standard modal dismissal; doesn't block editing flow |
| Path traversal defence | **3-layer**: id slug regex + path.basename + filename regex | Defence in depth |
| google_doc resume editing | **Read-only in the in-app editor**; use `02-google-docs-sync` → Sync Now | Single source of truth; avoids drift/conflicts |
| Branch | Off `resume-index` | 1 PR/Room rhythm; needed Drawer link from m3-resume-index |

## Specs in this Room

- [intent-in-ui-editor-001](specs/intent-in-ui-editor-001.yaml) — source: manual 简历的 CodeMirror 编辑器 + 实时 PDF 预览 + versions 快照
- [change-2026-04-29-m1-content-versions-render-backend](specs/change-2026-04-29-m1-content-versions-render-backend.yaml) — m1 backend
- [change-2026-04-29-m2-resume-edit-page](specs/change-2026-04-29-m2-resume-edit-page.yaml) — m2 full-page edit route
- [change-2026-04-29-m3-versions-restore-ui](specs/change-2026-04-29-m3-versions-restore-ui.yaml) — m3 versions popover + Restore (ROOM COMPLETE)

## Downstream Callers

- `03-cv-engine/04-auto-select` → 选 base 后 navigate 到 `/:id/edit` review (route ready)
- `03-cv-engine/05-tailor-engine` → 完成 tailor 后产出 markdown，可创建临时 resume + navigate 到 `/:tailoredId/edit` 让用户审阅 + Save 生成 versions 历史
- `04-renderer/01-html-template` → 已就绪；`/api/career/resumes/:id/render` 是 first-class consumer of `htmlToPdf`

🎯 **Sprint 3 视觉里程碑达成 + versions safety net**. 现在 demoable: edit markdown → save → PDF live preview → restore from any of 50 snapshot history.

---

_Completed 2026-04-29 via dev skill (3 milestones × plan-milestones)._
