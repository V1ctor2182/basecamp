---
description: One-shot onboarding for new contributors — install skills plugin, tour the repo, pick a starter task
allowed-tools: Bash(git:*), Bash(npm:*), Bash(node:*), Read, Glob, Grep
---

# Onboard a new contributor to Basecamp

You are walking a brand-new contributor through their first session in this repo. They just cloned it. Your job: get them productive in ≤ 10 minutes. Be concise — show, don't lecture.

## Step 1 — Pre-flight

Run these in parallel and report briefly:

- `git rev-parse --show-toplevel` — confirm we're at the repo root
- `git log --oneline -5` — last 5 commits (orient them on recency)
- `git branch --show-current` — confirm they're on `main`
- `node --version` — must be ≥ 18
- Check whether `node_modules/` exists (if not, tell them to run `npm install`)

If `node_modules/` is missing, **stop and tell them**: `npm install`, then re-run `/onboard`.

## Step 2 — Plugin install (skills)

This repo's Feature Room workflow (`/dev`, `/commit-sync`, `/plan-milestones`, `/room`, `/room-status`, `/prompt-gen`, `/room-init`, `/timeline-init`, `/random-contexts`) lives in **[V1ctor2182/feature-room-plugin](https://github.com/V1ctor2182/feature-room-plugin)**.

Tell them to run **in Claude Code** (not bash):

```
/plugin marketplace add V1ctor2182/feature-room-plugin
/plugin install feature-room
```

Then restart Claude Code. After restart, `/dev` etc. will be available.

Don't try to run `/plugin` yourself — it's a Claude Code CLI command, not a bash command.

## Step 3 — Repo tour

Read these in parallel (do not summarize them in full — quote 1-2 key lines from each, then synthesize):

- `CLAUDE.md` — project overview + skill routing
- `META/00-project-room/_tree.yaml` — module全景 (just count the rooms by lifecycle)
- `META/00-project-room/04-career-system/progress.yaml` — current focus + completion %
- `META/00-project-room/04-career-system/parallel-plan.md` — what's parallelizable right now

Then output a 6-line summary in this exact shape:

```
📍 You're at: <branch> @ <last commit hash>
🎯 Active epic: 04-career-system (<X>% — <N>/<M> features)
🔄 Sub-epics in progress: <list>
🎟️ Next unblocked rooms: <bullet list of 2-3>
📚 Iron rule: 先读 Spec, 再写代码
🛠️ Workflow: plan-milestones → dev (loops per milestone) → commit-sync (auto in dev) → /ship
```

## Step 4 — Pick a starter task

Suggest **one** room they could pick up, based on:
- `lifecycle: planning` (not yet started)
- `depends_on` all satisfied (parents `lifecycle: active` and progress 100)
- Owner field matches "backend" or "fullstack" (most flexible)
- Avoid anything CLAUDE.md notes a Colleague is on

Show them exactly the command to start:

```
/plan-milestones <sub-epic>/<feature-id>
```

…and explain: this skill reads the room's intent + sibling patterns, generates milestone breakdown, asks them to confirm. Then `/dev <feature-id>/m1` starts coding.

## Step 5 — Conventions cheat sheet

End with a 5-bullet recap they can scroll back to:

- **Branch per Room** — feature-id as branch name; PR back to `main` once Room complete
- **`/dev` drives commits** — never run raw `git commit`/`git push` (use `/commit-sync` if doing manual edits)
- **Specs live in `META/00-project-room/<...>/specs/`** — intent + change yaml
- **Data files** in `data/career/` are gitignored except whitelist (preferences.yml, portals.yml, narrative.md, proof-points.md, story-bank.md, qa-bank/templates.md, resumes/index.yml, resumes/*/metadata.yml)
- **Tests** — currently no test framework; verify via `node scripts/smoke-*.mjs` + `npx tsc --noEmit` + `npx vite build` + manual UI smoke

End with one line: `Ready when you are — say "make a plan" or paste the room id you want.`
