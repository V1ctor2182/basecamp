# Site Adapters

**Room ID**: `00-project-room/04-career-system/07-applier/06-site-adapters`  
**Type**: feature  
**Lifecycle**: planning (Mode 2 LOCKED 2026-05-11)  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/07-applier`  

## Intent

data/career/site-adapters/*.yml + 按 URL / DOM 检测 + 站点特化策略

不同 ATS 差异巨大（Workday Shadow DOM / iCIMS iframe / Greenhouse 平凡），Site Adapter 层隔离"通用处理"和"站点特化"。目录结构：_common.yml（跨站通用 wait/retry/anti-bot 配置）、greenhouse.yml / ashby.yml / lever.yml（初版内建）/ workday.yml / icims.yml / successfactors.yml / google-careers.yml / meta-careers.yml / default.yml（fallback）。YAML 字段：name / priority / detection {url_patterns: regex[], dom_signatures: selector[]} / flow {type: single-step|multi-step, next_button.selectors[], submit_button.selectors[]} / controls {date_picker, address_autocomplete, custom_dropdown, file_upload 每项 strategy}/ quirks (自由文本 tips) / known_fields (label → class + maps_to 快速映射)。生效方式：apply_start(url) 遍历 adapters 按 detection 找 active adapter，没匹配用 default。通过 site-adapters/*.yml commit 进 git 让团队（单人 project 也便于迭代追踪）。验收：访问 greenhouse 岗位 → 匹配 greenhouse.yml；访问 myworkdayjobs.com → 匹配 workday.yml 走多步流程；访问未知 domain → 用 default.yml。初版只确保 Greenhouse / Ashby / Lever 3 个工作。

## Specs in this Room

- [intent-site-adapters-001](specs/intent-site-adapters-001.yaml) — data/career/site-adapters/*.yml + 按 URL / DOM 检测 + 站点特化策略

## 当前进度 — 🟢 planning (milestones locked 2026-05-15)

**Plan A 锁定**. 3 milestones (~1630 LOC + ~730 smoke + 8 bundled YAMLs):

| m | 内容 | LOC | 解锁 |
|---|------|-----|------|
| **m1** | Zod schema + YAML loader + URL detector + 5 简单 ATS YAML (greenhouse/ashby/lever/default/_common) | ~580 (280 + 250 smoke + 50 YAML) | adapter loading + 检测 contract 定型 |
| **m2** | activateAdapter — 把 controls 注入 05 DETECTION_RULES, 把 known_fields prepend 到 03 classifier regex | ~450 (250 + 200 smoke) | 完整可激活 + 可撤销 |
| **m3** | 迁移 04-m2 siteAdapter.mjs → thin re-export; 3 多步 YAML (workday/icims/successfactors); endpoint 接线; ROOM COMPLETE | ~600 (280 + 250 smoke + 70 YAML) | 06-site-adapters 取代 inline registry + 下游 (08-human-gate / self-iteration) |

### Locked OQ

| OQ | 决定 | 理由 |
|----|------|------|
| Q1 YAML 分布 | 5 in m1 (simple) / 3 in m3 (multi-step) | multi-step flow 字段在 m3 才真正消费, m1 先稳定 schema |
| Q2 known_fields 语义 | Augment (prepend), 非 Override | 拼写错误的 known_field 不会破坏 generic 探测; 最差只是 no-op |
| Q3 siteAdapter.mjs 迁移 | Thin re-export, 保持 public API | stepProbe.mjs / machine.mjs imports 零改动 |
| Q4 DOM signature detection | URL only in m1, schema 接受 dom_signatures 不消费 | 需要 Page ref 使 detect async, 复杂度收益不匹配; Phase 2 / 飞轮再实 |

### 与已 shipped 基础的关系

```
04-multi-step-state-machine (ROOM COMPLETE) — siteAdapter.mjs inline registry
  ↑ 06 取代 (thin re-export, same public API)
05-non-standard-controls (ROOM COMPLETE) — DETECTION_RULES / STRATEGY_REGISTRY
  ↑ 06 通过 activateAdapter 注入 per-ATS detection rules
03-field-classifier (ROOM COMPLETE) — regexRules.mjs HARD/LEGAL/etc patterns
  ↑ 06 通过 registerExtraRules 注入 known_fields (priority-ordered prepend)
06-site-adapters (this Room)
  ↓ 8 YAMLs in data/career/site-adapters/ (5 single-step + 3 multi-step)
  ↓ loader + detector + activator
  ↓ endpoint.mjs.startMachine wraps runMachine with activate/deactivate
```

---

_Generated 2026-04-22 by room-init. Plan refined 2026-05-15 by plan-milestones._
