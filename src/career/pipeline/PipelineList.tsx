// Pipeline tab — scanned-job table.
//
// Reads /api/career/finder/pipeline (returns trimmed job rows from
// data/career/pipeline.json). Sort / filter / paginate client-side via
// server query params; the server already trims heavy fields
// (description, raw payload) so we don't ship megabytes to the browser.

import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, RefreshCw, AlertCircle } from 'lucide-react'

type EvalStageA = {
  score: number
  verdict?: string
  reasoning?: string
} | null

type Job = {
  id: string
  company: string
  role: string
  location: string[] | string | null
  url: string
  source: { type: string; name: string } | null
  tags: string[] | null
  comp_hint: string | null
  posted_at: string | null
  scraped_at: string | null
  status: string | null
  evaluation: { stage_a: EvalStageA; stage_b: { score: number } | null } | null
  needs_manual_enrich: boolean
}

type PipelineResp = {
  total: number
  filtered: number
  jobs: Job[]
  last_scan_at: string | null
}

type SortKey = 'score' | 'posted_at' | 'scraped_at' | 'company'
type SortOrder = 'asc' | 'desc'
const PAGE_SIZE = 30

export default function PipelineList() {
  const [data, setData] = useState<PipelineResp | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortKey>('score')
  const [order, setOrder] = useState<SortOrder>('desc')
  const [offset, setOffset] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  // Initial-load marker is derived from data===null below; React 19 lint
  // forbids synchronous setState inside useEffect body, so we don't mark
  // a "loading=true" between url changes — instead we keep the previous
  // data visible until the new response lands.

  const url = useMemo(() => {
    const params = new URLSearchParams({
      sort,
      order,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    })
    if (q.trim()) params.set('q', q.trim())
    return `/api/career/finder/pipeline?${params}`
  }, [q, sort, order, offset])

  useEffect(() => {
    const ctrl = new AbortController()
    fetch(url, { signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as PipelineResp
      })
      .then((json) => {
        setData(json)
        setError(null)
      })
      .catch((e) => {
        if ((e as { name?: string })?.name === 'AbortError') return
        setError((e as Error).message)
      })
    return () => ctrl.abort()
  }, [url])

  function refresh() {
    setRefreshing(true)
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as PipelineResp
      })
      .then((json) => {
        setData(json)
        setError(null)
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setRefreshing(false))
  }

  // Handlers that reset to page 1 when the filter/sort changes — done
  // inline (not via a derived-state useEffect) per React 19 lint rule.
  function changeQ(newQ: string) {
    setQ(newQ)
    setOffset(0)
  }
  function clickSort(key: SortKey) {
    if (sort === key) {
      setOrder((o) => (o === 'desc' ? 'asc' : 'desc'))
    } else {
      setSort(key)
      setOrder(key === 'company' ? 'asc' : 'desc')
    }
    setOffset(0)
  }

  return (
    <section className="c-pl-section">
      <header className="c-pl-header">
        <h3 className="c-pl-title">Scanned jobs</h3>
        <div className="c-pl-toolbar">
          <input
            className="c-pl-search"
            type="search"
            placeholder="Filter by company or role…"
            value={q}
            onChange={(e) => changeQ(e.target.value)}
            aria-label="Filter"
          />
          <button
            type="button"
            className="c-pl-btn c-pl-btn-ghost"
            onClick={refresh}
            disabled={refreshing}
            title="Re-fetch pipeline.json"
          >
            <RefreshCw size={14} /> {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {data && (
        <p className="c-pl-meta">
          Showing {data.jobs.length === 0 ? 0 : offset + 1}–{offset + data.jobs.length} of{' '}
          {data.filtered}
          {data.filtered !== data.total && (
            <> (filtered from {data.total})</>
          )}
          {data.last_scan_at && (
            <>
              {' · '}
              <span className="c-pl-meta-muted">
                last scan: {new Date(data.last_scan_at).toLocaleString()}
              </span>
            </>
          )}
        </p>
      )}

      {error && (
        <p className="c-pl-error">
          <AlertCircle size={14} /> {error}
        </p>
      )}

      {!data ? (
        <p className="c-pl-empty">Loading…</p>
      ) : data && data.total === 0 ? (
        <EmptyHint kind="no-scan" />
      ) : data && data.filtered === 0 && q.trim() === '' ? (
        <EmptyHint kind="all-filtered" total={data.total} />
      ) : data && data.filtered === 0 ? (
        <EmptyHint kind="no-match" />
      ) : (
        <>
          <div className="c-pl-table-wrap">
            <table className="c-pl-table">
              <thead>
                <tr>
                  <th>
                    <SortBtn label="Company" active={sort === 'company'} order={order} onClick={() => clickSort('company')} />
                  </th>
                  <th>Role</th>
                  <th>Location</th>
                  <th className="c-pl-num">
                    <SortBtn label="Stage A" active={sort === 'score'} order={order} onClick={() => clickSort('score')} />
                  </th>
                  <th>
                    <SortBtn label="Posted" active={sort === 'posted_at'} order={order} onClick={() => clickSort('posted_at')} />
                  </th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data!.jobs.map((j) => (
                  <Row key={j.id} job={j} />
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            offset={offset}
            pageSize={PAGE_SIZE}
            filtered={data!.filtered}
            onChange={setOffset}
          />
        </>
      )}
    </section>
  )
}

function SortBtn({
  label,
  active,
  order,
  onClick,
}: {
  label: string
  active: boolean
  order: SortOrder
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`c-pl-sort${active ? ' c-pl-sort-active' : ''}`}
      onClick={onClick}
    >
      {label}
      {active && <span className="c-pl-sort-arrow">{order === 'asc' ? ' ↑' : ' ↓'}</span>}
    </button>
  )
}

function Row({ job }: { job: Job }) {
  const stageA = job.evaluation?.stage_a?.score
  const locText = Array.isArray(job.location)
    ? job.location.slice(0, 2).join(', ') + (job.location.length > 2 ? ` +${job.location.length - 2}` : '')
    : (job.location ?? '')
  const posted = formatDate(job.posted_at)
  return (
    <tr>
      <td className="c-pl-td-company">
        <div className="c-pl-company">{job.company}</div>
        {job.source && (
          <div className="c-pl-source-tag">{job.source.type}</div>
        )}
      </td>
      <td className="c-pl-td-role">
        <span title={job.role}>{truncate(job.role, 70)}</span>
        {job.comp_hint && <span className="c-pl-comp">{job.comp_hint}</span>}
      </td>
      <td className="c-pl-td-loc">{locText || <span className="c-pl-muted">—</span>}</td>
      <td className="c-pl-num">
        {Number.isFinite(stageA) ? (
          <ScorePill score={stageA as number} />
        ) : (
          <span className="c-pl-muted">—</span>
        )}
      </td>
      <td>{posted}</td>
      <td>
        {job.status ? (
          <span className="c-pl-status">{job.status}</span>
        ) : (
          <span className="c-pl-muted">unrated</span>
        )}
      </td>
      <td>
        <a
          className="c-pl-link"
          href={job.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open job posting"
        >
          <ExternalLink size={14} />
        </a>
      </td>
    </tr>
  )
}

function ScorePill({ score }: { score: number }) {
  const cls =
    score >= 4 ? 'c-pl-score-ok' : score >= 3 ? 'c-pl-score-warn' : 'c-pl-score-bad'
  return <span className={`c-pl-score ${cls}`}>{score.toFixed(1)}</span>
}

function Pager({
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
    <div className="c-pl-pager">
      <button
        type="button"
        className="c-pl-btn c-pl-btn-ghost"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - pageSize))}
      >
        ← Prev
      </button>
      <span className="c-pl-pager-label">
        Page {page} / {last}
      </span>
      <button
        type="button"
        className="c-pl-btn c-pl-btn-ghost"
        disabled={offset + pageSize >= filtered}
        onClick={() => onChange(offset + pageSize)}
      >
        Next →
      </button>
    </div>
  )
}

function EmptyHint({ kind, total }: { kind: 'no-scan' | 'all-filtered' | 'no-match'; total?: number }) {
  if (kind === 'no-scan') {
    return (
      <div className="c-pl-empty-box">
        <p className="c-pl-empty">
          No jobs yet. Configure sources in <code>/career/settings/portals</code> and click <strong>Run scan now</strong>.
        </p>
      </div>
    )
  }
  if (kind === 'all-filtered') {
    return (
      <div className="c-pl-empty-box">
        <p className="c-pl-empty">
          Scan returned <strong>{total}</strong> raw jobs but <strong>0</strong> survived <code>hard_filters</code>.
        </p>
        <p className="c-pl-empty-sub">
          Common culprits: seniority allowlist too strict, comp_floor too high,
          posted_within_days too short. Edit <code>/career/settings/preferences</code> → Hard Filters,
          or check the dry-run breakdown there.
        </p>
      </div>
    )
  }
  return (
    <div className="c-pl-empty-box">
      <p className="c-pl-empty">No jobs match your filter.</p>
    </div>
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const days = Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000))
  if (days === 0) return 'today'
  if (days === 1) return '1d ago'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return new Date(t).toISOString().slice(0, 10)
}
