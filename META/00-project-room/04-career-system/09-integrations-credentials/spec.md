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

🔄 **in dev** — 1/3 milestones 完成(2026-05-24)。

| # | milestone | 估 | 状态 |
|---|-----------|-----|------|
| m1 | Backend — `/api/config` 扩字段 + anthropic 兜底 + smoke | ~150 行 | ✅ done |
| m2 | Frontend — Settings → Integrations 页 + nav + UX | ~180 行 | pending |
| m3 | Test Connection — 后端 `/test` 端点 + 前端 Test 按钮 + smoke | ~170 行 | pending |

m1 上线后端管道:GET `/api/config` 同时给 TrackerApp 旧 shape +
Integrations 页新 shape({anthropic, google, github} 各带 `set` + `masked`)。
PUT 接 `anthropicApiKey` / `googleClientId` / `googleClientSecret`
partial update,空串 = 清除,whitespace 自动 trim,改 anthropic key 后
立即 invalidate cached client(动态 import `_resetClientForTesting`,
不重启即生效)。同源守卫(`Origin` vs `Host`)防 CSRF;每字段 2KB 上限;
序列化写防交错。`anthropicClient.mjs` 加 `data/config.json` sync 兜底
(`fileURLToPath` 解析项目根,不依赖 cwd)。smoke 17/17。

下一步:`dev 09-integrations-credentials/m2`。

## Contracts

_(无)_
