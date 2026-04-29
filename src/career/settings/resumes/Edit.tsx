import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, RefreshCw, X, History } from 'lucide-react'
import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import '../ats-form.css'
import './edit.css'

type VersionEntry = { filename: string; ts: string; size: number }

function fmtVersionTs(iso: string): string {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, {
      month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
  } catch { return iso }
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}

export default function ResumeEdit() {
  const { id = '' } = useParams<{ id: string }>()

  const [content, setContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  // Bump on save (or manual Refresh) — appended to iframe src= so the
  // browser fetches a fresh PDF instead of using the cached previous render.
  const [pdfRefreshKey, setPdfRefreshKey] = useState(() => Date.now())
  const [versions, setVersions] = useState<VersionEntry[]>([])
  const [showVersions, setShowVersions] = useState(false)
  const versionsBtnRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    setServerError(null)
    fetch(`/api/career/resumes/${id}/content`)
      .then(async r => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          throw new Error(j.error || `HTTP ${r.status}`)
        }
        return r.json()
      })
      .then(data => {
        if (cancelled) return
        setContent(data?.content ?? '')
        setVersions(Array.isArray(data?.versions) ? data.versions : [])
        setLoaded(true)
      })
      .catch(e => {
        if (cancelled) return
        setServerError(e instanceof Error ? e.message : 'Network error')
        setLoaded(true)
      })
    return () => { cancelled = true }
  }, [id])

  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  function onChange(v: string) {
    setContent(v)
    setDirty(true)
    setSavedAt(null)
  }

  async function save() {
    if (!dirty || saving) return
    setSaving(true); setServerError(null)
    try {
      const r = await fetch(`/api/career/resumes/${id}/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        setServerError(j.error || `HTTP ${r.status}`)
        return
      }
      setDirty(false)
      setSavedAt(new Date().toLocaleTimeString())
      // Disk now reflects the saved content; bump iframe to re-fetch.
      setPdfRefreshKey(Date.now())
      // Refresh versions list — server just appended a new pre-write snapshot.
      fetch(`/api/career/resumes/${id}/content`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (Array.isArray(d?.versions)) setVersions(d.versions) })
        .catch(() => { /* non-critical */ })
    } catch (e) {
      setServerError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setSaving(false)
    }
  }

  async function handleRestore(filename: string) {
    setShowVersions(false)
    if (dirty) {
      // Loading a version replaces the editor — confirm before clobbering.
      const ok = window.confirm(
        'Discard your unsaved changes and load this version into the editor?\n' +
        '(The version becomes a draft — you still need to click Save to commit it.)'
      )
      if (!ok) return
    }
    setServerError(null)
    try {
      const r = await fetch(`/api/career/resumes/${id}/versions/${encodeURIComponent(filename)}`)
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        setServerError(j.error || `HTTP ${r.status}`)
        return
      }
      const data = await r.json()
      setContent(data.content ?? '')
      // Mark dirty so the user sees they have to click Save to commit the
      // restore. This also gives them a chance to bail (close tab → beforeunload).
      setDirty(true)
      setSavedAt(null)
    } catch (e) {
      setServerError(e instanceof Error ? e.message : 'Network error')
    }
  }

  // Close the versions popover on outside-click + Escape.
  useEffect(() => {
    if (!showVersions) return
    const onClick = (e: MouseEvent) => {
      if (versionsBtnRef.current && !versionsBtnRef.current.contains(e.target as Node)) {
        setShowVersions(false)
      }
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowVersions(false) }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [showVersions])

  return (
    <div className="c-resume-edit-page">
      <div className="c-resume-edit-toolbar">
        <Link to="/career/settings/resumes" className="c-resume-edit-back">
          <ArrowLeft size={14} /> Back to Resumes
        </Link>
        <h2 className="c-resume-edit-title">{id}</h2>
        <div className="c-resume-edit-actions">
          <div className="c-resume-versions-anchor" ref={versionsBtnRef}>
            <button
              type="button"
              className="c-resume-versions-button"
              onClick={() => setShowVersions(v => !v)}
              aria-expanded={showVersions}
              aria-haspopup="menu"
              title="Restore from a previous saved version"
            >
              <History size={13} />
              Versions ({versions.length})
            </button>
            {showVersions && (
              <div className="c-resume-versions-panel" role="menu">
                <div className="c-resume-versions-header">
                  Saved snapshots
                </div>
                {versions.length === 0 ? (
                  <div className="c-resume-versions-empty">
                    No versions yet. Save the editor once to start the snapshot history.
                  </div>
                ) : (
                  <ul className="c-resume-versions-list">
                    {versions.map(v => (
                      <li key={v.filename} className="c-resume-versions-row">
                        <div className="c-resume-versions-meta">
                          <div className="c-resume-versions-ts">{fmtVersionTs(v.ts)}</div>
                          <div className="c-resume-versions-size">{fmtSize(v.size)}</div>
                        </div>
                        <button
                          type="button"
                          className="af-btn-add"
                          onClick={() => handleRestore(v.filename)}
                          style={{ marginTop: 0, padding: '4px 10px', fontSize: 12 }}
                        >
                          Load
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          <span
            className={`c-resume-edit-status${dirty ? ' dirty' : savedAt ? ' saved' : ''}`}
            aria-live="polite"
          >
            {saving ? 'Saving…' :
             dirty ? 'Unsaved changes' :
             savedAt ? `✓ Saved at ${savedAt}` :
             'Ready'}
          </span>
          <button
            type="button"
            className="af-btn-primary"
            disabled={!dirty || saving}
            onClick={save}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {serverError && (
        <div className="c-resumes-modal-error c-resume-edit-error">
          {serverError}
          <button
            onClick={() => setServerError(null)}
            style={{ float: 'right', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}
            aria-label="Dismiss"
          ><X size={14} /></button>
        </div>
      )}

      {!loaded ? (
        <div className="af-loading">Loading resume…</div>
      ) : (
        <div className="c-resume-edit-split">
          <div className="c-resume-edit-pane-editor">
            <CodeMirror
              value={content}
              onChange={onChange}
              extensions={[markdown()]}
              theme="light"
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                highlightActiveLine: true,
              }}
              style={{ height: '100%', fontSize: 14 }}
            />
          </div>
          <div className="c-resume-edit-pane-preview">
            <div className="c-resume-edit-pane-preview-header">
              <span className="c-resume-edit-preview-label">PDF preview</span>
              <button
                type="button"
                className="af-btn-add"
                onClick={() => setPdfRefreshKey(Date.now())}
                title="Force re-render (e.g., after editing identity or metadata in another tab)"
              >
                <RefreshCw size={12} /> Refresh
              </button>
            </div>
            <iframe
              key={pdfRefreshKey}
              src={`/api/career/resumes/${encodeURIComponent(id)}/render?v=${pdfRefreshKey}`}
              title="PDF preview"
              className="c-resume-edit-iframe"
            />
          </div>
        </div>
      )}
    </div>
  )
}
