# Google Docs 同步

**Room ID**: `00-project-room/04-career-system/03-cv-engine/02-google-docs-sync`  
**Type**: feature  
**Lifecycle**: active ✅  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/03-cv-engine`  

## Intent

Google Docs OAuth + 按 resume 粒度 Sync（Doc → base.md markdown）

为 `source: google_doc` 的 base resume 提供一键同步能力：点 UI `Sync Now`
→ 调 Google Drive `files.export(..., text/markdown)` → 覆盖对应
`resumes/{id}/base.md`，同步前先快照到 `versions/`，并更新
`last_synced_at`。Google Doc 是这份 resume 的 source of truth，因此
`google_doc` resume 在 in-app editor 里是只读的，避免双向编辑冲突。

## Implementation Summary

**3 milestones 完成**（2026-04-30）— ~585 lines net:

- ✅ **m1-google-oauth-bootstrap** (`TBD`, 255 lines) — `src/career/lib/googleDocs.mjs` + OAuth start/callback endpoints + `data/career/.oauth.json` token store + helper smoke
- ✅ **m2-resume-sync-endpoint** (`TBD`, 145 lines) — `POST /api/career/resumes/:id/sync` + pre-sync snapshot + gdoc_id / last_synced_at persist
- ✅ **m3-sync-ui-and-readonly-guard** (`TBD`, 185 lines, ROOM COMPLETE) — Resumes drawer `Sync Now`, first-sync doc prompt, OAuth handoff, google_doc read-only guard in both UI and backend

## Backend API

### `GET /api/career/google/oauth/start`

Redirects the user into Google OAuth. Requires client credentials via:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

or `data/config.json` fields:

- `googleClientId`
- `googleClientSecret`

Optional override:

- `CAREER_GOOGLE_REDIRECT_BASE_URL`

### `GET /api/career/google/oauth/callback`

Exchanges the auth code for a refresh token and stores it in
`data/career/.oauth.json`.

### `POST /api/career/resumes/:id/sync`

Body:

```json
{
  "gdoc_id": "optional bare ID or full Google Docs URL"
}
```

Returns:

```json
{
  "ok": true,
  "snapshot": "2026-04-30T16-42-19.000Z.md",
  "synced_at": "2026-04-30T16:42:19.000Z",
  "resume": {
    "id": "backend",
    "source": "google_doc",
    "gdoc_id": "1AbCdEf...",
    "last_synced_at": "2026-04-30T16:42:19.000Z"
  }
}
```

Error contract:

- `409 { auth_required: true, authorize_path: "/api/career/google/oauth/start" }`
  when OAuth is missing or expired
- `400` when no valid Google Doc ID is available
- `413` when exported markdown exceeds the resume content cap

## Frontend UI (`/career/settings/resumes`)

- `google_doc` card drawer now shows **Sync Now**
- If `gdoc_id` is missing, first sync prompts for a Google Doc URL/ID and persists the normalized ID
- If sync needs authorization, the UI opens the OAuth flow in a new tab and tells the user to click sync again afterwards
- Manual resumes keep the **Edit content** button
- `google_doc` resumes show a disabled **Managed by Google Doc** button instead

## Locked Design Decisions (long-term-best, plan-milestones)

| Q | Choice | Rationale |
|---|---|---|
| Export source | **Drive `files.export(..., text/markdown)`** | Markdown is the native downstream format for renderer/tailor |
| OAuth storage | **`data/career/.oauth.json`** | Local, gitignored, survives restarts |
| Permissions | **`drive.readonly`** | Read-only scope is enough; no write privileges |
| First sync UX | **Allow paste of bare ID or full docs URL** | Avoids forcing gdoc_id entry at create-time |
| Source of truth | **`google_doc` resumes are read-only in in-app editor** | Prevents local edits from drifting away from Google Doc |
| Snapshot timing | **Before overwrite** | Every sync keeps a rollback point |
| Expired auth | **Return `auth_required` and clear invalid token** | Predictable recovery path |

## Specs in this Room

- [intent-google-docs-sync-001](specs/intent-google-docs-sync-001.yaml) — Google Docs OAuth + 按 resume 粒度 Sync（Doc → base.md markdown）
- [constraint-google-docs-sync-001](specs/constraint-google-docs-sync-001.yaml) — Sync 前必须快照 + OAuth token 必须 gitignored
- [change-2026-04-30-m1-google-oauth-bootstrap](specs/change-2026-04-30-m1-google-oauth-bootstrap.yaml) — OAuth bootstrap + helper module + smoke
- [change-2026-04-30-m2-resume-sync-endpoint](specs/change-2026-04-30-m2-resume-sync-endpoint.yaml) — sync endpoint + snapshot + index persist
- [change-2026-04-30-m3-sync-ui-and-readonly-guard](specs/change-2026-04-30-m3-sync-ui-and-readonly-guard.yaml) — Sync Now UI + read-only guard (ROOM COMPLETE)

## Downstream Callers

- `03-cv-engine/03-in-ui-editor` → `google_doc` resumes are now explicitly read-only there
- `03-cv-engine/05-tailor-engine` → can rely on `base.md` being refreshed from the upstream Google Doc source
- `04-renderer/01-html-template` → continues to render the synced `base.md`

🎯 **Google Doc source-of-truth flow landed**. Now demoable: authorize once → Sync Now →
snapshot old base → overwrite `base.md` with exported markdown → preview / downstream consumers use the fresh content.

---

_Completed 2026-04-30 via manual implementation._
