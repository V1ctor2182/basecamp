# 多简历索引

**Room ID**: `00-project-room/04-career-system/03-cv-engine/01-resume-index`  
**Type**: feature  
**Lifecycle**: in_progress  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/03-cv-engine`  

## Intent

resumes/index.yml + {id}/metadata.yml 多简历索引 + Gallery UI

多 base resume 管理的数据层 + 初版 UI。数据模型：data/career/resumes/index.yml 列出所有 base（id / title / description / source=google_doc|manual / gdoc_id / last_synced_at / is_default）；每份 resumes/{id}/ 下有 metadata.yml（archetype / match_rules: role_keywords+jd_keywords+negative_keywords / emphasize: projects+skills+narrative / renderer: template+font+accent_color）+ base.md（简历正文，gitignored）+ versions/ 快照目录。index.yml 和 metadata.yml commit（方向配置值得追踪），base.md 和 versions/ gitignored。UI：Settings → Resumes 页的 Gallery 视图，每份 resume 一张卡片显示 title / description / PDF 缩略图 / source 标记 / 最后更新时间；支持 Add New / Duplicate / Set as default / Delete（二次确认）。Match rules 编辑器复用 hard filter 的 tag input。验收：能看到 ≥3 份 resume 卡片，能切换 is_default；创建新 resume 会初始化 metadata.yml 模板。推荐初始创建 backend / applied-ai / fullstack / default 4 份。

## Milestones (planned 2026-04-28)

**3 milestones 规划完成**（~910 lines 估算，1/3 完成，all defaults 长期最优锁定）:

- ✅ **m1-resume-index-backend** (TBD, 275 lines 实际, complexity_flags: design_decisions) —
  Zod schemas (ResumeIndex / ResumeMetadata with MatchRules / Emphasize / RendererConfig nested) + `validateResumeId` slug regex + `resolveResumeDir` path-traversal guard + 5 endpoints (`GET /api/career/resumes` / `POST` / `DELETE /:id` / `PATCH /:id/set-default` / `GET+PUT /:id/metadata`). Atomic write index + atomic flip default. Creates dir + metadata.yml defaults + base.md skeleton on POST.
- **m2-resume-gallery-ui** (~350 lines) — `Settings → Resumes` Gallery: card grid + source badge + default ★ + Add (modal with slugify) + Delete (type-to-confirm) + Set Default. Empty state with CTA. New `resumes.css`.
- **m3-resume-metadata-editor** (~280 lines, ROOM COMPLETE) — Click card → expand drawer in-place. 4 sections (Archetype / Match Rules with TagInput / Emphasize / Renderer with color picker). Sticky save bar (复用 ats-form pattern). + Duplicate action with backend `POST /:id/duplicate` endpoint (atomic copy of metadata, fresh base.md skeleton).

**Locked design decisions** (long-term-best, no questions to user):

| Q | Choice | Rationale |
|---|---|---|
| PDF thumbnail in card | **Defer** | Needs rasterization (pdf-poppler/sharp); text card already conveys identity |
| Resume id format | **slug `^[a-z0-9-]{1,40}$`**; reserved `index` | URL-safe + path-traversal-safe + human-readable |
| Resume creation | **POST creates dir + metadata.yml + base.md skeleton** | 与 narrative/proof-points 软契约一致 (## Experience / ## Education / ## Skills / ## Projects) |
| Edit UX | **In-place expand drawer** (not modal) | 保持 gallery 上下文; 切换其他卡只切 expandedId |
| `is_default` | **Backend atomic flip** (PATCH /set-default) | Single source of truth; race-safe |
| Initial seed | **Empty state + CTA "Add resume"** | 显式用户动作; seed buttons = UI 复杂度 for 一次性 |
| Match rules editor | **复用 TagInput** (from m2-preferences) | DRY; 一致 UX |
| Color picker | **`<input type=color>` + hex text 双向同步** | 拖 OR 精确输入 |
| Duplicate | **Backend `POST /:id/duplicate` endpoint** (m3 加) | 比前端拼装更原子 (无 orphan dir on partial fail); base.md skeleton 不复制 (语义是"开始一份新方向") |
| Branch | **Off `html-template`** | 1 PR/Room rhythm; rebases clean |

**Output contract for downstream**:
- `02-google-docs-sync` → 接入 `source='google_doc'` resume 的 Sync 按钮
- `03-in-ui-editor` → drawer 加第二 tab 编辑 base.md 内容
- `04-auto-select` → 读 `index` + `metadata.match_rules` 选 base
- `05-tailor-engine` → 读 `metadata.emphasize` + `renderer` 调风格

## Specs in this Room

- [intent-resume-index-001](specs/intent-resume-index-001.yaml) — resumes/index.yml + {id}/metadata.yml 多简历索引 + Gallery UI
- [change-2026-04-28-m1-resume-index-backend](specs/change-2026-04-28-m1-resume-index-backend.yaml) — m1 backend Zod schemas + 5 endpoints + slug guard + atomic default flip

---

_Milestones planned 2026-04-28 via plan-milestones skill._
