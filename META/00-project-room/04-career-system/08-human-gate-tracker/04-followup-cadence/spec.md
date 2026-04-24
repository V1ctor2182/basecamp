# Follow-up Cadence

**Room ID**: `00-project-room/04-career-system/08-human-gate-tracker/04-followup-cadence`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/08-human-gate-tracker`  

## Intent

Follow-up 计算 + 提醒 + 邮件模板

根据 applications.json 每条 application 的 status + timeline 自动计算下次跟进时间写回 followup.nextAt + reason。简化规则：Applied 无回复 → 7 天后发 "checking in" 模板；Responded 无下一步 → 5 天后问进度；Interview 完成 → 24h 内发 thank-you + 7 天后追结果；Offer 待定 → 3 天决策窗口；Rejected → 30 天后可再联系（换岗位）；Discarded 不做跟进。UI /career/applied 页把 followup.nextAt < 3 天内的条目标黄 + 顶部放 "Today's follow-ups" 列表。配套邮件模板存 data/career/followup-templates.md，支持变量 {company} / {role} / {interviewer}，UI 点 "Compose Email" 填好模板后可 copy to clipboard（不自动发邮件，尊重用户节奏）。验收：跑一遍所有 Applied/Responded 状态的 application 能算出合理 followup.nextAt；UI Today's follow-ups 显示今天要发的 3 条；点某条能看到填好的邮件模板。

## Specs in this Room

- [intent-followup-cadence-001](specs/intent-followup-cadence-001.yaml) — Follow-up 计算 + 提醒 + 邮件模板

---

_Generated 2026-04-22 by room-init._
