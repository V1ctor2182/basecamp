import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, RefreshCw, X } from 'lucide-react'
import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import '../ats-form.css'
import './edit.css'

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
    } catch (e) {
      setServerError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="c-resume-edit-page">
      <div className="c-resume-edit-toolbar">
        <Link to="/career/settings/resumes" className="c-resume-edit-back">
          <ArrowLeft size={14} /> Back to Resumes
        </Link>
        <h2 className="c-resume-edit-title">{id}</h2>
        <div className="c-resume-edit-actions">
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
