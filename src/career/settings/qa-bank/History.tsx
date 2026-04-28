import { useEffect, useMemo, useState } from 'react'
import '../ats-form.css'

type HistoryRecord = {
  ts?: string
  job_id?: string
  company?: string
  role?: string
  field_type: 'legal' | 'open' | 'eeo' | 'other'
  q: string
  a_draft?: string
  a_final?: string
  edit_distance?: number
  template_used?: string
  model_used?: string
}

function trunc(s: string | undefined, n: number): string {
  if (!s) return ''
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function fmtTs(iso: string | undefined): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch { return iso }
}

export default function History() {
  const [rows, setRows] = useState<HistoryRecord[]>([])
  const [loaded, setLoaded] = useState(false)
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/career/qa-bank/history?limit=200')
      .then(r => r.json())
      .then(data => { setRows(Array.isArray(data) ? data : []); setLoaded(true) })
      .catch(e => { setError(e instanceof Error ? e.message : 'Network error'); setLoaded(true) })
  }, [])

  const filtered = useMemo(() => {
    if (!search.trim()) return rows
    const needle = search.toLowerCase()
    return rows.filter(r => {
      const hay = `${r.q} ${r.a_final ?? ''} ${r.a_draft ?? ''} ${r.company ?? ''} ${r.role ?? ''}`.toLowerCase()
      return hay.includes(needle)
    })
  }, [rows, search])

  if (!loaded) return <div className="af-loading">Loading history…</div>
  if (error) return <div className="af-loading" style={{ color: '#cf222e' }}>Error: {error}</div>

  return (
    <div className="c-qa-history">
      <div className="c-qa-history-toolbar">
        <input
          type="search"
          className="af-input"
          placeholder="Search question / answer / company / role…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ maxWidth: 360 }}
        />
        <span className="c-qa-history-count">
          Showing {filtered.length} of {rows.length} record{rows.length === 1 ? '' : 's'}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="c-qa-history-empty">
          No history yet — apply to a job to start the QA log.
          <br />
          <span style={{ fontSize: 12, color: '#999' }}>
            (Applier 完成填表后会 POST 到 /api/career/qa-bank/history。)
          </span>
        </div>
      ) : (
        <div className="c-qa-history-table-wrap">
          <table className="c-qa-history-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Company</th>
                <th>Role</th>
                <th>Type</th>
                <th>Question</th>
                <th>Answer</th>
                <th>Template</th>
                <th>Model</th>
                <th>Edit Δ</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const answer = r.a_final ?? r.a_draft ?? ''
                return (
                  <tr key={(r.ts ?? '') + i} className="c-qa-history-row">
                    <td title={r.ts}>{fmtTs(r.ts)}</td>
                    <td>{r.company ?? '—'}</td>
                    <td>{r.role ?? '—'}</td>
                    <td>
                      <span className={`c-qa-history-badge c-qa-history-badge-${r.field_type}`}>
                        {r.field_type}
                      </span>
                    </td>
                    <td title={r.q}>{trunc(r.q, 80)}</td>
                    <td title={answer}>{trunc(answer, 80)}</td>
                    <td>{r.template_used ?? '—'}</td>
                    <td>{r.model_used ?? '—'}</td>
                    <td className="c-qa-history-num">
                      {r.edit_distance !== undefined ? r.edit_distance : '—'}
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && rows.length > 0 && (
                <tr><td colSpan={9} className="c-qa-history-empty-row">No matches.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
