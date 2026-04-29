# 多简历索引

**Room ID**: `00-project-room/04-career-system/03-cv-engine/01-resume-index`  
**Type**: feature  
**Lifecycle**: active ✅  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/03-cv-engine`  

## Intent

`resumes/index.yml` + `{id}/metadata.yml` 多简历索引 + Gallery UI

多 base resume 管理的数据层 + Settings → Resumes Gallery UI。每份 resume 一个 archetype（backend / applied-ai / fullstack 等），auto-select 按 JD match-rules 自动挑选 base 用于 tailor。

## Implementation Summary

**3 milestones 完成**（2026-04-28 ~ 2026-04-29）— ~1406 lines net:

- ✅ **m1-resume-index-backend** (`9185a9d`, 275 lines, complexity_flags: design_decisions) — Zod schemas (ResumeIndexEntry / Index / MatchRules / Emphasize / RendererConfig / ResumeMetadata) + slug regex `^[a-z0-9-]{1,40}$` + `validateResumeId` / `resolveResumeDir` (path-traversal belt-and-suspenders) + 5 endpoints (`GET /resumes` / `POST` / `DELETE /:id` / `PATCH /:id/set-default` atomic flip / `GET+PUT /:id/metadata`) + `DEFAULT_BASE_MD` H2 skeleton (committed soft contract with narrative/proof-points downstream)
- ✅ **m2-resume-gallery-ui** (`7ca3475`, 709 lines) — Settings → Resumes card grid + Add modal (slugify on blur + inline regex/dup check + source radio + conditional gdoc_id) + Delete (type "delete" to confirm) + Set as default (3-dot menu) + Empty state CTA + new `resumes.css` (303 lines)
- ✅ **m3-resume-metadata-editor** (TBD, 422 lines, ROOM COMPLETE) — In-place expand drawer (4 sections: Archetype / Match Rules / Emphasize / Renderer with color picker) + Save bar with dirty/saved status + Duplicate action (3-dot menu → prompt → backend `POST /:id/duplicate` atomic clone metadata + fresh base.md skeleton)

## Backend API (6 endpoints)

| Endpoint | Behavior |
|---|---|
| `GET /api/career/resumes` | Full index `{ resumes: [...] }` |
| `POST /api/career/resumes` | Create resume — body `{ id, title, description?, source: 'manual'\|'google_doc', gdoc_id?, set_default? }`. Mkdir `{id}/versions/`, write `metadata.yml` defaults + `base.md` H2 skeleton, atomic index update. 201 + entry |
| `DELETE /api/career/resumes/:id` | Remove from index + `fs.rm(dir, recursive)`. 200 / 404 |
| `PATCH /api/career/resumes/:id/set-default` | Atomic flip — `is_default: r.id === id`. 200 / 404 |
| `GET / PUT /api/career/resumes/:id/metadata` | ResumeMetadata round-trip (Zod nested defaults preserved on partial PUT) |
| `POST /api/career/resumes/:id/duplicate` | body `{ new_id, new_title? }` → atomic clone of metadata + fresh `base.md` skeleton + new index entry (source=manual, is_default=false) |

**Path traversal defense**: regex `^[a-z0-9-]{1,40}$` + reserved id `index` + `path.resolve` + prefix check.

## Frontend UI (`/career/settings/resumes`)

**Card grid** (auto-fill 280px minimum):
- Title + ★ Default badge
- Source pill (Manual gray / Google Doc green)
- Description (line-clamp 2)
- Footer: mono `id` + last_synced/created date
- Click card → expand drawer in-place
- 3-dot menu: Set as default / Duplicate… / Delete…

**Empty state**: FileText icon + "No resumes yet" + Add Resume CTA.

**Add Resume modal**:
- ID (slugify on blur, inline regex + dup check)
- Title (required, max 200) + Description (optional, max 500)
- Source radio (Manual / Google Doc) — Google Doc shows gdoc_id field
- Set as default checkbox

**Delete confirm modal**: warn box + type `delete` to enable red Delete button.

**Expand drawer** (4 sections):
1. **Archetype** — single text label like "Backend SDE / L4"
2. **Match Rules** — 3 TagInputs (role / jd / negative keywords)
3. **Emphasize** — 2 TagInputs (projects / skills) + textarea narrative
4. **Renderer** — template / font / accent_color (color picker + hex text 双向同步)
- Save bar: status (Ready / Unsaved / ✓ Saved at HH:MM) + "Save Metadata" button (disabled if !dirty || saving)
- `beforeunload` guard when dirty
- X button collapses drawer

**Duplicate flow**: 3-dot menu → window.prompt for new ID (default `${source.id}-copy`) → slugify + inline regex/dup check → backend POST → refresh.

## Locked Design Decisions (long-term-best, plan-milestones)

| Q | Choice | Rationale |
|---|---|---|
| PDF thumbnail | **Defer** | Needs rasterization (pdf-poppler/sharp); text card already conveys |
| Resume id format | **slug `^[a-z0-9-]{1,40}$`**; reserved `index` | URL-safe + path-traversal-safe + unambiguous |
| Resume creation | **POST creates dir + metadata.yml + base.md skeleton** | 与 narrative/proof-points 软契约一致 (## Experience / ## Education / ## Skills / ## Projects) |
| Edit UX | **In-place expand drawer** (not modal) | 保持 gallery 上下文 |
| `is_default` constraint | **Backend atomic flip** | Single source of truth; race-safe |
| Initial seed | **Empty state + CTA "Add resume"** | 显式用户动作 |
| Match rules editor | **复用 TagInput** | DRY (共享 m2-preferences) |
| Color picker | **`<input type=color>` + hex text 双向同步** | 拖 OR 精确输入 |
| Duplicate | **Backend `POST /:id/duplicate`** + base.md skeleton (不复制内容) | 比前端拼装原子; semantically "新方向", 内容复制是 03-in-ui-editor 的 paste-import |

## Specs in this Room

- [intent-resume-index-001](specs/intent-resume-index-001.yaml) — 多简历索引 + Gallery UI
- [change-2026-04-28-m1-resume-index-backend](specs/change-2026-04-28-m1-resume-index-backend.yaml) — m1 backend
- [change-2026-04-29-m2-resume-gallery-ui](specs/change-2026-04-29-m2-resume-gallery-ui.yaml) — m2 Gallery UI
- [change-2026-04-29-m3-resume-metadata-editor](specs/change-2026-04-29-m3-resume-metadata-editor.yaml) — m3 drawer + Duplicate (ROOM COMPLETE)

## Downstream Callers

- **`03-cv-engine/02-google-docs-sync`** → card 加 Sync 按钮 (only for `source='google_doc'`)
- **`03-cv-engine/03-in-ui-editor`** → drawer 加第二 tab 编辑 base.md 内容 + 实时 PDF 预览
- **`03-cv-engine/04-auto-select`** → 读 `index` + `metadata.match_rules` 选 base
- **`03-cv-engine/05-tailor-engine`** → 读 `metadata.emphasize` + `metadata.renderer` 调风格
- **`04-renderer/01-html-template`** → ready (m2 已完成); 后续 03-in-ui-editor 调 `/api/career/render/pdf` with `metadata.renderer` 作 options

**⚠️ 重要**: backend Zod permissive — 老 metadata.yml 不带新字段时 deepMerge 后填默认值，下游消费者直接读不会崩。但 use-time 还是要 re-check 关键字段（match_rules 全空 → auto-select 应跳过）。

---

_Completed 2026-04-29 via dev skill (3 milestones × plan-milestones)._
