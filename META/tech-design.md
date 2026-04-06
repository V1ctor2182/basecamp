# Learn Dashboard — Technical Design

## Overview

A local-first Markdown knowledge base viewer/editor. It serves all `.md` files under `learn/` with a sidebar file tree, a live Markdown preview with Mermaid diagrams, and an extensible widget system that lets companion `.tsx` files inject interactive ECharts visualizations into the rendered content.

```
learn/                          ← content root (all .md files live here)
├── topic-a/
│   ├── notes.md                ← content
│   └── notes.tsx               ← companion enhancer (optional)
├── topic-b/
│   └── research.md
└── learn-dashboard/            ← this project (viewer/editor)
    ├── server.mjs              ← Express API (file tree, read/write)
    ├── src/
    │   ├── main.tsx            ← React entry
    │   ├── App.tsx             ← SPA shell (sidebar, editor, preview)
    │   ├── enhance-kit.tsx     ← shared theme/component kit for enhancers
    │   ├── index.css           ← all styles + CSS variables
    │   └── App.css             ← (empty, all styles in index.css)
    ├── vite.config.ts
    ├── tsconfig.app.json
    └── package.json
```

## Architecture

### Two-process dev setup

```
npm run dev
  → concurrently "node server.mjs" "vite"
```

| Process | Port | Role |
|---|---|---|
| `server.mjs` (Express) | 3001 | File system API: tree listing, read/write, create file/folder |
| `vite` (dev server) | 5173 | Frontend SPA with HMR; proxies `/api/*` to `:3001` |

### Backend — `server.mjs`

Minimal Express server. Resolves `LEARN_DIR` to one directory above `learn-dashboard/` (i.e. `learn/`).

| Endpoint | Method | Description |
|---|---|---|
| `/api/tree` | GET | Recursive directory listing; returns `TreeNode[]`; skips `.`, `node_modules`, `learn-dashboard`; only `.md` files |
| `/api/file?path=` | GET | Read file content |
| `/api/file` | POST | Write file content (body: `{ path, content }`) |
| `/api/new` | POST | Create new `.md` file (body: `{ dir, name }`) |
| `/api/folder` | POST | Create new folder (body: `{ path }`) |

### Frontend — `App.tsx`

Single-page app, no router. State lives in `App` component.

**Layout**: CSS Grid — 280px sidebar + fluid main content.

**Core state**:
- `tree: TreeNode[]` — file tree from API
- `activeFile: string | null` — currently open file path
- `content / savedContent` — editor buffer + dirty tracking
- `view: 'preview' | 'edit' | 'split'` — view mode
- `darkMode: boolean` — persisted to `localStorage('learn-theme')`, applied as `data-theme` attribute on `<html>`
- `fontSize: number` — persisted to `localStorage('learn-font-size')`

**Key features**:
- CodeMirror editor with Markdown syntax
- ReactMarkdown preview with GFM tables, blockquotes, etc.
- Mermaid diagram rendering with zoom/pan/node-highlight interactivity
- Widget system (see below)
- Cmd/Ctrl+S save shortcut
- Light/dark mode toggle
- Font size controls

## Widget / Enhancer System

This is the core extensibility mechanism. It lets companion `.tsx` files inject interactive React components into the Markdown preview.

### How it works

1. **Glob discovery**: `App.tsx` uses `import.meta.glob('../../**/*.tsx', { eager: false })` to lazy-discover all `.tsx` files under `learn/`.

2. **Path matching**: When a `.md` file is opened (e.g. `topic/notes.md`), the hook `useEnhancer` looks for a matching `.tsx` at the same path (`topic/notes.tsx`).

3. **Module shape**: Each enhancer `.tsx` exports:
   ```ts
   // Required: widget map
   export const widgets: Record<string, React.FC> = {
     'widget-name': MyWidgetComponent,
   }
   ```
   Note: default exports (Wrapper components) are intentionally **not** used by the dashboard. The preview handles its own layout via `.markdown-preview` CSS. This prevents enhancers from overriding dark mode backgrounds with hardcoded light colors.

4. **Markdown markers**: The `.md` file contains fenced code blocks with a `widget:` prefix:
   ````md
   ```widget:widget-name
   ```
   ````
   The custom `code` renderer in `ReactMarkdown` detects `language-widget:xxx`, looks up the widget by name, and renders the React component in place.

5. **Loading states**: If the enhancer is loading or the widget name doesn't match, a `WidgetSkeleton` shimmer placeholder is shown.

### Data flow

```
.md file opened
  → useEnhancer(filePath) lazily imports matching .tsx
  → ReactMarkdown renders content
  → code block with lang="widget:xxx" hits custom renderer
  → renderer looks up widgets['xxx'] from enhancer module
  → renders <Widget /> inside a .widget-container
```

## enhance-kit.tsx — Theme Contract

The single source of truth for all enhancer styling. Solves the fundamental problem: **ECharts renders on `<canvas>` and cannot resolve CSS variables**.

### Exports

| Export | Type | Purpose |
|---|---|---|
| `useTheme()` | Hook → `Theme` | Returns resolved hex color tokens. Watches `data-theme` attribute via MutationObserver; re-reads CSS variables via `getComputedStyle` on toggle. |
| `useBaseOption(t)` | `(Theme) => EChartsOption` | Base ECharts config with consistent fonts, tooltips, grid, palette, animation. |
| `WidgetHeader` | Component | Title + subtitle with "Interactive" tag. Takes `t` prop. |
| `WidgetNote` | Component | Footnote text. Takes `t` prop. |
| `Pill` | Component | Toggle button for chart filters. |
| `echarts` | Re-export | Pre-configured echarts core (all chart types + renderers registered). |
| `ReactEChartsCore` | Re-export | React wrapper for echarts. |

### Theme resolution flow

```
User toggles dark mode
  → App sets data-theme="dark" on <html>
  → CSS variables in index.css switch to dark values
  → MutationObserver in useTheme() fires
  → setIsDark(true) triggers re-render
  → cssVar() calls getComputedStyle() to read resolved hex values
  → All widgets re-render with correct dark colors
  → ECharts canvases get real hex values (not CSS var strings)
```

### Vite alias

`@enhance-kit` → `learn-dashboard/src/enhance-kit.tsx`

Configured in both `vite.config.ts` (runtime) and `tsconfig.app.json` (type checking). This means enhancer `.tsx` files at any directory depth can simply:

```tsx
import { useTheme, useBaseOption, echarts, ReactEChartsCore, WidgetHeader, Pill } from '@enhance-kit'
```

## Theming System

### CSS Variables (index.css)

Two complete token sets defined via `:root` and `[data-theme="dark"]`:

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--bg-primary` | `#F5F0E8` | `#1C1B19` | Page background |
| `--bg-card` | `#FAF7F2` | `#22211E` | Card/panel background |
| `--bg-secondary` | `#EDE8DF` | `#242320` | Sidebar, sub-sections |
| `--text-primary` | `#2D2B28` | `#D5D0C8` | Main text |
| `--text-secondary` | `#5A5650` | `#ADA89E` | Body text |
| `--text-muted` | `#ADA89F` | `#5C5850` | Labels, hints |
| `--accent` | `#2D5A27` | `#7AB06E` | Links, active states |
| `--chart-1..6` | Muted tones | Lighter variants | Data series in charts |

Design philosophy: warm, eye-friendly palette. No harsh primaries. Low saturation for extended reading comfort.

### Fonts

| Variable | Font | Usage |
|---|---|---|
| `--font-display` | Space Grotesk | Headings, UI labels |
| `--font-body` | Inter | Body text, paragraphs |
| `--font-mono` | JetBrains Mono | Code, data values |

Loaded via Google Fonts in `index.html`.

## Mermaid Diagrams

Mermaid code blocks are auto-detected and rendered interactively:

- **Zoom/pan**: Powered by `react-zoom-pan-pinch` (`TransformWrapper`)
- **Node hover**: Shows tooltip with node label
- **Node click**: Highlights the node and its connected edges; dims everything else
- **Theme**: Initialized once with hardcoded light-mode `themeVariables` (known limitation — does not respond to dark mode toggle)

## enhance-md Skill

A Claude Code skill (`.skill` zip + `~/.claude/skills/`) that automates the creation of companion `.tsx` files.

### Flow

1. User runs `/enhance-md path/to/file.md`
2. Skill reads the markdown, identifies 2-5 widget opportunities
3. Generates a `.tsx` file importing from `@enhance-kit`
4. Inserts ` ```widget:name``` ` markers into the markdown
5. Runs `tsc --noEmit` to verify

### Key constraints enforced by the skill prompt

- Must import from `@enhance-kit` only — no local color definitions
- Every widget must call `useTheme()` + `useBaseOption(t)`
- Must pass `t` to all shared components
- Must use `t.palette[n]` for data series — no hardcoded hex
- Must not export a default PageWrapper

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Framework | React | 19.2 |
| Bundler | Vite | 7.3 |
| Language | TypeScript | 5.9 |
| Editor | CodeMirror 6 | via @uiw/react-codemirror |
| Markdown | react-markdown + remark-gfm | 10.1 |
| Diagrams | mermaid | 11.12 |
| Charts | ECharts (via echarts-for-react) | 6.0 |
| Icons | lucide-react | 0.576 |
| Backend | Express | 5.2 |
| Dev runner | concurrently | — |

## Claude Code Usage Tracking

Two complementary data sources track Claude Code usage: a passive stats cache reader and a real-time activity hook.

### Data Sources

| Source | Mechanism | Granularity | Data |
|---|---|---|---|
| `~/.claude/stats-cache.json` | Read on page load + every 60s | Daily totals (updates on new session) | Messages, tokens by model, sessions, cost |
| `Stop` hook → `/api/claude-ping` | Real-time, fires on every Claude response | Per-turn | Timestamp, session ID, project name |

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Claude Code (any project, global hook)                 │
│                                                         │
│  Stop hook fires ──→ curl POST localhost:8000/claude-ping│
│                      { session_id, cwd }                │
│                                                         │
│  Session start ──→ updates ~/.claude/stats-cache.json   │
└─────────────────────────────────────────────────────────┘
          │                          │
          ▼                          ▼
┌──────────────────┐    ┌──────────────────────────┐
│ data/             │    │ server.mjs                │
│ claude-pings.json │◀───│ POST /api/claude-ping     │
└──────────────────┘    │ GET /api/claude-stats      │
                        │ reads stats-cache.json     │
                        └──────────────────────────┘
```

### Data Flow — Activity Pings (real-time)

```
Claude finishes response
  → Stop hook in ~/.claude/settings.json fires
  → bash curl POSTs { session_id, cwd } to localhost:8000/api/claude-ping
  → server extracts ts, session, project (basename of cwd)
  → appends to data/claude-pings.json
  → frontend polls /api/claude-pings, groups by session
  → Activity Timeline renders session blocks on a 24h track
  → total active time = sum of (last ping − first ping) per session
```

### Data Flow — Stats Cache (delayed, read-only)

```
New Claude Code session starts
  → Claude Code recomputes ~/.claude/stats-cache.json
  → frontend fetches /api/claude-stats (reads file directly)
  → renders all-time stats cards, heatmap, model breakdown, charts
```

### Hook Configuration

Global hook in `~/.claude/settings.json` under `hooks.Stop`:

```json
{
  "type": "command",
  "command": "bash -c 'INPUT=$(cat); curl -s -X POST http://localhost:8000/api/claude-ping -H \"Content-Type: application/json\" -d \"$INPUT\" --max-time 3 >/dev/null 2>&1 || true'",
  "timeout": 5
}
```

- Global scope: fires in all projects, all sessions
- Fails silently if server is not running (`|| true`)
- 3s curl timeout + 5s hook timeout to avoid blocking Claude

### Storage

| File | Contents | Retention |
|---|---|---|
| `data/claude-pings.json` | `[{ ts, session, project }]` | Last 50k entries |
| `~/.claude/stats-cache.json` | Claude Code's own cache (read-only) | Managed by Claude Code |

### Frontend Components

| Component | Data Source | Shows |
|---|---|---|
| Stats cards (Sessions, Messages, Tokens, Cost) | stats-cache | All-time totals |
| Contribution heatmap | stats-cache dailyActivity | Messages per day (calendar grid) |
| Tokens by Model chart | stats-cache dailyModelTokens | Last 30 days stacked bars |
| When Do You Code the Most? | stats-cache hourCounts | All-time session distribution by hour |
| Activity Timeline | claude-pings.json | Session blocks on 24h track with date picker |
| Model Breakdown table | stats-cache modelUsage | Per-model tokens + estimated cost |

### Limitations

1. **Stats cache is delayed** — stats-cache.json only updates when a new Claude Code session starts, not during a session.
2. **Activity pings require server running** — if the dashboard server is down, pings are silently dropped (no queuing).
3. **No model/token info in pings** — the Stop hook payload doesn't include model or token counts; that data only comes from stats-cache.
4. **Cost is estimated** — uses hardcoded pricing per million tokens; may drift from actual billing.

## Known Limitations

1. **Mermaid colors don't follow dark mode** — `mermaid.initialize()` is called once at module load with hardcoded light-theme `themeVariables`. Fixing this requires re-initializing mermaid and re-rendering diagrams on theme toggle.
2. **No authentication** — the Express server serves all files under `learn/` without auth. Intended for local use only.
3. **No file deletion** — the API supports create and write but not delete.
4. **Single-user** — no conflict resolution or locking for concurrent edits.
