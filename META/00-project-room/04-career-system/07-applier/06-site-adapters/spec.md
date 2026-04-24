# Site Adapters

**Room ID**: `00-project-room/04-career-system/07-applier/06-site-adapters`  
**Type**: feature  
**Lifecycle**: backlog  
**Owner**: backend  
**Parent**: `00-project-room/04-career-system/07-applier`  

## Intent

data/career/site-adapters/*.yml + 按 URL / DOM 检测 + 站点特化策略

不同 ATS 差异巨大（Workday Shadow DOM / iCIMS iframe / Greenhouse 平凡），Site Adapter 层隔离"通用处理"和"站点特化"。目录结构：_common.yml（跨站通用 wait/retry/anti-bot 配置）、greenhouse.yml / ashby.yml / lever.yml（初版内建）/ workday.yml / icims.yml / successfactors.yml / google-careers.yml / meta-careers.yml / default.yml（fallback）。YAML 字段：name / priority / detection {url_patterns: regex[], dom_signatures: selector[]} / flow {type: single-step|multi-step, next_button.selectors[], submit_button.selectors[]} / controls {date_picker, address_autocomplete, custom_dropdown, file_upload 每项 strategy}/ quirks (自由文本 tips) / known_fields (label → class + maps_to 快速映射)。生效方式：apply_start(url) 遍历 adapters 按 detection 找 active adapter，没匹配用 default。通过 site-adapters/*.yml commit 进 git 让团队（单人 project 也便于迭代追踪）。验收：访问 greenhouse 岗位 → 匹配 greenhouse.yml；访问 myworkdayjobs.com → 匹配 workday.yml 走多步流程；访问未知 domain → 用 default.yml。初版只确保 Greenhouse / Ashby / Lever 3 个工作。

## Specs in this Room

- [intent-site-adapters-001](specs/intent-site-adapters-001.yaml) — data/career/site-adapters/*.yml + 按 URL / DOM 检测 + 站点特化策略

---

_Generated 2026-04-22 by room-init._
