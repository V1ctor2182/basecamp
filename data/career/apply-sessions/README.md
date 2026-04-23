# apply-sessions/ — Applier 多步表单 session state

Workday / iCIMS 等多步表单的 state machine 持久化。全部 gitignored。

## 文件格式

```
apply-sessions/
└── {jobId}.json    🔒 每个进行中的多步 apply 一份 session
```

JSON schema：
```json
{
  "jobId": "...",
  "site_adapter": "workday",
  "job_url": "https://...",
  "current_step": 3,
  "total_steps": 7,
  "per_step_draft": { "1": {...}, "2": {...}, "3": {...} },
  "per_step_status": { "1": "filled", "2": "filled", "3": "pending" },
  "field_memory": { "firstName": "Chenyang", "email": "...", ... },
  "started_at": "...",
  "last_activity_at": "..."
}
```

## 生命周期

1. 用户对 Workday / iCIMS 岗位点 "Apply (Mode 2)"
2. Applier 状态机 INIT → 写 session file
3. 每一步 USER_APPROVE → FILL → NEXT_BUTTON_CLICK → 更新 session.current_step
4. **中断恢复**：dashboard 重启后扫 apply-sessions/ 显示 "Resumable: Anthropic step 3/7"，点 Resume 从 per_step_status 跳过已填步骤
5. 完成（ 用户 Mark submitted）→ archive（移到 sub-dir or 删除）
6. 超时 24h 无活动 → 自动标 abandoned（保留数据但不再 offer resume）

## 谁读 / 谁写

| 动作 | 谁 |
|---|---|
| 写入 | 07-applier/04-multi-step-state-machine |
| 读取 | 同上 (resume) + UI dashboard (显示 pending sessions) |

## 下游 feature

- `07-applier/04-multi-step-state-machine` — 唯一使用者
