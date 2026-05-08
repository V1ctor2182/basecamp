// Shortlist page — sorted+filterable list of jobs that passed Stage B
// with total_score >= prefs.thresholds.worth (default 4.0). Replaces the
// stub from earlier rooms. Click row → /career/reports/{jobId}.
//
// Pre-existing manual-enrich pending banner (from earlier work) is
// preserved at the top — useful nudge when JD enrich pipeline failed
// for some jobs.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ClipboardPaste,
  ExternalLink,
  Wand2,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react'
import './shortlist/shortlist.css'

const REFRESH_MS = 30_000

type ShortlistRow = {
  id: string
  company: string
  role: string
  url: string
  location: string[]
  total_score: number
  blocks_emitted: string[]
  report_path: string | null
  evaluated_at: string
  cost_usd: number
  stage_a_score: number | null
  has_tailor_output: boolean
}

type ShortlistResp = {
  total: number
  score_floor: number
  results: ShortlistRow[]
}

type StageBPendingRow = {
  id: string
  company: string
  role: string
  total_score: number | null
  status: string
}

type FilterChip = 'all' | 'score-4.5+' | 'score-4.0-4.4' | 'pending-stage-b' | 'has-tailor'

const CHIP_LABELS: Record<FilterChip, string> = {
  'all': 'All',
  'score-4.5+': 'Score 4.5+',
  'score-4.0-4.4': 'Score 4.0-4.4',
  'pending-stage-b': 'Stage A passers, no B yet',
  'has-tailor': 'Has tailor output',
}

export default function Shortlist() {
  const navigate = useNavigate()
  const [data, setData] = useState<ShortlistResp | null>(null)
  const [pendingStageB, setPendingStageB] = useState<number>(0)
  const [manualPasteCount, setManualPasteCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterChip>('all')
  const manualCtrlRef = useRef<AbortController | null>(null)

  async function fetchShortlist(signal?: AbortSignal) {
    try {
      const r = await fetch('/api/career/shortlist', { signal })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const json = (await r.json()) as ShortlistResp
      setData(json)
      setError(null)
    } catch (e) {
      const name = (e as { name?: string })?.name
      if (name === 'AbortError') return
      setError((e as Error).message ?? 'Failed to load shortlist')
    }
  }

  // Side-fetch for the "Stage A passers, no B yet" filter — derives
  // pending count from existing /evaluate/stage-b/results endpoint.
  async function fetchStageBPending(signal?: AbortSignal) {
    try {
      const r = await fetch('/api/career/evaluate/stage-b/results', { signal })
      if (!r.ok) return
      const json = (await r.json()) as { pending: number }
      setPendingStageB(json.pending ?? 0)
    } catch {
      // silent — chip just shows 0
    }
  }

  // Pre-existing manual-enrich pending nudge — preserved from prior stub.
  async function fetchManualPaste(signal?: AbortSignal) {
    try {
      const r = await fetch('/api/career/finder/needs-manual', { signal })
      if (!r.ok) return
      const json = await r.json()
      if (Array.isArray(json?.jobs)) setManualPasteCount(json.jobs.length)
    } catch {
      // silent
    }
  }

  useEffect(() => {
    const ctrl = new AbortController()
    fetchShortlist(ctrl.signal)
    fetchStageBPending(ctrl.signal)
    fetchManualPaste(ctrl.signal)
    const t = setInterval(() => {
      fetchShortlist(ctrl.signal)
      fetchStageBPending(ctrl.signal)
    }, REFRESH_MS)
    return () => {
      ctrl.abort()
      manualCtrlRef.current?.abort()
      clearInterval(t)
    }
  }, [])

  // Predicates shared by filteredResults + chip count derivation so both
  // sides cannot drift. Map chip → predicate; null = no client-side filter.
  const CHIP_PREDICATES: Record<FilterChip, ((r: ShortlistRow) => boolean) | null> = {
    'all': null,
    'score-4.5+': (r) => r.total_score >= 4.5,
    'score-4.0-4.4': (r) => r.total_score >= 4.0 && r.total_score < 4.5,
    'has-tailor': (r) => r.has_tailor_output,
    'pending-stage-b': null, // navigational hint; never filters the table
  }

  const filteredResults = useMemo(() => {
    if (!data) return []
    // pending-stage-b clears the table and shows a CTA (handled in render).
    if (filter === 'pending-stage-b') return []
    const pred = CHIP_PREDICATES[filter]
    return pred ? data.results.filter(pred) : data.results
  }, [data, filter])

  const chipCounts = useMemo<Record<FilterChip, number>>(() => {
    const rows = data?.results ?? []
    return {
      'all': data?.total ?? 0,
      'score-4.5+': rows.filter(CHIP_PREDICATES['score-4.5+']!).length,
      'score-4.0-4.4': rows.filter(CHIP_PREDICATES['score-4.0-4.4']!).length,
      'has-tailor': rows.filter(CHIP_PREDICATES['has-tailor']!).length,
      'pending-stage-b': pendingStageB,
    }
  }, [data, pendingStageB])

  if (error && !data) {
    return (
      <div className="c-page">
        <h2>Shortlist</h2>
        <div className="sl-error">
          <AlertTriangle size={14} /> Failed to load: {error}
        </div>
      </div>
    )
  }

  return (
    <div className="c-page">
      <h2>Shortlist</h2>
      <p className="c-page-todo">
        Stage B-evaluated jobs at score ≥ {data?.score_floor.toFixed(1) ?? '4.0'},
        sorted by total_score descending.
      </p>

      {/* Manual-enrich nudge (preserved from prior stub) */}
      {manualPasteCount !== null && manualPasteCount > 0 && (
        <div className="sl-manual-nudge">
          <ClipboardPaste size={18} />
          <span className="sl-manual-nudge-text">
            {manualPasteCount} job{manualPasteCount === 1 ? '' : 's'} need manual JD paste —
            the enrich pipeline couldn&rsquo;t fetch the description.
          </span>
          <Link to="/career/shortlist/needs-manual" className="sl-manual-nudge-link">
            Paste now →
          </Link>
        </div>
      )}

      {/* Filter chips + refresh */}
      <div className="sl-toolbar">
        <div className="sl-chips">
          {(['all', 'score-4.5+', 'score-4.0-4.4', 'pending-stage-b', 'has-tailor'] as FilterChip[]).map(
            (chip) => (
              <button
                key={chip}
                type="button"
                className={`sl-chip${filter === chip ? ' sl-chip-active' : ''}`}
                onClick={() => setFilter(chip)}
              >
                {CHIP_LABELS[chip]} <span className="sl-chip-count">({chipCounts[chip]})</span>
              </button>
            )
          )}
        </div>
        <button
          type="button"
          className="sl-refresh"
          onClick={() => {
            // Abort prior in-flight manual refresh so spam-clicking doesn't
            // pile up requests, and so unmount cleanup can cancel the latest.
            manualCtrlRef.current?.abort()
            const ctrl = new AbortController()
            manualCtrlRef.current = ctrl
            fetchShortlist(ctrl.signal)
            fetchStageBPending(ctrl.signal)
          }}
          aria-label="Refresh"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Results table OR empty state OR pending-redirect */}
      {filter === 'pending-stage-b' ? (
        <div className="sl-empty">
          {pendingStageB > 0 ? (
            <>
              <strong>{pendingStageB}</strong> Stage A passer{pendingStageB === 1 ? '' : 's'} awaiting Stage B
              eval.{' '}
              <Link to="/career/pipeline" className="sl-link">
                Go to Pipeline → run Stage B
              </Link>
            </>
          ) : (
            <>No Stage A passers waiting for Stage B. All caught up 🎉</>
          )}
        </div>
      ) : filteredResults.length === 0 ? (
        <div className="sl-empty">
          {data && data.total === 0 ? (
            <>
              No Stage B-evaluated jobs yet. Head to{' '}
              <Link to="/career/pipeline" className="sl-link">/career/pipeline</Link>{' '}
              to run Stage A + B first.
            </>
          ) : (
            <>No matches for this filter.</>
          )}
        </div>
      ) : (
        <>
          <table className="sl-table">
            <thead>
              <tr>
                <th>Score</th>
                <th>Role · Company</th>
                <th>Stage A</th>
                <th>Blocks</th>
                <th>Tailor</th>
                <th>Evaluated</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredResults.map((row) => (
                <tr
                  key={row.id}
                  className="sl-row"
                  onClick={() => navigate(`/career/reports/${row.id}`)}
                  role="link"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      navigate(`/career/reports/${row.id}`)
                    }
                  }}
                >
                  <td><ScoreBadge score={row.total_score} /></td>
                  <td>
                    <div className="sl-role">{row.role}</div>
                    <div className="sl-meta">
                      {row.company}
                      {Array.isArray(row.location) && row.location.length > 0 && (
                        <> · {row.location.join(' / ')}</>
                      )}
                    </div>
                  </td>
                  <td className="sl-stage-a">
                    {typeof row.stage_a_score === 'number' ? row.stage_a_score.toFixed(1) : '—'}
                  </td>
                  <td className="sl-blocks">
                    {row.blocks_emitted.length === 0
                      ? <span className="sl-meta">—</span>
                      : row.blocks_emitted.map((k) => (
                          <span key={k} className="sl-block-chip">{k}</span>
                        ))}
                  </td>
                  <td className="sl-tailor">
                    {row.has_tailor_output ? (
                      <span className="sl-tailor-yes" title="Tailored output exists for this job">
                        <Wand2 size={11} /> yes
                      </span>
                    ) : (
                      <span className="sl-meta">—</span>
                    )}
                  </td>
                  <td className="sl-meta sl-evaluated">
                    {formatRelative(row.evaluated_at)}
                  </td>
                  <td className="sl-row-actions">
                    <a
                      href={row.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="sl-btn-link"
                      aria-label="Open job posting"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ExternalLink size={12} />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.total > filteredResults.length && (
            <div className="sl-footer">
              Showing {filteredResults.length} of {data.total}
              {data.total >= 100 && ' (capped at 100; raise prefs.thresholds.worth to narrow)'}
            </div>
          )}
        </>
      )}

      {error && data && (
        <div className="sl-stale">
          <AlertTriangle size={12} /> Last refresh failed: {error} — showing cached data
        </div>
      )}
    </div>
  )
}

function ScoreBadge({ score }: { score: number }) {
  let cls = 'sl-score-consider'
  if (score >= 4.5) cls = 'sl-score-strong'
  else if (score >= 4.0) cls = 'sl-score-worth'
  return <span className={`sl-score ${cls}`}>{score.toFixed(1)}</span>
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
