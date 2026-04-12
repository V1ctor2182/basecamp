import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Plus, Trash2, Settings, RefreshCw, ExternalLink,
  Activity, GitBranch, GitPullRequest, Clock, X, AlertCircle, ArrowLeft,
  CalendarDays, CalendarRange, Calendar, ChevronLeft, ChevronRight, BarChart3,
  MessageSquare, Wrench, Zap
} from 'lucide-react'
import { Link } from 'react-router-dom'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent, TitleComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import './tracker.css'

echarts.use([BarChart, LineChart, PieChart, ScatterChart, GridComponent, TooltipComponent, LegendComponent, TitleComponent, CanvasRenderer])

// Types
interface Repo {
  id: string
  url: string
  owner: string
  repo: string
  addedAt: string
}

interface Config {
  githubUsername: string
  hasToken: boolean
}

interface Commit {
  sha: string
  message: string
  author: string
  date: string
  url: string
  branch: string
}

interface RepoActivity {
  repo: string
  repoUrl: string
  branches: string[]
  commits: Commit[]
}

interface PR {
  number: number
  title: string
  state: string
  merged: boolean
  author: string
  branch: string
  baseBranch: string
  createdAt: string
  updatedAt: string
  mergedAt: string | null
  closedAt: string | null
  url: string
}

interface RepoPRs {
  repo: string
  repoUrl: string
  prs: PR[]
}

interface ClaudeStats {
  lastComputedDate: string
  dailyActivity: { date: string; messageCount: number; sessionCount: number; toolCallCount: number }[]
  dailyModelTokens: { date: string; tokensByModel: Record<string, number> }[]
  dailyCost?: { date: string; costByModel: Record<string, number> }[]
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>
  totalSessions: number
  totalMessages: number
  hourCounts: Record<string, number>
  firstSessionDate: string
}

interface ClaudePing {
  ts: string
  session: string
  project: string
}

// Claude logo icon
function ClaudeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#D97757" fillRule="nonzero" style={{ flexShrink: 0 }}>
      <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
    </svg>
  )
}

type DateRange = 'week' | 'month' | 'custom'
type ViewTab = 'commits' | 'prs' | 'claude'

// Claude model pricing ($ per million tokens)
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-4-6':            { input: 15,   output: 75,  cacheRead: 1.875,  cacheWrite: 18.75 },
  'claude-opus-4-5-20251101':   { input: 15,   output: 75,  cacheRead: 1.875,  cacheWrite: 18.75 },
  'claude-sonnet-4-6':          { input: 3,    output: 15,  cacheRead: 0.375,  cacheWrite: 3.75 },
  'claude-sonnet-4-5-20250929': { input: 3,    output: 15,  cacheRead: 0.375,  cacheWrite: 3.75 },
  'claude-haiku-4-5-20251001':  { input: 0.80, output: 4,   cacheRead: 0.08,   cacheWrite: 1.0 },
}

function calcModelCost(model: string, usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }) {
  const p = MODEL_PRICING[model]
  if (!p) return 0
  return (usage.inputTokens * p.input + usage.outputTokens * p.output + usage.cacheReadInputTokens * p.cacheRead + usage.cacheCreationInputTokens * p.cacheWrite) / 1_000_000
}

function formatUSD(v: number) {
  return v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`
}

// Project color palette for activity timeline
const PROJECT_COLORS = [
  '#D97757', '#5B8DEF', '#43B581', '#E8A87C', '#A78BFA',
  '#F59E42', '#38BDF8', '#FB7185', '#34D399', '#C084FC',
  '#FBBF24', '#6EE7B7', '#F472B6', '#93C5FD', '#FCA5A5',
]
function getProjectColor(project: string, allProjects: string[]): string {
  const idx = allProjects.indexOf(project)
  return PROJECT_COLORS[idx >= 0 ? idx % PROJECT_COLORS.length : 0]
}

// Helpers
function toDateKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function getDateRange(range: DateRange, customDate?: Date) {
  const now = new Date()
  let since: Date
  let until: Date = now
  switch (range) {
    case 'week':
      since = new Date(now)
      since.setDate(since.getDate() - 7)
      break
    case 'month':
      since = new Date(now)
      since.setMonth(since.getMonth() - 1)
      break
    case 'custom':
      if (customDate) {
        since = new Date(customDate.getFullYear(), customDate.getMonth(), customDate.getDate())
        until = new Date(since)
        until.setDate(until.getDate() + 1)
      } else {
        since = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      }
      break
  }
  return { since: since.toISOString(), until: until.toISOString() }
}

function formatTime(d: string) {
  return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function formatDateTime(d: string, showDate: boolean) {
  return showDate ? `${formatDate(d)} ${formatTime(d)}` : formatTime(d)
}

// Mini calendar component
function MiniCalendar({ selectedDate, onSelect, commitsByDate }: {
  selectedDate: Date | null
  onSelect: (d: Date) => void
  commitsByDate: Map<string, number>
}) {
  const [viewMonth, setViewMonth] = useState(() => {
    const d = selectedDate || new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })

  const weeks = useMemo(() => {
    const year = viewMonth.getFullYear()
    const month = viewMonth.getMonth()
    const firstDay = new Date(year, month, 1).getDay()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const rows: (Date | null)[][] = []
    let week: (Date | null)[] = new Array(firstDay).fill(null)
    for (let d = 1; d <= daysInMonth; d++) {
      week.push(new Date(year, month, d))
      if (week.length === 7) { rows.push(week); week = [] }
    }
    if (week.length > 0) {
      while (week.length < 7) week.push(null)
      rows.push(week)
    }
    return rows
  }, [viewMonth])

  const todayKey = toDateKey(new Date())
  const selectedKey = selectedDate ? toDateKey(selectedDate) : null
  const monthLabel = viewMonth.toLocaleDateString([], { month: 'long', year: 'numeric' })

  const maxCommits = Math.max(1, ...Array.from(commitsByDate.values()))

  return (
    <div className="t-calendar">
      <div className="t-cal-header">
        <button className="t-cal-nav" onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))}>
          <ChevronLeft size={14} />
        </button>
        <span className="t-cal-month">{monthLabel}</span>
        <button className="t-cal-nav" onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))}>
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="t-cal-grid">
        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(d => (
          <div key={d} className="t-cal-dow">{d}</div>
        ))}
        {weeks.flat().map((day, i) => {
          if (!day) return <div key={`empty-${i}`} className="t-cal-day t-cal-empty" />
          const key = toDateKey(day)
          const count = commitsByDate.get(key) || 0
          const isToday = key === todayKey
          const isSelected = key === selectedKey
          const isFuture = day > new Date()
          const intensity = count > 0 ? Math.min(count / maxCommits, 1) : 0
          return (
            <button
              key={key}
              className={`t-cal-day${isToday ? ' t-cal-today' : ''}${isSelected ? ' t-cal-selected' : ''}${isFuture ? ' t-cal-future' : ''}`}
              onClick={() => !isFuture && onSelect(day)}
              disabled={isFuture}
            >
              <span className="t-cal-num">{day.getDate()}</span>
              {count > 0 && (
                <span
                  className="t-cal-dot"
                  style={{ opacity: 0.35 + intensity * 0.65 }}
                  title={`${count} commit${count > 1 ? 's' : ''}`}
                />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

type CalCommit = { sha: string; message: string; repo: string; date: Date; url: string; minutes: number }

function DayTimeline({
  date, commits, onPrev, onNext, onToday,
}: {
  date: Date
  commits: CalCommit[]
  onPrev: () => void
  onNext: () => void
  onToday: () => void
}) {
  // Hour range — pad ±1 around commit hours, default 7-22
  let startHour = 7
  let endHour = 22
  if (commits.length > 0) {
    const hours = commits.map(c => Math.floor(c.minutes / 60))
    startHour = Math.max(0, Math.min(...hours) - 1)
    endHour = Math.min(23, Math.max(...hours) + 1)
  }
  const hours = Array.from({ length: endHour - startHour + 1 }, (_, i) => startHour + i)
  const HOUR_HEIGHT = 56
  const totalHeight = hours.length * HOUR_HEIGHT

  const now = new Date()
  const isToday = toDateKey(date) === toDateKey(now)
  const nowMinutesIntoRange = (now.getHours() - startHour) * 60 + now.getMinutes()
  const nowTop = (nowMinutesIntoRange / 60) * HOUR_HEIGHT
  const showNow = isToday && nowMinutesIntoRange >= 0 && nowMinutesIntoRange <= hours.length * 60

  // Sort commits by time and assign lanes to avoid overlap
  const sorted = [...commits].sort((a, b) => a.minutes - b.minutes)
  type Placed = CalCommit & { lane: number; top: number }
  const placed: Placed[] = []
  const laneEnds: number[] = [] // last commit's "end" minutes per lane (we treat each commit as 30min slot)
  for (const c of sorted) {
    let lane = laneEnds.findIndex(end => end <= c.minutes)
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(0) }
    laneEnds[lane] = c.minutes + 30
    const minutesIntoRange = c.minutes - startHour * 60
    placed.push({ ...c, lane, top: (minutesIntoRange / 60) * HOUR_HEIGHT })
  }
  const numLanes = Math.max(1, laneEnds.length)

  const dateLabel = date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <div className="t-day-timeline">
      <div className="t-day-timeline-header">
        <button className="t-day-nav-btn" onClick={onPrev} title="Previous day"><ChevronLeft size={16} /></button>
        <button className={`t-day-nav-today ${isToday ? 'is-today' : ''}`} onClick={onToday}>{isToday ? 'Today' : dateLabel}</button>
        <button className="t-day-nav-btn" onClick={onNext} title="Next day" disabled={isToday}><ChevronRight size={16} /></button>
        <span className="t-day-commit-count">{commits.length} commit{commits.length === 1 ? '' : 's'}</span>
      </div>
      <div className="t-day-timeline-body" style={{ height: totalHeight }}>
        {/* Hour grid */}
        <div className="t-day-hours">
          {hours.map(h => (
            <div key={h} className="t-day-hour-row" style={{ height: HOUR_HEIGHT }}>
              <span className="t-day-hour-label">{String(h).padStart(2, '0')}:00</span>
            </div>
          ))}
        </div>
        {/* Track column (where dots sit) */}
        <div className="t-day-track">
          {placed.map(c => (
            <div
              key={c.sha}
              className="t-day-dot"
              style={{ top: c.top - 4 }}
              title={c.date.toLocaleTimeString()}
            />
          ))}
          {showNow && (
            <div className="t-day-now-dot" style={{ top: nowTop - 5 }} />
          )}
        </div>
        {/* Cards column */}
        <div className="t-day-cards" style={{ minHeight: totalHeight }}>
          {placed.map(c => (
            <a
              key={c.sha}
              href={c.url}
              target="_blank"
              rel="noreferrer"
              className="t-day-card"
              style={{ top: c.top, left: `calc(${(c.lane / numLanes) * 100}% + 6px)`, width: `calc(${100 / numLanes}% - 12px)` }}
            >
              <div className="t-day-card-time">{String(Math.floor(c.minutes / 60)).padStart(2, '0')}:{String(c.minutes % 60).padStart(2, '0')}</div>
              <div className="t-day-card-repo">{c.repo}</div>
              <div className="t-day-card-msg">{c.message.split('\n')[0]}</div>
            </a>
          ))}
          {showNow && (
            <div className="t-day-now-line" style={{ top: nowTop }}>
              <span className="t-day-now-label">{String(now.getHours()).padStart(2, '0')}:{String(now.getMinutes()).padStart(2, '0')}</span>
            </div>
          )}
          {commits.length === 0 && (
            <div className="t-day-empty">No commits on this day</div>
          )}
        </div>
      </div>
    </div>
  )
}

function WeekCalendar({ days, byDay }: { days: Date[]; byDay: Map<string, CalCommit[]> }) {
  // Determine hour range to show: from earliest commit hour - 1 to latest + 1, clamped 0..23
  const allCommits = [...byDay.values()].flat()
  let startHour = 7
  let endHour = 22
  if (allCommits.length > 0) {
    const hours = allCommits.map(c => Math.floor(c.minutes / 60))
    startHour = Math.max(0, Math.min(...hours) - 1)
    endHour = Math.min(23, Math.max(...hours) + 1)
  }
  const hours = Array.from({ length: endHour - startHour + 1 }, (_, i) => startHour + i)
  const HOUR_HEIGHT = 36 // px per hour
  const totalHeight = hours.length * HOUR_HEIGHT

  const now = new Date()
  const todayKey = toDateKey(now)
  const nowMinutesIntoRange = (now.getHours() - startHour) * 60 + now.getMinutes()
  const nowTop = (nowMinutesIntoRange / 60) * HOUR_HEIGHT
  const showNow = nowMinutesIntoRange >= 0 && nowMinutesIntoRange <= hours.length * 60

  const dayLabel = (d: Date) => {
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
    return `${wd} ${d.getDate()}`
  }

  return (
    <div className="t-week-cal">
      <div className="t-week-cal-header">
        <div className="t-week-cal-tz">CST</div>
        {days.map((d, i) => {
          const isToday = toDateKey(d) === todayKey
          return (
            <div key={i} className={`t-week-cal-day ${isToday ? 'today' : ''}`}>
              {dayLabel(d)}
            </div>
          )
        })}
      </div>
      <div className="t-week-cal-body" style={{ height: totalHeight }}>
        <div className="t-week-cal-hours">
          {hours.map(h => (
            <div key={h} className="t-week-cal-hour-row" style={{ height: HOUR_HEIGHT }}>
              <span className="t-week-cal-hour-label">{String(h).padStart(2, '0')}:00</span>
            </div>
          ))}
        </div>
        {days.map((d, i) => {
          const key = toDateKey(d)
          const commits = byDay.get(key) || []
          const isToday = key === todayKey
          return (
            <div key={i} className={`t-week-cal-col ${isToday ? 'today' : ''}`}>
              {hours.map(h => (
                <div key={h} className="t-week-cal-cell" style={{ height: HOUR_HEIGHT }} />
              ))}
              {commits.map(c => {
                const minutesIntoRange = c.minutes - startHour * 60
                if (minutesIntoRange < 0 || minutesIntoRange > hours.length * 60) return null
                const top = (minutesIntoRange / 60) * HOUR_HEIGHT
                return (
                  <a
                    key={c.sha}
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="t-week-cal-event"
                    style={{ top }}
                    title={`${c.repo}: ${c.message}\n${c.date.toLocaleString()}`}
                  >
                    <div className="t-week-cal-event-title">{c.repo}</div>
                    <div className="t-week-cal-event-msg">{c.message}</div>
                  </a>
                )
              })}
              {isToday && showNow && (
                <div className="t-week-cal-now" style={{ top: nowTop }}>
                  <span className="t-week-cal-now-label">{String(now.getHours()).padStart(2, '0')}:{String(now.getMinutes()).padStart(2, '0')}</span>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function TrackerApp() {
  const [repos, setRepos] = useState<Repo[]>([])
  const [config, setConfig] = useState<Config>({ githubUsername: '', hasToken: false })
  const [activity, setActivity] = useState<RepoActivity[]>([])
  const [prData, setPrData] = useState<RepoPRs[]>([])
  const [fetchErrors, setFetchErrors] = useState<{ repo: string; error: string }[]>([])
  const [dateRange, setDateRange] = useState<DateRange>('week')
  const [customDate, setCustomDate] = useState<Date | null>(null)
  const [showCalendar, setShowCalendar] = useState(false)
  const [showChart, setShowChart] = useState(true)
  const [viewTab, setViewTab] = useState<ViewTab>('commits')
  const [loading, setLoading] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [repoUrl, setRepoUrl] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [settingsForm, setSettingsForm] = useState({ githubUsername: '', githubToken: '' })
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  // Full month data for chart + calendar dots
  const [monthActivity, setMonthActivity] = useState<RepoActivity[]>([])
  const [claudeStats, setClaudeStats] = useState<ClaudeStats | null>(null)
  const [claudePings, setClaudePings] = useState<ClaudePing[]>([])
  const [activityDate, setActivityDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [activityView, setActivityView] = useState<'day' | 'week' | 'month' | 'projects'>('day')
  const [showActivityCal, setShowActivityCal] = useState(false)
  const [blockTooltip, setBlockTooltip] = useState<{ text: string; x: number; y: number; trackId: string } | null>(null)
  const [dayRange, setDayRange] = useState<[number, number]>([0, 24]) // hours
  const [isDraggingTimeline, setIsDraggingTimeline] = useState(false)
  const [dragStartX, setDragStartX] = useState(0)
  const [dragStartRange, setDragStartRange] = useState<[number, number]>([0, 24])
  const [heatmapTooltip, setHeatmapTooltip] = useState<{ text: string; x: number; y: number } | null>(null)
  const [modelChartMode, setModelChartMode] = useState<'tokens' | 'cost'>('cost')
  const [weekView, setWeekView] = useState<'chart' | 'calendar'>('chart')
  const heatmapRef = useRef<HTMLDivElement>(null)
  const calendarRef = useRef<HTMLDivElement>(null)
  const activityCalRef = useRef<HTMLDivElement>(null)
  const timelineZoomRef = useRef<HTMLDivElement>(null)

  const loadClaudeStats = useCallback(async () => {
    try {
      const [statsRes, pingsRes] = await Promise.all([
        fetch('/api/claude-stats'),
        fetch('/api/claude-pings'),
      ])
      if (statsRes.ok) setClaudeStats(await statsRes.json())
      if (pingsRes.ok) setClaudePings(await pingsRes.json())
    } catch { /* silent */ }
  }, [])

  useEffect(() => {
    (async () => {
      try {
        const [reposRes, configRes] = await Promise.all([
          fetch('/api/repos'), fetch('/api/config')
        ])
        const reposData = await reposRes.json()
        const configData = await configRes.json()
        setRepos(reposData)
        setConfig(configData)
        setSettingsForm({ githubUsername: configData.githubUsername || '', githubToken: '' })
        if (!configData.githubUsername) setShowSettings(true)
        setInitialized(true)
        loadClaudeStats()
      } catch {
        setError('Failed to connect to server. Is it running?')
      }
    })()
  }, [loadClaudeStats])

  // Auto-refresh claude stats every 60s
  useEffect(() => {
    const interval = setInterval(loadClaudeStats, 60_000)
    return () => clearInterval(interval)
  }, [loadClaudeStats])

  // Load month-level data for chart/calendar (always fetches last 30 days)
  const loadMonthActivity = useCallback(async () => {
    if (repos.length === 0) { setMonthActivity([]); return }
    try {
      const now = new Date()
      const since = new Date(now)
      since.setDate(since.getDate() - 30)
      const params = new URLSearchParams({ since: since.toISOString(), until: now.toISOString() })
      if (config.githubUsername) params.set('author', config.githubUsername)
      const res = await fetch(`/api/activity?${params}`)
      if (res.ok) {
        const data = await res.json()
        setMonthActivity(data.activity || [])
      }
    } catch { /* silent */ }
  }, [repos.length, config.githubUsername])

  const loadActivity = useCallback(async () => {
    if (repos.length === 0) { setActivity([]); setPrData([]); return }
    setLoading(true)
    setError(null)
    try {
      const { since, until } = getDateRange(dateRange, customDate || undefined)
      const params = new URLSearchParams({ since, until })
      if (config.githubUsername) params.set('author', config.githubUsername)

      const [actRes, prRes] = await Promise.all([
        fetch(`/api/activity?${params}`),
        fetch(`/api/prs?${params}`),
      ])

      if (!actRes.ok) throw new Error('Failed to fetch activity')
      const actData = await actRes.json()
      setActivity(actData.activity || [])

      if (prRes.ok) {
        const prDataRes = await prRes.json()
        setPrData(prDataRes.prs || [])
        setFetchErrors([...(actData.errors || []), ...(prDataRes.errors || [])])
      } else {
        setFetchErrors(actData.errors || [])
      }

      setLastUpdated(new Date())
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [dateRange, customDate, config.githubUsername, repos.length])

  useEffect(() => {
    if (initialized) {
      loadActivity()
      loadMonthActivity()
    }
  }, [initialized, loadActivity, loadMonthActivity])

  useEffect(() => {
    if (!initialized) return
    const id = setInterval(() => { loadActivity(); loadMonthActivity() }, 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [initialized, loadActivity, loadMonthActivity])

  // Close calendar on click outside
  useEffect(() => {
    if (!showCalendar) return
    const handler = (e: MouseEvent) => {
      if (calendarRef.current && !calendarRef.current.contains(e.target as Node)) {
        setShowCalendar(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showCalendar])

  // Non-passive wheel handler for timeline zoom (via callback ref)
  const dayRangeRef = useRef(dayRange)
  dayRangeRef.current = dayRange
  const wheelHandlerRef = useRef<((e: WheelEvent) => void) | null>(null)
  if (!wheelHandlerRef.current) {
    wheelHandlerRef.current = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const el = timelineZoomRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const r = dayRangeRef.current
      const mouseRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      const mouseHour = r[0] + mouseRatio * (r[1] - r[0])
      const zoomFactor = e.deltaY > 0 ? 1.15 : 0.85
      const newSpan = Math.max(0.25, Math.min(24, (r[1] - r[0]) * zoomFactor))
      let newStart = mouseHour - mouseRatio * newSpan
      let newEnd = mouseHour + (1 - mouseRatio) * newSpan
      if (newStart < 0) { newEnd -= newStart; newStart = 0 }
      if (newEnd > 24) { newStart -= (newEnd - 24); newEnd = 24 }
      setDayRange([Math.max(0, newStart), Math.min(24, newEnd)])
    }
  }
  const timelineRefCallback = useCallback((node: HTMLDivElement | null) => {
    // Detach from old node
    if (timelineZoomRef.current && wheelHandlerRef.current) {
      timelineZoomRef.current.removeEventListener('wheel', wheelHandlerRef.current)
    }
    timelineZoomRef.current = node
    // Attach to new node
    if (node && wheelHandlerRef.current) {
      node.addEventListener('wheel', wheelHandlerRef.current, { passive: false })
    }
  }, [])

  // Close activity calendar on click outside
  useEffect(() => {
    if (!showActivityCal) return
    const handler = (e: MouseEvent) => {
      if (activityCalRef.current && !activityCalRef.current.contains(e.target as Node)) {
        setShowActivityCal(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showActivityCal])

  // Commits by date (for chart + calendar)
  const commitsByDate = useMemo(() => {
    const map = new Map<string, number>()
    for (const ra of monthActivity) {
      for (const c of ra.commits) {
        const key = toDateKey(new Date(c.date))
        map.set(key, (map.get(key) || 0) + 1)
      }
    }
    return map
  }, [monthActivity])

  // All projects seen in pings, sorted by total turns (most used first)
  const allProjects = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of claudePings) counts.set(p.project, (counts.get(p.project) || 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p)
  }, [claudePings])

  // Pings by date (for activity calendar dots) — use local date
  const pingsByDate = useMemo(() => {
    const map = new Map<string, number>()
    for (const p of claudePings) {
      const key = toDateKey(new Date(p.ts))
      map.set(key, (map.get(key) || 0) + 1)
    }
    return map
  }, [claudePings])

  // Commits by date per repo (for stacked chart)
  const chartData = useMemo(() => {
    // Chart spans: today→7d, week→7d, month→30d, custom→30d
    const numDays = (dateRange === 'today' || dateRange === 'week') ? 7 : 30
    const days: string[] = []
    const now = new Date()
    for (let i = numDays - 1; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(d.getDate() - i)
      days.push(toDateKey(d))
    }
    const dayKeys = new Set(days)

    // Use activity for short ranges (7 days), monthActivity for long (30 days)
    const source = numDays === 7 ? activity : monthActivity

    // group by repo
    const repoMap = new Map<string, Map<string, number>>()
    for (const ra of source) {
      const repoName = ra.repo.split('/')[1] || ra.repo
      for (const c of ra.commits) {
        const key = toDateKey(new Date(c.date))
        if (!dayKeys.has(key)) continue
        if (!repoMap.has(repoName)) repoMap.set(repoName, new Map())
        const m = repoMap.get(repoName)!
        m.set(key, (m.get(key) || 0) + 1)
      }
    }

    const repoNames = [...repoMap.keys()]
    const chartColors = [
      'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)',
      'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)',
    ]

    return { days, repoNames, repoMap, chartColors }
  }, [monthActivity, activity, dateRange])

  // Day timeline — commits for the selected single day
  const dayTimelineData = useMemo(() => {
    const targetKey = customDate ? toDateKey(customDate) : toDateKey(new Date())
    const commits: CalCommit[] = []
    for (const ra of activity) {
      const repoName = ra.repo.split('/')[1] || ra.repo
      for (const c of ra.commits) {
        const d = new Date(c.date)
        if (toDateKey(d) !== targetKey) continue
        commits.push({
          sha: c.sha,
          message: c.message,
          repo: repoName,
          date: d,
          url: c.url,
          minutes: d.getHours() * 60 + d.getMinutes(),
        })
      }
    }
    return commits
  }, [activity, customDate])

  // Week calendar — commits placed at their commit time on a 7-day x 24-hour grid
  const weekCalendarData = useMemo(() => {
    // Build the 7 days based on current dateRange (week = last 7 days ending today)
    const { since, until } = getDateRange('week')
    const startDay = new Date(since); startDay.setHours(0, 0, 0, 0)
    const endDay = new Date(until); endDay.setHours(0, 0, 0, 0)
    const days: Date[] = []
    const cur = new Date(startDay)
    while (cur <= endDay) {
      days.push(new Date(cur))
      cur.setDate(cur.getDate() + 1)
    }

    // Place each commit into the day it belongs to
    type CalCommit = { sha: string; message: string; repo: string; date: Date; url: string; minutes: number }
    const byDay = new Map<string, CalCommit[]>()
    for (const ra of activity) {
      const repoName = ra.repo.split('/')[1] || ra.repo
      for (const c of ra.commits) {
        const d = new Date(c.date)
        const key = toDateKey(d)
        if (!byDay.has(key)) byDay.set(key, [])
        byDay.get(key)!.push({
          sha: c.sha,
          message: c.message,
          repo: repoName,
          date: d,
          url: c.url,
          minutes: d.getHours() * 60 + d.getMinutes(),
        })
      }
    }

    return { days, byDay }
  }, [activity])

  const handleAddRepo = async () => {
    const url = repoUrl.trim()
    if (!url) return
    try {
      const res = await fetch('/api/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setRepoUrl('')
      setRepos(prev => [...prev, data])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to add repo')
    }
  }

  const handleDeleteRepo = async (owner: string, repo: string) => {
    await fetch(`/api/repos/${owner}/${repo}`, { method: 'DELETE' })
    setRepos(prev => prev.filter(r => r.id !== `${owner}/${repo}`))
  }

  const handleSaveConfig = async () => {
    try {
      const body: Record<string, string> = { githubUsername: settingsForm.githubUsername }
      if (settingsForm.githubToken) body.githubToken = settingsForm.githubToken
      await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      setConfig(prev => ({
        ...prev,
        githubUsername: settingsForm.githubUsername,
        hasToken: settingsForm.githubToken ? true : prev.hasToken
      }))
      setSettingsForm(prev => ({ ...prev, githubToken: '' }))
      setShowSettings(false)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    }
  }

  // GitHub-style contribution heatmap data
  const heatmapData = useMemo(() => {
    if (!claudeStats) return null
    // Build a map of date -> messageCount
    const byDate = new Map<string, number>()
    for (const d of claudeStats.dailyActivity) byDate.set(d.date, d.messageCount)

    // Build weeks grid: columns = weeks, rows = days (Mon..Sun)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    // Start from the earliest data point (with 1 week padding)
    const firstDate = claudeStats.firstSessionDate ? new Date(claudeStats.firstSessionDate) : new Date(today)
    firstDate.setHours(0, 0, 0, 0)
    const start = new Date(firstDate)
    start.setDate(start.getDate() - 7) // 1 week padding
    // Align to Monday
    const startDay = start.getDay()
    const mondayOffset = startDay === 0 ? -6 : 1 - startDay
    start.setDate(start.getDate() + mondayOffset)

    const weeks: { date: Date; key: string; count: number; future: boolean }[][] = []
    let week: typeof weeks[0] = []
    const cursor = new Date(start)
    while (cursor <= today || week.length > 0) {
      const key = toDateKey(cursor)
      const isFuture = cursor > today
      if (!isFuture || week.length > 0) {
        week.push({ date: new Date(cursor), key, count: byDate.get(key) || 0, future: isFuture })
      }
      if (week.length === 7) {
        weeks.push(week)
        week = []
        if (cursor > today) break
      }
      cursor.setDate(cursor.getDate() + 1)
    }
    if (week.length > 0) weeks.push(week)

    const maxCount = Math.max(1, ...claudeStats.dailyActivity.map(d => d.messageCount))

    // Month labels
    const monthLabels: { label: string; weekIdx: number }[] = []
    let lastMonth = -1
    for (let wi = 0; wi < weeks.length; wi++) {
      for (const d of weeks[wi]) {
        if (!d.future && d.date.getMonth() !== lastMonth) {
          lastMonth = d.date.getMonth()
          monthLabels.push({ label: d.date.toLocaleDateString([], { month: 'short' }), weekIdx: wi })
          break
        }
      }
    }

    const totalMessages = claudeStats.dailyActivity.reduce((s, d) => s + d.messageCount, 0)
    const firstDateStr = claudeStats.firstSessionDate
      ? new Date(claudeStats.firstSessionDate).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
      : ''

    return { weeks, maxCount, monthLabels, totalMessages, firstDateStr }
  }, [claudeStats])

  // Total cost — sum from server-computed dailyCost (includes subagents).
  // Falls back to modelUsage-based calc if dailyCost is not available.
  const totalClaudeCost = useMemo(() => {
    if (!claudeStats) return 0
    if (claudeStats.dailyCost && claudeStats.dailyCost.length > 0) {
      let total = 0
      for (const d of claudeStats.dailyCost) {
        for (const m of Object.keys(d.costByModel)) {
          if (m === '<synthetic>') continue
          total += d.costByModel[m]
        }
      }
      return total
    }
    return Object.entries(claudeStats.modelUsage)
      .filter(([m]) => m !== '<synthetic>')
      .reduce((s, [m, u]) => s + calcModelCost(m, u), 0)
  }, [claudeStats])

  const claudeModelChart = useMemo(() => {
    if (!claudeStats) return null
    const isCost = modelChartMode === 'cost'
    const tokenData = claudeStats.dailyModelTokens.slice(-30)
    const costData = claudeStats.dailyCost?.slice(-30) || []
    if (isCost && costData.length === 0) return null

    const root = document.documentElement
    const cs = getComputedStyle(root)
    const resolve = (v: string) => { const m = v.match(/var\((.+)\)/); return m ? cs.getPropertyValue(m[1]).trim() || '#888' : v }

    const modelSet = new Set<string>()
    if (isCost) {
      for (const d of costData) for (const m of Object.keys(d.costByModel)) modelSet.add(m)
    } else {
      for (const d of tokenData) for (const m of Object.keys(d.tokensByModel)) modelSet.add(m)
    }
    const models = [...modelSet].filter(m => m !== '<synthetic>')

    const modelColors: Record<string, string> = {
      'claude-opus-4-6': '#D97757',
      'claude-opus-4-5-20251101': '#C65D33',
      'claude-sonnet-4-6': '#E8A87C',
      'claude-sonnet-4-5-20250929': '#B8856C',
      'claude-haiku-4-5-20251001': '#F0C4A8',
    }
    const shortName = (m: string) => {
      if (m.includes('opus-4-6')) return 'Opus 4.6'
      if (m.includes('opus-4-5')) return 'Opus 4.5'
      if (m.includes('sonnet-4-6')) return 'Sonnet 4.6'
      if (m.includes('sonnet-4-5')) return 'Sonnet 4.5'
      if (m.includes('haiku')) return 'Haiku 4.5'
      return m
    }

    const last30 = isCost ? costData : tokenData
    const dates = last30.map(d => { const dt = new Date(d.date + 'T00:00:00'); return dt.toLocaleDateString([], { month: 'short', day: 'numeric' }) })

    return {
      grid: { left: 56, right: 12, top: 30, bottom: 28 },
      tooltip: {
        trigger: 'axis' as const,
        backgroundColor: resolve('var(--bg-card)'),
        borderColor: resolve('var(--border)'),
        textStyle: { color: resolve('var(--text-primary)'), fontSize: 12 },
        valueFormatter: isCost
          ? (v: number) => `$${v.toFixed(2)}`
          : (v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v),
      },
      legend: {
        top: 0, right: 0,
        textStyle: { color: resolve('var(--text-muted)'), fontSize: 11 },
        itemWidth: 10, itemHeight: 10,
      },
      xAxis: {
        type: 'category' as const,
        data: dates,
        axisLabel: { color: resolve('var(--text-muted)'), fontSize: 10, interval: (_i: number) => _i % Math.ceil(last30.length / 8) === 0 },
        axisLine: { lineStyle: { color: resolve('var(--border-light)') } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value' as const,
        axisLabel: {
          color: resolve('var(--text-muted)'), fontSize: 10,
          formatter: isCost
            ? (v: number) => `$${v.toFixed(0)}`
            : (v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v),
        },
        splitLine: { lineStyle: { color: resolve('var(--border-light)'), type: 'dashed' as const } },
      },
      series: models.map((m, i) => ({
        name: shortName(m),
        type: 'bar' as const,
        stack: 'model',
        barWidth: '60%',
        itemStyle: {
          color: modelColors[m] || resolve(`var(--chart-${(i % 6) + 1})`),
          borderRadius: i === models.length - 1 ? [2, 2, 0, 0] : [0, 0, 0, 0],
        },
        data: isCost
          ? costData.map(d => Math.round((d.costByModel[m] || 0) * 100) / 100)
          : tokenData.map(d => d.tokensByModel[m] || 0),
      })),
    }
  }, [claudeStats, modelChartMode])

  const claudeHourChart = useMemo(() => {
    if (!claudeStats) return null
    const root = document.documentElement
    const cs = getComputedStyle(root)
    const resolve = (v: string) => { const m = v.match(/var\((.+)\)/); return m ? cs.getPropertyValue(m[1]).trim() || '#888' : v }

    const hours = Array.from({ length: 24 }, (_, i) => i)
    const data = hours.map(h => claudeStats.hourCounts[String(h)] || 0)
    const maxVal = Math.max(...data)

    return {
      grid: { left: 36, right: 12, top: 14, bottom: 28 },
      tooltip: {
        trigger: 'axis' as const,
        backgroundColor: resolve('var(--bg-card)'),
        borderColor: resolve('var(--border)'),
        textStyle: { color: resolve('var(--text-primary)'), fontSize: 12 },
        formatter: (params: Array<{ dataIndex: number; value: number }>) => {
          const p = params[0]
          const h = p.dataIndex
          return `${h}:00 — ${h}:59<br/><b>${p.value}</b> sessions`
        },
      },
      xAxis: {
        type: 'category' as const,
        data: hours.map(h => `${h}`),
        axisLabel: { color: resolve('var(--text-muted)'), fontSize: 10, interval: 2 },
        axisLine: { lineStyle: { color: resolve('var(--border-light)') } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value' as const,
        minInterval: 1,
        axisLabel: { color: resolve('var(--text-muted)'), fontSize: 10 },
        splitLine: { lineStyle: { color: resolve('var(--border-light)'), type: 'dashed' as const } },
      },
      series: [{
        type: 'bar' as const,
        barWidth: '65%',
        data: data.map(v => ({
          value: v,
          itemStyle: {
            color: '#D97757',
            opacity: 0.3 + (v / maxVal) * 0.7,
            borderRadius: [2, 2, 0, 0],
          },
        })),
      }],
    }
  }, [claudeStats])

  // Build continuous activity blocks — each slice runs from one ping to the next,
  // colored by project. Only gaps > 30min create visual breaks.
  const GAP_MS = 30 * 60 * 1000
  const buildBlocks = useCallback((pings: ClaudePing[]) => {
    if (!pings.length) return []
    const sorted = [...pings].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())

    const blocks: { start: Date; end: Date; project: string; turns: number }[] = []
    let blockStart = new Date(sorted[0].ts)
    let blockProject = sorted[0].project
    let blockTurns = 1

    for (let i = 1; i < sorted.length; i++) {
      const prevTime = new Date(sorted[i - 1].ts).getTime()
      const currTime = new Date(sorted[i].ts).getTime()
      const gap = currTime - prevTime
      const currProject = sorted[i].project

      if (gap > GAP_MS) {
        // Big gap — close current block, start new one
        blocks.push({ start: blockStart, end: new Date(prevTime), project: blockProject, turns: blockTurns })
        blockStart = new Date(currTime)
        blockProject = currProject
        blockTurns = 1
      } else if (currProject !== blockProject) {
        // Project changed — close current block at this ping's time, start new with same time (no gap)
        blocks.push({ start: blockStart, end: new Date(currTime), project: blockProject, turns: blockTurns })
        blockStart = new Date(currTime)
        blockProject = currProject
        blockTurns = 1
      } else {
        blockTurns++
      }
    }
    // Close last block
    blocks.push({ start: blockStart, end: new Date(sorted[sorted.length - 1].ts), project: blockProject, turns: blockTurns })

    return blocks
  }, [])

  // Filter pings by local date (not UTC)
  const filterPingsByDate = useCallback((pings: ClaudePing[], dateKey: string) => {
    return pings.filter(p => toDateKey(new Date(p.ts)) === dateKey)
  }, [])

  // Activity timeline from pings — shows active sessions as time blocks
  const activityTimeline = useMemo(() => {
    if (!claudePings.length) return null
    const dayPings = filterPingsByDate(claudePings, activityDate)
    if (!dayPings.length) return null

    const blocks = buildBlocks(dayPings)
    const totalMinutes = blocks.reduce((s, b) => s + Math.max(1, (b.end.getTime() - b.start.getTime()) / 60000), 0)
    const sessionCount = new Set(dayPings.map(p => p.session)).size

    return { blocks, totalMinutes, totalTurns: dayPings.length, sessionCount }
  }, [claudePings, activityDate, buildBlocks, filterPingsByDate])

  // Week view: 7 days of activity tracks
  const activityWeek = useMemo(() => {
    if (!claudePings.length) return null
    const baseDate = new Date(activityDate + 'T00:00:00')
    const dayOfWeek = baseDate.getDay()
    const monday = new Date(baseDate)
    monday.setDate(monday.getDate() - ((dayOfWeek + 6) % 7))

    const days: { date: string; label: string; blocks: { start: Date; end: Date; project: string; turns: number }[]; totalMinutes: number; turns: number }[] = []

    for (let i = 0; i < 7; i++) {
      const d = new Date(monday)
      d.setDate(d.getDate() + i)
      const key = toDateKey(d)
      const dayPings = filterPingsByDate(claudePings, key)
      const blocks = buildBlocks(dayPings)
      const totalMinutes = blocks.reduce((s, b) => s + Math.max(1, (b.end.getTime() - b.start.getTime()) / 60000), 0)
      days.push({ date: key, label: d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }), blocks, totalMinutes, turns: dayPings.length })
    }

    const weekTotal = days.reduce((s, d) => s + d.totalMinutes, 0)
    return { days, weekTotal }
  }, [claudePings, activityDate, buildBlocks, filterPingsByDate])

  // Month view: daily hours line chart
  const activityMonthChart = useMemo(() => {
    if (!claudePings.length) return null
    const root = document.documentElement
    const cs = getComputedStyle(root)
    const resolve = (v: string) => { const m = v.match(/var\((.+)\)/); return m ? cs.getPropertyValue(m[1]).trim() || '#888' : v }

    const baseDate = new Date(activityDate + 'T00:00:00')
    const year = baseDate.getFullYear()
    const month = baseDate.getMonth()
    const daysInMonth = new Date(year, month + 1, 0).getDate()

    const dailyHours: { date: string; label: string; hours: number; turns: number }[] = []
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month, d)
      const key = toDateKey(date)
      const dayPings = filterPingsByDate(claudePings, key)
      const blocks = buildBlocks(dayPings)
      const minutes = blocks.reduce((s, b) => s + Math.max(1, (b.end.getTime() - b.start.getTime()) / 60000), 0)
      dailyHours.push({ date: key, label: `${d}`, hours: minutes / 60, turns: dayPings.length })
    }

    const totalHours = dailyHours.reduce((s, d) => s + d.hours, 0)
    const activeDays = dailyHours.filter(d => d.turns > 0).length

    return {
      totalHours,
      activeDays,
      monthLabel: baseDate.toLocaleDateString([], { month: 'long', year: 'numeric' }),
      chart: {
        grid: { left: 42, right: 12, top: 14, bottom: 28 },
        tooltip: {
          trigger: 'axis' as const,
          backgroundColor: resolve('var(--bg-card)'),
          borderColor: resolve('var(--border)'),
          textStyle: { color: resolve('var(--text-primary)'), fontSize: 12 },
          formatter: (params: Array<{ dataIndex: number; value: number }>) => {
            const p = params[0]
            const d = dailyHours[p.dataIndex]
            return `${d.date}<br/><b>${d.hours.toFixed(1)}h</b> · ${d.turns} turns`
          },
        },
        xAxis: {
          type: 'category' as const,
          data: dailyHours.map(d => d.label),
          axisLabel: { color: resolve('var(--text-muted)'), fontSize: 10, interval: 2 },
          axisLine: { lineStyle: { color: resolve('var(--border-light)') } },
          axisTick: { show: false },
        },
        yAxis: {
          type: 'value' as const,
          axisLabel: { color: resolve('var(--text-muted)'), fontSize: 10, formatter: (v: number) => `${v}h` },
          splitLine: { lineStyle: { color: resolve('var(--border-light)'), type: 'dashed' as const } },
        },
        series: [{
          type: 'line' as const,
          smooth: true,
          symbol: 'circle',
          symbolSize: 5,
          lineStyle: { color: '#D97757', width: 2 },
          itemStyle: { color: '#D97757' },
          areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(217, 119, 87, 0.3)' },
            { offset: 1, color: 'rgba(217, 119, 87, 0.02)' },
          ])},
          data: dailyHours.map(d => d.hours),
        }],
      },
    }
  }, [claudePings, activityDate, buildBlocks, filterPingsByDate])

  // Project stats: bar chart of hours per project
  const activityProjectChart = useMemo(() => {
    if (!claudePings.length) return null
    const root = document.documentElement
    const cs = getComputedStyle(root)
    const resolve = (v: string) => { const m = v.match(/var\((.+)\)/); return m ? cs.getPropertyValue(m[1]).trim() || '#888' : v }

    // Group pings by project, compute time with gap detection
    const projectPings = new Map<string, ClaudePing[]>()
    const projectTurns = new Map<string, number>()
    for (const p of claudePings) {
      if (!projectPings.has(p.project)) projectPings.set(p.project, [])
      projectPings.get(p.project)!.push(p)
      projectTurns.set(p.project, (projectTurns.get(p.project) || 0) + 1)
    }

    const projectMinutes = new Map<string, number>()
    for (const [project, pings] of projectPings) {
      const blocks = buildBlocks(pings)
      const totalMin = blocks.reduce((s, b) => s + Math.max(1, (b.end.getTime() - b.start.getTime()) / 60000), 0)
      projectMinutes.set(project, totalMin)
    }

    const sorted = [...projectMinutes.entries()].sort((a, b) => b[1] - a[1])
    if (!sorted.length) return null

    const projects = sorted.map(([p]) => p)
    const hours = sorted.map(([, m]) => +(m / 60).toFixed(1))

    return {
      chart: {
        grid: { left: 120, right: 24, top: 14, bottom: 28 },
        tooltip: {
          trigger: 'axis' as const,
          backgroundColor: resolve('var(--bg-card)'),
          borderColor: resolve('var(--border)'),
          textStyle: { color: resolve('var(--text-primary)'), fontSize: 12 },
          formatter: (params: Array<{ dataIndex: number; value: number }>) => {
            const p = params[0]
            const proj = projects[p.dataIndex]
            return `<b>${proj}</b><br/>${p.value}h · ${projectTurns.get(proj) || 0} turns`
          },
        },
        xAxis: {
          type: 'value' as const,
          axisLabel: { color: resolve('var(--text-muted)'), fontSize: 10, formatter: (v: number) => `${v}h` },
          splitLine: { lineStyle: { color: resolve('var(--border-light)'), type: 'dashed' as const } },
        },
        yAxis: {
          type: 'category' as const,
          data: projects,
          axisLabel: { color: resolve('var(--text-muted)'), fontSize: 10, width: 100, overflow: 'truncate' as const },
          axisLine: { lineStyle: { color: resolve('var(--border-light)') } },
          axisTick: { show: false },
        },
        series: [{
          type: 'bar' as const,
          barWidth: '60%',
          itemStyle: { borderRadius: [0, 3, 3, 0] },
          data: hours.map((v, i) => ({ value: v, itemStyle: { color: getProjectColor(projects[i], allProjects) } })),
        }],
      },
    }
  }, [claudePings, buildBlocks])

  const activeRepos = activity.filter(a => a.commits.length > 0)
  const totalCommits = activity.reduce((sum, a) => sum + a.commits.length, 0)
  const totalPRs = prData.reduce((sum, r) => sum + r.prs.length, 0)
  const activePRRepos = prData.filter(r => r.prs.length > 0)
  const showDate = dateRange !== 'custom'

  const handleCalendarSelect = (d: Date) => {
    setCustomDate(d)
    setDateRange('custom')
    setShowCalendar(false)
  }

  const customDateLabel = customDate
    ? (toDateKey(customDate) === toDateKey(new Date()) ? 'Today' : customDate.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }))
    : 'Today'

  // ECharts option for workload chart
  const chartOption = useMemo(() => {
    const { days, repoNames, repoMap, chartColors } = chartData
    const xLabels = days.map(d => {
      const dt = new Date(d + 'T00:00:00')
      return dt.toLocaleDateString([], { month: 'short', day: 'numeric' })
    })

    // Resolve CSS variables from computed style
    const root = document.documentElement
    const cs = getComputedStyle(root)
    const resolveColor = (v: string) => {
      const m = v.match(/var\((.+)\)/)
      return m ? cs.getPropertyValue(m[1]).trim() || '#888' : v
    }

    const series = repoNames.map((name, i) => ({
      name,
      type: 'bar' as const,
      stack: 'total',
      barWidth: '60%',
      itemStyle: {
        color: resolveColor(chartColors[i % chartColors.length]),
        borderRadius: i === repoNames.length - 1 ? [2, 2, 0, 0] : [0, 0, 0, 0],
      },
      data: days.map(d => repoMap.get(name)?.get(d) || 0),
    }))

    return {
      grid: { left: 36, right: 12, top: 30, bottom: 28 },
      tooltip: {
        trigger: 'axis' as const,
        backgroundColor: resolveColor('var(--bg-card)'),
        borderColor: resolveColor('var(--border)'),
        textStyle: {
          color: resolveColor('var(--text-primary)'),
          fontSize: 12,
        },
      },
      legend: {
        show: repoNames.length > 1,
        top: 0,
        right: 0,
        textStyle: {
          color: resolveColor('var(--text-muted)'),
          fontSize: 11,
        },
        itemWidth: 10,
        itemHeight: 10,
      },
      xAxis: {
        type: 'category' as const,
        data: xLabels,
        axisLabel: {
          color: resolveColor('var(--text-muted)'),
          fontSize: 10,
          interval: (index: number) => {
            if (days.length <= 7) return true
            return index % Math.ceil(days.length / 8) === 0
          },
        },
        axisLine: { lineStyle: { color: resolveColor('var(--border-light)') } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value' as const,
        minInterval: 1,
        axisLabel: { color: resolveColor('var(--text-muted)'), fontSize: 10 },
        splitLine: { lineStyle: { color: resolveColor('var(--border-light)'), type: 'dashed' as const } },
      },
      series,
    }
  }, [chartData])

  return (
    <div className="tracker">
      {/* Header */}
      <header className="t-header">
        <div className="t-header-left">
          <Link to="/" className="t-back">
            <ArrowLeft size={16} />
          </Link>
          <Activity size={20} strokeWidth={2} />
          <h1>Work Tracker</h1>
        </div>
        <div className="t-header-right">
          {lastUpdated && (
            <span className="t-updated">Updated {formatTime(lastUpdated.toISOString())}</span>
          )}
          {config.githubUsername && (
            <span className="t-username">@{config.githubUsername}</span>
          )}
          <button
            className={`t-icon-btn ${showSettings ? 'active' : ''}`}
            onClick={() => setShowSettings(!showSettings)}
          >
            <Settings size={15} />
          </button>
        </div>
      </header>

      {/* Settings */}
      {showSettings && (
        <div className="t-settings">
          <div className="t-settings-head">
            <span>Settings</span>
            <button className="t-icon-btn-sm" onClick={() => setShowSettings(false)}>
              <X size={14} />
            </button>
          </div>
          <div className="t-settings-body">
            <div className="t-field">
              <label>GitHub Username</label>
              <input
                type="text"
                value={settingsForm.githubUsername}
                onChange={e => setSettingsForm(f => ({ ...f, githubUsername: e.target.value }))}
                placeholder="your-username"
              />
              <span className="t-hint">Filter commits to show only your activity</span>
            </div>
            <div className="t-field">
              <label>GitHub Token</label>
              <input
                type="password"
                value={settingsForm.githubToken}
                onChange={e => setSettingsForm(f => ({ ...f, githubToken: e.target.value }))}
                placeholder={config.hasToken ? 'Token set — enter to replace' : 'ghp_xxxx (for private repos)'}
              />
              <span className="t-hint">
                {config.hasToken ? 'Token configured' : 'Optional — increases rate limit to 5000/hr'}
              </span>
            </div>
            <button className="t-btn t-btn-accent" onClick={handleSaveConfig}>Save</button>
          </div>
        </div>
      )}

      {/* Add Repo */}
      <div className="t-add-bar">
        <input
          type="text"
          value={repoUrl}
          onChange={e => setRepoUrl(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAddRepo()}
          placeholder="https://github.com/owner/repo"
        />
        <button className="t-btn t-btn-accent" onClick={handleAddRepo}>
          <Plus size={15} /> Add
        </button>
      </div>

      {/* Controls */}
      <div className="t-controls">
        <div className="t-date-picker">
          <div className="t-cal-wrapper" ref={calendarRef}>
            <button
              className={`t-date-tab ${dateRange === 'custom' ? 'active' : ''}`}
              onClick={() => {
                if (dateRange !== 'custom') {
                  const today = new Date()
                  today.setHours(0, 0, 0, 0)
                  setCustomDate(today)
                  setDateRange('custom')
                } else {
                  setShowCalendar(!showCalendar)
                }
              }}
            >
              <Calendar size={14} />
              <span>{dateRange === 'custom' ? customDateLabel : 'Today'}</span>
            </button>
            {showCalendar && (
              <MiniCalendar
                selectedDate={customDate}
                onSelect={handleCalendarSelect}
                commitsByDate={commitsByDate}
              />
            )}
          </div>
          <button
            className={`t-date-tab ${dateRange === 'week' ? 'active' : ''}`}
            onClick={() => { setDateRange('week'); setCustomDate(null) }}
          >
            <CalendarDays size={14} />
            <span>This Week</span>
          </button>
          <button
            className={`t-date-tab ${dateRange === 'month' ? 'active' : ''}`}
            onClick={() => { setDateRange('month'); setCustomDate(null) }}
          >
            <CalendarRange size={14} />
            <span>This Month</span>
          </button>
        </div>
        <div className="t-controls-right">
          <button
            className={`t-icon-btn ${showChart ? 'active' : ''}`}
            onClick={() => setShowChart(!showChart)}
            title="Toggle chart"
          >
            <BarChart3 size={15} />
          </button>
          <button className="t-icon-btn" onClick={loadActivity} disabled={loading} title="Refresh">
            <RefreshCw size={15} className={loading ? 't-spinning' : ''} />
          </button>
        </div>
      </div>

      {/* Workload Chart */}
      {showChart && repos.length > 0 && (
        <div className="t-chart-card">
          {dateRange !== 'custom' && (
            <div className="t-chart-header">
              <BarChart3 size={14} />
              <span>Workload — {dateRange === 'week' && weekView === 'calendar' ? 'This Week' : dateRange === 'week' ? 'Last 7 Days' : 'Last 30 Days'}</span>
              {dateRange === 'week' && (
                <div className="t-chart-toggle">
                  {(['chart', 'calendar'] as const).map(v => (
                    <button key={v} className={`t-chart-toggle-btn ${weekView === v ? 'active' : ''}`} onClick={() => setWeekView(v)}>
                      {v === 'chart' ? 'Chart' : 'Calendar'}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {dateRange === 'custom' && customDate ? (
            <DayTimeline
              date={customDate}
              commits={dayTimelineData}
              onPrev={() => {
                const d = new Date(customDate); d.setDate(d.getDate() - 1); setCustomDate(d)
              }}
              onNext={() => {
                const d = new Date(customDate); d.setDate(d.getDate() + 1)
                const today = new Date(); today.setHours(0, 0, 0, 0)
                if (d <= today) setCustomDate(d)
              }}
              onToday={() => {
                const today = new Date(); today.setHours(0, 0, 0, 0); setCustomDate(today)
              }}
            />
          ) : dateRange === 'week' && weekView === 'calendar' ? (
            <WeekCalendar days={weekCalendarData.days} byDay={weekCalendarData.byDay} />
          ) : (
            <ReactEChartsCore
              echarts={echarts}
              option={chartOption}
              style={{ height: 200 }}
              notMerge
            />
          )}
        </div>
      )}

      {/* View Tabs: Commits / PRs */}
      <div className="t-view-tabs">
        <button
          className={`t-view-tab ${viewTab === 'commits' ? 'active' : ''}`}
          onClick={() => setViewTab('commits')}
        >
          <GitBranch size={14} />
          Commits
          <span className="t-view-count">{totalCommits}</span>
        </button>
        <button
          className={`t-view-tab ${viewTab === 'prs' ? 'active' : ''}`}
          onClick={() => setViewTab('prs')}
        >
          <GitPullRequest size={14} />
          Pull Requests
          <span className="t-view-count">{totalPRs}</span>
        </button>
        <button
          className={`t-view-tab ${viewTab === 'claude' ? 'active' : ''}`}
          onClick={() => setViewTab('claude')}
        >
          <ClaudeIcon size={14} />
          Claude Usage
        </button>
      </div>

      {/* Stats */}
      {viewTab !== 'claude' && <div className="t-stats">
        <div className="t-stat">
          <div className="t-stat-val">{viewTab === 'commits' ? activeRepos.length : activePRRepos.length}</div>
          <div className="t-stat-label">Active Repos</div>
        </div>
        <div className="t-stat">
          <div className="t-stat-val">{viewTab === 'commits' ? totalCommits : totalPRs}</div>
          <div className="t-stat-label">{viewTab === 'commits' ? 'Commits' : 'PRs'}</div>
        </div>
        <div className="t-stat">
          <div className="t-stat-val">{repos.length}</div>
          <div className="t-stat-label">Tracked</div>
        </div>
      </div>}

      {/* Errors */}
      {error && (
        <div className="t-error">
          <AlertCircle size={14} />
          <span>{error}</span>
          <button className="t-dismiss" onClick={() => setError(null)}><X size={14} /></button>
        </div>
      )}
      {fetchErrors.length > 0 && (
        <div className="t-warning">
          <AlertCircle size={14} />
          <span>Failed: {fetchErrors.map(e => e.repo).join(', ')}</span>
        </div>
      )}

      {/* Commits View */}
      {viewTab === 'commits' && (
        <div className="t-feed">
          {loading && activity.length === 0 ? (
            <div className="t-empty">
              <RefreshCw size={28} className="t-spinning" />
              <p>Loading activity...</p>
            </div>
          ) : repos.length === 0 ? (
            <div className="t-empty">
              <GitBranch size={36} strokeWidth={1.5} />
              <p>Add a GitHub repo to start tracking</p>
              <span className="t-empty-hint">Paste a repo URL above and click Add</span>
            </div>
          ) : activeRepos.length === 0 && !loading ? (
            <div className="t-empty">
              <Clock size={36} strokeWidth={1.5} />
              <p>No commits {dateRange === 'custom' ? 'on this date' : dateRange === 'week' ? 'this week' : 'this month'}</p>
              <span className="t-empty-hint">Try a different time range</span>
            </div>
          ) : (
            activeRepos
              .sort((a, b) => (b.commits[0]?.date || '').localeCompare(a.commits[0]?.date || ''))
              .map(ra => (
                <div key={ra.repo} className="t-repo">
                  <div className="t-repo-head">
                    <div className="t-repo-name">
                      <GitBranch size={15} />
                      <span>{ra.repo.split('/')[1]}</span>
                      <span className="t-owner">{ra.repo.split('/')[0]}</span>
                      <span className="t-badge">{ra.commits.length}</span>
                    </div>
                    <a href={ra.repoUrl} target="_blank" rel="noopener noreferrer" className="t-ext-link">
                      <ExternalLink size={13} />
                    </a>
                  </div>
                  <div className="t-commits">
                    {ra.commits.map(c => (
                      <div key={c.sha} className="t-commit">
                        <span className="t-time">
                          {formatDateTime(c.date, showDate)}
                        </span>
                        <span className="t-branch-tag">{c.branch}</span>
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="t-msg"
                          title={c.message}
                        >
                          {c.message.split('\n')[0]}
                        </a>
                        <span className="t-sha">{c.sha.slice(0, 7)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))
          )}
        </div>
      )}

      {/* PRs View */}
      {viewTab === 'prs' && (
        <div className="t-feed">
          {loading && prData.length === 0 ? (
            <div className="t-empty">
              <RefreshCw size={28} className="t-spinning" />
              <p>Loading PRs...</p>
            </div>
          ) : repos.length === 0 ? (
            <div className="t-empty">
              <GitPullRequest size={36} strokeWidth={1.5} />
              <p>Add a GitHub repo to start tracking</p>
              <span className="t-empty-hint">Paste a repo URL above and click Add</span>
            </div>
          ) : activePRRepos.length === 0 && !loading ? (
            <div className="t-empty">
              <GitPullRequest size={36} strokeWidth={1.5} />
              <p>No PRs {dateRange === 'custom' ? 'on this date' : dateRange === 'week' ? 'this week' : 'this month'}</p>
              <span className="t-empty-hint">Try a different time range</span>
            </div>
          ) : (
            activePRRepos
              .sort((a, b) => (b.prs[0]?.updatedAt || '').localeCompare(a.prs[0]?.updatedAt || ''))
              .map(rp => (
                <div key={rp.repo} className="t-repo">
                  <div className="t-repo-head">
                    <div className="t-repo-name">
                      <GitPullRequest size={15} />
                      <span>{rp.repo.split('/')[1]}</span>
                      <span className="t-owner">{rp.repo.split('/')[0]}</span>
                      <span className="t-badge">{rp.prs.length}</span>
                    </div>
                    <a href={rp.repoUrl} target="_blank" rel="noopener noreferrer" className="t-ext-link">
                      <ExternalLink size={13} />
                    </a>
                  </div>
                  <div className="t-pr-list">
                    {rp.prs.map(pr => (
                      <div key={pr.number} className="t-pr-item">
                        <span className={`t-pr-status ${pr.merged ? 'merged' : pr.state}`}>
                          {pr.merged ? 'Merged' : pr.state === 'open' ? 'Open' : 'Closed'}
                        </span>
                        <a
                          href={pr.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="t-pr-title"
                          title={pr.title}
                        >
                          {pr.title}
                        </a>
                        <span className="t-branch-tag">{pr.branch}</span>
                        <span className="t-pr-meta">
                          #{pr.number} · {formatDateTime(pr.updatedAt, showDate)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))
          )}
        </div>
      )}

      {/* Claude Usage View */}
      {viewTab === 'claude' && (
        <div className="t-feed">
          {/* Setup banner for activity tracking */}
          {claudePings.length === 0 && (
            <div className="t-setup-banner">
              <div className="t-setup-banner-text">
                <ClaudeIcon size={16} />
                <span>Enable real-time activity tracking by adding a hook to Claude Code</span>
              </div>
              <button className="t-setup-banner-btn" onClick={() => {
                const prompt = `Add a Stop hook to my global Claude Code settings (~/.claude/settings.json) that sends a POST request to http://localhost:8000/api/claude-ping on every response. The hook should:\n- POST the raw hook JSON input (which includes session_id, cwd, etc.) to the endpoint\n- Use curl with --max-time 3 and fail silently (|| true) so it never blocks Claude\n- Set timeout to 5 seconds\n\nHere is the exact hook entry to add to the "Stop" array in hooks:\n{\n  "type": "command",\n  "command": "bash -c 'INPUT=$(cat); curl -s -X POST http://localhost:8000/api/claude-ping -H \\\\"Content-Type: application/json\\\\" -d \\\\"$INPUT\\\\" --max-time 3 >/dev/null 2>&1 || true'",\n  "timeout": 5\n}`
                navigator.clipboard.writeText(prompt)
                const btn = document.activeElement as HTMLButtonElement
                if (btn) { const orig = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = orig }, 2000) }
              }}>
                Copy Setup Prompt
              </button>
            </div>
          )}
          {!claudeStats ? (
            <div className="t-empty">
              <ClaudeIcon size={36} />
              <p>Loading Claude stats...</p>
              <span className="t-empty-hint">Reading from ~/.claude/stats-cache.json</span>
            </div>
          ) : (
            <>
              {/* Claude Stats Cards */}
              <div className="t-claude-since">
                All time since {new Date(claudeStats.firstSessionDate).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                <span className="t-claude-updated">Last updated: {claudeStats.lastComputedDate}</span>
              </div>
              <div className="t-stats" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                <div className="t-stat">
                  <div className="t-stat-val">{claudeStats.totalSessions.toLocaleString()}</div>
                  <div className="t-stat-label">Sessions</div>
                </div>
                <div className="t-stat">
                  <div className="t-stat-val">{claudeStats.totalMessages.toLocaleString()}</div>
                  <div className="t-stat-label">Messages</div>
                </div>
                <div className="t-stat">
                  <div className="t-stat-val">
                    {(() => {
                      const total = Object.values(claudeStats.modelUsage).reduce((s, m) => s + m.outputTokens, 0)
                      return total >= 1_000_000 ? `${(total / 1_000_000).toFixed(1)}M` : `${(total / 1000).toFixed(0)}k`
                    })()}
                  </div>
                  <div className="t-stat-label">Output Tokens</div>
                </div>
                <div className="t-stat">
                  <div className="t-stat-val">
                    {formatUSD(totalClaudeCost)}
                  </div>
                  <div className="t-stat-label">Est. Cost</div>
                </div>
              </div>

              {/* GitHub-style Contribution Heatmap */}
              {heatmapData && (
                <div className="t-chart-card">
                  <div className="t-chart-header">
                    <MessageSquare size={14} />
                    <span>{heatmapData.totalMessages.toLocaleString()} messages since {heatmapData.firstDateStr}</span>
                  </div>
                  <div className="t-heatmap">
                    <div className="t-heatmap-months">
                      {heatmapData.monthLabels.map((m, i) => (
                        <span key={i} className="t-heatmap-month" style={{ gridColumnStart: m.weekIdx + 2 }}>{m.label}</span>
                      ))}
                    </div>
                    <div className="t-heatmap-body">
                      <div className="t-heatmap-days">
                        <span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span>
                      </div>
                      <div className="t-heatmap-grid" ref={heatmapRef}>
                        {heatmapData.weeks.map((week, wi) => (
                          <div key={wi} className="t-heatmap-col">
                            {week.map(d => {
                              const level = d.future ? -1 : d.count === 0 ? 0 : Math.min(4, Math.ceil((d.count / heatmapData.maxCount) * 4))
                              return (
                                <div
                                  key={d.key}
                                  className={`t-heatmap-cell${d.future ? ' future' : ''}`}
                                  data-level={level}
                                  onMouseEnter={d.future ? undefined : (e) => {
                                    const rect = (e.target as HTMLElement).getBoundingClientRect()
                                    const container = heatmapRef.current!.getBoundingClientRect()
                                    setHeatmapTooltip({
                                      text: `${d.count.toLocaleString()} messages on ${d.date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`,
                                      x: rect.left - container.left + rect.width / 2,
                                      y: rect.top - container.top - 8,
                                    })
                                  }}
                                  onMouseLeave={() => setHeatmapTooltip(null)}
                                />
                              )
                            })}
                          </div>
                        ))}
                        {heatmapTooltip && (
                          <div className="t-heatmap-tooltip" style={{ left: heatmapTooltip.x, top: heatmapTooltip.y }}>
                            {heatmapTooltip.text}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="t-heatmap-legend">
                      <span>Less</span>
                      <div className="t-heatmap-cell" data-level={0} />
                      <div className="t-heatmap-cell" data-level={1} />
                      <div className="t-heatmap-cell" data-level={2} />
                      <div className="t-heatmap-cell" data-level={3} />
                      <div className="t-heatmap-cell" data-level={4} />
                      <span>More</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Model Usage (Tokens / Cost toggle) */}
              {claudeModelChart && (
                <div className="t-chart-card">
                  <div className="t-chart-header">
                    <Zap size={14} />
                    <span>Usage by Model — Last 30 Days</span>
                    <div className="t-chart-toggle">
                      {(['tokens', 'cost'] as const).map(mode => (
                        <button key={mode} className={`t-chart-toggle-btn ${modelChartMode === mode ? 'active' : ''}`} onClick={() => setModelChartMode(mode)}>
                          {mode === 'tokens' ? 'Tokens' : 'Cost'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <ReactEChartsCore echarts={echarts} option={claudeModelChart} style={{ height: 200 }} notMerge />
                </div>
              )}

              {/* Usage by Hour (all time) */}
              {claudeHourChart && (
                <div className="t-chart-card">
                  <div className="t-chart-header">
                    <Clock size={14} />
                    <span>When Do You Code the Most?</span>
                  </div>
                  <ReactEChartsCore echarts={echarts} option={claudeHourChart} style={{ height: 160 }} notMerge />
                </div>
              )}

              {/* Activity Timeline */}
              <div className="t-chart-card">
                <div className="t-chart-header">
                  <Clock size={14} />
                  <span>Activity Timeline</span>
                  <div className="t-activity-tabs">
                    {(['day', 'week', 'month', 'projects'] as const).map(v => (
                      <button key={v} className={`t-activity-tab ${activityView === v ? 'active' : ''}`} onClick={() => setActivityView(v)}>
                        {v === 'day' ? 'Day' : v === 'week' ? 'Week' : v === 'month' ? 'Month' : 'Projects'}
                      </button>
                    ))}
                  </div>
                  {activityView !== 'projects' && (
                    <div className="t-cal-wrapper" ref={activityCalRef}>
                      <button
                        className={`t-date-tab ${showActivityCal ? 'active' : ''}`}
                        onClick={() => setShowActivityCal(!showActivityCal)}
                      >
                        <Calendar size={14} />
                        <span>{activityView === 'month'
                          ? new Date(activityDate + 'T00:00:00').toLocaleDateString([], { month: 'short', year: 'numeric' })
                          : new Date(activityDate + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })
                        }</span>
                      </button>
                      {showActivityCal && (
                        <MiniCalendar
                          selectedDate={new Date(activityDate + 'T00:00:00')}
                          onSelect={(d) => { setActivityDate(toDateKey(d)); setShowActivityCal(false) }}
                          commitsByDate={pingsByDate}
                        />
                      )}
                    </div>
                  )}
                </div>

                {/* Day View */}
                {activityView === 'day' && (
                  activityTimeline ? (() => {
                    const rangeStartMin = dayRange[0] * 60
                    const rangeEndMin = dayRange[1] * 60
                    const rangeDuration = rangeEndMin - rangeStartMin

                    // Ruler tick generation
                    const rulerTicks: { h: number; major: boolean }[] = []
                    // rangeDuration is in minutes (15–1440)
                    const step = rangeDuration <= 30 ? 5/60 : rangeDuration <= 60 ? 0.25 : rangeDuration <= 180 ? 0.25 : rangeDuration <= 360 ? 0.5 : 1
                    const labelStep = rangeDuration <= 30 ? 0.25 : rangeDuration <= 60 ? 0.25 : rangeDuration <= 180 ? 0.5 : rangeDuration <= 360 ? 1 : rangeDuration <= 720 ? 2 : 3
                    for (let h = Math.ceil(dayRange[0] / step) * step; h <= dayRange[1]; h += step) {
                      rulerTicks.push({ h, major: Math.abs(h % labelStep) < 0.01 || Math.abs(h % labelStep - labelStep) < 0.01 })
                    }

                    const handleMouseDown = (e: React.MouseEvent) => {
                      const r = dayRangeRef.current
                      if (r[0] === 0 && r[1] === 24) return
                      e.preventDefault()
                      setIsDraggingTimeline(true)
                      const startX = e.clientX
                      const startRange: [number, number] = [r[0], r[1]]
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      const hoursPerPx = (startRange[1] - startRange[0]) / rect.width
                      const handleMouseMove = (ev: MouseEvent) => {
                        const dx = ev.clientX - startX
                        const shift = -dx * hoursPerPx
                        let s = startRange[0] + shift
                        let en = startRange[1] + shift
                        if (s < 0) { en -= s; s = 0 }
                        if (en > 24) { s -= (en - 24); en = 24 }
                        setDayRange([Math.max(0, s), Math.min(24, en)])
                      }
                      const handleMouseUp = () => {
                        setIsDraggingTimeline(false)
                        document.removeEventListener('mousemove', handleMouseMove)
                        document.removeEventListener('mouseup', handleMouseUp)
                      }
                      document.addEventListener('mousemove', handleMouseMove)
                      document.addEventListener('mouseup', handleMouseUp)
                    }

                    return (
                      <>
                        <div className="t-activity-summary">
                          {Math.floor(activityTimeline.totalMinutes / 60) > 0 && `${Math.floor(activityTimeline.totalMinutes / 60)}h `}
                          {Math.round(activityTimeline.totalMinutes % 60)}m · {activityTimeline.totalTurns} turns · {activityTimeline.sessionCount} sessions
                          {(dayRange[0] !== 0 || dayRange[1] !== 24) && (
                            <button className="t-range-reset" onClick={() => setDayRange([0, 24])}>Reset</button>
                          )}
                        </div>
                        <div
                          ref={timelineRefCallback}
                          className={`t-timeline t-timeline-zoomable${isDraggingTimeline ? ' dragging' : dayRange[0] !== 0 || dayRange[1] !== 24 ? ' zoomed' : ''}`}
                          onMouseDown={handleMouseDown}
                        >
                          {/* Ruler */}
                          <div className="t-ruler">
                            {rulerTicks.map(({ h, major }) => (
                              <div
                                key={h}
                                className={`t-ruler-tick${major ? ' major' : ''}`}
                                style={{ left: `${((h * 60 - rangeStartMin) / rangeDuration) * 100}%` }}
                              >
                                {major && <span className="t-ruler-label">{h === Math.floor(h) ? `${h}` : `${Math.floor(h)}:${Math.round((h % 1) * 60).toString().padStart(2, '0')}`}</span>}
                              </div>
                            ))}
                          </div>
                          {/* Track */}
                          <div className="t-timeline-track">
                            {activityTimeline.blocks.map((block, i) => {
                              const startMin = block.start.getHours() * 60 + block.start.getMinutes()
                              const endMin = block.end.getHours() * 60 + block.end.getMinutes()
                              const left = ((startMin - rangeStartMin) / rangeDuration) * 100
                              const width = Math.max(0.5, ((Math.max(endMin - startMin, 1)) / rangeDuration) * 100)
                              if (endMin < rangeStartMin || startMin > rangeEndMin) return null
                              const color = getProjectColor(block.project, allProjects)
                              const tip = `${block.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — ${block.end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${block.project} · ${block.turns} turns`
                              return (
                                <div
                                  key={i}
                                  className="t-timeline-block"
                                  style={{ left: `${Math.max(0, left)}%`, width: `${width}%`, background: color }}
                                  onMouseEnter={e => {
                                    const rect = (e.target as HTMLElement).getBoundingClientRect()
                                    const track = (e.target as HTMLElement).parentElement!.getBoundingClientRect()
                                    setBlockTooltip({ text: tip, x: rect.left - track.left + rect.width / 2, y: -8, trackId: 'day' })
                                  }}
                                  onMouseLeave={() => setBlockTooltip(null)}
                                />
                              )
                            })}
                            {blockTooltip?.trackId === 'day' && <div className="t-block-tooltip" style={{ left: blockTooltip.x, top: blockTooltip.y }}>{blockTooltip.text}</div>}
                          </div>
                        </div>
                      </>
                    )
                  })() : (
                    <div className="t-hourly-empty">
                      No activity for {new Date(activityDate + 'T00:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
                      <span className="t-hourly-empty-hint">Data records automatically via Claude Code hooks on every response</span>
                    </div>
                  )
                )}

                {/* Project Legend (shown for day & week views) */}
                {(activityView === 'day' || activityView === 'week') && allProjects.length > 0 && (
                  <div className="t-project-legend">
                    {allProjects.map(p => (
                      <span key={p} className="t-project-legend-item">
                        <span className="t-project-legend-dot" style={{ background: getProjectColor(p, allProjects) }} />
                        {p}
                      </span>
                    ))}
                  </div>
                )}

                {/* Week View */}
                {activityView === 'week' && (
                  activityWeek && activityWeek.days.some(d => d.blocks.length > 0) ? (
                    <>
                      <div className="t-activity-summary">
                        {Math.floor(activityWeek.weekTotal / 60) > 0 && `${Math.floor(activityWeek.weekTotal / 60)}h `}
                        {Math.round(activityWeek.weekTotal % 60)}m this week
                      </div>
                      <div className="t-timeline-week">
                        {activityWeek.days.map(day => (
                          <div key={day.date} className="t-timeline-week-row">
                            <span className="t-timeline-week-label">{day.label}</span>
                            <div className="t-timeline-track">
                              {day.blocks.map((block, i) => {
                                const startMin = block.start.getHours() * 60 + block.start.getMinutes()
                                const endMin = block.end.getHours() * 60 + block.end.getMinutes()
                                const left = (startMin / 1440) * 100
                                const width = Math.max(0.4, ((Math.max(endMin - startMin, 1)) / 1440) * 100)
                                const color = getProjectColor(block.project, allProjects)
                                const tip = `${block.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — ${block.end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${block.project} · ${block.turns} turns`
                                return (
                                  <div
                                    key={i}
                                    className="t-timeline-block"
                                    style={{ left: `${left}%`, width: `${width}%`, background: color }}
                                    onMouseEnter={e => {
                                      const rect = (e.target as HTMLElement).getBoundingClientRect()
                                      const track = (e.target as HTMLElement).parentElement!.getBoundingClientRect()
                                      setBlockTooltip({ text: tip, x: rect.left - track.left + rect.width / 2, y: -8, trackId: day.date })
                                    }}
                                    onMouseLeave={() => setBlockTooltip(null)}
                                  />
                                )
                              })}
                              {blockTooltip?.trackId === day.date && <div className="t-block-tooltip" style={{ left: blockTooltip.x, top: blockTooltip.y }}>{blockTooltip.text}</div>}
                            </div>
                            <span className="t-timeline-week-time">
                              {day.totalMinutes >= 60 ? `${(day.totalMinutes / 60).toFixed(1)}h` : day.totalMinutes > 0 ? `${Math.round(day.totalMinutes)}m` : ''}
                            </span>
                          </div>
                        ))}
                        <div className="t-timeline-week-row t-timeline-week-hours-row">
                          <span className="t-timeline-week-label" />
                          <div className="t-timeline-hours">
                            {Array.from({ length: 24 }, (_, i) => (
                              <span key={i} className="t-timeline-hour-label">{i % 3 === 0 ? i : ''}</span>
                            ))}
                          </div>
                          <span className="t-timeline-week-time" />
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="t-hourly-empty">
                      No activity this week
                      <span className="t-hourly-empty-hint">Data records automatically via Claude Code hooks on every response</span>
                    </div>
                  )
                )}

                {/* Month View */}
                {activityView === 'month' && (
                  activityMonthChart ? (
                    <>
                      <div className="t-activity-summary">
                        {activityMonthChart.totalHours.toFixed(1)}h across {activityMonthChart.activeDays} days in {activityMonthChart.monthLabel}
                      </div>
                      <ReactEChartsCore echarts={echarts} option={activityMonthChart.chart} style={{ height: 180 }} notMerge />
                    </>
                  ) : (
                    <div className="t-hourly-empty">
                      No activity data yet
                      <span className="t-hourly-empty-hint">Data records automatically via Claude Code hooks on every response</span>
                    </div>
                  )
                )}

                {/* Projects View */}
                {activityView === 'projects' && (
                  activityProjectChart ? (
                    <ReactEChartsCore echarts={echarts} option={activityProjectChart.chart} style={{ height: Math.max(150, Object.keys(activityProjectChart.chart.yAxis.data).length * 32) }} notMerge />
                  ) : (
                    <div className="t-hourly-empty">
                      No project data yet
                      <span className="t-hourly-empty-hint">Data records automatically via Claude Code hooks on every response</span>
                    </div>
                  )
                )}
              </div>

              {/* Model Breakdown */}
              <div className="t-chart-card">
                <div className="t-chart-header">
                  <Wrench size={14} />
                  <span>Model Usage Breakdown</span>
                  <span className="t-chart-header-right">
                    est. total: {formatUSD(totalClaudeCost)}
                  </span>
                </div>
                <div style={{ padding: '12px 16px' }}>
                  {Object.entries(claudeStats.modelUsage).filter(([m]) => m !== '<synthetic>').map(([model, usage]) => {
                    const shortName = model.includes('opus-4-6') ? 'Opus 4.6' :
                      model.includes('opus-4-5') ? 'Opus 4.5' :
                      model.includes('sonnet-4-6') ? 'Sonnet 4.6' :
                      model.includes('sonnet-4-5') ? 'Sonnet 4.5' :
                      model.includes('haiku') ? 'Haiku 4.5' : model
                    const totalOut = usage.outputTokens
                    const totalCache = usage.cacheReadInputTokens
                    const cost = calcModelCost(model, usage)
                    return (
                      <div key={model} className="t-claude-model-row">
                        <span className="t-claude-model-name">{shortName}</span>
                        <div className="t-claude-model-stats">
                          <span title="Output tokens">
                            {totalOut >= 1_000_000 ? `${(totalOut / 1_000_000).toFixed(1)}M` : `${(totalOut / 1000).toFixed(0)}k`} out
                          </span>
                          <span className="t-claude-sep">·</span>
                          <span title="Cache read tokens">
                            {totalCache >= 1_000_000_000 ? `${(totalCache / 1_000_000_000).toFixed(1)}B` : totalCache >= 1_000_000 ? `${(totalCache / 1_000_000).toFixed(0)}M` : `${(totalCache / 1000).toFixed(0)}k`} cache
                          </span>
                          <span className="t-claude-sep">·</span>
                          <span className="t-claude-cost" title="Estimated cost">{formatUSD(cost)}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Tracked Repos */}
      {repos.length > 0 && (
        <div className="t-tracked">
          <h3>Tracked Repos</h3>
          <div className="t-chips">
            {repos.map(repo => (
              <div key={repo.id} className="t-chip">
                <a href={repo.url} target="_blank" rel="noopener noreferrer">{repo.id}</a>
                <button className="t-chip-x" onClick={() => handleDeleteRepo(repo.owner, repo.repo)}>
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
