# Per-Day Cost Breakdown for Project Usage Cards

## Context

You have a dashboard that shows Claude API usage statistics, powered by `ccusage`. The backend (`server.mjs`) calls `ccusage daily --instances --json` and aggregates per-project usage into a `projectUsage` object. The frontend (`src/TrackerApp.tsx`) renders this as a "Project Usage Breakdown" section — a list of project cards, each showing total cost and a per-model token/cost summary.

## What to build

Add a **click-to-expand dropdown** on each project card that shows the **last 10 active days** of usage. Each day should show:
- Date (weekday label + month+day)
- Total cost for that day
- A horizontal bar whose **width is proportional to the most expensive day** (so you can visually compare days at a glance)
- The bar is filled with a **gradient built from model colors**, proportional to each model's share of that day's cost
- Per-model rows in a **3-column aligned grid**: model name (with a colored dot) | output tokens | cost

The expansion is toggled by clicking the project header. A chevron rotates 0°/−90° to indicate open/closed state.

---

## Backend changes (`server.mjs`)

Inside the per-project aggregation loop (where you already accumulate `projModels` and `projTotalCost`), also accumulate a **per-day map**:

```js
const projDailyMap = {}; // date -> { date, totalCostUSD, models: { modelName -> { outputTokens, costUSD } } }

// inside the inner `for (const m of entry.modelBreakdowns)` loop:
if (!projDailyMap[date]) projDailyMap[date] = { date, totalCostUSD: 0, models: {} };
const dayBucket = projDailyMap[date];
if (!dayBucket.models[m.modelName]) dayBucket.models[m.modelName] = { outputTokens: 0, costUSD: 0 };
dayBucket.models[m.modelName].outputTokens += m.outputTokens;
dayBucket.models[m.modelName].costUSD += m.cost;
dayBucket.totalCostUSD += m.cost;
```

Then when emitting the `projectUsage` entry, attach the daily breakdown sorted **newest first, capped at 10**:

```js
const dailyBreakdown = Object.values(projDailyMap)
  .sort((a, b) => b.date.localeCompare(a.date))
  .slice(0, 10);

projectUsage[encodedDir] = {
  // ...existing fields...
  dailyBreakdown,
};
```

Bump the stats schema version constant (e.g. from 4 to 5) so the cached stats file is invalidated and rebuilt on next server start.

---

## Frontend type changes (`ClaudeStats` interface)

Add `dailyBreakdown` to the project usage entry type:

```ts
projectUsage?: Record<string, {
  // ...existing fields...
  dailyBreakdown?: {
    date: string
    totalCostUSD: number
    models: Record<string, { outputTokens: number; costUSD: number }>
  }[]
}>
```

---

## Frontend state

Add one new state variable:

```ts
const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
```

---

## Frontend render

Wrap the project list in an IIFE so you can define local helpers once and reuse them across both the summary model rows and the daily model rows:

```tsx
{(() => {
  const shortModelName = (mname: string) =>
    mname.includes('opus-4-6')    ? 'Opus 4.6'    :
    mname.includes('sonnet-4-6')  ? 'Sonnet 4.6'  :
    mname.includes('haiku')       ? 'Haiku 4.5'   : mname

  const formatTokens = (out: number) =>
    out >= 1_000_000 ? `${(out / 1_000_000).toFixed(1)}M` :
    out >= 1_000     ? `${(out / 1000).toFixed(0)}k`       : String(out)

  // Match the colors used in your existing charts
  const getModelColor = (mname: string) =>
    mname.includes('opus-4-6')    ? '#D97757' :
    mname.includes('sonnet-4-6')  ? '#E8A87C' :
    mname.includes('haiku')       ? '#F0C4A8' : '#999'

  return Object.entries(claudeStats.projectUsage)
    .sort((a, b) => b[1].totalCostUSD - a[1].totalCostUSD)
    .map(([key, proj]) => {
      const isExpanded = expandedProjects.has(key)
      const toggle = () => setExpandedProjects(prev => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key); else next.add(key)
        return next
      })

      return (
        <div key={key} className="t-claude-project-section">

          {/* Clickable header with rotating chevron */}
          <div
            className="t-claude-project-header t-claude-project-header-toggle"
            onClick={toggle} role="button" tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
          >
            <div className="t-claude-project-name-meta">
              <ChevronDown size={12} className={`t-claude-project-chevron${isExpanded ? ' expanded' : ''}`} />
              <span className="t-claude-project-name">{proj.displayName}</span>
              <span className="t-claude-project-meta">· {proj.daysActive} days · {formatRelativeTime(proj.lastActivity)}</span>
            </div>
            <span className="t-claude-cost">{formatUSD(proj.totalCostUSD)}</span>
          </div>

          {/* All-time per-model summary (existing) */}
          <div className="t-claude-project-models">
            {Object.entries(proj.models)
              .sort((a, b) => b[1].costUSD - a[1].costUSD)
              .map(([mname, m]) => (
                <div key={mname} className="t-claude-project-model-row">
                  <span className="t-claude-project-model-name">{shortModelName(mname)}</span>
                  <div className="t-claude-project-model-stats">
                    <span>{formatTokens(m.outputTokens)} out</span>
                    <span className="t-claude-sep">·</span>
                    <span className="t-claude-cost">{formatUSD(m.costUSD)}</span>
                  </div>
                </div>
              ))
            }
          </div>

          {/* Expandable daily breakdown */}
          {isExpanded && proj.dailyBreakdown && proj.dailyBreakdown.length > 0 && (() => {
            const maxDayCost = Math.max(...proj.dailyBreakdown.map(d => d.totalCostUSD), 0.01)
            return (
              <div className="t-claude-project-days">
                <div className="t-claude-project-days-title">
                  Last {proj.dailyBreakdown.length} active days
                </div>
                {proj.dailyBreakdown.map(day => {
                  const dayModels = Object.entries(day.models).sort((a, b) => b[1].costUSD - a[1].costUSD)
                  const d = new Date(day.date + 'T00:00:00')
                  const pct = (day.totalCostUSD / maxDayCost) * 100

                  // Build bar gradient from model colors, proportional to each model's cost share
                  const stops: string[] = []
                  let acc = 0
                  for (const [mname, m] of dayModels) {
                    const frac = day.totalCostUSD > 0 ? (m.costUSD / day.totalCostUSD) * 100 : 0
                    const color = getModelColor(mname)
                    stops.push(`${color} ${acc}%`, `${color} ${acc + frac}%`)
                    acc += frac
                  }
                  const barBg = stops.length > 0
                    ? `linear-gradient(90deg, ${stops.join(', ')})`
                    : 'var(--border-light)'

                  return (
                    <div key={day.date} className="t-claude-project-day">
                      <div className="t-claude-project-day-header">
                        <span className="t-claude-project-day-date">
                          <span className="t-claude-project-day-weekday">
                            {d.toLocaleDateString([], { weekday: 'short' })}
                          </span>
                          <span className="t-claude-project-day-monthday">
                            {d.toLocaleDateString([], { month: 'short', day: 'numeric' })}
                          </span>
                        </span>
                        <span className="t-claude-project-day-cost">{formatUSD(day.totalCostUSD)}</span>
                      </div>
                      <div className="t-claude-project-day-bar">
                        <div className="t-claude-project-day-bar-fill"
                          style={{ width: `${pct}%`, background: barBg }} />
                      </div>
                      <div className="t-claude-project-day-models">
                        {dayModels.map(([mname, m]) => (
                          <div key={mname} className="t-claude-project-day-model">
                            <span className="t-claude-project-day-model-name">
                              <span className="t-model-dot" style={{ background: getModelColor(mname) }} />
                              {shortModelName(mname)}
                            </span>
                            <span className="t-claude-project-day-model-tokens">{formatTokens(m.outputTokens)}</span>
                            <span className="t-claude-project-day-model-cost">{formatUSD(m.costUSD)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })()}

        </div>
      )
    })
})()}
```

---

## CSS

```css
/* Header — clickable */
.t-claude-project-header-toggle {
  cursor: pointer;
  border-radius: 4px;
  padding: 2px 4px;
  margin: 0 -4px 4px;
  transition: background 0.12s;
}
.t-claude-project-header-toggle:hover { background: var(--bg-secondary); }

.t-claude-project-chevron {
  color: var(--text-muted);
  flex-shrink: 0;
  transition: transform 0.15s;
  transform: rotate(-90deg);
  align-self: center;
}
.t-claude-project-chevron.expanded { transform: rotate(0deg); }

/* Dropdown container */
.t-claude-project-days {
  margin-top: 10px;
  margin-left: 18px;
  padding: 4px 14px 10px;
  background: var(--bg-secondary);
  border-radius: 8px;
  border: 1px solid var(--border-light);
  animation: t-fadeIn 0.2s ease-out;
}
@keyframes t-fadeIn {
  from { opacity: 0; transform: translateY(-2px); }
  to   { opacity: 1; transform: translateY(0); }
}
.t-claude-project-days-title {
  font-size: 0.66rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  padding: 8px 0 6px;
  border-bottom: 1px solid var(--border-light);
  margin-bottom: 2px;
}

/* Individual day */
.t-claude-project-day { padding: 10px 0 9px; }
.t-claude-project-day + .t-claude-project-day { border-top: 1px solid var(--border-light); }

.t-claude-project-day-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 5px;
}
.t-claude-project-day-date   { display: inline-flex; align-items: baseline; gap: 6px; }
.t-claude-project-day-weekday {
  font-size: 0.66rem; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--text-muted);
}
.t-claude-project-day-monthday {
  font-size: 0.82rem; font-weight: 600;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}
.t-claude-project-day-cost {
  font-size: 0.82rem; font-weight: 700;
  color: #D97757;
  font-variant-numeric: tabular-nums;
}

/* Relative cost bar */
.t-claude-project-day-bar {
  height: 5px;
  background: var(--border-light);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 8px;
}
.t-claude-project-day-bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.25s ease-out;
}

/* Model rows — 3-column grid for alignment */
.t-claude-project-day-models {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 2px 12px;
  padding-left: 4px;
}
.t-claude-project-day-model { display: contents; }
.t-claude-project-day-model-name {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 0.76rem; color: var(--text-secondary);
}
.t-claude-project-day-model-tokens {
  font-size: 0.72rem; font-family: var(--font-mono);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums; text-align: right;
}
.t-claude-project-day-model-tokens::after { content: ' out'; opacity: 0.7; }
.t-claude-project-day-model-cost {
  font-size: 0.74rem; font-family: var(--font-mono);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums; text-align: right;
  min-width: 52px;
}
.t-model-dot {
  display: inline-block; width: 8px; height: 8px;
  border-radius: 50%; flex-shrink: 0;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.06);
}
```

---

## Notes

- **Schema version bump**: If you cache the stats JSON, bump the version number so the cache is invalidated after adding `dailyBreakdown`.
- **Model colors**: Use whatever palette your charts already use for consistency. The bar gradient is built by converting each model's cost share to a percentage segment.
- **`display: contents`**: The day-model rows use `display: contents` so all rows participate in the same grid, giving perfectly aligned columns across every model in the day.
- **Bar proportionality**: Width is relative to the single most expensive day (`maxDayCost`), not the total — this makes the comparison meaningful when days have wildly different costs.
