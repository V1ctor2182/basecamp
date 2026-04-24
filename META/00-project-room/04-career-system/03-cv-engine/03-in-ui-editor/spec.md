# In-UI 简历编辑器

**Room ID**: `00-project-room/04-career-system/03-cv-engine/03-in-ui-editor`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: frontend  
**Parent**: `00-project-room/04-career-system/03-cv-engine`  

## Intent

source: manual 简历的 CodeMirror 编辑器 + 实时 PDF 预览 + versions 快照

让用户在 dashboard 里直接编辑 source: manual 类型的 base resume（不关联 Google Doc 的那些），配合右侧实时 PDF 预览验证视觉效果。左侧复用 LearnApp 现有的 markdown + CodeMirror 编辑组件（已支持语法高亮 + 保存），右侧用 Renderer 模块（04-renderer/01-html-template）产出 PDF 嵌入 iframe/object 实时渲染。每次保存前把当前 base.md 快照到 resumes/{id}/versions/{timestamp}.md；UI 提供回滚 dropdown（选择某个 timestamp → 预览 → 确认覆盖）。通过 editor 改出的 resume 不触发 Google Docs 同步（避免冲突）。验收：在 UI 编辑一份 manual resume，保存后 base.md 更新；右侧 PDF 预览反映最新；versions/ 里有旧版；能回滚到旧版。

## Specs in this Room

- [intent-in-ui-editor-001](specs/intent-in-ui-editor-001.yaml) — source: manual 简历的 CodeMirror 编辑器 + 实时 PDF 预览 + versions 快照

---

_Generated 2026-04-22 by room-init._
