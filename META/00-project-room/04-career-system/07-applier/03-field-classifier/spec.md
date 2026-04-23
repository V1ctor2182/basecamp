# Field Classifier

**Room ID**: `00-project-room/04-career-system/07-applier/03-field-classifier`  
**Type**: feature  
**Lifecycle**: backlog  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/07-applier`  

## Intent

4 class 字段分类器 + 分类路由（Hard Info / Legal / Open-Ended / File）

Mode 2 Applier 的核心智能：把表单每个字段路由到不同填充策略。输入：DOM 扫描得到的 field list（id / label / type / required / placeholder / maxLength / options）。分类（按优先级 Hard > Legal > File > Open > Unknown）：(1) Class 1 Hard Info — 姓名/邮箱/电话/LinkedIn/GitHub/portfolio(URL 字段，非 file) / 学校 / 学位 / GPA 等，纯 regex 匹配 label，查 identity.yml 直接填；(2) Class 2 Legal — sponsor / visa / citizen / gender / race / veteran / felony / relocate / how-did-you-hear 等，查 qa-bank/legal.yml，EEO 默认 "Decline to answer"；(3) Class 3 Open-Ended — textarea 或 text maxLength≥100 或 label 含 Why/Tell/Describe 等，子分类 why-company / why-role / tell-me-about / weakness / salary-expectation / start-date / notice-period / reason-for-leaving / unknown-open，走 LLM + templates + history；(4) Class 4 File Upload — resume/cv 用 output/{jobId}-{resumeId}.pdf，cover letter 按需 LLM 生成，work-samples 不强制（有 URL 字段走 Class 1）。产出 drafts/{jobId}.json 给 Mode 1 复用 / Mode 2 Playwright 消费。置信度标记 High/Medium/Low/Manual（见 05-non-standard-controls）。验收：给一份 Greenhouse 申请表（~15 字段），classifier 产出 drafts JSON 里每字段的 class 和 suggested_value 正确率 ≥ 90%。

## Specs in this Room

- [intent-field-classifier-001](specs/intent-field-classifier-001.yaml) — 4 class 字段分类器 + 分类路由（Hard Info / Legal / Open-Ended / File）

---

_Generated 2026-04-22 by room-init._
