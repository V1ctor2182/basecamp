import { useEffect, useRef, useState } from 'react'
import { Clock, Play, RefreshCw, AlertTriangle, CheckCircle, Circle } from 'lucide-react'
import './schedulerPanel.css'

type Row = {
  type: string
  cadence_str: string | null
  cadence_ms: number | null
  cadence_valid: boolean
  last_run_at: string | null
  next_run_at: string | null
  last_outcome: 'ok' | 'partial' | 'error' | null
  last_jobs_count: number | null
  last_error: string | null
  has_active_source: boolean
}

type ScanStatus = {
  running: boolean
  enriching?: boolean
  scan_id: string | null
  filtered_types?: string[] | null
}

type StatusResp = { rows: Row[]; scan_status: ScanStatus }

const REFRESH_MS = 30_000

export default function SchedulerPanel() {
  const [data, setData] = useState<StatusResp | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyType, setBusyType] = useState<string | null>(null) // optimistic "scanning" badge
  const [actionError, setActionError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  async function fetchStatus(signal?: AbortSignal) {
    try {
      const r = await fetch('/api/career/finder/scheduler/status', { signal })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const json = (await r.json()) as StatusResp
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
    fetchStatus(ctrl.signal)
    const t = setInterval(() => fetchStatus(), REFRESH_MS)
    return () => {
      ctrl.abort()
      clearInterval(t)
    }
  }, [])

  async function runNow(type: string) {
    if (busyType) return
    setBusyType(type)
    setActionError(null)
    try {
      const r = await fetch('/api/career/finder/scan/source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        setActionError(body.error ?? `HTTP ${r.status}`)
      }
      // Re-poll status to surface the running scan
      await fetchStatus()
    } catch (e) {
      setActionError((e as Error).message ?? 'Network error')
    } finally {
      setBusyType(null)
    }
  }

  if (loadError && !data) {
    return (
      <div className="sp-card">
        <div className="sp-error">Failed to load scheduler status: {loadError}</div>
      </div>
    )
  }
  if (!data) {
    return (
      <div className="sp-card">
        <div className="sp-loading">Loading scheduler…</div>
      </div>
    )
  }

  const isScanning = data.scan_status.running === true

  return (
    <div className="sp-card">
      <header className="sp-header">
        <div className="sp-title">
          <Clock size={18} />
          <h3>Scan Scheduler</h3>
          {isScanning && (
            <span className="sp-running-badge">
              Scanning{data.scan_status.filtered_types ? `: ${data.scan_status.filtered_types.join(', ')}` : '…'}
            </span>
          )}
        </div>
        <button
          type="button"
          className="sp-refresh"
          onClick={() => fetchStatus()}
          aria-label="Refresh"
        >
          <RefreshCw size={14} />
        </button>
      </header>

      {actionError && (
        <div className="sp-error">
          <AlertTriangle size={14} /> {actionError}
        </div>
      )}

      {data.rows.length === 0 ? (
        <div className="sp-empty">
          {"No scan_cadence configured in portals.yml. Add `scan_cadence: {greenhouse: '72h', ...}` to enable scheduling."}
        </div>
      ) : (
        <table className="sp-table">
          <thead>
            <tr>
              <th>Source Type</th>
              <th>Cadence</th>
              <th>Last Run</th>
              <th>Next Run</th>
              <th>Outcome</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.type} className={r.has_active_source ? '' : 'sp-row-inactive'}>
                <td>
                  <span className="sp-type-name">{r.type}</span>
                  {!r.has_active_source && (
                    <span className="sp-no-source-tag">no source configured</span>
                  )}
                </td>
                <td>
                  {r.cadence_valid ? (
                    <span className="sp-cadence-valid">{r.cadence_str}</span>
                  ) : (
                    <span className="sp-cadence-invalid" title="Cadence string malformed or missing">
                      {r.cadence_str ?? '—'}
                    </span>
                  )}
                </td>
                <td>{formatRelative(r.last_run_at)}</td>
                <td>{formatRelative(r.next_run_at, true)}</td>
                <td><OutcomeBadge outcome={r.last_outcome} jobs={r.last_jobs_count} error={r.last_error} /></td>
                <td>
                  <button
                    type="button"
                    className="sp-run-btn"
                    disabled={isScanning || busyType !== null || !r.has_active_source}
                    onClick={() => runNow(r.type)}
                  >
                    {busyType === r.type ? 'Starting…' : <><Play size={12} /> Run Now</>}
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

function OutcomeBadge({ outcome, jobs, error }: { outcome: Row['last_outcome']; jobs: number | null; error: string | null }) {
  if (outcome == null) return <span className="sp-outcome-never"><Circle size={12} /> never</span>
  if (outcome === 'ok') return <span className="sp-outcome-ok"><CheckCircle size={12} /> ok ({jobs ?? 0})</span>
  if (outcome === 'partial') {
    return (
      <span className="sp-outcome-partial" title={error ?? ''}>
        <AlertTriangle size={12} /> partial ({jobs ?? 0})
      </span>
    )
  }
  return <span className="sp-outcome-error" title={error ?? ''}><AlertTriangle size={12} /> error</span>
}

function formatRelative(iso: string | null, future = false): string {
  if (!iso) return future ? 'pending' : 'never'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const now = Date.now()
  const diff = future ? t - now : now - t
  if (diff < 0) return future ? 'soon' : new Date(iso).toLocaleString()
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return future ? `in ${sec}s` : `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return future ? `in ${min}m` : `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return future ? `in ${h}h` : `${h}h ago`
  const d = Math.floor(h / 24)
  return future ? `in ${d}d` : `${d}d ago`
}
