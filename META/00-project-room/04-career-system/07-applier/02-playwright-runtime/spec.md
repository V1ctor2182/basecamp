# Playwright Runtime

**Room ID**: `00-project-room/04-career-system/07-applier/02-playwright-runtime`  
**Type**: feature  
**Lifecycle**: backlog  
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

---

_Generated 2026-04-22 by room-init._
