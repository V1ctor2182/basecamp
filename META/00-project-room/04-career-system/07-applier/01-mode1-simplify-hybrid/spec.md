# Mode 1 - Simplify Hybrid

**Room ID**: `00-project-room/04-career-system/07-applier/01-mode1-simplify-hybrid`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: fullstack  
**Parent**: `00-project-room/04-career-system/07-applier`  

## Intent

Mode 1 Simplify Hybrid：生成开放题 draft + 复制粘贴流程 + Mark submitted

最省时的 apply 流程，推荐日常用。用户装 Simplify Chrome 插件处理常规 ATS 字段（姓名 / 邮箱 / 学校 / 公司 / 日期 etc），本系统只处理 JD-specific 开放题 + 定制简历上传。流程：(1) 用户在 shortlist 点 Apply → 后端 POST /api/career/apply/draft { jobId } → 读 JD + reports/{jobId}.md + qa-bank/legal + templates + history → 产出 drafts/{jobId}.json（每字段一条：label / class / suggested_value / confidence / source_ref）；(2) 前端展示开放题建议答案（Why us / Tell us / Expected salary 等），每条有 [Copy] 按钮 + 可编辑；(3) 用户切到浏览器 Simplify autofill 常规字段 + 复制粘贴开放题答案 + 手动上传 output/{jobId}-{resumeId}.pdf + 手动点 Submit；(4) 回 UI 点 "Mark submitted" → POST /api/career/apply/submitted → 状态更新为 Applied + append 用户最终提交的答案到 qa-bank/history.jsonl（Applier 飞轮②的数据源）+ 更新 applications.json timeline。验收：跑一次真实申请，draft 里开放题答案质量能直接粘贴（<30% 改动）；mark submitted 后 applications.json 状态为 Applied + history.jsonl 多一条记录。

## Constraints

永远不自动点 Submit；状态只在用户明确 Mark submitted 后才改 Applied

(1) Mode 1 MUST NOT 实现任何自动提交逻辑 — 本 feature 只生成 drafts/{jobId}.json 供用户复制粘贴，绝不触发浏览器动作（即使未来加 Playwright 自动化，也归 Mode 2 的 feature，不能在 Mode 1 里悄悄做）；(2) applications.json 的 status Evaluated → Applied 的转换 MUST 且仅在用户点 UI 的 "Mark submitted" 按钮后发生，绝不能因为生成了 draft 就推测已投；(3) qa-bank/history.jsonl 的 append MUST 同时发生（"Mark submitted" 时一起），不能在生成 draft 时提前写（否则用户没投也会污染 few-shot 上下文）；(4) UI 的 "Mark submitted" 按钮 MUST 二次确认（modal "你确定已在浏览器点过 Submit 吗？"），防止误触。

## Specs in this Room

- [intent-mode1-simplify-hybrid-001](specs/intent-mode1-simplify-hybrid-001.yaml) — Mode 1 Simplify Hybrid：生成开放题 draft + 复制粘贴流程 + Mark submitted
- [constraint-mode1-simplify-hybrid-001](specs/constraint-mode1-simplify-hybrid-001.yaml) — 永远不自动点 Submit；状态只在用户明确 Mark submitted 后才改 Applied

---

_Generated 2026-04-22 by room-init._
