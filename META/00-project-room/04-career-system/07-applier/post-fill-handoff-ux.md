# Post-Fill Hand-off UX — Mode 2 的"残局"问题

**Room**: `00-project-room/04-career-system/07-applier`
**关联 sub-Rooms**: `02-playwright-runtime` · `03-field-classifier` · `04-multi-step-state-machine` · `06-site-adapters` · `07-self-iteration/02-data-flywheel`
**写于**: 2026-05-26
**状态**: 设计讨论 — 跨 sub-Room 的 UX gap + 学习闭环缺口
**触发**: 一次真实 Captivation(Greenhouse 变体)投递,5 verified / 9 didn't land / 9 do these yourself + CAPTCHA

> 这份文档回答 3 个问题:
> 1. Mode 2 自动填表跑完之后,有一坨字段 verify 没过,**UI 应该怎么对待用户**?
> 2. 用户在 UI 上看到这个状态后,**怎么把它收成真正的 Applied**(顺序、动作、submit 时机、确认)?
> 3. 这次投递的失败 / 用户的兜底动作,**怎么让系统下次同 ATS / 同字段更准**?

---

## 0. 触发场景 — Captivation 投递截图

```
Apply — Software Engineer 1 - Linux/HPC/Bash/Python/Docker/Gitlab/CI/CD · Captivation
Auto-fill · a real browser window fills the form step by step.

Step 1 · generic   done

Form filled — but some fields need a look.
✓ 5 verified
✗ 9 didn't land
   - Are You Authorized to work in the U.S. ... — expected "Yes", form shows ""
   - Will You Now or in the Future Require Sponsorship ... — expected "Yes", form shows ""
   - Gender — expected "Decline To Self Identify", form shows ""
   - Veteran Status — expected "I am not a protected veteran", form shows ""
   - Disability Status — expected "I do not want to answer", form shows ""
   - Country — expected "United States +1", form shows ""
   - How would you describe your gender identity? — expected "I don't wish to answer", form shows ""
   - Do you have a disability ... — expected "I don't wish to answer", form shows ""
   - Are you a veteran or active member ... — expected "No, I am not a veteran ...", form shows ""

Before you submit, do these yourself:
   - (unlabeled field) × 7
   - Do you have a disability or chronic condition ... (truncated)
   - CAPTCHA — manual
```

显示给用户的总结:**14 件需要人工兜底**,机器只完成了 5 条。
**而且没人告诉用户:这之后该怎么做才能真正 Applied。**

---

## 1. 当前 UX 错在哪

### 1.1 把 partial failure 当 final state

"didn't land" / "do these yourself" 当前是**装饰性列表**。
看不出哪个先做、能不能 Copy 答案、字段在浏览器哪个位置。
用户要切到 Chromium 窗口,自己滚动、自己找、自己手填,系统不参与。

这把 Mode 2 从"自动投递"降级成了"打开了浏览器的 Mode 1",
而且**比 Mode 1 还差** —— Mode 1 卡片里至少有 Copy 按钮和
source_ref hint([01-mode1-simplify-hybrid](01-mode1-simplify-hybrid/spec.md))。

### 1.2 信号重复 / 分类混淆

```
"didn't land":      Do you have a disability or chronic condition (full) — expected ...
"do these yourself": Do you have a disability or chronic condition ... (截断) — not captured
```

同一字段两个分类都出现。**用户视角:这是 14 件事还是 9 件事?**

### 1.3 9 个 fail 不是 9 个 bug,是 1 个 bug

"didn't land" 9 条全是 EEO/legal/demographic 题。这些字段几乎肯定
共用同一个 Greenhouse-EEO 区段 + 同种 control(很可能是
React-Select / Combobox)。classifier 找到了 control 但 `selectOption`
对非 native `<select>` 不生效 → **看上去 9 个独立 fail,根因是 1 个**
**Greenhouse-EEO control strategy** 没适配。

UI 把它平铺成 9 行 → 用户看不出同根,无法触发"修一次解决所有"。

### 1.4 没有 next action

每个 fail 应该带至少一个明确动作:Copy / Focus / Retry / Skip。
当前 UI 只是一份 read-only 报告 —— **告知,但不引导,也不参与**。

### 1.5 没有 submit gate / 没有 submit 检测

最严重的一点 —— 当前 UI 上有 "Mark applied" 按钮,但**没有任何
机制确认用户真的在浏览器里点了 Submit**。用户可能:
- 完全没点 Submit 就误点 Mark applied → 假阳数据污染 flywheel
- 点了 Submit 但没回来 mark → 漏掉真实投递
- 看着失败列表心虚直接关掉 → 数据完全丢

系统应该**主动检测 submit**(URL 变化 / confirmation page / 新 thank-you 文案),
而不是把这一步外包给用户的记性。

---

## 2. 根因诊断 vs 症状治标

| 层级 | 当前 | 应该 |
|------|------|------|
| **Strategy(02-playwright-runtime)** | fill 一次 → verify 一次 → 写 mismatch | fill 失败时 fallback 2-3 种策略(option click → keyboard → role locator) |
| **Classifier(03-field-classifier)** | label 配对失败 → 标 unlabeled | unlabeled 字段额外跑一轮 LLM 看 context HTML(siblings/parent text) |
| **Site adapter(06-site-adapters)** | greenhouse.yml 没覆盖 EEO 段 | 加 `eeo_section` rule + `react_select` control hint |
| **Flywheel(07-self-iteration/02)** | 失败的 verify 被静默丢弃 | 每次 fail / 每次用户手填,**全写 history.jsonl + 触发 propose** |
| **UI(02-playwright + 04-multi-step)** | 14 行只读列表 + Mark applied 全凭良心 | 引导式 triage + 字段动作卡 + 主动 submit 检测 + 真实 verify gate |

---

## 3. UX 应该怎么改 — 4 个角度(单点改动)

### A. Mode-1 ergonomics for the tail(最快 ship)

每个 fail 字段一张卡片:

```
┌─ ✗ Are You Authorized to work in the U.S. without restriction? ─┐
│  Expected:  "Yes"                                                │
│  Form has:  (empty)                                              │
│  [📋 Copy "Yes"]  [🎯 Focus in browser]  [🔁 Retry]  [✋ Skip]    │
└──────────────────────────────────────────────────────────────────┘
```

- **📋 Copy** 把答案放剪贴板
- **🎯 Focus** 在 Chromium 里 scroll + outline 红框 + 把光标放进去
- **🔁 Retry** 调 02-playwright-runtime 的下一种 fallback 策略
- **✋ Skip** 标"用户决定不答",不写入 propose-rule 评分(避免污染)

### B. Auto-retry with fallback strategies

fill 失败时**先重试 2-3 次再 verify**。Strategy ladder:

1. `locator.selectOption(value)` —— 当前默认
2. `locator.click()` + `locator.locator('option', { hasText })`.click()
3. `locator.focus()` + `keyboard.type()` + `keyboard.press('Enter')`
4. `getByRole('option', { name })`.click()

每步失败再下一步。**每一步成功/失败都进 flywheel**(§5 第 1 条)。

### C. 根因修复 — Site adapter EEO rule

```yaml
# data/career/adapters/greenhouse.yml
eeo_section:
  detect:
    - css_contains: ".application-question--eeo"
    - role_contains: "group"
      label_matches: "(disability|veteran|gender|race)"
  control_hints:
    primary_strategy: "react_select_click"
    expected_class: "select-decline-pattern"
  known_options:
    decline: ["Decline To Self Identify", "I don't wish to answer", "Prefer not to say", "I do not want to answer"]
```

跨所有 Greenhouse ATS 一次性修好。

### D. Block at low quality(保守兜底)

mismatch ≥ N 时**不允许 Submit gate 转绿**,弹窗:"质量不够,建议转 Mode 1"。

D 不单独立项,作为 Phase 1 的一个 settings 开关存在,默认关。

---

## 4. 用户侧 — 从 partial 到 Applied 的完整流程

§3 是"系统应该改成怎样",这一节是"用户在新 UX 下从看到失败到真正 Applied **每一步做什么**"。

### 4.1 Status board(永久顶部)

```
┌─ Captivation · Software Engineer 1 ──────────── 02:34 elapsed ─┐
│   Verified  ████████░░░░░░░░░░  5 / 14                          │
│   ─ to retry: 9   ─ unlabeled: 7   ─ manual (CAPTCHA): 1        │
│                                                                  │
│   [▶ Start clean-up]   [⏸ Pause session]   [🚪 Cancel]          │
└──────────────────────────────────────────────────────────────────┘
```

数字**实时刷新** —— 用户每在浏览器里手填一个字段,系统通过 MutationObserver
检测到 DOM 变化,debounce 200ms 后悄悄 re-verify,绿条往前走。

### 4.2 Triage view — 同根问题折叠成一组

点 Start clean-up 进 triage:

```
┌─ ⚠ EEO 段(9 字段,全部为空) ──────────────── 推测同根因 ─┐
│  推测:Greenhouse-EEO React-Select 兼容问题                       │
│  推荐:[🔁 Batch retry with `react_select_click` strategy]        │
│                                                                  │
│  ▸ Are You Authorized to work in the U.S. ...                   │
│  ▸ Will You Now or in the Future Require Sponsorship ...        │
│  ▸ Gender                                                        │
│  ... (+6 more, 折叠)                                              │
└──────────────────────────────────────────────────────────────────┘

┌─ ❓ Unlabeled fields(7) ─────────────────────────────────────┐
│  ▸ Field at <select.application-question__select> (line 142)   │
│  ▸ Field at <input[type=text]#field_3022> (line 156)           │
│  ...                                                            │
└─────────────────────────────────────────────────────────────────┘

┌─ ✋ Manual(1) ────────────────────────────────────────────────┐
│  CAPTCHA — 切到浏览器解,我等                                    │
└─────────────────────────────────────────────────────────────────┘
```

- "同根" 通过 DOM 共享祖先检测(`closest('.application-question--eeo')` 等),
  跟 §5 学习闭环 #1 的策略评分挂钩
- Batch retry 一次性对组内所有字段轮一轮新策略 —— **一次操作修 9 个**

### 4.3 Per-field card(展开后)

```
┌─ Are You Authorized to work in the U.S. without restriction? ─┐
│                                                                 │
│   Expected:  "Yes"        Form has:  (empty)                    │
│   Control:   <div role="combobox" class="select__control">      │
│   Tried:     selectOption(value)  ✗ click()  ✗ keyboard  ⏸     │
│                                                                 │
│   [📋 Copy "Yes"] [🎯 Focus] [🔁 Try keyboard] [✋ I'll skip]   │
│                                                                 │
│   Status: ⏸ awaiting your action                                │
└─────────────────────────────────────────────────────────────────┘
```

- **Tried** 行显示已尝试过的 strategy ladder 状态(剩下哪步可点)
- 用户点 Focus 后,Chromium 自动 scroll + outline 红框 + cursor 进字段
- 任何动作完成后,卡片自动 re-verify;成功就翻绿、折叠

### 4.4 主动观察用户在浏览器的动作(Active observation)

这是新 UX 的关键 —— **用户在 Chromium 里手动填的字段,系统应该自动认出来更新状态,而不是要求用户回 dashboard 点"我填好了"**。

实现:
- 02-playwright-runtime 在 page 上挂 `MutationObserver` 监听 `input` / `change` 事件
- debounce 200ms → 取该字段当前 value → 跟 expected 比较
- 匹配 → 卡片翻绿 + flywheel 记 `final_state: "filled_by_user_manual"`(§5 #5)
- 不匹配但非空 → 卡片黄,记 "用户手填了但跟 expected 不同" —— 可能是 expected 错(qa-bank 数据陈旧)

### 4.5 Submit gate

只有当 **required 字段** verified 数 = required 字段总数 时,Submit gate 才**转绿**:

```
┌─────────────────────────────────────────────────────────────┐
│  ✓ All required fields verified.                            │
│                                                              │
│  现在切到浏览器,点 Submit。我会自动检测页面跳转。            │
│                                                              │
│  [🔵 Open Chromium]   [我已点 Submit,手动 Mark applied]    │
└──────────────────────────────────────────────────────────────┘
```

- "required" 由 06-site-adapter rule 标(`required: true` 或 DOM 上的 `aria-required`/`*`)
- 非必填字段红 / 黄不阻塞 Submit gate,但提示
- gate 没绿时 Mark applied 按钮**灰且 disable**,hover 显示"还有 3 个必填没好"

### 4.6 Submit 检测 + 自动 Mark applied

用户切到 Chromium 点 Submit 后,02-playwright-runtime 后台监听:

| 信号 | 判定 |
|------|------|
| URL 变化(含 `success` / `thank-you` / `confirmation`) | ✅ 强信号 |
| HTTP request to `/applications` 返 200 + redirect | ✅ 强信号 |
| 页面出现"Thank you for applying" 类文案(adapter rule 提供 selector) | ✅ 强信号 |
| 页面无变化超过 60s | ⏸ 询问用户 |
| 用户关 tab / 切 URL 离开 application page | ⚠ 询问"是否已提交?" |

检测到强信号 → 自动 POST `/api/career/apply/:jobId/submitted` → 状态机走 applied →
session 关闭 + 写 history.jsonl(§5)。

**Mark applied 按钮变成 fallback** —— 仅当系统检测失败时让用户手动确认。
正常路径用户根本不需要点。

### 4.7 整个流程的时间线

```
00:00  Mode 2 start → 自动填表 → 5 verified / 9 fail / 7 unlabeled / 1 CAPTCHA
00:30  Triage 显示同根分组提示
00:32  用户点 EEO 组的 Batch retry (react_select_click)
00:40  9 字段里 6 个翻绿,3 个仍红
00:45  用户点第一个红字段 Focus → 切到 Chromium → 手填
00:48  系统检测到 DOM 变化 → re-verify → 卡片翻绿
       (重复 3 次)
01:30  Unlabeled 7 个里 → 4 个用户用 Focus + Copy 填上,3 个是 optional 直接 Skip
02:00  CAPTCHA 用户在浏览器里解掉
02:05  Submit gate 转绿
02:08  用户在浏览器点 Submit
02:09  系统检测到 URL → /thank-you → 自动 Mark applied
       状态机 → applied + flywheel 写完整 session log
```

vs 当前 UX:用户看到 14 个 fail / unlabeled 列表 → 心累 → 关闭 → 数据丢 + 没投出去。

---

## 5. 学习闭环 — 一次投递怎么让系统下次更准

§4 收住了用户当前这次,§5 把这次的所有信号都吃进系统,让**下次同 ATS 同字段更快更准**。

### 5.1 这次投递产生什么数据

每次 Mode 2 session 结束(成功或取消),**强制写** `data/career/qa-bank/history.jsonl`
一条 envelope record:

```jsonl
{
  "session_id": "captivation-2026-05-25-XXXX",
  "job_id": "captivation-swe1",
  "ats_detected": "greenhouse",
  "ats_variant": "greenhouse-eeo-react-select",
  "ats_confidence": 0.85,
  "site_url": "...",
  "started_at": "2026-05-25T...",
  "ended_at": "2026-05-25T...",
  "outcome": "applied",
  "total_fields": 14,
  "verified_auto": 5,
  "verified_after_retry": 6,
  "filled_by_user_manual": 2,
  "skipped_by_user": 1,
  "submit_detected_by": "url_redirect",
  "submit_detect_latency_ms": 1200,
  "fields": [
    {
      "label": "Are You Authorized to work in the U.S.",
      "expected": "Yes",
      "control_fingerprint": {
        "tag": "div", "role": "combobox",
        "class": "select__control",
        "ancestors": [".application-question--eeo"]
      },
      "strategies_tried": [
        { "name": "selectOption", "result": "no_effect" },
        { "name": "react_select_click", "result": "verified" }
      ],
      "final_state": "verified_after_retry",
      "user_time_ms": 0
    },
    {
      "label": "(unlabeled)",
      "expected": null,
      "control_fingerprint": { ... },
      "final_state": "filled_by_user_manual",
      "user_answer": "<USER_TYPED_VALUE>",
      "user_time_ms": 8200
    },
    ...
  ]
}
```

**关键点**:control_fingerprint 不只存 selector,存**特征签名**(tag + role + class pattern + ancestor chain) —— 下次同 ATS 不同 jobId 的同类型字段也能 match。

### 5.2 信号 #1 — Strategy ladder 自动重排序

flywheel 跑 7-day rolling 聚合:对每个 `(ats_variant, control_fingerprint_class)` pair,
计算每条 strategy 的成功率。结果写回 `data/career/adapters/<ats>.yml`
的 `strategy_priority`:

```yaml
# data/career/adapters/greenhouse.yml (auto-tuned)
strategy_priority:
  "react-select-combobox":   # control_fingerprint class
    - react_select_click   # 87% success
    - keyboard_input       # 60% success
    - selectOption         # 4% success ← demoted
```

下次同样的字段 → 直接走 `react_select_click`,不浪费两次失败再 fallback。

### 5.3 信号 #2 — Site adapter rule 自动 propose

`07-self-iteration/01-code-calibration` 的 runner 周期性跑:
- 拉最近 N 次 session 里的 fail / retry-success 字段
- 对每组 same-fingerprint 字段,试拟一条 candidate rule:
  ```yaml
  eeo_section:
    detect: { css_contains: ".application-question--eeo" }
    control_hints: { primary_strategy: "react_select_click" }
  ```
- 在保存的 snapshot 上 replay → 算 verify 率提升
- 提升 ≥ 30 个百分点 → 写到 `data/career/eval-fixtures/promote-queue/`
- `07-self-iteration/03-iteration-dashboard` 看到队列里有新 proposal:

```
┌─ Proposal: greenhouse.yml — add eeo_section rule ────────────┐
│  Based on 4 sessions (Captivation, Notion, Stripe, Linear)   │
│  Current verify rate on EEO fields: 36%                       │
│  Predicted with rule:              95%                        │
│  Replays clean, 0 regressions on 87 saved fixtures.           │
│  [📄 Review YAML diff]  [✅ Promote]  [❌ Reject]              │
└──────────────────────────────────────────────────────────────┘
```

用户一键 Promote → `greenhouse.yml` 自动 commit + 投到 production →
**下一次 Greenhouse 投递的 EEO 段直接 95%+ verified**,这才是
"投得多 → 更精准更快"的真实闭环。

### 5.4 信号 #3 — qa-bank fuzzy-match 缓存

`07-self-iteration/02-data-flywheel` 已经实现了 qa-bank fuzzy match。
本 session 的每个 verified 字段都自动写入:

```yaml
# data/career/qa-bank/history.yml(append-only)
- label_hash: "are_you_authorized_to_work_us"
  ats: "greenhouse"
  answer: "Yes"
  confidence: high
  evidence: ["session-captivation-...", "session-notion-..."]
```

下次任何 ATS 出现 fuzzy match 的 label → 跳过 LLM,直接答 "Yes",**零成本**。

### 5.5 信号 #4 — Unlabeled / unknown 字段 → classifier 重训提示

7 个 unlabeled 字段是 classifier 的盲区。session 完成时:
- 对每个 unlabeled 字段,**保存 control_fingerprint + 周围 HTML 片段**(`data/career/eval-fixtures/unlabeled-pool/`)
- 03-iteration-dashboard 显示"未分类字段池累计 47 条,可发起一次 classifier eval calibration"
- 用户触发后,`01-code-calibration` 跑 LLM 重新分类这些字段 → 跟用户手填的答案比对 → 算 LLM 的分类准确率,生成 prompt 调优建议

### 5.6 信号 #5 — 用户手填模式

用户在 §4.4 主动观察阶段手填的字段,系统记下来:
- `final_state: "filled_by_user_manual"` + `user_answer: "..."`
- 如果同一个 fingerprint 的字段在最近 3 次 session 都是 manual 填(说明系统从来填不上),
  并且 user_answer 一致 → **propose 加进 qa-bank known-answers** 或 **加进 identity.yml**
  作为新字段
- 例如:用户每次都手填 "Preferred name" = "Victor",但 identity.yml 没这字段 →
  proposal:"add `identity.preferred_name`: 'Victor'? 命中过去 3 次同字段"

### 5.7 信号 #6 — Submit detection accuracy

如果 §4.6 自动 submit 检测失败,用户用 fallback "我已点 Submit" 手动 mark:
- 记 `submit_detected_by: "user_fallback"`
- 同 ATS / 同 fingerprint 跑出 N 次 fallback → propose 让用户添加这个 ATS 的
  thank-you page selector,丰富 06-site-adapter 的 `submit_detection` 规则

### 5.8 用户侧可见的"系统在进步"指标

dashboard 顶部应该有:

```
Captivation (Greenhouse) — your 2nd apply
  · First time:  5 / 14 verified, 2:34 with manual cleanup
  · This time:  13 / 14 verified, 0:45 (CAPTCHA only)
  · Improvement powered by: greenhouse.yml eeo_section rule (promoted 2026-05-26)
```

用户能看见每次投递让下一次更快,这才是 self-iteration 价值的 UI 兑现。

---

## 6. 推进顺序

| Phase | 内容 | 涉及 sub-Room | Milestone 估算 |
|-------|------|--------------|--------------|
| **1** | §3-A(Mode-1 ergonomics)+ §4.1-4.3(Status board + Triage + 字段卡)+ §5.1(envelope record schema) | UI: 04-multi-step / Apply.tsx;Backend: 02-playwright(focus/retry/skip endpoints) | 2 milestones |
| **2** | §3-B(fallback strategies)+ §4.4(MutationObserver active observation)+ §5.2(strategy auto-reorder) | 02-playwright-runtime + 07-self-iteration/02-data-flywheel | 2 milestones |
| **3** | §4.5(Submit gate)+ §4.6(Submit detection)+ §5.7(detection signal) | 04-multi-step + 06-site-adapters(submit_detection rules) | 1 milestone |
| **4** | §3-C(EEO site rules)+ §5.3(auto-propose rules)+ §5.8(visible improvement metric) | 06-site-adapters + 07-self-iteration/01 + 03(dashboard) | 2-3 milestones |
| **5** | §5.4(qa-bank fuzzy 加深 evidence)+ §5.5(unlabeled pool)+ §5.6(manual-fill propose identity field) | 07-self-iteration/02 + 03 | 1-2 milestones |

D(quality block)作为 Phase 1 的 settings 开关跟着出。

---

## 7. 开 spec 之前要拍板的问题

1. **Focus 动作的 IPC** — Apply.tsx → Express → page handle。当前 page 在 04-multi-step
   `_machines[jobId]` 里,UI 没有 ref。需 `/api/career/apply/:jobId/focus-field` 路由。

2. **Retry 是 idempotent 吗?** fill 失败后 form 可能处于半填状态(focus 在某 option 上)。
   需要 02-playwright-runtime 提供 `resetField()` 原语。

3. **Skip 写不写 flywheel?** 不写 propose-rule 评分,但写 history.jsonl 的 `skipped_by_user`
   计数(用于 §5.5 "用户经常跳过哪类问题"统计)。

4. **CAPTCHA 永远 manual** —— 单列一行 + 倒计时,session 超时警告。

5. **同根分组检测**(§4.2) — 简单版:`closest('.application-question--eeo')` 共享祖先;
   复杂版:LLM 语义聚类。**Phase 1 用简单版**,够用。

6. **MutationObserver 频率**(§4.4) — 200ms debounce。**只监听 form 区域内的事件**,
   不监听整个 document,避免 React re-render 风暴。

7. **Submit detection 的强信号定义**(§4.6) —— URL redirect / thank-you HTML /
   POST /applications 200。**6-site-adapter 里 per-ATS 配置**(thank-you selector +
   redirect pattern),没配置走 fallback 询问用户。

8. **同根错误率阈值** —— mismatch ≥ N 时(默认 5)才显示"同根分组"提示。
   N 可调,settings 里。

9. **history.jsonl 体积控制** —— envelope 包含 control_fingerprint + HTML snippet,
   单次 session 可能 KB 级,长期 jsonl 会涨。**每 90 天 rotate + gzip**,
   超过 1 年的归档。

10. **adapter 自动 promote 还是手动?** §5.3 default **永远人工 promote**,自动只到
    "proposal 写队列"。03-iteration-dashboard 的"Pending Actions"里走人工 review。
    自动 promote 风险:错的 rule 让所有 Greenhouse 投递都崩。

---

## 8. 跟现有 Room 的对接

| Room | 改动 |
|------|------|
| **02-playwright-runtime** | + `fillWithFallback(strategies[])` · `focusField(ref)` · `resetField(ref)` · `attachFormObserver(callback)` · `detectSubmit(rules)` 五个新原语 |
| **03-field-classifier** | unlabeled 字段额外跑 context-aware LLM(看 siblings/parent HTML);保存 control_fingerprint 进 envelope |
| **04-multi-step-state-machine** | endpoint.mjs 加 `/focus-field` / `/retry-field` / `/skip-field` / `/manual-mark` 四个路由;state machine 加 `awaiting_user_cleanup` 状态(verify 失败时 enter,Submit gate 转绿时 exit) |
| **06-site-adapters** | greenhouse.yml / lever.yml / workday.yml 加 `eeo_section` rule + `submit_detection` block;schema 加 `strategy_priority` 字段(auto-tuned) |
| **07-self-iteration/01-code-calibration** | runner 新增 "auto-propose-adapter-rule" 子命令,读 N 天 envelopes → 拟 rule → snapshot replay → 算提升 → 写 promote-queue |
| **07-self-iteration/02-data-flywheel** | history.jsonl envelope schema 升级(新增 control_fingerprint / strategies_tried / final_state);qa-bank evidence 引用 session_id 而非 jobId |
| **07-self-iteration/03-iteration-dashboard** | Pending Actions 加 "Adapter Rule Proposal" 类型;§5.8 visible improvement 视图 |
| **07-self-iteration/04-flywheel-dashboard** | (planning)把 strategy effectiveness / adapter coverage / 用户手填 trends 合到一页 — 直接消费 §5 所有信号 |

---

## 9. 一句话总结

> Mode 2 跑完不等于"投出去了"。当前 UX **三件事都没做** ——
> 没把 partial 状态收成有动作的 triage(§3)、没引导用户走完
> 到 Submit 的最后一段路(§4)、没把这次失败的信号变成下次的能力(§5)。
> Phase 1 把可见的 UX 收住(triage + 字段卡 + envelope schema),
> Phase 2/3 接通主动观察 + Submit 检测,Phase 4/5 把 envelope 转成
> auto-propose 的 adapter rule + 可见的进步指标。
> 闭环成立之后,"投得多 → 更精准更快"就不是承诺,是用户每次投完都能看见的数字。
