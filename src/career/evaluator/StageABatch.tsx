import { useEffect, useRef, useState } from 'react'
import { Sparkles, ExternalLink, RefreshCw, AlertTriangle, CheckCircle, Circle, Loader2 } from 'lucide-react'
import './stageABatch.css'

type StageAStatus = 'evaluated' | 'archived' | 'error'

type EvaluatedRow = {
  id: string
  company: string
  role: string
  url: string
  location: string[]
  score: number | null
  reason: string | null
  status: StageAStatus
  evaluated_at: string
  cost_usd: number
  error: string | null
}

type ResultsResp = {
  total: number
  pending: number
  evaluated_count: number
  results: EvaluatedRow[]
}

type RunResp = {
  total: number
  evaluated: number
  archived: number
  errors: number
  skipped: number
  total_cost_usd: number
}

const REFRESH_MS = 30_000

export default function StageABatch() {
  const [data, setData] = useState<ResultsResp | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [actionMessage, setActionMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  async function fetchResults(signal?: AbortSignal) {
    try {
      const r = await fetch('/api/career/evaluate/stage-a/results', { signal })
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
    const t = setInterval(() => fetchResults(), REFRESH_MS)
    return () => {
      ctrl.abort()
      clearInterval(t)
    }
  }, [])

  async function runStageA() {
    if (running || !data || data.pending === 0) return
    setRunning(true)
    setActionMessage(null)
    try {
      const r = await fetch('/api/career/evaluate/stage-a', {
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
      setActionMessage({
        kind: 'ok',
        text: `Evaluated ${body.evaluated ?? 0} · archived ${body.archived ?? 0}` +
          (body.errors ? ` · ${body.errors} errors` : '') +
          ` · $${cost}`,
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
      <div className="sab-card">
        <div className="sab-error">
          <AlertTriangle size={14} /> Failed to load: {loadError}
        </div>
      </div>
    )
  }
  if (!data) {
    return (
      <div className="sab-card">
        <div className="sab-loading">Loading Stage A…</div>
      </div>
    )
  }

  const allEvaluated = data.total > 0 && data.pending === 0

  return (
    <div className="sab-card">
      <header className="sab-header">
        <div className="sab-title">
          <Sparkles size={18} />
          <h3>Stage A · Haiku quick eval</h3>
          {data.pending > 0 ? (
            <span className="sab-pending-badge">{data.pending} pending</span>
          ) : data.total === 0 ? (
            <span className="sab-empty-badge">no jobs in pipeline</span>
          ) : (
            <span className="sab-done-badge">all evaluated 🎉</span>
          )}
        </div>
        <div className="sab-actions">
          <button
            type="button"
            className="sab-refresh"
            onClick={() => fetchResults()}
            aria-label="Refresh"
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            className="sab-run-btn"
            disabled={running || data.pending === 0}
            onClick={runStageA}
          >
            {running ? (
              <><Loader2 size={14} className="sab-spin" /> Running…</>
            ) : (
              <>Run Stage A on {data.pending} pending</>
            )}
          </button>
        </div>
      </header>

      {actionMessage && (
        <div className={actionMessage.kind === 'ok' ? 'sab-toast-ok' : 'sab-toast-error'}>
          {actionMessage.kind === 'ok' ? <CheckCircle size={14} /> : <AlertTriangle size={14} />}
          {actionMessage.text}
        </div>
      )}

      {data.results.length === 0 ? (
        <div className="sab-empty">
          {allEvaluated
            ? 'No evaluated jobs to display yet. Refresh after a scan.'
            : 'No jobs evaluated. Click Run Stage A above to start.'}
        </div>
      ) : (
        <table className="sab-table">
          <thead>
            <tr>
              <th>Score</th>
              <th>Role · Company</th>
              <th>Reason</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {data.results.map((row) => (
              <tr key={row.id} className={`sab-row sab-row-${row.status}`}>
                <td><ScoreBadge score={row.score} status={row.status} /></td>
                <td>
                  <div className="sab-role">{row.role}</div>
                  <div className="sab-meta">
                    {row.company}
                    {Array.isArray(row.location) && row.location.length > 0 && (
                      <> · {row.location.join(' / ')}</>
                    )}
                  </div>
                </td>
                <td className="sab-reason" title={row.reason ?? row.error ?? ''}>
                  {row.status === 'error'
                    ? <span className="sab-reason-error">{row.error ?? 'error'}</span>
                    : (row.reason ?? '—')}
                </td>
                <td className="sab-row-actions">
                  <a
                    href={row.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="sab-btn-link"
                    aria-label="Open job posting"
                  >
                    <ExternalLink size={12} />
                  </a>
                  <button
                    type="button"
                    className="sab-force-sonnet"
                    disabled
                    title="Force Sonnet override on a single job — wires up in 06-evaluator/05-pipeline-ui"
                  >
                    Force Sonnet
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function ScoreBadge({ score, status }: { score: number | null; status: StageAStatus }) {
  if (status === 'error') {
    return <span className="sab-score sab-score-error"><AlertTriangle size={12} /> err</span>
  }
  if (score == null) {
    return <span className="sab-score sab-score-archived"><Circle size={12} /> —</span>
  }
  let cls = 'sab-score-archived'
  if (status === 'evaluated' && score >= 4.0) cls = 'sab-score-strong'
  else if (status === 'evaluated' && score >= 3.5) cls = 'sab-score-worth'
  else if (status === 'evaluated') cls = 'sab-score-consider'
  return <span className={`sab-score ${cls}`}>{score.toFixed(1)}</span>
}
