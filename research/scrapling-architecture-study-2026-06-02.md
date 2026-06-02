# Scrapling 项目源码深度研究

> **背景**：研究 [D4Vinci/Scrapling](https://github.com/D4Vinci/Scrapling) 的架构与实现，评估其用于 career-system applier/finder 反 bot 与自适应抓取的可行性。
>
> - **版本**：0.4.8
> - **规模**：51 个 Python 文件 / ~13,200 LOC
> - **作者**：Karim Shoair · BSD-3
> - **本地路径**：`../../Scrapling/`（learn-dashboard 同级目录，未纳入 git）
> - **研究日期**：2026-06-02

---

## 1. 项目定位与核心创新

Scrapling 是一个 **自适应（adaptive）web scraping 框架**。它不只是又一个解析器或浏览器自动化封装，最大的设计卖点是：

> **网站改版后，被保存过的元素能基于"语义指纹"自动重定位。** 今天用 `.css('.product-card')` 抓到的元素，明天 class 改成 `.item-tile` 了，它仍然能找到"同一个东西"。

整个项目围绕这一核心创新，加上三层正交能力——**fetcher 隐身栈**、**Scrapy 风格 spider 框架**、**MCP/CLI/REPL 开发者工具**——构成完整产品。

**对 career-system 的潜在价值**：
- **Applier**（07）：StealthyFetcher + Cloudflare 自解 + page pool 可显著提升在 Greenhouse/Workday/Lever 等求职平台投递的稳定性
- **Finder**（05）：自适应 Selector 可让职位列表抓取在网站改版时不需要立即维护
- **Multi-step state machine**（07/04）：spider 框架的 checkpoint/resume + 多 session 路由跟我们的 m14 SSE/状态机思路重叠，可参考其 anyio + MemoryObjectStream 流式实现

---

## 2. 顶层公开 API（`scrapling/__init__.py`）

`__init__.py` 仅 39 行，全部用 `__getattr__` 做 **lazy import**——单纯 `import scrapling` 几乎零开销，只有真正用到某个 fetcher 才会触发其 heavy 依赖（playwright / curl_cffi / patchright）。

公开符号：

| 符号 | 来源 | 作用 |
|------|------|------|
| `Selector` / `Selectors` | `parser.py` | 自适应解析器（核心） |
| `Fetcher` / `AsyncFetcher` | `fetchers/requests.py` | curl_cffi 的 HTTP 客户端 |
| `DynamicFetcher` | `fetchers/chrome.py` | 标准 Playwright |
| `StealthyFetcher` | `fetchers/stealth_chrome.py` | patchright + 反检测栈 |
| `TextHandler` / `AttributesHandler` | `core/custom_types.py` | 强化版 str / Mapping |

下面分四层展开。

---

## 3. 第一层：自适应解析器（parser.py · 1381 行）

这是 Scrapling 整个产品价值的根。

### 3.1 `Selector` 类的关键设计决策（parser.py:64-78）

```python
class Selector(SelectorsGeneration):
    __slots__ = ("url", "encoding", "__adaptive_enabled", "_root",
                 "_storage", "__keep_comments", "__huge_tree_enabled",
                 "__attributes", "__text", "__tag", "__keep_cdata", "_raw_body")
```

**几个非显然的选择**：

1. **不继承 `lxml.html.HtmlElement` 而是包装**——parser.py:99-101 注释解释：lxml 元素无法 pickle（`AssertionError: invalid Element proxy at...`），而 spider 框架需要把 Request/Response 序列化到 checkpoint，所以必须用 wrapper。
2. **`__slots__` + 显式拒绝 pickle**——parser.py:250-252 `__getstate__` 直接 `raise TypeError`，防止误用。
3. **lazy property 缓存**——`tag` / `text` / `attrib` 都是属性，首次访问才计算并写入 `self.__tag` 等私有变量（parser.py:259-342）。代码注释里写："Doing that only made the library performance test sky rocket multiple times faster"。
4. **预编译的 XPath 常量**（parser.py:57-61）：`_find_all_elements`、`_find_all_elements_with_spaces`、`_find_all_text_nodes` 全局复用。

### 3.2 自适应"自愈"机制

**入口**：`.css(sel, adaptive=True, auto_save=True, identifier="my_btn", percentage=40)`

**保存流程**：用户首次正常用 CSS/XPath 抓到元素时，如果 `auto_save=True`，调用 parser.py:881 `save()` → 委托给 `_storage`（`SQLiteStorageSystem`）→ 内部调用 `_StorageTools.element_to_dict()` 把元素拍快照成 JSON。

**指纹结构**（在 `core/utils/_utils.py` 里）：

```python
{
  "tag": "div",
  "attributes": {...},      # 清洗后的属性（删空值）
  "text": "Buy now",
  "path": ("html","body","main","section","div"),  # 从根到该元素的标签序列
  "parent_name": "section",
  "parent_attribs": {...},
  "parent_text": "...",
  "siblings": ("h2","p","div"),    # 同级标签序列
  "children": ("span","i")         # 子级标签序列
}
```

**重定位流程**（parser.py:519-566 `relocate()`）：

1. 遍历 **页面上所有元素**（XPath `.//*`）；
2. 对每个候选调用 `__calculate_similarity_score()`（parser.py:807-872），用 `difflib.SequenceMatcher.ratio()` 对每个维度算相似度：
   - `tag` 精确匹配
   - `text` 模糊匹配
   - 属性字典整体（一半比 keys 一半比 values，见 parser.py:874-879）
   - **class / id / href / src 各算一次** — 这是关键，单独加权能在 layout 大改时锁定身份
   - `path` 元组结构相似度
   - 父节点的 name / attribs / text
   - 兄弟节点序列
3. 得分 = `(总分 / 检查项数) × 100`；保留 ≥ `percentage` 的最高分桶。

**自愈闭环**（parser.py:660-688 `xpath()`）：

```python
if elements := self._root.xpath(selector, **kwargs):
    # 选择器还工作 → 可选 auto_save 刷新指纹
    if self.__adaptive_enabled and auto_save:
        self.save(elements[0], identifier or selector)
    return self.__handle_elements(elements)
elif self.__adaptive_enabled:
    if adaptive:
        element_data = self.retrieve(identifier or selector)
        if element_data:
            elements = self.relocate(element_data, percentage)
            # 找到了 + auto_save → 用新元素覆盖旧指纹，越用越准
            if elements is not None and auto_save:
                self.save(elements[0], identifier or selector)
```

**这就是"自愈"**：每次成功定位都刷新指纹，所以选择器跟着网站演化漂移，不会卡死在某个旧版结构上。

### 3.3 多模式查询 API

除 CSS/XPath 外，`Selector` 提供 BeautifulSoup 风格的 `find_all()`（parser.py:698），能混合接受 tag 字符串、tag 元组、`{attr: value}` 字典、`re.Pattern`、callable 过滤器——内部其实是先拼成 CSS 选择器（parser.py:761-769）调用 `css()`，再用 pattern/callable 二次过滤。还有 `find_by_text()` / `find_by_regex()` / `find_similar()`（受 AutoScraper 启发，parser.py:1013，按"同深度同 tag 同父祖父"圈候选再属性比对）。

### 3.4 `Selectors`（parser.py:1200-1376）

`List[Selector]` 的子类，支持 **链式 css/xpath** —— `page.css('.quote').css('.text::text')` 会对每个元素调用并自动 flatten（parser.py:1250-1279）。`.first / .last / .length` 属性、`.filter(fn)` / `.search(fn)`、`.get() / .getall() / .re()` 全部 Scrapy 兼容。文件末尾 `Adaptor = Selector` / `Adaptors = Selectors` 是早期命名的向后兼容别名。

---

## 4. 第二层：核心工具层（scrapling/core/）

### 4.1 `core/custom_types.py` — 强化类型

- **`TextHandler(str)`**（custom_types.py:29-208）：所有 str 方法被重载，**返回 `TextHandler` 而非裸 `str`**，保证链式调用不丢类型。提供 `.clean()`（折叠空白 + 可选 HTML entity 解码）、`.re(regex, clean_match=True)`（独创的"匹配前先清洗"开关）、`.json()`（用 `orjson.loads()`，绕过 orjson 对 str 子类的 issue #445）。
- **`TextHandlers(List[TextHandler])`**（custom_types.py:210）：切片自动保持类型，`.re()` 对每项应用并 flatten。
- **`AttributesHandler(Mapping)`**（custom_types.py:285）：只读，底层 `MappingProxyType`，所有 string 值自动包装成 `TextHandler`，提供 `.search_values(keyword, partial=False)` 模糊搜属性。

### 4.2 `core/storage.py` — 指纹持久化

- `StorageSystemMixin`（storage.py:14-71）：抽象 backend，约定 `save(element, identifier)` / `retrieve(identifier)`。helper 包括 `_get_base_url()` 用 `tld` 库提取 FLD 做多站隔离，`_get_hash()` SHA256+长度后缀防碰撞。
- `SQLiteStorageSystem`（storage.py:74-157）：生产实现。
  - **schema**: `(id PK, url, identifier, element_data, UNIQUE(url, identifier))`，`INSERT OR REPLACE` 语义
  - **并发**: `RLock` + `check_same_thread=False` + WAL journal mode
  - **序列化**: `orjson.dumps()` 把指纹 dict 存成 JSON 字符串
- **默认 DB 路径**: parser.py:47 `elements_storage.db`（位于包安装目录）

### 4.3 `core/translator.py` — CSS→XPath

源自 Parsel（README 致谢段），134 行。扩展 `cssselect.HTMLTranslator` 支持 Scrapy 风格伪元素 `::text` 和 `::attr(name)`：

- `XPathExpr` 子类带 `textnode: bool` 和 `attribute: str` 元数据，`__str__` 时拼上 `/text()` 或 `/@name`
- 用方法名反射 dispatch 伪元素（`xpath_text_simple_pseudo_element`, `xpath_attr_functional_pseudo_element`）
- 模块级 `css_to_xpath()` 用 `@lru_cache(256)` 缓存翻译结果

### 4.4 `core/mixins.py` — 反向选择器生成

`SelectorsGeneration` 给 `Selector` 注入 `generate_css_selector` / `generate_xpath_selector` / `generate_full_*` 属性——已知一个 HTML 元素，倒着生成定位它的选择器。逻辑：若有 `id` 提前返回 `#id`；否则用 tag + `:nth-of-type(n)` 向上递归到根。调试/日志时很有用，relocate 调试输出 top-5 候选时就靠它（parser.py:557）。

### 4.5 `core/utils/_utils.py`

- `_StorageTools.element_to_dict()` / `_get_element_path()`：上面 3.2 提到的指纹算法实现
- `log` 是 `LoggerProxy`，底层用 `contextvars.ContextVar` 存当前 logger，spider 框架靠它在不同 task 间隔离日志输出

---

## 5. 第三层：抓取栈（fetchers + engines）

### 5.1 公开 fetcher 类（fetchers/）

四个门面类，每个都几乎是空壳，把工作转给 engines/：

| Fetcher | Engine | Backend 库 | 适用场景 |
|---------|--------|-----------|---------|
| `Fetcher` / `AsyncFetcher` | `engines/static.py` | **curl_cffi** | 简单站点；TLS 指纹伪装 |
| `DynamicFetcher` | `engines/_browsers/_controllers.py` | **playwright** | JS 重的常规站点 |
| `StealthyFetcher` | `engines/_browsers/_stealth.py` | **patchright** + browserforge | Cloudflare/反爬 |

### 5.2 HTTP 引擎 — `engines/static.py`

- 用 **curl_cffi** —— 它能在 TLS 握手层伪装真实 Chrome/Firefox 指纹（ja3/ja4），单 `impersonate='chrome'` 一个参数就能绕过 TLS 指纹检测
- `_SyncSessionLogic._make_request()` 负责：合并 headers/proxy/impersonation、调用 `ProxyRotator.get_proxy()`、用 `is_proxy_error()` 智能识别错误并切代理
- 若没指定 `impersonate`，回退到 `toolbelt/fingerprints.py:37 generate_headers()` 用 **browserforge** 生成与目标 OS 一致的可信 headers

### 5.3 浏览器引擎 — `engines/_browsers/`

**关键文件**：

- `_base.py`（577 行）：`SyncSession` / `AsyncSession` 基类，page pool 管理
- `_controllers.py`（401 行）：`DynamicSession` 系列（Playwright 直驱）
- `_stealth.py`（576 行）：`StealthySession` 系列（patchright + 反检测）
- `_validators.py`（252 行）：用 `msgspec.Struct` 做类型验证的配置类
- `_page.py`：`PagePool` — 复用 page，标记 busy/error

**三种启动模式**（`_base.py`）：

1. **持久 context**（默认）：`launch_persistent_context()`，cookies/localStorage 跨请求保留
2. **代理轮换模式**：`launch()` 不带 context，每请求新建 context 注入新 proxy
3. **CDP 模式**：`connect_over_cdp(url)`，连远程浏览器集群

**Page pool** 用 `asyncio.Lock`（async 端）和 `max_pages=1..50` 上限，超过时等待最多 60s。

### 5.4 隐身栈核心 — `_browsers/_stealth.py`

这是项目最 "黑魔法" 的地方。技术分四层：

**1) patchright 替换 playwright** —— patchright 是 playwright 的 fork，在 launch 时打了一组补丁：移除 `navigator.webdriver`、刷新 `navigator.plugins`、加 canvas 噪声等。Scrapling 用它代替原 playwright（_stealth.py:8）。

**2) ~60 个 Chromium 启动 flag**（`engines/constants.py` `STEALTH_ARGS`）：

- `--disable-blink-features=AutomationControlled` 屏蔽 headless 指标
- `--fingerprinting-canvas-image-data-noise` 给 canvas getImageData 加像素噪声
- `--webrtc-ip-handling-policy=disable_non_proxied_udp` 防 WebRTC 泄露真实 IP
- `--disable-webgl` / `--disable-webgl2`（可选）

**3) BrowserContext 默认值**（_base.py:416-433）：`color_scheme="dark"`（绕过 creepjs 的 light-mode 默认值检测）、`device_scale_factor=2`、`screen={1920×1080}`、`is_mobile=False, has_touch=False`、`service_workers="allow"`。

**4) Cloudflare Turnstile solver**（_stealth.py:107-182 `_cloudflare_solver()`）—— **不调用第三方 API，自己解**：

- 检测 challenge type（`non-interactive` / `managed` / `interactive`，通过页面源码里的 `cType:` 字段判断）
- non-interactive：循环等待 `<title>Just a moment...</title>` 消失
- managed/interactive：
  1. 通过 URL 正则锁定 Turnstile iframe
  2. 计算 iframe bounding box
  3. **在中心 ±2-3 像素的随机偏移处点击**（避免完美居中被识破）
  4. 等待 network idle 让 token 交换完成
  5. 最多递归重试 100 次

### 5.5 工具带（engines/toolbelt/）

- `convertor.py`（323 行）：`ResponseFactory` 把 curl_cffi/Playwright 的响应统一转成 `Response`（继承 `Selector`），自动追踪 redirect 链 / 捕获的 XHR / Windows 上 `page.content()` 的重试逻辑
- `navigation.py`：`create_intercept_handler()` 通过 `page.route("**/*", ...)` 阻止字体/图片/CSS 加载，域名黑名单用 frozenset 做 O(1) 前缀匹配
- `proxy_rotation.py`：`ProxyRotator` 默认 cyclic 轮换，支持自定义策略；`is_proxy_error()` 识别 `net::ERR_PROXY*` / `connection refused` 等触发自动切换
- `ad_domains.py`（**3537 行**）：内嵌 Peter Lowe 的 ~3500 条广告/追踪域名 frozenset，`block_ads=True` 时启用
- `fingerprints.py`：包装 browserforge 的 header 生成
- `custom.py`（307 行）：`BaseFetcher`、`Response`（继承 Selector，绑定 `.request` / `.meta` / `.captured_xhr` 属性）

---

## 6. 第四层：Spider 爬虫框架（scrapling/spiders/）

类 Scrapy 设计但用 **asyncio + anyio**，~1700 LOC。十个文件分工清晰：

### 6.1 数据流

```
Spider.start()
  └─→ anyio.run(CrawlerEngine.crawl)
        ├─ 恢复 checkpoint（如果有）
        ├─ on_start() hook
        ├─ prefetch robots.txt
        ├─ start_requests() → Scheduler.enqueue
        └─ async with task_group:    （并发上限 = concurrent_requests）
            └─ 循环:
               ├─ 检查 pause/stop flag
               ├─ 定期 save_checkpoint（默认 5 分钟）
               ├─ Scheduler.dequeue → _task_wrapper(request)
               │     ├─ robots.txt 检查
               │     ├─ ResponseCache 查 dev-mode 缓存
               │     ├─ 获取 domain 限流器 + download_delay
               │     ├─ SessionManager.fetch(request)  ← 按 sid 路由到对应 session
               │     ├─ is_blocked() → 命中则 retry_blocked_request() 后重新 enqueue
               │     └─ _run_callbacks(request, response)
               │           └─ 用户的 parse() 是 async generator，yield 出：
               │                ├─ Request → enqueue
               │                └─ dict   → on_scraped_item → items 列表 / stream
               └─ ……
        ├─ on_close() hook
        └─ 完成则 cleanup checkpoint，未完成则保留
```

### 6.2 关键组件

| 文件 | 类 | 职责 |
|------|-----|------|
| `spider.py` | `Spider` (abstract) | 用户合约：`name`、`start_urls`、`parse`、`configure_sessions`、各种 hook |
| `engine.py` | `CrawlerEngine` | 调度循环，用 `anyio.CapacityLimiter` 做全局/per-domain 限流 |
| `scheduler.py` | `Scheduler` | `asyncio.PriorityQueue` + fingerprint 去重 |
| `request.py` | `Request` | SHA1 指纹 = URL+method+body+sid，缓存在 `_fp` |
| `session.py` | `SessionManager` | 多 session 注册表，按 `request.sid` 路由 |
| `checkpoint.py` | `CheckpointManager` | pickle CheckpointData 到 `.tmp` 然后原子 rename |
| `cache.py` | `ResponseCacheManager` | dev 模式：响应存为 JSON，body 用 base64 |
| `robotstxt.py` | `RobotsTxtManager` | 用 `protego` 解析；合并 Crawl-Delay 和 Request-Rate 到 download_delay |
| `links.py` | `LinkExtractor` | regex allow/deny + domain 白名单 + extension 过滤 |
| `result.py` | `CrawlResult`, `CrawlStats`, `ItemList` | `ItemList.to_json()`/`to_jsonl()`；`CrawlStats` 统计 per-session/per-domain/per-status |
| `templates/crawler.py` | `CrawlSpider` | 自动 link following 基于 `CrawlRule` |
| `templates/sitemap.py` | `SitemapSpider` | 从 robots.txt/sitemap.xml 发现 URL，处理 sitemapindex 嵌套和 gzip |

### 6.3 三个值得特别注意的设计

1. **多 session 路由**（`session.py`）—— `configure_sessions(manager)` hook 里可注册多个 session：`manager.add("fast", FetcherSession(...))`、`manager.add("stealth", AsyncStealthySession(...), lazy=True)`。`Request(url, sid="stealth")` 就让这条请求走 stealth 浏览器栈。`lazy=True` 的 session 直到第一次被用才初始化，Lock 保护避免重复 start。

2. **流式消费**（engine.py:420-440）—— `async for item in spider.stream()` 底层是 `anyio.MemoryObjectStream[dict](capacity=100)`：crawl 协程作为生产者，消费者控制反压。capacity=100 是软背压点。**这跟 applier m14 的 SSE attachFormObserver 是同一类模式，可以借鉴。**

3. **可恢复爬取的原子性** —— checkpoint 用 pickle 保存整个 `CheckpointData(requests, seen)`，写 `.tmp` 后 rename。`Request.callback` 因为是闭包不好 pickle，所以序列化时只存方法名，恢复时 `_restore_callback(spider)` 按名字从 spider 实例上取回函数引用（request.py:165-174）。

---

## 7. 第五层：开发者/AI 工具

### 7.1 MCP server — `core/ai.py`（907 行）

实现 Anthropic 的 Model Context Protocol（mcp>=1.27.0），让 Claude/Cursor 等 AI agent 直接调用 Scrapling。

**11 个 tools**：

- 会话管理：`open_session` / `close_session` / `list_sessions`
- HTTP：`get` / `bulk_get`
- 浏览器：`fetch` / `bulk_fetch`
- 隐身浏览器：`stealthy_fetch` / `bulk_stealthy_fetch`
- 视觉：`screenshot`（返回 image block 给多模态模型）

**省 token 的关键设计** —— `_translate_response()`（ai.py:75-90）+ `Convertor._extract_content()`（shell.py:615-653）：

1. **CSS selector 预过滤**：只返回指定 DOM 区域
2. **`main_content_only=True`**（默认）：限定到 `<body>`、剥离 `<script>/<style>/<noscript>/<svg>`、删 CSS hidden / aria-hidden / template 元素
3. **去零宽 Unicode**：shell.py:82 的 regex 扫掉 zero-width 字符——**防 prompt injection**
4. **HTML→Markdown**：用 `markdownify` 库压缩结构噪声

启动：`scrapling mcp [--http --host 0.0.0.0 --port 8000]`（默认 stdio）。

### 7.2 CLI — `cli.py`（661 行，Click 框架）

四个顶层命令：

- `scrapling install [--force]` —— 装 Playwright Chromium + 系统依赖 + 更新 TLD 数据库，写 `.scrapling_dependencies_installed` sentinel
- `scrapling shell` —— 启动 IPython REPL
- `scrapling mcp` —— 启动 MCP server
- `scrapling extract <verb> URL OUTPUT` —— 一行命令抓取

extract 有六个子命令：`get/post/put/delete`（HTTP）+ `fetch`（DynamicFetcher）+ `stealthy_fetch`（StealthyFetcher）。**输出格式按扩展名自动选**：`.html` 原文、`.md` markdownify、`.txt` 纯文本。共享 `-H/--headers`、`--cookies`、`-s/--css-selector`、`--ai-targeted`（= main_content_only + block_ads）等。

### 7.3 交互 Shell — `core/shell.py`（678 行）

封装 `IPython.terminal.embed.InteractiveShellEmbed`，开箱注入：

- 缩写函数：`get()`, `post()`, `fetch()`, `stealthy_fetch()` 直接可用
- `page` / `response` 自动绑定到上次抓取的 Selector，`pages` 是最近 5 次的环形缓冲
- `view(page)` —— 把 Selector 内容写临时 HTML 文件 + `webbrowser.open(f"file://{...}")` 浏览器里查看渲染效果
- `uncurl('curl ...')` —— 把从 DevTools "Copy as cURL" 出来的命令解析成 `Request` namedtuple
- `curl2fetcher('curl ...')` —— 同上但直接执行返回 Response

**curl 解析**（shell.py:98-330 `CurlParser`）：自定义 `NoExitArgumentParser`（屏蔽 argparse 默认的 SystemExit），覆盖 `-X/-H/-d/--data-raw/--data-binary/-b/-x/-U/-k/-G` 等 DevTools 常用 flag，自动推断 method（带 data 即 POST）和 body 类型（JSON 或 form）。

`_shell_signatures.py`（118 行）—— 把每个 fetcher 的 kwargs 列在 dict 里，shell 启动时 `_unpack_signature()` 重建出显式的 keyword-only 函数签名，让 IPython 的 `?` 帮助和 Tab 补全能看到所有参数（而不是模糊的 `**kwargs`）。

---

## 8. 整体架构示意

```
┌──────────────────────────────────────────────────────┐
│  用户层  Spider | StealthyFetcher | MCP tools | CLI  │
└──────────────────┬───────────────────────────────────┘
                   │
        ┌──────────▼──────────┐
        │  Selector (parser)  │ ◄── 自适应核心：fingerprint + relocate
        │  TextHandler/...    │     SQLite 存指纹，每次 hit 自动刷新
        └─────────┬───────────┘
                  │
   ┌──────────────┼──────────────────┐
   │              │                  │
┌──▼──────┐  ┌────▼─────────┐  ┌─────▼────────┐
│ static  │  │ _browsers/   │  │ spiders/     │
│ (curl_  │  │ patchright + │  │ asyncio +    │
│  cffi)  │  │ 60 flags +   │  │ anyio        │
│         │  │ CF solver    │  │ Scrapy-like  │
└─────────┘  └──────────────┘  └──────────────┘
   公共工具带（toolbelt）：proxy_rotation · ad_domains · convertor
```

---

## 9. 值得借鉴的工程亮点

1. **`__getattr__` 级 lazy import** —— heavy 依赖（playwright/curl_cffi/mcp）只在真用到时加载，让 `import scrapling` 几乎瞬时
2. **`Selector` 不继承 lxml** 而是 wrap，专门为了 pickle 友好（spider checkpoint 需要）
3. **指纹自愈** —— 每次成功 relocate 都 `auto_save` 覆盖旧指纹，让选择器跟随网站演化"漂移"
4. **多维度相似度** —— 不是单一 hash，而是把 tag/text/属性/路径/父子/兄弟分别用 `SequenceMatcher` 算分再平均，class/id/href/src 还单独加权
5. **统一 `Response = Selector + meta`** 模型让所有引擎的产物可以无缝传给同一套解析 API
6. **三种 session 启动模式** 覆盖单浏览器持久态、代理轮换、CDP 集群三种部署形态
7. **Cloudflare solver 自带** —— 不依赖 2Captcha/CapMonster 第三方 API，靠 patchright + 几何点击 + network idle 等待
8. **lazy session in spider** —— 不常用的 stealth session 可标记 `lazy=True`，第一次路由到才启动浏览器
9. **MCP 反 prompt injection** —— 抓回来的页面会先扫掉零宽 Unicode 字符再交给 LLM
10. **curl→Scrapling 转译** —— 从 DevTools "Copy as cURL" 一行命令直接跑成 Python 抓取请求，对调试加速极大

---

## 10. 给 career-system 的具体借鉴清单

| 模块 | Scrapling 的可借鉴点 | 落地路径 |
|------|---------------------|---------|
| **applier/02-playwright-runtime** | 60+ stealth chromium flags；patchright 替代原 playwright | 在 `data/career/.../runtime` 配置层加 `stealth_args` |
| **applier/04-multi-step-state-machine** | spider 的 `MemoryObjectStream` 流式 + checkpoint pickle 恢复 | m14 SSE 路径可参考 capacity=100 的反压设计 |
| **applier/05-non-standard-controls** | `find_similar()` 按"同深度同 tag 同父祖父"圈候选 | 用于识别同类 form control（如多个 radio group） |
| **applier/06-site-adapters** | `Selector` 的自适应指纹 + SQLite 持久化 | 每个 site adapter 的 critical selector 用 adaptive 模式存盘，网站改版自愈 |
| **finder（05）** | StealthyFetcher + Cloudflare 自解 + ProxyRotator | LinkedIn/Indeed 抓取的反 bot 兜底 |
| **cv-engine（03）/02-google-docs-sync** | curl_cffi 的 TLS 指纹伪装，单 `impersonate='chrome'` 起手 | Google Docs API 之外的兜底抓取路径 |
| **integrations-credentials（09）** | `ProxyRotator` 的 cyclic / custom 策略 + `is_proxy_error` 自动切换 | 凭证池/代理池的统一抽象可借鉴 |

---

**研究结论**：Scrapling 的成熟度（92% 测试覆盖、活跃维护、与 Playwright 1.59 对齐）和功能完整度（fetcher 三档 + spider + MCP）使其值得作为 career-system applier 反 bot 层的候选方案之一。下一步建议先在 `07-applier` 起一个 spike：用 StealthyFetcher 抓一次 Workday 的 Cloudflare-protected 投递页面，对比当前 m14 Phase 6 wiring 的成功率与稳定性。
