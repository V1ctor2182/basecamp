# 多简历索引

**Room ID**: `00-project-room/04-career-system/03-cv-engine/01-resume-index`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/03-cv-engine`  

## Intent

resumes/index.yml + {id}/metadata.yml 多简历索引 + Gallery UI

多 base resume 管理的数据层 + 初版 UI。数据模型：data/career/resumes/index.yml 列出所有 base（id / title / description / source=google_doc|manual / gdoc_id / last_synced_at / is_default）；每份 resumes/{id}/ 下有 metadata.yml（archetype / match_rules: role_keywords+jd_keywords+negative_keywords / emphasize: projects+skills+narrative / renderer: template+font+accent_color）+ base.md（简历正文，gitignored）+ versions/ 快照目录。index.yml 和 metadata.yml commit（方向配置值得追踪），base.md 和 versions/ gitignored。UI：Settings → Resumes 页的 Gallery 视图，每份 resume 一张卡片显示 title / description / PDF 缩略图 / source 标记 / 最后更新时间；支持 Add New / Duplicate / Set as default / Delete（二次确认）。Match rules 编辑器复用 hard filter 的 tag input。验收：能看到 ≥3 份 resume 卡片，能切换 is_default；创建新 resume 会初始化 metadata.yml 模板。推荐初始创建 backend / applied-ai / fullstack / default 4 份。

## Specs in this Room

- [intent-resume-index-001](specs/intent-resume-index-001.yaml) — resumes/index.yml + {id}/metadata.yml 多简历索引 + Gallery UI

---

_Generated 2026-04-22 by room-init._
