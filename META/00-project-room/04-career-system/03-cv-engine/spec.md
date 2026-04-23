# CV Engine

**Room ID**: `00-project-room/04-career-system/03-cv-engine`  
**Type**: sub-epic  
**Lifecycle**: planning  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system`  

## Intent

多简历管理 + Google Docs 同步 + Auto-Select + 针对 JD 定制 Tailor

5 个 feature 组成的简历系统：(1) 01-resume-index — resumes/index.yml + metadata.yml 管理 backend/applied-ai/fullstack 等多份 base resume + Gallery UI；(2) 02-google-docs-sync — 按 resume 粒度 OAuth Sync（Doc 是 source of truth）；(3) 03-in-ui-editor — source:manual resume 的 CodeMirror + PDF 实时预览；(4) 04-auto-select — 基于 metadata.match_rules 给 Job 选最匹配的 base（+UI override）；(5) 05-tailor-engine — 读 base + Evaluator Block E 建议 → LLM 改写 → 调 Renderer 产出定制 PDF。核心设计：base 是用户维护的多份通用简历（按方向分），tailored 是针对每个 Job 自动生成的版本（改写而不捏造）。依赖 02-profile（narrative/proof-points）+ 04-renderer（PDF 渲染）+ 05-finder（Job schema）+ 06-evaluator（Block E）。

## Specs in this Room

- [intent-cv-engine-001](specs/intent-cv-engine-001.yaml) — 多简历管理 + Google Docs 同步 + Auto-Select + 针对 JD 定制 Tailor

## Child Rooms

- [多简历索引](01-resume-index/spec.md) — feature, planning
- [Google Docs 同步](02-google-docs-sync/spec.md) — feature, planning
- [In-UI 简历编辑器](03-in-ui-editor/spec.md) — feature, planning
- [Auto-Select](04-auto-select/spec.md) — feature, planning
- [Tailor Engine](05-tailor-engine/spec.md) — feature, planning

---

_Generated 2026-04-22 by room-init._
