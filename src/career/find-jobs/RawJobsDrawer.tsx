// Raw Jobs drawer — drill-in view from FindJobs ② Filters section.
//
// 04-career-system / find-jobs-redesign m1.c.
//
// Shows EVERY job from the latest scan (passed + dropped) so the
// operator can see exactly what got filtered and why. Each dropped card
// has an [Adjust filter] action that jumps back to the Filters section
// and highlights the responsible rule.

import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import JobCard, { type JobCardModel } from './JobCard'

type RawJobsResp = {
  total: number
  passed: number
  dropped: number
  filtered: number
  jobs: JobCardModel[]
  sources: string[]
  dropped_by_rule: Record<string, number>
  last_scan_at: string | null
}

type Status = 'all' | 'passed' | 'dropped'

const PAGE_SIZE = 60

export default function RawJobsDrawer({
  onClose,
  onAdjustFilter,
  onApply,
  onView,
}: {
  onClose: () => void
  onAdjustFilter: (rule: string) => void
  onApply: (job: JobCardModel) => void
  onView: (job: JobCardModel) => void
}) {
  const [data, setData] = useState<RawJobsResp | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>('all')
  const [source, setSource] = useState<string>('')
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)

  const url = useMemo(() => {
    const params = new URLSearchParams({
      status,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    })
    if (source) params.set('source', source)
    if (q.trim()) params.set('q', q.trim())
    return `/api/career/finder/raw-jobs?${params}`
  }, [status, source, q, offset])

  useEffect(() => {
    const ctrl = new AbortController()
    fetch(url, { signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as RawJobsResp
      })
      .then((j) => {
        setData(j)
        setError(null)
      })
      .catch((e) => {
        if ((e as { name?: string })?.name === 'AbortError') return
        setError((e as Error).message)
      })
    return () => ctrl.abort()
  }, [url])

  // Reset to page 1 whenever filters change.
  function setStatusReset(s: Status) {
    setStatus(s)
    setOffset(0)
  }
  function setSourceReset(s: string) {
    setSource(s)
    setOffset(0)
  }
  function setQReset(s: string) {
    setQ(s)
    setOffset(0)
  }

  // ESC to close
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  return (
    <div
      className="c-fj-drawer-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Raw scan results"
    >
      <div className="c-fj-drawer c-fj-drawer-raw" onClick={(e) => e.stopPropagation()}>
        <header className="c-fj-drawer-head">
          <div>
            <h3 className="c-fj-drawer-title">Raw scan results</h3>
            {data && (
              <p className="c-fj-drawer-sub">
                <strong>{data.total}</strong> jobs · {data.passed} passed · {data.dropped} dropped
                {data.last_scan_at && (
                  <> · last scan {new Date(data.last_scan_at).toLocaleString()}</>
                )}
              </p>
            )}
          </div>
          <button
            type="button"
            className="c-fj-btn c-fj-btn-ghost c-fj-drawer-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </header>

        <div className="c-fj-drawer-toolbar">
          <input
            type="search"
            className="c-fj-input"
            placeholder="Filter by company or role…"
            value={q}
            onChange={(e) => setQReset(e.target.value)}
          />
          <select
            className="c-fj-input"
            value={source}
            onChange={(e) => setSourceReset(e.target.value)}
          >
            <option value="">All sources</option>
            {data?.sources.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <div className="c-fj-segmented">
            <button
              type="button"
              className={`c-fj-seg ${status === 'all' ? 'c-fj-seg-active' : ''}`}
              onClick={() => setStatusReset('all')}
            >
              All {data && `(${data.total})`}
            </button>
            <button
              type="button"
              className={`c-fj-seg ${status === 'passed' ? 'c-fj-seg-active' : ''}`}
              onClick={() => setStatusReset('passed')}
            >
              Passed {data && `(${data.passed})`}
            </button>
            <button
              type="button"
              className={`c-fj-seg ${status === 'dropped' ? 'c-fj-seg-active' : ''}`}
              onClick={() => setStatusReset('dropped')}
            >
              Dropped {data && `(${data.dropped})`}
            </button>
          </div>
        </div>

        {data && data.dropped > 0 && (
          <div className="c-fj-drop-breakdown">
            <span className="c-fj-muted">Dropped by:</span>
            {Object.entries(data.dropped_by_rule)
              .sort((a, b) => b[1] - a[1])
              .map(([rule, n]) => (
                <button
                  key={rule}
                  type="button"
                  className="c-fj-chip"
                  onClick={() => onAdjustFilter(rule)}
                  title="Open Filters and highlight this rule"
                >
                  {rule.replace(/_/g, ' ')} <strong>{n}</strong>
                </button>
              ))}
          </div>
        )}

        <div className="c-fj-drawer-body">
          {error && <p className="c-fj-error">Failed: {error}</p>}
          {!data ? (
            <p className="c-fj-muted">Loading…</p>
          ) : data.filtered === 0 ? (
            <p className="c-fj-muted">No jobs match the current filter.</p>
          ) : (
            <>
              <p className="c-fj-muted c-fj-drawer-meta">
                Showing {offset + 1}–{offset + data.jobs.length} of {data.filtered}
              </p>
              <div className="c-fj-cards-grid">
                {data.jobs.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    onView={onView}
                    onApply={onApply}
                    onAdjustFilter={(j) => j._dropped_by && onAdjustFilter(j._dropped_by)}
                  />
                ))}
              </div>
              <DrawerPager
                offset={offset}
                pageSize={PAGE_SIZE}
                filtered={data.filtered}
                onChange={setOffset}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function DrawerPager({
  offset,
  pageSize,
  filtered,
  onChange,
}: {
  offset: number
  pageSize: number
  filtered: number
  onChange: (n: number) => void
}) {
  const page = Math.floor(offset / pageSize) + 1
  const last = Math.max(1, Math.ceil(filtered / pageSize))
  if (last <= 1) return null
  return (
    <div className="c-fj-pager">
      <button
        type="button"
        className="c-fj-btn c-fj-btn-ghost"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - pageSize))}
      >
        ← Prev
      </button>
      <span className="c-fj-pager-label">Page {page} / {last}</span>
      <button
        type="button"
        className="c-fj-btn c-fj-btn-ghost"
        disabled={offset + pageSize >= filtered}
        onClick={() => onChange(offset + pageSize)}
      >
        Next →
      </button>
    </div>
  )
}
