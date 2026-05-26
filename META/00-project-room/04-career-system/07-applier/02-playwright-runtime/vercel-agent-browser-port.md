# Playwright Runtime — Vercel agent-browser 借鉴优化记录

**Room**: `00-project-room/04-career-system/07-applier/02-playwright-runtime`
**关联 Room**: `08-snapshot-refs-layer`（同一套思想的 LLM-facing 那一半）
**写于**: 2026-05-21
**状态**: 描述当前已落地的实现（02 m1-m3 + 08 m1-m3 均已 ship）

> 这份文档回答一个问题：**"优化后的 Playwright" 到底优化了什么、从 Vercel agent-browser 借了哪些 idea。**
> 它不是 spec（spec 见 `spec.md`），是一份"为什么这么写"的设计说明。

---

## 0. 背景 — 朴素 Playwright 跑 ATS 投递为什么不行

最直觉的写法是：每个 apply 任务 `chromium.launch()` 开一个浏览器，把整页 DOM
或完整 a11y 树丢给 LLM，让它返回 CSS selector，然后 `page.locator(selector)` 执行。

这套朴素方案有四个致命问题：

| 问题 | 朴素做法的代价 |
|------|----------------|
| **冷启动** | 每个 apply `launch()` 一个 Chromium ≈ 1s + ~300MB，几十次/天累计很重 |
| **Token 爆炸** | 一个 Greenhouse 投递页的 raw a11y dump / DOM ≈ 7000-8000 tokens，贵且慢 |
| **模型瞎猜 selector** | LLM 看 DOM 写 `.css-1x7abc` 这种 hash class，ATS 一改就失效 |
| **SPA 失效不可知** | Greenhouse/Lever/Ashby/Workday 全是 SPA，pushState 绕过 `framenavigated`，旧 selector 静默指向已卸载的节点 |

Vercel 的 agent-browser（给 v0 / Vercel Agent 用的浏览器底座）已经把这四个问题
解过一遍。我们没有直接用它的代码（它是 daemon + 自有协议），但**把它的设计思想移植
进了 02 + 08 两个 Room**。下面逐条说移植了什么。

---

## 1. Snapshot + Refs 格式 —— 最核心的一招（借鉴度最高）

**Vercel 的 idea**: 不要给 LLM 看 DOM，给它看一个"压扁的、只含可交互节点的、
每个节点一行"的文本快照；元素不用 selector 引用，用符号 ref（`e1` `e2`…）。

**我们的实现**（`runtime/snapshot.mjs` + `runtime/refTable.mjs`）：

```
- heading "First Name" [ref=e1]
- textbox "First Name" [ref=e2] [required]
- textbox "Email" [ref=e3]
- button "Submit" [ref=e4]
```

- 走 CDP `Accessibility.getFullAXTree`，过滤到 9 个 interactive role 的 allowlist
  （button/link/textbox/checkbox/radio/combobox/menuitem/tab/heading）。
- 每个节点压成一行 `- role "name" [ref=eN]`，附必要 ARIA state（required/checked/
  selected/expanded/disabled）。
- **效果：200-400 tokens vs 7000-8000 tokens，约 20× 节省。** 这是让 LLM 驱动
  浏览器自动化"便宜且可靠"的关键，整条 Mode 2 的成本结构都建立在这上面。
- ref 格式刻意选 `e1` 而不是 `[1]`/`r1` —— 与 agent-browser 对齐（08 OQ6 锁定）。

**约束（08 的硬铁律 C1/C2）**：snapshot 输出**绝不**含 DOM id / class / XPath /
CSS selector / data-*。LLM 永远只看到 role + accessible-name + ref。一旦留了
selector 后门，模型会偷懒回去写 selector，整层抽象就失效。

---

## 2. Symbolic Action API + RefTable 解耦

**Vercel 的 idea**: LLM 不直接碰浏览器 API，只发符号动词；server 端有一张表把
符号 ref 翻译回真实元素。

**我们的实现**（`runtime/actions.mjs` + `runtime/refTable.mjs`）：

- LLM 发的是 `click @e2` / `fill @e3 "value"` / `upload @e6 "/path.pdf"`。
- `RefTable` 是 per-Page 实例：snapshot 时 `mint()` 计数器发 `eN`，记下
  `{role, name, occurrenceIndex, frame, backendNodeId}`；动作时 `resolve()`
  用 `getByRole({name}).nth(occurrenceIndex)` 还原成 Playwright Locator。
- LLM 永远 NEVER sees raw Playwright API —— `page.locator` / `page.eval` /
  `setInputFiles` 都不在它的 tool surface 上。

这一层把 **"LLM 看到的抽象" 和 "驱动浏览器的 driver"** 彻底解耦：底座换 Playwright
版本、换 CDP 调用方式，LLM 这一侧的契约不动。

---

## 3. Pessimistic Invalidation —— 比 agent-browser 更保守的一处

**问题**: ATS 全是 SPA，pushState 不触发 `framenavigated`/`domcontentloaded`，
靠导航事件判断"页面变了、旧 ref 作废"会漏。

**我们的实现**（`refTable.mjs` 的 generation 计数器）：

- 每次成功的 mutating action（click/fill/select/...）后**立刻** bump RefTable 的
  generation，让所有现存 ref 变 `STALE_REF`。
- 调用方**必须**重新 `snapshot()` 才能拿到新 ref。
- 不依赖任何导航事件 —— post-action invalidation 是主信号。

这是我们针对 ATS 场景比朴素移植更激进的一处：宁可多 snapshot 一次，也不接受
ref 静默指向已卸载节点。多步状态机（`machine.mjs`）的 dependent-field 检测就是
建立在"FILL 后强制 re-snapshot diff"之上。

---

## 4. Daemon Warmth —— 模块单例常驻

**Vercel 的 idea**: agent-browser 是常驻 daemon，浏览器 context 是热的，
per-call 延迟极低（session-per-task 而不是 process-per-task）。

**我们的实现**（`runtime/browser.mjs`）—— 拿到的是 daemon warmth 这"一半"：

- **模块级单例 `BrowserContext`**：首次 `getBrowser()` lazy launch（~1s），之后
  返回热 context（~0ms）。dashboard 生命周期内只开一个 Chromium。
- **race guard**：并发首调用共享同一个 launch Promise，不会 spawn 出重复 Chromium。
- **持久化 profile**：`launchPersistentContext(data/career/.playwright/profile/)`
  —— cookies/localStorage/IndexedDB 跨 server 重启存活，累积"人类指纹"对抗
  Cloudflare / reCAPTCHA。
- **crash recovery**：context 意外关闭（Chromium 崩 / OOM / 用户强退）时把单例
  标脏，下次 `getBrowser()` 自动重开。
- **SIGTERM/SIGINT cleanup**：优雅关闭，不留 Chromium 僵尸进程。

> agent-browser 思想被刻意拆成两半：**warm context 这一半在 02（本 Room）**，
> **snapshot+refs prompt 格式那一半在 08** —— 让 LLM-facing 抽象和 driver 解耦。

---

## 5. Session-per-task —— per-apply newPage

**Vercel 的 idea**: 每个 task 一个干净 session，互不串。

**我们的实现**（`browser.mjs` 的 `getPage(jobId)`）：

- context 是共享的（为了那个累积的"人类指纹" cookie 池），但**每个 apply 一个
  新 Page**。
- 新 Page 保证 DOM / sessionStorage 干净隔离，一个 apply 的状态不会漏进下一个。
- Page 上用 `WeakMap` 挂 jobId，截图 helper 据此把每步 JPEG 路由到
  `screenshots/{jobId}/`。

这跟 agent-browser 的 session-per-task 一致（02 OQ8 锁定）。

---

## 6. 我们没照搬 / 主动改造的部分

agent-browser 是给通用 web agent 用的；我们的场景是"半自动 ATS 投递"，所以有意
偏离了几处：

| 维度 | agent-browser | 我们的选择 | 理由 |
|------|---------------|-----------|------|
| Headless | 通常 headless | **强制 headful**（02 约束 C1） | 用户要看到填表过程；反 bot 检测对 headful 更宽容；失败立刻可见 |
| 反检测 | 自有方案 | `playwright-extra` + `puppeteer-extra-plugin-stealth` | 不自己维护 evasion；插件覆盖 `navigator.webdriver` 等（02 OQ1） |
| 人类节奏 | agent 速度优先 | 所有交互插 **100-400ms 随机延迟** + 逐字符打字（`humanize.mjs`） | ATS 反 bot；瞬时填表会被 flag |
| 提交动作 | agent 自主完成 | **机器永不点 Submit** | `machine.mjs` 填到 Review/Submit 页就停，由操作者人工 review + 提交 |
| 并发 | daemon 多 session 并发 | **单 context 串行**（02 OQ4） | V1 不做并发，简化 |
| 截图 | —— | per-step JPEG quality 70 留证（02 OQ6） | 投递留证 + self-iteration 的 evidence store |
| iframe | explicit frame switch | **inline-recurse**（08 OQ1） | Greenhouse 90% 表单在 iframe 里，强制 LLM 切 frame 体验差 |

---

## 7. 文件映射 —— 想看代码去哪

| 借鉴点 | 文件 |
|--------|------|
| Snapshot 序列化 / a11y 过滤 | `src/career/applier/runtime/snapshot.mjs` |
| RefTable / 符号 ref / generation 失效 | `src/career/applier/runtime/refTable.mjs` |
| Symbolic action 动词 + 统一错误码 | `src/career/applier/runtime/actions.mjs` `errors.mjs` |
| 浏览器单例 / persistent profile / crash recovery | `src/career/applier/runtime/browser.mjs` |
| 人类节奏（随机延迟 / 逐字符打字 / humanNavigate） | `src/career/applier/runtime/humanize.mjs` |
| 每步截图留证 | `src/career/applier/runtime/screenshot.mjs` `elementScreenshot.mjs` |
| 多步状态机（消费上面所有层） | `src/career/applier/multistep/machine.mjs` |

---

## 8. 一句话总结

> 优化后的 Playwright = **常驻热单例**（agent-browser 的 daemon warmth）
> + **压扁到 ~300 tokens 的 a11y 快照**（agent-browser 的 snapshot 格式，~20× 省）
> + **符号 ref 解耦 LLM 与 driver** + **post-action 悲观失效**（应对 SPA），
> 再叠上 ATS 场景专属的 **headful + stealth + 人类节奏 + 永不自动提交**。

_相关 spec：[02 spec.md](spec.md) · [08 spec.md](../08-snapshot-refs-layer/spec.md)_
