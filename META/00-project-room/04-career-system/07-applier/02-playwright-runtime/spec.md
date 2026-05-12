# Playwright Runtime

**Room ID**: `00-project-room/04-career-system/07-applier/02-playwright-runtime`  
**Type**: feature  
**Lifecycle**: planning (Mode 2 LOCKED 2026-05-11)  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/07-applier`  

## Intent

独立 Chromium + 持久化 profile + 反检测 + 截图留证（Mode 2 底座）

Mode 2 Full Agent 的运行时基础。设计：(1) 独立 userDataDir 在 data/career/.playwright/profile/（和用户日常 Chrome / Arc 完全隔离，不共享 cookies）；(2) 持久化 profile — 用 launchPersistentContext，不每次开空白（累积"人类指纹"应对 Cloudflare / reCAPTCHA）；(3) 单例 browser — dashboard 生命周期里只开一个 Chromium 实例，多个 apply 复用；(4) Headful 默认 — 用户能看到填表过程，反 bot 检测宽容度更高；(5) 反检测加固 — playwright-extra + stealth 插件、navigator.webdriver=false、真实 UA、100-400ms 随机延迟；(6) 截图留证 — 投递过程每步截图存到 data/career/.playwright/screenshots/{jobId}/；(7) 崩溃恢复 — Applier Chromium 崩了不影响 dashboard，重启时清理 session。后端 server.mjs 启动时 lazy init browser；dashboard 关闭时 cleanup。data/career/.playwright/ 整个目录 gitignored。验收：启动 Applier 能看到独立 Chromium 弹出；访问任意 ATS 页面后 cookie 持久化到下次重启仍在；stealth 测试 cn.bot-detect-test.com 通过。

## Constraints

必须 headful + userDataDir 隔离 + stealth 插件必载 + 不共享日常 Chrome cookies

(1) Playwright MUST 用 headful 模式（{ headless: false }）— 用户能看到填表过程、反检测宽容度高、失败能立刻看到；MUST NOT 为了性能改 headless；(2) userDataDir MUST 独立为 data/career/.playwright/profile/，MUST NOT 指向用户日常 Chrome profile（~/Library/Application Support/Google/Chrome/Default 等）— 避免 cookies 串 / 日常登录态被脚本干扰；(3) playwright-extra + stealth 插件 MUST 加载 — 否则 navigator.webdriver=true 会被绝大多数反 bot 检测识破；(4) 所有 page interaction 之间 MUST 加 100-400ms 随机延迟（打字 / 点击 / 翻页），不能瞬时完成；(5) 用户日常 Chrome 必须和 Applier Chromium 完全隔离（独立 OS 进程，~200-500MB 内存独立占用）。

## Specs in this Room

- [intent-playwright-runtime-001](specs/intent-playwright-runtime-001.yaml) — 独立 Chromium + 持久化 profile + 反检测 + 截图留证（Mode 2 底座）
- [constraint-playwright-runtime-001](specs/constraint-playwright-runtime-001.yaml) — 必须 headful + userDataDir 隔离 + stealth 插件必载 + 不共享日常 Chrome cookies

## 当前进度 — 🟢 planning (milestones locked 2026-05-11)

**Plan A (Foundation-first) accepted**. 3 milestones (~450 LOC + ~330 smoke):

| m | 内容 | LOC | 解锁 |
|---|------|-----|------|
| **m1** | Module-singleton browser + persistent profile + lazy init + SIGTERM cleanup | ~180 + ~100 smoke | **08-snapshot-refs-layer 起步** |
| m2 | playwright-extra + stealth plugin + humanDelay 100-400ms | ~120 + ~80 smoke | 反 bot 检测 |
| m3 | Per-step screenshot + crash recovery + integration smoke + ROOM COMPLETE | ~150 + ~150 smoke | self-iteration/01 fixture eval / 02 heuristics 学习 |

### Locked OQ (planning 时决定)

| OQ | 决定 |
|----|------|
| OQ1 stealth 选型 | `playwright-extra` + `puppeteer-extra-plugin-stealth` |
| OQ2 smoke headless | `process.env.SMOKE === '1'` (dev/prod headful, CI/smoke headless) |
| OQ3 stealth 测试 URL | `bot.sannysoft.com` (12-check 业内标准) |
| OQ4 V1 并发? | 否, 单 context 串行 |
| OQ5 Browser path | Bundled Chromium (pinned, CI-friendly) |
| OQ6 Screenshot 格式 | JPEG quality 70 (5x 小 vs PNG) |
| OQ7 Crash 策略 | Auto-recreate + log warning |
| OQ8 Page lifecycle | Per-apply new Page (跟 agent-browser session-per-task 一致) |

### Agent-browser inspiration

**02 拿到 agent-browser daemon warmth 那一半** — 模块单例 + warm context, per-call < 200ms. **Snapshot+refs prompt 格式那一半在 08-snapshot-refs-layer** (LLM-facing 抽象, 跟 driver 解耦).

---

_Generated 2026-04-22 by room-init. Plan refined 2026-05-11 by plan-milestones._
