# 05-cicd — CI/CD

## Goal
Automate quality gates and deployment for learn-dashboard so every PR is validated and every merge to `main` ships automatically.

## Stack
- **CI**: GitHub Actions
- **Deploy**: Vercel (matches existing MCP integration)

## Features

### 01-github-actions-ci
GitHub Actions workflow that runs on every PR and push to `main`:
- `tsc -b` — type-check (frontend + server types)
- `npm run lint` — ESLint across src/
- `npm run build` — Vite production build

Fail fast: type-check → lint → build in sequence.

### 02-deploy-vercel
Vercel project wiring for the frontend:
- Preview deployments on PRs
- Production deployment on merge to `main`
- Environment variable management (ANTHROPIC_API_KEY, GitHub tokens)

Note: Express backend stays local-only. Only the Vite frontend static build deploys to Vercel.

## Locked Decisions
- **OQ1 resolved**: Backend (Express) stays local-only — no Railway/Fly.io.
- **OQ2 resolved**: Smoke tests excluded from CI (require real filesystem, too slow for CI).
