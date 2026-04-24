# qa-bank/templates.md — 开放题模板库

Applier Class 3 Open-Ended 分类路由读本文件匹配模板 + 填变量 + LLM 润色。

**模板而非硬答案** — 每次 apply 的值会因 JD / 公司 / 你的状态变化而变，模板只定结构和参考表达。

---

## Why {company}?

### Template (80 words)

I've been following {company}'s work on {key_product} — specifically {specific_detail_from_deep_research}. My background in {relevant_experience} aligns with what the team is building around {team_focus}. I'd love to contribute to {specific_initiative}, and I'm looking for a role where I can {career_goal_from_narrative}.

### Variables

- `{company}`, `{key_product}`, `{specific_detail}` → `reports/{jobId}.md` Block A (Role Summary) + deep research
- `{relevant_experience}` → `cv.md` + `narrative.md`
- `{team_focus}`, `{specific_initiative}` → JD 正文
- `{career_goal_from_narrative}` → `narrative.md` 的 north star

---

## Why this role?

### Template (60 words)

This role matches where I want to grow in the next {timeframe}: {specific_skill_or_area}. I've already {relevant_proof_point}, and I see the role's focus on {jd_responsibility} as the natural next step. Particularly interested in {specific_jd_detail} because {personal_reason}.

### Variables

- `{timeframe}` → 1-2 年（通常）
- `{specific_skill_or_area}` → `narrative.md` north star
- `{relevant_proof_point}` → `proof-points.md` top match
- `{jd_responsibility}` → JD bullet
- `{specific_jd_detail}`, `{personal_reason}` → connect JD 具体条款 to 你的经历

---

## Tell me about a time...

### Template: STAR+R 格式

**Situation** (1 句 context) → **Task** (你的具体职责) → **Action** (你采取的步骤，~ 3 条) → **Result** (可量化的结果) → **Reflection** (如果重做会怎么改 / 学到什么)

### 匹配规则

从 `story-bank.md` 找与 JD 要求最匹配的 STAR+R 故事，按模板格式化输出。story-bank 里每个故事已经是 STAR+R，直接引用 + 针对 JD 关键词微调即可。

---

## Expected salary

### Template

Based on Levels.fyi data for {role_level} at {company_tier}, I'm targeting ${low}K–${high}K base + equity. I'm flexible based on the total package and growth opportunity.

### Variables

- `{low}`, `{high}` → `preferences.yml.comp_target`
- `{role_level}` → JD parse (L3/L4/Junior/Mid 等)
- `{company_tier}` → `reports/{jobId}.md` Block A 公司规模

---

## When can you start?

### Default: Two weeks after signing an offer.

### Variants

- **Currently employed**: "With two weeks' notice to my current employer, I can start {date}."
- **On OPT / visa transfer**: "Ideally within {timeframe}, pending OPT/H1B paperwork."
- **Available immediately**: "Immediately."

---

## What's your biggest weakness?

### Template

I've historically struggled with {specific_weakness}. In the last {timeframe}, I've been working on this by {mitigation_approach}, and I've seen improvement in {concrete_example}. It's still an area I'm actively working on.

### 3 个模板（挑最适合你的）

1. **"告诉别人你在干嘛"** (over-engineering → shipping trade-off): 我曾经倾向追求技术完美而延迟发布，最近通过 time-boxed iteration 改进
2. **"说不"** (saying no to scope creep): 以前不擅长 push back 合理的 scope，最近通过 proactive scoping doc 改善
3. **"公开演讲"** (public speaking): 1-on-1 沟通 OK 但对大群 demo 紧张，通过 Toastmasters / 团队 lightning talks 改善

**警告**：绝不说"我是完美主义者" / "我工作太努力" — 面试官一眼看穿不真诚。

---

## Why are you leaving your current role?

### Template

I've enjoyed {positive_about_current} and shipped {proof_point}, but I'm looking for {gap}: {specific_reason_aligned_with_jd}. This role's {jd_specific_match} is exactly what drew me to apply.

### 避免

- 批评前公司 / 前老板
- 薪资作为**唯一**原因（可以提，但不是主因）
- "我只是想要个新 challenge" — 太空泛

### 好的理由

- scope / scale mismatch（团队太小学不到，或太大移动太慢）
- technical direction 不符（当前做 X 你想做 Y）
- company stage 不符（当前 early stage 你想去 growth 阶段，或反之）

---

**添加新模板**：为高频开放题新增。飞轮也会基于 history.jsonl 自动建议新模板（当某 template 的平均 edit_distance 偏大时）。
