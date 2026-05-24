# Integrations & Credentials — Settings 凭证统一管理

> Feature Room · `04-career-system/09-integrations-credentials`
> lifecycle: **planning** · owner: fullstack · created 2026-05-24

## Intent

Settings 下新建一个 **Integrations** tab，让操作者可以在 UI 里设置整个
dashboard 用到的第三方凭证，**不再需要手编 `data/config.json` 或
`.env`**。当前痛点：

- Google Doc 同步报错 "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET not
  configured" — 用户得自己去翻文档、改 JSON、重启服务。
- 切换 `ANTHROPIC_API_KEY` 同样要改 env 重启。
- GitHub PAT 早就在 `data/config.json` 里，但没有任何 UI。

三类凭证统一一个页面管：

| 卡片 | 字段 | 消费方 |
|------|------|--------|
| **Anthropic API** | API key (可选切 backend mode：api / claude CLI / mock) | Stage B / tailor / 飞轮 inducer / classifier |
| **Google OAuth** | clientId + clientSecret | Google Doc resume sync (`03-cv-engine/02-google-docs-sync`) |
| **GitHub** | username + token | Tracker app (GitHub usage 路由) |

设计原则：
- **存到现有 `data/config.json`** — 已经 gitignored（`data/*.json`），不引
  新文件、不引新存储介质。
- **Masked display**：读时永远返回 `sk-...abcd` 或 `set/unset` 布尔标志，
  从不回显完整密钥。
- **Atomic write**：tmp + rename，避免并发改坏 config。
- **写完即生效**：anthropic SDK client 是模块级 cache，PUT 后要 reset
  cache，下一次 `getClient()` 重新读 env → config.json 兜底，不用重启
  server。

## Decisions

_(plan-milestones 锁定 2026-05-24)_

- **D1** — 三类凭证都落到 `data/config.json`(已 gitignored)；不引新
  存储。沿用现有 `GET/PUT /api/config` 端点扩字段,不开新路由。
  Anthropic key 现在只读 env，要补 config.json 兜底（和现有
  GOOGLE_CLIENT_ID 模式一致）。
- **D2** — Mask 策略:末 4 位明文,其余 dot,短串 <8 全屏蔽。GET 返
  `{set:true, masked:'sk-...abcd'}` 或 `{set:false}`。前端永远不持有
  原始密钥。
- **D3** — 清除语义:`PUT {key: ""}` 表示清除字段(沿用现有 PUT partial-
  update pattern,不开 DELETE 端点)。
- **D4** — PUT 后立刻 invalidate `_client` cache(`anthropicClient.mjs`
  导出的 `_resetClientForTesting` 复用),让新 key 不重启即生效。
- **D5** — Settings nav 加 "Integrations" 一个 tab,三个卡片(Anthropic
  / Google OAuth / GitHub)各管自己的字段。不分子页面。
- **D6** — Anthropic UI 只管 API key,不暴露 backend mode
  (api / claude CLI / mock)。CLI 和 mock 是 dev 用,改 .env 即可。
- **D7** — Test Connection **包含**(m3)。三个 service 各一种策略:
  anthropic 真发 1-token haiku ping(~$0.0001),google 只做格式校验
  (clientId `*.apps.googleusercontent.com` / clientSecret `GOCSPX-*` —
  真 OAuth 流程已经在 Resumes Sync),github 带 token 调 `GET /user`
  验真。
- **D8** — 单账号。多账号(两套 Google OAuth 之类)Defer。

## Constraints

_(继承父 Room；本 Room 暂无新增)_

## Deferred

- **更广的 Settings 改动** — LLM 模型选择(Sonnet vs Haiku 默认) /
  Playwright headless toggle / 自测 fixture 路径。当前 Room 只管凭证,
  其他作为独立 Room 排期。
- **Anthropic backend mode toggle** (api / claude CLI / mock) — UI 不
  暴露,Dev 改 .env(D6)。
- **多账号** — 比如两套 Google OAuth(个人 + 工作)。本 Room 单账号(D8)。
- **Per-key 用法 telemetry** — "这个 key 上次什么时候被用了"。

## 当前进度

✅ **complete** — 3/3 milestones 完成(2026-05-24)。

| # | milestone | 估 | 状态 |
|---|-----------|-----|------|
| m1 | Backend — `/api/config` 扩字段 + anthropic 兜底 + smoke | ~150 行 | ✅ done |
| m2 | Frontend — Settings → Integrations 页 + nav + UX | ~180 行 | ✅ done |
| m3 | Test Connection — 后端 `/test` 端点 + 前端 Test 按钮 + smoke | ~170 行 | ✅ done |

m1 上线后端管道:GET `/api/config` 同时给 TrackerApp 旧 shape +
Integrations 页新 shape({anthropic, google, github} 各带 `set` + `masked`)。
PUT 接 `anthropicApiKey` / `googleClientId` / `googleClientSecret`
partial update,空串 = 清除,whitespace 自动 trim,改 anthropic key 后
立即 invalidate cached client(动态 import `_resetClientForTesting`,
不重启即生效)。同源守卫(`Origin` vs `Host`)防 CSRF;每字段 2KB 上限;
序列化写防交错。`anthropicClient.mjs` 加 `data/config.json` sync 兜底
(`fileURLToPath` 解析项目根,不依赖 cwd)。smoke 17/17。

m2 上线 `/career/settings/integrations` 页面 + Settings 子 nav 入口
(`KeyRound` 图标)。三张并列卡片:Anthropic API key、Google OAuth
(clientId + secret)、GitHub (username + token)。每张卡片是独立 form,
Enter 提交;secret 字段 password 输入 + placeholder 显示 masked tail
让操作者认得是哪把 key 已配置;clear 按钮二次确认防误删。Code review
9 项 must-fix 已修:AbortController + mountedRef 防 unmount race、
auto-dismiss toast、Retry 按钮、form-per-card 提交、跨卡片输入解锁
(只锁 saving 卡片)、1Password/LastPass ignore 标记、Clear 确认、
AlertCircle 区分 partial 与 unset、加 "Leave blank to keep current"
hint 防误清除。

m3 上线 Test Connection 后端 `POST /api/career/config/:service/test`
+ 前端每张卡片的 Test 按钮。三种策略:
- **anthropic** — 走 `anthropicClient.getClient()`(先 reset cache 拿
  最新 key),真发 1-output-token `claude-haiku-4-5-20251001` ping
  (~$0.0001 / 次),分类 `AuthenticationError` / `RateLimitError` /
  `APIConnectionError` / 超时 / 其他;
- **google** — 纯格式校验(`*.apps.googleusercontent.com` +
  `GOCSPX-*` regex),不跑真 OAuth(那是 Resumes Sync 的活)。只 set
  半边也能返 `ok:true`,unset 字段 `valid:null` 中性显示。
- **github** — 调 `GET /user` 取 `login` + `X-OAuth-Scopes`,401/403
  区分 auth vs rate_limit。`MOCK_GITHUB_TEST=1` 仅 NODE_ENV != production
  下生效(防 prod env 漏配静默 mock)。

Code review 8 项 must-fix 已修:Promise.race timer leak (clearTimeout)、
stale testResults on edit invalidation(改字段自动失效之前的测试结果)、
Google `ok` 与 OR-testable 对齐(`valid: true | false | null`,null 中性)、
跨卡片 error cast 防 GoogleTestResult crash、同卡 Save+Test 互斥(防
测旧 key/写新 key race)、NODE_ENV gate for MOCK_GITHUB_TEST、github
body-read 保活(AbortController 不在 body 读完前 clear)、200 + 非 JSON
显式 error(no silent empty success)、aria-live polite 明示。smoke 29/29。

Room 进入 lifecycle: shipped。

## Contracts

_(无)_
