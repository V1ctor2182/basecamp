# Non-Standard Controls

**Room ID**: `00-project-room/04-career-system/07-applier/05-non-standard-controls`  
**Type**: feature  
**Lifecycle**: planning (Mode 2 LOCKED 2026-05-11)  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/07-applier`  

## Intent

21 种非标控件策略 + 置信度分级 + 红框高亮 Manual fallback

普通 input 用 page.fill() 一行搞定，真实表单大量自定义控件需要特殊处理。覆盖 21 种控件（见架构文档 §6.4 完整表）：HTML5 date / React DatePicker / MUI DatePicker / Flatpickr / 分离式 month-day-year select / 未知日历 (Manual) / Google Places autocomplete / Algolia Places / 自定义地址补全 (Manual) / Radio button (标准 vs div[role=radio]) / Checkbox / Multi-select chip/tag / Select (标准 vs custom combobox vs 搜索式) / TinyMCE/Quill/Draft.js 富文本 / Slider/Range / CAPTCHA (必须 Manual) / Shadow DOM / iframe 表单。通用处理：先 try high-confidence strategy → 失败 fallback 到 medium-confidence → 再失败标记 Manual。**不强行填**：失败就停，不让 agent 把错数据填进去。置信度分级：🟢 High (approve all 直接过) / 🟡 Medium (高亮建议 review) / 🔴 Low (阻塞必须 review) / ⚠️ Manual (Applier 不填，用户在浏览器处理)。手工补救 UX：浏览器里该字段红框高亮 + 滚到中心 + Dashboard 弹 "请去浏览器填 X，完成后回来点 Continue" + 提供建议值 Copy to Clipboard + Continue/Skip/Abort 选项。验收：对有 date picker + multi-select chips + CAPTCHA 的表单跑一遍，日历和 chip 能自动填，CAPTCHA 触发 Manual fallback 红框高亮 + dashboard 提示；用户手填完点 Continue 后继续。

## Constraints

失败必须 fallback 到 Manual；Low confidence 字段必须阻塞 review

(1) 任何控件的 high-confidence strategy 失败 → try medium-confidence → 再失败 → MUST 标记为 Manual 让用户处理，MUST NOT 强行填错数据（"填错"的代价是整个申请被 ATS 判断为 bot 或数据错误拒掉）；(2) Draft JSON 中 confidence = "Low" 的字段 MUST 在 UI 上阻塞 "Approve All" 按钮 — 用户必须逐个 review 才能过；Medium 默认高亮但可一键过；High 默认静默过；(3) CAPTCHA / reCAPTCHA 检测到 MUST 立即暂停 agent + 显式通知用户在浏览器里手动解决，绝不尝试绕过（任何自动化 CAPTCHA 方案都违反 ToS + 风险高）；(4) 富文本编辑器 (TinyMCE / Quill / Draft.js) 默认 Manual fallback — 这类控件 DOM 结构每家不同，强行填容易丢格式。

## Specs in this Room

- [intent-non-standard-controls-001](specs/intent-non-standard-controls-001.yaml) — 21 种非标控件策略 + 置信度分级 + 红框高亮 Manual fallback
- [constraint-non-standard-controls-001](specs/constraint-non-standard-controls-001.yaml) — 失败必须 fallback 到 Manual；Low confidence 字段必须阻塞 review

## 当前进度 — 🟢 planning (milestones locked 2026-05-15)

**Plan A 锁定**. 4 milestones (~1830 LOC + ~950 smoke):

| m | 内容 | LOC | 解锁 |
|---|------|-----|------|
| **m1** | Control router + 标准控件 + `nonstandardFillField` (替换 PROVISIONAL `defaultFillField`) | ~580 (280 + 300 smoke) | 完整可用的 `_fillField`，覆盖标准控件 |
| **m2** | 日期控件 (6 种) + 地址自动补全 (3 种) | ~470 (220 + 250 smoke) | ATS 通用日历 + Google/Algolia 地址 |
| **m3** | 选择控件变体: `radio_div` / chip / custom_combobox / search_select | ~380 (180 + 200 smoke) | Workday/Greenhouse 自定义 combobox |
| **m4** | CAPTCHA + 富文本 + slider + Shadow DOM + iframe + Manual highlight + endpoint 接线 + ROOM COMPLETE | ~400 (200 + 200 smoke) | 06-site-adapters + 08-human-gate-tracker/02 |

### Locked OQ

| OQ | 决定 | 理由 |
|----|------|------|
| Q1 STALE_REF | Raw locator bypass | multi-action 序列拿一次 locator 直接操作，不再过 RefTable；跨字段失效是 machine 层问题 |
| Q2 控件检测深度 | ARIA + class sniff | 一次 `page.evaluate` 拿 className/dataset，能区分 flatpickr / MUI / React DatePicker / Quill / TinyMCE |
| Q3 scope | 完全替换 `defaultFillField` | machine.mjs 注释明确说 "real action-verb layer"，标准+非标都走新的 `nonstandardFillField` |

### 与已 shipped 基础的关系

```
02-playwright-runtime (ROOM COMPLETE)
  ↓ actions.mjs (click/fill/select/press/upload + RefTable invalidation)
08-snapshot-refs-layer (ROOM COMPLETE)
  ↓ snapshot() → { text, table, skippedFrames }
03-field-classifier m1 (COMPLETE) — m2/m3 进行中
  ↓ classifiedField { class, role, name, refId, suggested_value, confidence }
04-multi-step-state-machine (ROOM COMPLETE) — defaultFillField 标记为 PROVISIONAL
  ↓ machine.mjs's _fillField injection point: (page, refId, classifiedField, table)
05-non-standard-controls (this Room)
  ↓ nonstandardFillField — 完整替换 defaultFillField
  ↓ 26 ControlType (5 standard + 21 non-standard)
  ↓ 写入 classifiedField.manual_required / block_approve / confidence
```

---

_Generated 2026-04-22 by room-init. Plan refined 2026-05-15 by plan-milestones._
