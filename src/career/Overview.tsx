// Career system dashboard — Overview page.
//
// 08-human-gate-tracker/02-career-dashboard-views m2.
//
// Aggregates 3 already-shipped endpoints in parallel:
//   GET /api/career/applications           (08/01 m2)
//   GET /api/career/shortlist              (06-evaluator/05-pipeline-ui m2)
//   GET /api/career/llm-costs              (today's aggregate)
//   GET /api/career/llm-costs?groupBy=day&start=14daysAgo  (cost trend)
//
// Layout:
//   - 4 stat cards (Total / This-week / Active / Today's spend)
//   - Nivo pie: status distribution (8 statuses, color-tiered)
//   - Nivo bar: 7-day activity (stacked by event type)
//   - Followup list (next 7 days, ≤3d yellow / past-due red)
//   - Nivo line: 14-day cost trend (with daily_budget_usd reference line)

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ResponsivePie } from '@nivo/pie'
import { ResponsiveBar } from '@nivo/bar'
import { ResponsiveLine } from '@nivo/line'
import {
  AlertTriangle,
  Loader2,
  RefreshCw,
  TrendingUp,
  Briefcase,
  Activity,
  DollarSign,
} from 'lucide-react'
import './overview.css'

const REFRESH_MS = 30_000

type Status =
  | 'Evaluated'
  | 'Applied'
  | 'Responded'
  | 'Interview'
  | 'Offer'
  | 'Rejected'
  | 'Discarded'
  | 'SKIP'

type TimelineEvent = { ts: string; event: string; from?: Status; to?: Status; note?: string }

type Application = {
  id: string
  company: string
  role: string
  url: string
  score: number | null
  status: Status
  legitimacy: string
  reportPath: string | null
  pdfPath: string | null
  resumeId: string | null
  timeline: TimelineEvent[]
  followup?: { nextAt: string; reason: string }
}

type ApplicationsResp = {
  total: number
  filtered: number
  results: Application[]
}

type ShortlistResp = {
  total: number
  score_floor: number
  results: Array<{ id: string; total_score: number; evaluated_at: string }>
}

type CostsToday = { total_cost: number; total_tokens: number; record_count: number }
type CostsByDay = Record<string, { total_cost: number; total_tokens: number; record_count: number }>

const ACTIVE_STATUSES: Status[] = ['Evaluated', 'Applied', 'Responded', 'Interview']

// 8 status color tiers — semantic (green=won/active, amber=in-progress,
// red=lost, gray=archive). Matches Applied.tsx status pill conventions.
const STATUS_COLORS: Record<Status, string> = {
  Evaluated:  '#d6d3d1', // gray-warm
  Applied:    '#fbbf24', // amber
  Responded:  '#60a5fa', // blue
  Interview:  '#a78bfa', // purple
  Offer:      '#10b981', // green
  Rejected:   '#ef4444', // red
  Discarded:  '#a8a29e', // gray
  SKIP:       '#d6d3d1', // gray
}

const STATUS_ORDER: Status[] = [
  'Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP',
]

const FOLLOWUP_WARN_MS = 3 * 24 * 60 * 60 * 1000
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000

export default function Overview() {
  const [applications, setApplications] = useState<ApplicationsResp | null>(null)
  const [shortlist, setShortlist] = useState<ShortlistResp | null>(null)
  const [costsToday, setCostsToday] = useState<CostsToday | null>(null)
  const [costsByDay, setCostsByDay] = useState<CostsByDay | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function fetchAll(signal?: AbortSignal) {
    try {
      const startIso = new Date(Date.now() - FOURTEEN_DAYS_MS).toISOString()
      const [appsR, shortR, costsTR, costsDR] = await Promise.all([
        fetch('/api/career/applications', { signal }).then((r) => r.json()),
        fetch('/api/career/shortlist', { signal }).then((r) => r.json()).catch(() => null),
        fetch('/api/career/llm-costs', { signal }).then((r) => r.json()).catch(() => null),
        fetch(`/api/career/llm-costs?groupBy=day&start=${encodeURIComponent(startIso)}`, { signal })
          .then((r) => r.json()).catch(() => ({})),
      ])
      setApplications(appsR ?? { total: 0, filtered: 0, results: [] })
      setShortlist(shortR ?? { total: 0, score_floor: 4.0, results: [] })
      setCostsToday(costsTR ?? { total_cost: 0, total_tokens: 0, record_count: 0 })
      setCostsByDay(costsDR ?? {})
      setError(null)
    } catch (e) {
      const name = (e as { name?: string })?.name
      if (name === 'AbortError') return
      setError((e as Error).message ?? 'Failed to load overview data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const ctrl = new AbortController()
    fetchAll(ctrl.signal)
    const t = setInterval(() => fetchAll(ctrl.signal), REFRESH_MS)
    return () => {
      ctrl.abort()
      clearInterval(t)
    }
  }, [])

  // ── Derived metrics ────────────────────────────────────────────────
  const stats = useMemo(() => {
    const apps = applications?.results ?? []
    const now = Date.now()
    const oneWeekAgo = now - ONE_WEEK_MS
    const evaluatedThisWeek = apps.filter((a) => {
      const created = a.timeline?.[0]?.ts
      if (!created) return false
      return new Date(created).getTime() >= oneWeekAgo
    }).length
    // activeInFunnel: includes Evaluated (full pipeline view for the
    // stat card — see the stat card hint text)
    const activeInFunnel = apps.filter((a) => ACTIVE_STATUSES.includes(a.status)).length
    // appliedTabCount: what the Applied tab actually shows. Excludes
    // Evaluated since those live on Shortlist (matches Applied.tsx m1
    // chipCounts.all logic). Used for the quick-link count so it agrees
    // with what the user sees on Applied page.
    const appliedTabCount = apps.filter((a) =>
      a.status !== 'Evaluated'
    ).length
    const todaySpend = costsToday?.total_cost ?? 0
    return {
      total: apps.length,
      evaluatedThisWeek,
      activeInFunnel,
      appliedTabCount,
      todaySpend,
    }
  }, [applications, costsToday])

  // Status distribution → Nivo pie data
  const pieData = useMemo(() => {
    const apps = applications?.results ?? []
    const counts = new Map<Status, number>()
    for (const s of STATUS_ORDER) counts.set(s, 0)
    for (const a of apps) counts.set(a.status, (counts.get(a.status) ?? 0) + 1)
    return STATUS_ORDER
      .filter((s) => (counts.get(s) ?? 0) > 0)
      .map((s) => ({
        id: s,
        label: s,
        value: counts.get(s) ?? 0,
        color: STATUS_COLORS[s],
      }))
  }, [applications])

  // 7-day activity → Nivo bar data (stacked by event type: created vs status_changed)
  const barData = useMemo(() => {
    const apps = applications?.results ?? []
    const now = new Date()
    const days: Array<{ day: string; created: number; status_changed: number; other: number }> = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
      days.push({
        day: `${d.getMonth() + 1}/${d.getDate()}`,
        created: 0,
        status_changed: 0,
        other: 0,
      })
    }
    for (const a of apps) {
      for (const ev of a.timeline ?? []) {
        const evDate = new Date(ev.ts)
        if (!Number.isFinite(evDate.getTime())) continue
        const evDay = `${evDate.getMonth() + 1}/${evDate.getDate()}`
        const bucket = days.find((d) => d.day === evDay)
        if (!bucket) continue
        if (ev.event === 'created') bucket.created++
        else if (ev.event === 'status_changed') bucket.status_changed++
        else bucket.other++
      }
    }
    return days
  }, [applications])

  // Followup list (next 7 days)
  const followups = useMemo(() => {
    const apps = applications?.results ?? []
    const now = Date.now()
    const cutoff = now + 7 * 24 * 60 * 60 * 1000
    return apps
      .filter((a) => {
        if (!a.followup) return false
        const due = new Date(a.followup.nextAt).getTime()
        return Number.isFinite(due) && due <= cutoff
      })
      .sort((a, b) =>
        new Date(a.followup!.nextAt).getTime() - new Date(b.followup!.nextAt).getTime()
      )
      .slice(0, 10)
  }, [applications])

  // 14-day cost trend → Nivo line data (one series with daily totals)
  const lineData = useMemo(() => {
    const buckets = costsByDay ?? {}
    const now = new Date()
    const series: Array<{ x: string; y: number }> = []
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      const label = `${d.getMonth() + 1}/${d.getDate()}`
      const totalCost = buckets[key]?.total_cost ?? 0
      series.push({ x: label, y: Math.round(totalCost * 10000) / 10000 })
    }
    return [{ id: 'Cost ($)', data: series, color: '#0969da' }]
  }, [costsByDay])

  // ── Render ─────────────────────────────────────────────────────────
  if (loading && !applications) {
    return (
      <div className="c-page">
        <h2>Overview</h2>
        <div className="ov-loading">
          <Loader2 size={14} className="ov-spin" /> Loading dashboard…
        </div>
      </div>
    )
  }

  if (error && !applications) {
    return (
      <div className="c-page">
        <h2>Overview</h2>
        <div className="ov-error">
          <AlertTriangle size={14} /> Failed to load: {error}
        </div>
      </div>
    )
  }

  const todaySpendTinted = stats.todaySpend > 5 ? 'ov-stat-warn' : ''

  return (
    <div className="c-page ov-page">
      <div className="ov-header">
        <h2>Overview</h2>
        <button
          type="button"
          className="ov-refresh"
          aria-label="Refresh"
          onClick={() => fetchAll()}
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Stat cards */}
      <div className="ov-stats">
        <StatCard
          icon={<Briefcase size={16} />}
          label="Total applications"
          value={stats.total.toString()}
          hint={stats.total === 0 ? 'No applications yet' : 'in applications.json'}
        />
        <StatCard
          icon={<TrendingUp size={16} />}
          label="Stage B this week"
          value={stats.evaluatedThisWeek.toString()}
          hint="created within last 7 days"
        />
        <StatCard
          icon={<Activity size={16} />}
          label="Active in funnel"
          value={stats.activeInFunnel.toString()}
          hint="Evaluated / Applied / Responded / Interview"
        />
        <StatCard
          icon={<DollarSign size={16} />}
          label="Today's spend"
          value={`$${stats.todaySpend.toFixed(2)}`}
          hint={`${costsToday?.record_count ?? 0} LLM calls`}
          variant={todaySpendTinted}
        />
      </div>

      {/* Two-column chart row: pie + bar */}
      <div className="ov-chart-row">
        <div className="ov-chart-card">
          <h3 className="ov-chart-title">Status distribution</h3>
          {pieData.length === 0 ? (
            <div className="ov-chart-empty">No applications yet.</div>
          ) : (
            <div className="ov-chart-container" style={{ height: 240 }}>
              <ResponsivePie
                data={pieData}
                margin={{ top: 16, right: 90, bottom: 16, left: 16 }}
                innerRadius={0.5}
                padAngle={1}
                cornerRadius={2}
                colors={{ datum: 'data.color' }}
                borderWidth={1}
                borderColor={{ from: 'color', modifiers: [['darker', 0.2]] }}
                arcLabelsSkipAngle={12}
                arcLabelsTextColor="#1c1917"
                arcLinkLabelsSkipAngle={12}
                arcLinkLabelsTextColor="#57534e"
                arcLinkLabelsColor={{ from: 'color' }}
                legends={[{
                  anchor: 'right',
                  direction: 'column',
                  itemWidth: 80,
                  itemHeight: 18,
                  itemTextColor: '#57534e',
                  symbolSize: 12,
                  symbolShape: 'circle',
                  translateX: 80,
                }]}
              />
            </div>
          )}
        </div>

        <div className="ov-chart-card">
          <h3 className="ov-chart-title">Activity (last 7 days)</h3>
          {barData.every((d) => d.created === 0 && d.status_changed === 0 && d.other === 0) ? (
            <div className="ov-chart-empty">No timeline events in the last 7 days.</div>
          ) : (
            <div className="ov-chart-container" style={{ height: 240 }}>
              <ResponsiveBar
                data={barData}
                keys={['created', 'status_changed', 'other']}
                indexBy="day"
                margin={{ top: 8, right: 16, bottom: 40, left: 32 }}
                padding={0.25}
                groupMode="stacked"
                colors={['#fbbf24', '#60a5fa', '#a8a29e']}
                borderWidth={0}
                axisBottom={{ tickRotation: 0, legend: '', tickSize: 4 }}
                axisLeft={{ tickSize: 4, tickValues: 4 }}
                labelSkipWidth={16}
                labelSkipHeight={12}
                labelTextColor="#1c1917"
                legends={[{
                  dataFrom: 'keys',
                  anchor: 'top-right',
                  direction: 'row',
                  itemWidth: 90,
                  itemHeight: 12,
                  symbolSize: 8,
                  itemTextColor: '#57534e',
                  translateY: -8,
                }]}
              />
            </div>
          )}
        </div>
      </div>

      {/* Followup list + cost trend row */}
      <div className="ov-chart-row">
        <div className="ov-chart-card">
          <h3 className="ov-chart-title">Followups (next 7 days)</h3>
          {followups.length === 0 ? (
            <div className="ov-chart-empty">No followups scheduled in the next 7 days.</div>
          ) : (
            <ul className="ov-followup-list">
              {followups.map((a) => {
                const due = new Date(a.followup!.nextAt).getTime()
                const now = Date.now()
                const tone =
                  due < now ? 'ov-fu-past' :
                  due - now <= FOLLOWUP_WARN_MS ? 'ov-fu-soon' :
                  'ov-fu-future'
                return (
                  <li key={a.id} className={`ov-fu-item ${tone}`}>
                    <span className="ov-fu-date">
                      {new Date(a.followup!.nextAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </span>
                    <span className="ov-fu-text">
                      <strong>{a.role}</strong> @ {a.company} — {a.followup!.reason}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="ov-chart-card">
          <h3 className="ov-chart-title">Cost trend (last 14 days)</h3>
          <div className="ov-chart-container" style={{ height: 240 }}>
            <ResponsiveLine
              data={lineData}
              margin={{ top: 16, right: 16, bottom: 40, left: 40 }}
              xScale={{ type: 'point' }}
              yScale={{ type: 'linear', min: 0, max: 'auto' }}
              colors={['#0969da']}
              enablePoints
              pointSize={6}
              pointBorderWidth={2}
              pointBorderColor={{ from: 'serieColor' }}
              pointColor={{ theme: 'background' }}
              useMesh
              axisBottom={{
                tickRotation: -45,
                tickSize: 4,
                tickValues: lineData[0].data.filter((_, i) => i % 2 === 0).map((d) => d.x),
              }}
              axisLeft={{ tickSize: 4, format: (v) => `$${v}` }}
              gridYValues={4}
              enableArea
              areaOpacity={0.08}
              curve="monotoneX"
            />
          </div>
        </div>
      </div>

      {/* Quick links */}
      <div className="ov-quicklinks">
        <Link to="/career/pipeline" className="ov-quicklink">→ Pipeline</Link>
        <Link to="/career/shortlist" className="ov-quicklink">
          → Shortlist ({shortlist?.total ?? 0})
        </Link>
        <Link to="/career/applied" className="ov-quicklink">
          → Applied ({stats.appliedTabCount})
        </Link>
      </div>

      {error && applications && (
        <div className="ov-stale">
          <AlertTriangle size={12} /> Last refresh failed: {error} — showing cached data
        </div>
      )}
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  hint,
  variant = '',
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint: string
  variant?: string
}) {
  return (
    <div className={`ov-stat-card ${variant}`}>
      <div className="ov-stat-head">
        <span className="ov-stat-icon">{icon}</span>
        <span className="ov-stat-label">{label}</span>
      </div>
      <div className="ov-stat-value">{value}</div>
      <div className="ov-stat-hint">{hint}</div>
    </div>
  )
}
