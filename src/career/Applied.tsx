// Applied dashboard — surfaces applications.json state for jobs the user has
// submitted (or transitioned past Evaluated). Filter chips by status, per-row
// timeline visualization, followup highlight, [Advance status] quick action.
//
// 08-human-gate-tracker/02-career-dashboard-views m1.
//
// Consumes already-shipped GET /api/career/applications (?status=CSV) and
// POST /api/career/applications/:id/status from 08/01.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import {
  AlertTriangle,
  Loader2,
  RefreshCw,
  ExternalLink,
  FileText,
  ChevronRight,
} from 'lucide-react'
import './applied.css'

const REFRESH_MS = 30_000
const FOLLOWUP_WARN_MS = 3 * 24 * 60 * 60 * 1000 // 3 days

type Status =
  | 'Evaluated'
  | 'Applied'
  | 'Responded'
  | 'Interview'
  | 'Offer'
  | 'Rejected'
  | 'Discarded'
  | 'SKIP'

type Legitimacy = 'High Confidence' | 'Proceed with Caution' | 'Suspicious' | 'Unknown'

type TimelineEvent = {
  ts: string
  event: string
  note?: string
  from?: Status
  to?: Status
}

type Followup = { nextAt: string; reason: string }

type Application = {
  id: string
  company: string
  role: string
  url: string
  score: number | null
  status: Status
  legitimacy: Legitimacy
  reportPath: string | null
  pdfPath: string | null
  resumeId: string | null
  timeline: TimelineEvent[]
  followup?: Followup
}

type ApplicationsResp = {
  total: number
  filtered: number
  results: Application[]
}

// Mirror of server-side VALID_TRANSITIONS. Duplicated intentionally — client
// uses this to render the [Advance status] dropdown options. Server-side is
// the source of truth: illegal transitions return 400 with allowed_next even
// if the client falls out of sync.
const VALID_TRANSITIONS: Record<Status, readonly Status[]> = {
  Evaluated: ['Applied', 'Discarded', 'SKIP'],
  Applied: ['Responded', 'Discarded', 'SKIP'],
  Responded: ['Interview', 'Rejected', 'Discarded', 'SKIP'],
  Interview: ['Offer', 'Rejected', 'Discarded', 'SKIP'],
  Offer: ['Rejected', 'Discarded'],
  Rejected: ['Discarded'],
  Discarded: [],
  SKIP: ['Discarded'],
} as const

type FilterChip = 'all' | 'Applied' | 'Responded' | 'Interview' | 'Offer' | 'Rejected' | 'Discarded'

const CHIP_ORDER: FilterChip[] = [
  'all',
  'Applied',
  'Responded',
  'Interview',
  'Offer',
  'Rejected',
  'Discarded',
]
const CHIP_LABELS: Record<FilterChip, string> = {
  all: 'All',
  Applied: 'Applied',
  Responded: 'Responded',
  Interview: 'Interview',
  Offer: 'Offer',
  Rejected: 'Rejected',
  Discarded: 'Discarded',
}

export default function Applied() {
  const navigate = useNavigate()
  const [data, setData] = useState<ApplicationsResp | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterChip>('all')
  const [transitionBusy, setTransitionBusy] = useState<string | null>(null) // application id mid-transition
  const [transitionError, setTransitionError] = useState<string | null>(null)
  const manualCtrlRef = useRef<AbortController | null>(null)

  async function fetchApplications(signal?: AbortSignal) {
    try {
      const r = await fetch('/api/career/applications', { signal })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const json = (await r.json()) as ApplicationsResp
      setData(json)
      setError(null)
    } catch (e) {
      const name = (e as { name?: string })?.name
      if (name === 'AbortError') return
      setError((e as Error).message ?? 'Failed to load applications')
    }
  }

  useEffect(() => {
    const ctrl = new AbortController()
    fetchApplications(ctrl.signal)
    const t = setInterval(() => fetchApplications(ctrl.signal), REFRESH_MS)
    return () => {
      ctrl.abort()
      manualCtrlRef.current?.abort()
      clearInterval(t)
    }
  }, [])

  const filteredResults = useMemo(() => {
    if (!data) return []
    if (filter === 'all') {
      // Exclude Evaluated rows — those live on Shortlist, not Applied
      return data.results.filter((r) => r.status !== 'Evaluated')
    }
    return data.results.filter((r) => r.status === filter)
  }, [data, filter])

  const chipCounts = useMemo<Record<FilterChip, number>>(() => {
    const rows = data?.results ?? []
    return {
      all: rows.filter((r) => r.status !== 'Evaluated').length,
      Applied: rows.filter((r) => r.status === 'Applied').length,
      Responded: rows.filter((r) => r.status === 'Responded').length,
      Interview: rows.filter((r) => r.status === 'Interview').length,
      Offer: rows.filter((r) => r.status === 'Offer').length,
      Rejected: rows.filter((r) => r.status === 'Rejected').length,
      Discarded: rows.filter((r) => r.status === 'Discarded').length,
    }
  }, [data])

  async function advanceStatus(row: Application, newStatus: Status) {
    const ok = window.confirm(
      `Transition ${row.role} @ ${row.company} from ${row.status} to ${newStatus}?\n\nThis writes a status_changed event to applications.json timeline.`
    )
    if (!ok) return
    setTransitionBusy(row.id)
    setTransitionError(null)
    try {
      const r = await fetch(`/api/career/applications/${encodeURIComponent(row.id)}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      const body = await r.json()
      if (!r.ok) {
        if (body?.current_status && Array.isArray(body?.allowed_next)) {
          throw new Error(
            `${body.error}. Current: ${body.current_status}. Allowed: ${body.allowed_next.join(', ')}`
          )
        }
        throw new Error(body?.error ?? `HTTP ${r.status}`)
      }
      // Refresh list to pick up the new timeline event
      await fetchApplications()
    } catch (e) {
      setTransitionError((e as Error).message ?? 'Transition failed')
    } finally {
      setTransitionBusy(null)
    }
  }

  if (error && !data) {
    return (
      <div className="c-page">
        <h2>Applied</h2>
        <div className="ad-error">
          <AlertTriangle size={14} /> Failed to load: {error}
        </div>
      </div>
    )
  }

  return (
    <div className="c-page">
      <h2>Applied</h2>
      <p className="c-page-todo">
        Applications you've moved past Evaluated. Filter by current status, scan the
        timeline, advance state via the per-row action.
      </p>

      {/* Filter chips + manual refresh */}
      <div className="ad-toolbar">
        <div className="ad-chips">
          {CHIP_ORDER.map((chip) => (
            <button
              key={chip}
              type="button"
              className={`ad-chip${filter === chip ? ' ad-chip-active' : ''}`}
              onClick={() => setFilter(chip)}
            >
              {CHIP_LABELS[chip]}
              <span className="ad-chip-count">({chipCounts[chip]})</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="ad-refresh"
          aria-label="Refresh"
          onClick={() => {
            manualCtrlRef.current?.abort()
            const ctrl = new AbortController()
            manualCtrlRef.current = ctrl
            fetchApplications(ctrl.signal)
          }}
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {transitionError && (
        <div className="ad-error">
          <AlertTriangle size={12} /> {transitionError}
        </div>
      )}

      {!data ? (
        <div className="ad-loading">
          <Loader2 size={14} className="ad-spin" /> Loading applications…
        </div>
      ) : filteredResults.length === 0 ? (
        <div className="ad-empty">
          {data.total === 0 ? (
            <>
              No applications yet. Head to{' '}
              <Link to="/career/shortlist" className="ad-link">/career/shortlist</Link>{' '}
              to find jobs to apply to.
            </>
          ) : (
            <>No applications match this filter.</>
          )}
        </div>
      ) : (
        <div className="ad-cards">
          {filteredResults.map((row) => (
            <AppliedRowCard
              key={row.id}
              row={row}
              busy={transitionBusy === row.id}
              onAdvance={(target) => advanceStatus(row, target)}
              onOpenReport={() => {
                const jobId = row.id.split('-')[0]
                navigate(`/career/reports/${jobId}`)
              }}
            />
          ))}
        </div>
      )}

      {error && data && (
        <div className="ad-stale">
          <AlertTriangle size={12} /> Last refresh failed: {error} — showing cached data
        </div>
      )}
    </div>
  )
}

function AppliedRowCard({
  row,
  busy,
  onAdvance,
  onOpenReport,
}: {
  row: Application
  busy: boolean
  onAdvance: (target: Status) => void
  onOpenReport: () => void
}) {
  const followupClass = followupHighlight(row.followup)
  const allowedNext = VALID_TRANSITIONS[row.status]
  return (
    <div className={`ad-row ad-row-${row.status.toLowerCase()}`}>
      <div className="ad-row-head">
        <ScoreBadge score={row.score} />
        <div className="ad-row-title">
          <div className="ad-role">{row.role}</div>
          <div className="ad-meta">
            {row.company}
            {row.id.includes('-') && (
              <>
                {' · '}
                <code className="ad-id">{row.id}</code>
              </>
            )}
          </div>
        </div>
        <span className={`ad-status-pill ad-status-${row.status.toLowerCase()}`}>
          {row.status}
        </span>
      </div>

      <Timeline events={row.timeline} />

      {row.followup && (
        <div className={`ad-followup ${followupClass}`}>
          <AlertTriangle size={12} />
          <strong>Follow up by {formatDate(row.followup.nextAt)}</strong>
          {' — '}
          {row.followup.reason}
        </div>
      )}

      <div className="ad-row-actions">
        <button
          type="button"
          className="ad-btn ad-btn-secondary"
          onClick={onOpenReport}
          title="Open Block A-G report"
        >
          <FileText size={12} /> Report
        </button>
        {row.url && (
          <a
            href={row.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ad-btn ad-btn-secondary"
            title="Open job posting"
          >
            <ExternalLink size={12} /> Job
          </a>
        )}
        {allowedNext.length > 0 && (
          <div className="ad-advance">
            <select
              className="ad-advance-select"
              defaultValue=""
              disabled={busy}
              onChange={(e) => {
                const target = e.target.value as Status
                if (target) {
                  onAdvance(target)
                  e.target.value = ''
                }
              }}
              aria-label={`Advance status from ${row.status}`}
            >
              <option value="" disabled>
                {busy ? 'Advancing…' : 'Advance status…'}
              </option>
              {allowedNext.map((s) => (
                <option key={s} value={s}>
                  → {s}
                </option>
              ))}
            </select>
            <ChevronRight size={10} className="ad-advance-icon" />
          </div>
        )}
      </div>
    </div>
  )
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  if (!Array.isArray(events) || events.length === 0) {
    return <div className="ad-timeline ad-timeline-empty">no timeline events</div>
  }
  return (
    <div className="ad-timeline" role="list">
      {events.map((ev, i) => {
        const cls = ev.event === 'status_changed' ? 'ad-tl-status' : 'ad-tl-event'
        const tooltip = [
          `${formatRelative(ev.ts)} · ${ev.event}`,
          ev.from && ev.to ? `${ev.from} → ${ev.to}` : null,
          ev.note ? `note: ${ev.note}` : null,
        ]
          .filter(Boolean)
          .join('\n')
        return (
          <div
            key={`${i}-${ev.ts}`}
            className={`ad-tl-dot ${cls}`}
            role="listitem"
            title={tooltip}
          >
            <span className="ad-tl-label">
              {ev.event === 'status_changed' && ev.to ? ev.to : ev.event}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score == null) return <span className="ad-score ad-score-na">—</span>
  let cls = 'ad-score-consider'
  if (score >= 4.5) cls = 'ad-score-strong'
  else if (score >= 4.0) cls = 'ad-score-worth'
  return <span className={`ad-score ${cls}`}>{score.toFixed(1)}</span>
}

function followupHighlight(followup: Followup | undefined): string {
  if (!followup) return ''
  const due = new Date(followup.nextAt).getTime()
  if (!Number.isFinite(due)) return ''
  const now = Date.now()
  if (due < now) return 'ad-followup-past'
  if (due - now <= FOLLOWUP_WARN_MS) return 'ad-followup-soon'
  return 'ad-followup-future'
}

function formatRelative(iso: string): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return '—'
  const diffMs = Date.now() - then
  const diffMin = Math.round(diffMs / 60_000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  return `${diffDay}d ago`
}

function formatDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
