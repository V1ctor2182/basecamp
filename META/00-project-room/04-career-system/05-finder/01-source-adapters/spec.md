# Source Adapters

**Room ID**: `00-project-room/04-career-system/05-finder/01-source-adapters`  
**Type**: feature  
**Lifecycle**: planning  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/05-finder`  

## Intent

6 种 Source Adapter：Greenhouse / Ashby / Lever / github-md / scrape / rss / manual

Finder 的可插拔数据源层，每个 adapter 实现 fetch(config) → RawJobs[] 和 normalize(raw, source) → Job。初版先做 3 个主流 ATS API（零 token、无反爬）：(1) Greenhouse: https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true；(2) Ashby: https://api.ashbyhq.com/posting-api/job-board/{slug}；(3) Lever: https://api.lever.co/v0/postings/{slug}?mode=json。再加 2 个高 ROI 源：(4) github-md: 从 raw.githubusercontent.com 拉 SimplifyJobs / speedyapply 等 repo 的 README.md，按表格行解析（处理 ↳ 同公司续行 / 🔒 已关闭）；(5) manual: POST /api/career/pipeline/manual { url, note } 让用户粘 URL + Playwright 兜底抓。剩余（scrape / rss / SmartRecruiters / Recruitee / Workable）作为后续扩展，不在 MVP 里。portals.yml 配各源的 slug / config / priority。验收：配好 10 个 Greenhouse 公司 + 3 个 github-md repo 后跑一次 fetch，能拿到 100+ raw jobs；normalize 后全部通过 Zod schema 校验；Job.raw 字段保留原始数据留底。

## Constraints

外部 API / 爬虫必须遵守：rate limit / robots.txt / 公开 UA / 禁止 LinkedIn 类自动扫

(1) 每个 adapter 调用外部 API 的请求间隔 MUST ≥ 1s（即使平台允许更高频率也自我克制）；(2) HTTP adapters MUST 尊重 robots.txt — 爬之前 fetch robots.txt 检查路径；(3) User-Agent header MUST 标明本项目（例 "learn-dashboard career-system/1.0 (https://github.com/...)" 或用户邮箱），不能伪装浏览器；(4) LinkedIn / Indeed / Glassdoor / ZipRecruiter MUST NOT 自动扫 — ToS 严格禁止，风险不对等。这些平台上的岗位只能用 manual adapter 粘 URL；(5) 所有 network 错误 MUST 捕获 + 记录，不得让一个 source 挂掉整个 scan。

## Specs in this Room

- [intent-source-adapters-001](specs/intent-source-adapters-001.yaml) — 6 种 Source Adapter：Greenhouse / Ashby / Lever / github-md / scrape / rss / manual
- [constraint-source-adapters-001](specs/constraint-source-adapters-001.yaml) — 外部 API / 爬虫必须遵守：rate limit / robots.txt / 公开 UA / 禁止 LinkedIn 类自动扫

---

_Generated 2026-04-22 by room-init._
