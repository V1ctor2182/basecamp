import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ClipboardPaste, ExternalLink, Check, X } from 'lucide-react'
import './needsManualEnrich.css'

type NeedsManualJob = {
  id: string
  company: string
  role: string
  url: string
  location: string[]
  posted_at: string | null
  source: { type: string; name: string } | null
}

type RowState = {
  draft: string
  saving: boolean
  error: string | null
  saved: boolean
}

const EMPTY_ROW: RowState = { draft: '', saving: false, error: null, saved: false }

export default function NeedsManualEnrich() {
  const [jobs, setJobs] = useState<NeedsManualJob[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [rows, setRows] = useState<Record<string, RowState>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    abortRef.current = ctrl
    fetch('/api/career/finder/needs-manual', { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => setJobs(Array.isArray(data?.jobs) ? data.jobs : []))
      .catch((e) => {
        if (e.name !== 'AbortError') setLoadError(e.message ?? 'Failed to load')
      })
    return () => ctrl.abort()
  }, [])

  function rowFor(id: string): RowState {
    return rows[id] ?? EMPTY_ROW
  }

  function patchRow(id: string, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY_ROW), ...patch } }))
  }

  async function save(id: string) {
    const row = rowFor(id)
    if (row.saving) return
    if (row.draft.trim().length < 10) {
      patchRow(id, { error: 'Description must be at least 10 characters' })
      return
    }
    patchRow(id, { saving: true, error: null })
    try {
      const r = await fetch(`/api/career/pipeline/job/${encodeURIComponent(id)}/description`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: row.draft }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        patchRow(id, { saving: false, error: body.error ?? `HTTP ${r.status}` })
        return
      }
      // Optimistic remove from list — job no longer needs manual enrich.
      setJobs((prev) => (prev ?? []).filter((j) => j.id !== id))
      patchRow(id, { saving: false, saved: true })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Network error'
      patchRow(id, { saving: false, error: msg })
    }
  }

  if (loadError) {
    return (
      <div className="c-page">
        <BackLink />
        <div className="nme-error">Failed to load: {loadError}</div>
      </div>
    )
  }
  if (jobs == null) {
    return (
      <div className="c-page">
        <BackLink />
        <div className="nme-loading">Loading…</div>
      </div>
    )
  }

  return (
    <div className="c-page nme-page">
      <BackLink />
      <header className="nme-header">
        <div className="nme-header-title">
          <ClipboardPaste size={20} />
          <h2>Jobs needing manual JD paste</h2>
          <span className="nme-counter">{jobs.length} pending</span>
        </div>
        <p className="nme-header-help">
          The 4-tier enrich (skip → ATS → Playwright → manual) couldn't fetch a JD for these jobs.
          Open the URL, copy the JD text, paste it below, and Save. The job will then flow into the evaluator.
        </p>
      </header>

      {jobs.length === 0 ? (
        <div className="nme-empty">🎉 No jobs need manual JD. Run a scan if you want fresh listings.</div>
      ) : (
        <ul className="nme-list">
          {jobs.map((j) => {
            const row = rowFor(j.id)
            const open = expanded[j.id] === true
            return (
              <li key={j.id} className="nme-row">
                <div className="nme-row-meta">
                  <div className="nme-row-title">
                    <strong>{j.role}</strong>
                    <span className="nme-row-sep">·</span>
                    <span>{j.company}</span>
                  </div>
                  <div className="nme-row-sub">
                    {Array.isArray(j.location) && j.location.length > 0 && (
                      <span className="nme-row-location">{j.location.join(' / ')}</span>
                    )}
                    {j.posted_at && (
                      <span className="nme-row-posted">
                        posted {new Date(j.posted_at).toLocaleDateString()}
                      </span>
                    )}
                    {j.source && <span className="nme-row-source">via {j.source.name}</span>}
                  </div>
                </div>
                <div className="nme-row-actions">
                  <a
                    href={j.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="nme-btn-link"
                    aria-label="Open job posting"
                  >
                    <ExternalLink size={14} /> Open
                  </a>
                  <button
                    type="button"
                    className="nme-btn-toggle"
                    onClick={() => setExpanded((p) => ({ ...p, [j.id]: !open }))}
                  >
                    {open ? 'Hide' : 'Paste JD'}
                  </button>
                </div>

                {open && (
                  <div className="nme-paste">
                    <textarea
                      className="nme-textarea"
                      placeholder="Paste the full job description here (≥ 10 chars)…"
                      value={row.draft}
                      onChange={(e) =>
                        patchRow(j.id, { draft: e.target.value, error: null, saved: false })
                      }
                      rows={10}
                      disabled={row.saving}
                    />
                    {row.error && (
                      <div className="nme-err">
                        <X size={12} /> {row.error}
                      </div>
                    )}
                    <div className="nme-paste-actions">
                      <span className="nme-char-count">{row.draft.length} chars</span>
                      <button
                        type="button"
                        className="nme-btn-save"
                        onClick={() => save(j.id)}
                        disabled={row.saving || row.draft.trim().length < 10}
                      >
                        {row.saving ? 'Saving…' : <><Check size={14} /> Save JD</>}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function BackLink() {
  return (
    <Link to="/career/shortlist" className="nme-back">
      <ArrowLeft size={14} /> Shortlist
    </Link>
  )
}
