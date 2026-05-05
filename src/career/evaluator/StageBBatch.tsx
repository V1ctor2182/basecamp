import { useEffect, useRef, useState } from 'react'
import {
  ScanSearch,
  ExternalLink,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  Circle,
  Loader2,
  FileText,
  Globe,
} from 'lucide-react'
import ReportViewer from './ReportViewer'
import './stageBBatch.css'

type StageBStatus = 'evaluated' | 'error'

type EvaluatedRow = {
  id: string
  company: string
  role: string
  url: string
  location: string[]
  total_score: number | null
  blocks_emitted: string[]
  report_path: string | null
  status: StageBStatus
  evaluated_at: string
  cost_usd: number
  web_search_requests: number
  tool_rounds_used: number
  error: string | null
}

type ResultsResp = {
  total: number
  pending: number
  evaluated_count: number
  threshold: number
  results: EvaluatedRow[]
}

type RunResp = {
  total: number
  evaluated: number
  errors: number
  skipped: number
  total_cost_usd: number
  total_web_search_requests: number
  threshold: number
}

const REFRESH_MS = 30_000

export default function StageBBatch() {
  const [data, setData] = useState<ResultsResp | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [actionMessage, setActionMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [viewingJobId, setViewingJobId] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  async function fetchResults(signal?: AbortSignal) {
    try {
      const r = await fetch('/api/career/evaluate/stage-b/results', { signal })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const json = (await r.json()) as ResultsResp
      setData(json)
      setLoadError(null)
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return
      setLoadError((e as Error).message ?? 'Failed to load')
    }
  }

  useEffect(() => {
    const ctrl = new AbortController()
    abortRef.current = ctrl
    fetchResults(ctrl.signal)
    // Pass the same signal so polling fetches abort cleanly on unmount —
    // prevents setState-after-unmount when a poll is mid-flight.
    const t = setInterval(() => fetchResults(ctrl.signal), REFRESH_MS)
    return () => {
      ctrl.abort()
      clearInterval(t)
    }
  }, [])

  async function runStageB() {
    if (running || !data || data.pending === 0) return
    setRunning(true)
    setActionMessage(null)
    try {
      const r = await fetch('/api/career/evaluate/stage-b', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const body = (await r.json().catch(() => ({}))) as Partial<RunResp & { error?: string }>
      if (r.status === 409) {
        setActionMessage({
          kind: 'error',
          text: body?.error ?? 'pipeline busy — retry in a moment',
        })
        return
      }
      if (!r.ok) {
        setActionMessage({ kind: 'error', text: body?.error ?? `HTTP ${r.status}` })
        return
      }
      const cost = (body.total_cost_usd ?? 0).toFixed(4)
      const webSearchSuffix =
        body.total_web_search_requests && body.total_web_search_requests > 0
          ? ` · ${body.total_web_search_requests} web_search`
          : ''
      setActionMessage({
        kind: 'ok',
        text:
          `Evaluated ${body.evaluated ?? 0}` +
          (body.errors ? ` · ${body.errors} errors` : '') +
          ` · $${cost}${webSearchSuffix}`,
      })
      await fetchResults()
    } catch (e) {
      setActionMessage({ kind: 'error', text: (e as Error).message ?? 'Network error' })
    } finally {
      setRunning(false)
    }
  }

  if (loadError && !data) {
    return (
      <div className="sbb-card">
        <div className="sbb-error">
          <AlertTriangle size={14} /> Failed to load: {loadError}
        </div>
      </div>
    )
  }
  if (!data) {
    return (
      <div className="sbb-card">
        <div className="sbb-loading">Loading Stage B…</div>
      </div>
    )
  }

  const allEvaluated = data.evaluated_count > 0 && data.pending === 0

  return (
    <div className="sbb-card">
      <header className="sbb-header">
        <div className="sbb-title">
          <ScanSearch size={18} />
          <h3>Stage B · Sonnet deep eval</h3>
          {data.pending > 0 ? (
            <span className="sbb-pending-badge">{data.pending} awaiting deep eval</span>
          ) : data.evaluated_count === 0 ? (
            <span className="sbb-empty-badge">no Stage A passers yet</span>
          ) : (
            <span className="sbb-done-badge">all done 🎉</span>
          )}
          <span className="sbb-threshold-hint" title="Stage A score threshold to qualify for Stage B">
            ≥ {data.threshold.toFixed(1)}
          </span>
        </div>
        <div className="sbb-actions">
          <button
            type="button"
            className="sbb-refresh"
            onClick={() => fetchResults()}
            aria-label="Refresh"
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            className="sbb-run-btn"
            disabled={running || data.pending === 0}
            onClick={runStageB}
          >
            {running ? (
              <><Loader2 size={14} className="sbb-spin" /> Running…</>
            ) : (
              <>Run Stage B on {data.pending} pending</>
            )}
          </button>
        </div>
      </header>

      {actionMessage && (
        <div className={actionMessage.kind === 'ok' ? 'sbb-toast-ok' : 'sbb-toast-error'}>
          {actionMessage.kind === 'ok' ? <CheckCircle size={14} /> : <AlertTriangle size={14} />}
          {actionMessage.text}
        </div>
      )}

      {data.results.length === 0 ? (
        <div className="sbb-empty">
          {allEvaluated
            ? 'No deep-evaluated jobs to display yet. Refresh after a Stage B run.'
            : 'No Stage B reports yet. Run Stage A first, then click Run Stage B above.'}
        </div>
      ) : (
        <table className="sbb-table">
          <thead>
            <tr>
              <th>Score</th>
              <th>Role · Company</th>
              <th>Blocks</th>
              <th>Tools</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {data.results.map((row) => (
              <tr key={row.id} className={`sbb-row sbb-row-${row.status}`}>
                <td><ScoreBadge score={row.total_score} status={row.status} /></td>
                <td>
                  <div className="sbb-role">{row.role}</div>
                  <div className="sbb-meta">
                    {row.company}
                    {Array.isArray(row.location) && row.location.length > 0 && (
                      <> · {row.location.join(' / ')}</>
                    )}
                  </div>
                </td>
                <td className="sbb-blocks">
                  {row.status === 'error' ? (
                    <span className="sbb-reason-error" title={row.error ?? ''}>
                      {row.error ?? 'error'}
                    </span>
                  ) : row.blocks_emitted.length === 0 ? (
                    <span className="sbb-meta">—</span>
                  ) : (
                    row.blocks_emitted.map((k) => (
                      <span key={k} className="sbb-block-chip">{k}</span>
                    ))
                  )}
                </td>
                <td className="sbb-tools">
                  {row.web_search_requests > 0 && (
                    <span className="sbb-tool-chip" title={`${row.web_search_requests} web_search request(s)`}>
                      <Globe size={11} /> {row.web_search_requests}
                    </span>
                  )}
                  {row.tool_rounds_used > 1 && (
                    <span className="sbb-tool-chip" title={`${row.tool_rounds_used} tool-use rounds`}>
                      ↻ {row.tool_rounds_used}
                    </span>
                  )}
                </td>
                <td className="sbb-row-actions">
                  <a
                    href={row.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="sbb-btn-link"
                    aria-label="Open job posting"
                  >
                    <ExternalLink size={12} />
                  </a>
                  <button
                    type="button"
                    className="sbb-view-report"
                    disabled={!row.report_path || row.status === 'error'}
                    onClick={() => setViewingJobId(row.id)}
                    title={row.report_path ? 'View Stage B report' : 'No report (eval errored)'}
                  >
                    <FileText size={12} /> Report
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {viewingJobId && (
        <ReportViewer jobId={viewingJobId} onClose={() => setViewingJobId(null)} />
      )}
    </div>
  )
}

function ScoreBadge({ score, status }: { score: number | null; status: StageBStatus }) {
  if (status === 'error') {
    return <span className="sbb-score sbb-score-error"><AlertTriangle size={12} /> err</span>
  }
  if (score == null) {
    return <span className="sbb-score sbb-score-archived"><Circle size={12} /> —</span>
  }
  let cls = 'sbb-score-archived'
  if (score >= 4.5) cls = 'sbb-score-strong'
  else if (score >= 4.0) cls = 'sbb-score-worth'
  else if (score >= 3.5) cls = 'sbb-score-consider'
  return <span className={`sbb-score ${cls}`}>{score.toFixed(1)}</span>
}
