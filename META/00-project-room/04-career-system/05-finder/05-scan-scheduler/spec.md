# Scan Scheduler

**Room ID**: `00-project-room/04-career-system/05-finder/05-scan-scheduler`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/05-finder`  

## Intent

定时 scan 调度 + 每 source type 独立 cadence + pipeline.json 入队

串起所有 finder 子模块的调度层。server.mjs 启动时用 setInterval 按 portals.yml.scan_cadence 为每个 source type 独立调度：github-md 每 24h（更新快）、greenhouse/ashby/lever 每 72h、scrape 每 168h（一周一次，反爬风险小）。每轮：1-多源并行拉取 → 2-normalize → 3-dedupe → 4-hard_filter → 5-jd_enrich → 6-append 到 data/career/pipeline.json（状态 Pending）。UI 也提供 "Scan Now" 按钮（POST /api/career/scan 手动触发）和 "Scan One Source" 调试接口。所有 LLM 成本调用（本阶段无 LLM）都走 01-foundation/03-llm-cost-observability 记录。错误处理：某个 source fetch 失败不影响其他；某条 Job normalize 失败只跳过那一条；整个流程幂等（重复跑不产生副作用）。验收：跑一轮完整 scan 能看到 pipeline.json 增加新的 Pending 岗位；scan-history.jsonl 记录本次所有扫到的 id；archive.jsonl 记录所有 drop。

## Specs in this Room

- [intent-scan-scheduler-001](specs/intent-scan-scheduler-001.yaml) — 定时 scan 调度 + 每 source type 独立 cadence + pipeline.json 入队

---

_Generated 2026-04-22 by room-init._
