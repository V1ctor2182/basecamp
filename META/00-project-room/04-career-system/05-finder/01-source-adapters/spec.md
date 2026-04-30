# Source Adapters

**Room ID**: `00-project-room/04-career-system/05-finder/01-source-adapters`  
**Type**: feature  
**Lifecycle**: active (ROOM COMPLETE)  
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

## 当前进度 — 🎉 ROOM COMPLETE (2026-04-30)

4 milestones, ~1700 行 actual:

- ✅ **m1-scan-infra-greenhouse** (`c82f5ae`, 605 行) — httpFetch (robots-cache + UA + maxBytes) + portalsLoader + scanRunner + Greenhouse adapter + 2 endpoints + smoke 12/12
- ✅ **m2-ashby-lever** (`d848a19`, 360 行) — Ashby + Lever adapters; smoke 19/19
- ✅ **m3-github-md** (`62e7c1b`, 405 行) — HTML `<table>` (cheerio) + markdown-pipe (regex fallback) for SimplifyJobs / speedyapply; smoke 12/12
- ✅ **m4-manual-and-portals-ui** (`TBD`, 580 行) — manual paste endpoint + Settings → Portals CRUD UI

### Locked design (long-term-best)

| Decision | Choice |
|----------|--------|
| `pipeline.json` shape | `{ jobs: Job[], last_scan_at, scan_summary: [{source, type, count, duration_ms, error?}] }` |
| Scan execution | POST `/scan` 202 + scan_id, background runner, GET `/scan/status` poll |
| Concurrent scan | `scanState.running` guard, 二次 POST → 409 |
| Rate limit | 1s sleep between fetch (sequential, 整个 scanRunner) |
| Robots.txt | shared `httpFetch()` — 每 domain per-scan 缓存, blocked → throw + scan_summary error |
| User-Agent | `learn-dashboard career-system/1.0 (+https://github.com/V1ctor2182/basecamp)` |
| Body limit | 1MB max, 10s timeout (AbortController) |
| Error isolation | try/catch per source — 单 source 挂不影响其他 |
| Description | `stripHtml()` → plain text |
| comp_hint | 各 ATS 不强抽 (信号弱), null |
| Manual adapter | URL + title (可选, 否则 cheerio 抽 `<title>`) + note; description=null defer to enrich |
| Portals UI | nested route `/career/settings/portals`, Identity 同 pattern (load/dirty/save/before-unload) |
| scan-history.jsonl | defer to `03-dedupe-hard-filter` (其 constraint own append-only) |
| File layout | `src/career/finder/{httpFetch,portalsLoader,scanRunner}.mjs` + `adapters/{greenhouse,ashby,lever,githubMd,manual}.mjs` |

### 下游

- **`03-dedupe-hard-filter`**: 消费 `pipeline.json.jobs`, 写 scan-history + archive.jsonl
- **`04-jd-enrich`**: 处理 `description===null` jobs (含 manual + github-md 大部分; 检查 `tags` 含 `enriched_via:manual_pending`)
- **`05-scan-scheduler`**: setInterval 调本 Room 的 POST `/scan`

### Live data 实绩 (full scan against current portals.yml)

```
3 GH ✓     Anthropic 441 + Stripe 491 + Databricks 815          = 1747 jobs
3 Ashby ✓  OpenAI 668 + Notion 142 + Linear 23 + Vercel 0       =  833 jobs
2 Lever ❌  Perplexity 404 + Ramp 404 (boards moved off Lever — user portals 待更新)
3 github-md ✓:
  - SimplifyJobs New Grad: 304 (HTML <table>)
  - SimplifyJobs Summer 2026 Interns: 989 (HTML <table>)
  - speedyapply SWE: 264 (markdown pipe fallback)
                                                                = 1557 jobs
TOTAL: 4137 jobs across 9 active boards
```

---

_Generated 2026-04-22 by room-init. Plan + ROOM COMPLETE 2026-04-30 by plan-milestones + dev._
