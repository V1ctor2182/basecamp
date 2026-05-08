// Reports page — two render paths via useParams:
//
// 1) /career/reports         → list view of all stage_b-evaluated jobs
//                              (incl. status='error' rows so user can see
//                              why a deep eval failed). Click → detail.
// 2) /career/reports/:id     → markdown detail view with Block A-G sticky
//                              sidebar nav (auto-derived from content) +
//                              page actions (Tailor / Open in Pipeline /
//                              Print).
//
// Reuses already-shipped infrastructure:
//   GET /api/career/evaluate/stage-b/results   — list source
//   GET /api/career/evaluate/stage-b/report/:id — markdown source
//   <TailorPanel jobId jobRole? jobCompany? onClose />   — tailor modal

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowLeft,
  AlertTriangle,
  Loader2,
  ExternalLink,
  Printer,
  Wand2,
  Workflow,
} from 'lucide-react'
import TailorPanel from './cv/TailorPanel'
import './reports.css'

type ResultsRow = {
  id: string
  company: string
  role: string
  url: string
  location: string[]
  total_score: number | null
  blocks_emitted: string[]
  report_path: string | null
  status: 'evaluated' | 'error' | string
  evaluated_at: string
  cost_usd: number | null
  error: string | null
}

type ResultsResp = {
  total: number
  pending: number
  evaluated_count: number
  threshold: number
  results: ResultsRow[]
}

type ReportData = {
  content: string
  evaluated_at: string
  total_score: number | null
  blocks_emitted: string[]
}

const BLOCK_LABELS: Record<string, string> = {
  A: 'Role Summary',
  B: 'CV Match',
  C: 'Level & Strategy',
  D: 'Comp & Demand',
  E: 'Personalization',
  F: 'Interview Plan',
  G: 'Posting Legitimacy',
}

export default function Reports() {
  const { id } = useParams<{ id?: string }>()
  if (id) return <ReportDetail jobId={id} />
  return <ReportsList />
}

// ─── List view ─────────────────────────────────────────────────────────
function ReportsList() {
  const navigate = useNavigate()
  const [data, setData] = useState<ResultsResp | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    fetch('/api/career/evaluate/stage-b/results', { signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<ResultsResp>
      })
      .then(setData)
      .catch((e: Error) => {
        if (e.name === 'AbortError') return
        setError(e.message ?? 'Failed to load reports')
      })
    return () => ctrl.abort()
  }, [])

  if (error) {
    return (
      <div className="c-page">
        <h2>Reports</h2>
        <div className="rp-error">
          <AlertTriangle size={14} /> Failed to load: {error}
        </div>
      </div>
    )
  }

  return (
    <div className="c-page">
      <h2>Reports</h2>
      <p className="c-page-todo">
        All Stage B-evaluated jobs (incl. errors). Click a row to read the full
        Block A-G report.
      </p>

      {!data ? (
        <div className="rp-loading">
          <Loader2 size={14} className="rp-spin" /> Loading reports…
        </div>
      ) : data.results.length === 0 ? (
        <div className="rp-empty">
          No Stage B reports yet. Head to{' '}
          <Link to="/career/pipeline" className="rp-link">/career/pipeline</Link>{' '}
          to run Stage B first.
        </div>
      ) : (
        <table className="rp-table">
          <thead>
            <tr>
              <th>Score</th>
              <th>Role · Company</th>
              <th>Status</th>
              <th>Evaluated</th>
            </tr>
          </thead>
          <tbody>
            {data.results.map((row) => (
              <tr
                key={row.id}
                className={`rp-row${row.status === 'error' ? ' rp-row-error' : ''}`}
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
                <td>
                  {row.status === 'error' ? (
                    <span className="rp-score rp-score-error">err</span>
                  ) : typeof row.total_score === 'number' ? (
                    <ScoreBadge score={row.total_score} />
                  ) : (
                    <span className="rp-meta">—</span>
                  )}
                </td>
                <td>
                  <div className="rp-role">{row.role}</div>
                  <div className="rp-meta">
                    {row.company}
                    {Array.isArray(row.location) && row.location.length > 0 && (
                      <> · {row.location.join(' / ')}</>
                    )}
                  </div>
                </td>
                <td>
                  {row.status === 'error' ? (
                    <span className="rp-status-err" title={row.error ?? ''}>
                      <AlertTriangle size={11} /> error
                    </span>
                  ) : (
                    <span className="rp-status-ok">evaluated</span>
                  )}
                </td>
                <td className="rp-meta rp-evaluated">
                  {formatRelative(row.evaluated_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ─── Detail view ───────────────────────────────────────────────────────
function ReportDetail({ jobId }: { jobId: string }) {
  const navigate = useNavigate()
  const [report, setReport] = useState<ReportData | null>(null)
  const [meta, setMeta] = useState<ResultsRow | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tailorOpen, setTailorOpen] = useState(false)
  const [activeBlock, setActiveBlock] = useState<string | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)

  // Fetch report content + side-fetch row metadata for header / TailorPanel
  useEffect(() => {
    const ctrl = new AbortController()
    setReport(null)
    setMeta(null)
    setLoadError(null)
    setActiveBlock(null)

    fetch(`/api/career/evaluate/stage-b/report/${encodeURIComponent(jobId)}`, { signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          throw new Error(j.error ?? `HTTP ${r.status}`)
        }
        return r.json() as Promise<ReportData>
      })
      .then(setReport)
      .catch((e: Error) => {
        if (e.name === 'AbortError') return
        setLoadError(e.message)
      })

    fetch('/api/career/evaluate/stage-b/results', { signal: ctrl.signal })
      .then(async (r) => (r.ok ? (r.json() as Promise<ResultsResp>) : null))
      .then((j) => {
        if (!j) return
        const row = j.results.find((x) => x.id === jobId)
        if (row) setMeta(row)
      })
      .catch(() => { /* meta is optional — header falls back to id */ })

    return () => ctrl.abort()
  }, [jobId])

  // Derive Block A-G letters present in the markdown content
  const blocks = useMemo<string[]>(() => {
    if (!report?.content) return []
    const re = /^## Block ([A-G])\b/gm
    const seen = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = re.exec(report.content)) !== null) seen.add(m[1])
    return Array.from(seen).sort()
  }, [report])

  // IntersectionObserver tracks which Block heading is currently in view.
  // Anchored on data-block attributes that ReactMarkdown's h2 renderer adds.
  useEffect(() => {
    const root = contentRef.current
    if (!root || blocks.length === 0) return
    const headings = root.querySelectorAll<HTMLElement>('[data-block]')
    if (headings.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the topmost heading that's currently intersecting
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible.length > 0) {
          const letter = (visible[0].target as HTMLElement).dataset.block ?? null
          if (letter) setActiveBlock(letter)
        }
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 }
    )
    headings.forEach((h) => observer.observe(h))
    return () => observer.disconnect()
  }, [blocks])

  const handlePrint = () => window.print()
  const handleOpenPipeline = () => navigate('/career/pipeline')
  const scrollToBlock = (letter: string) => {
    const el = document.getElementById(`block-${letter}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  if (loadError) {
    return (
      <div className="c-page">
        <button
          type="button"
          className="rp-back"
          onClick={() => navigate('/career/reports')}
        >
          <ArrowLeft size={14} /> All reports
        </button>
        <h2>Report — {jobId}</h2>
        <div className="rp-error">
          <AlertTriangle size={14} /> {loadError}
        </div>
        <p>
          The report may not exist yet, or the Stage B run errored.{' '}
          <Link to="/career/pipeline" className="rp-link">
            Re-run from Pipeline →
          </Link>
        </p>
      </div>
    )
  }

  if (!report) {
    return (
      <div className="c-page">
        <button
          type="button"
          className="rp-back"
          onClick={() => navigate('/career/reports')}
        >
          <ArrowLeft size={14} /> All reports
        </button>
        <h2>Report — {jobId}</h2>
        <div className="rp-loading">
          <Loader2 size={14} className="rp-spin" /> Loading report…
        </div>
      </div>
    )
  }

  return (
    <div className="c-page rp-detail">
      {/* Top bar — back link + actions (hidden in print) */}
      <div className="rp-topbar">
        <button
          type="button"
          className="rp-back"
          onClick={() => navigate('/career/reports')}
        >
          <ArrowLeft size={14} /> All reports
        </button>
        <div className="rp-actions">
          <button
            type="button"
            className="rp-action-btn"
            onClick={() => setTailorOpen(true)}
          >
            <Wand2 size={12} /> Tailor for this job
          </button>
          <button
            type="button"
            className="rp-action-btn"
            onClick={handleOpenPipeline}
          >
            <Workflow size={12} /> Open in Pipeline
          </button>
          <button
            type="button"
            className="rp-action-btn"
            onClick={handlePrint}
          >
            <Printer size={12} /> Print
          </button>
        </div>
      </div>

      {/* Header — uses meta when available, falls back to jobId */}
      <header className="rp-header">
        <h2 className="rp-title">
          {meta ? meta.role : `Report — ${jobId}`}
        </h2>
        <div className="rp-subhead">
          {meta && (
            <>
              <span>{meta.company}</span>
              {meta.url && (
                <>
                  {' · '}
                  <a
                    href={meta.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rp-link"
                  >
                    posting <ExternalLink size={10} />
                  </a>
                </>
              )}
            </>
          )}
          {report.total_score != null && (
            <>
              {meta && ' · '}
              <ScoreBadge score={report.total_score} />
            </>
          )}
          {' · evaluated '}
          {new Date(report.evaluated_at).toLocaleString()}
        </div>
      </header>

      {/* Body — sticky sidebar + markdown content */}
      <div className="rp-body">
        <aside className="rp-sidebar" aria-label="Block navigation">
          <div className="rp-sidebar-title">Blocks</div>
          {blocks.length === 0 ? (
            <div className="rp-sidebar-empty">No section headers found</div>
          ) : (
            <ul className="rp-toc">
              {blocks.map((letter) => (
                <li key={letter}>
                  <button
                    type="button"
                    className={`rp-toc-link${activeBlock === letter ? ' rp-toc-active' : ''}`}
                    onClick={() => scrollToBlock(letter)}
                  >
                    <span className="rp-toc-letter">{letter}</span>
                    <span className="rp-toc-label">
                      {BLOCK_LABELS[letter] ?? ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <article className="rp-content" ref={contentRef}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h2: ({ node, children, ...props }) => {
                const text = childrenToString(children)
                const m = text.match(/^Block ([A-G])\b/)
                if (m) {
                  const letter = m[1]
                  return (
                    <h2
                      id={`block-${letter}`}
                      data-block={letter}
                      {...props}
                    >
                      {children}
                    </h2>
                  )
                }
                return <h2 {...props}>{children}</h2>
              },
            }}
          >
            {report.content}
          </ReactMarkdown>
        </article>
      </div>

      {tailorOpen && (
        <TailorPanel
          jobId={jobId}
          jobRole={meta?.role}
          jobCompany={meta?.company}
          onClose={() => setTailorOpen(false)}
        />
      )}
    </div>
  )
}

// Helpers ──────────────────────────────────────────────────────────────
function childrenToString(children: unknown): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map(childrenToString).join('')
  if (children && typeof children === 'object' && 'props' in children) {
    return childrenToString((children as { props: { children: unknown } }).props.children)
  }
  return ''
}

function ScoreBadge({ score }: { score: number }) {
  let cls = 'rp-score-consider'
  if (score >= 4.5) cls = 'rp-score-strong'
  else if (score >= 4.0) cls = 'rp-score-worth'
  return <span className={`rp-score ${cls}`}>{score.toFixed(1)}</span>
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
