import { useEffect, useState, FormEvent } from 'react'
import { Plus, MoreVertical, Star, FileText, X } from 'lucide-react'
import './ats-form.css'
import './resumes.css'

type Source = 'manual' | 'google_doc'

type ResumeEntry = {
  id: string
  title: string
  description?: string
  source: Source
  gdoc_id?: string
  last_synced_at?: string
  is_default: boolean
  created_at: string
}

const ID_RE = /^[a-z0-9-]{1,40}$/

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function fmtDate(iso?: string): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  } catch { return iso }
}

export default function Resumes() {
  const [resumes, setResumes] = useState<ResumeEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<ResumeEntry | null>(null)

  async function refresh() {
    try {
      const r = await fetch('/api/career/resumes')
      const data = await r.json()
      setResumes(data?.resumes ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load resumes')
    } finally {
      setLoaded(true)
    }
  }

  useEffect(() => { refresh() }, [])

  async function handleSetDefault(id: string) {
    setOpenMenuId(null)
    try {
      const r = await fetch(`/api/career/resumes/${id}/set-default`, { method: 'PATCH' })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        setError(j.error || `HTTP ${r.status}`)
        return
      }
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    }
  }

  async function handleDelete(id: string) {
    try {
      const r = await fetch(`/api/career/resumes/${id}`, { method: 'DELETE' })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        setError(j.error || `HTTP ${r.status}`)
        return
      }
      setConfirmDelete(null)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    }
  }

  if (!loaded) return <div className="af-loading">Loading resumes…</div>

  return (
    <div className="c-resumes-page">
      <div className="c-resumes-toolbar">
        <div>
          <h2>Resumes</h2>
          <p>多份方向化 base 简历。每份对应不同的 archetype（backend / applied-ai / fullstack 等），auto-select 按 JD match-rules 自动挑选 base 用于 tailor。</p>
        </div>
        {resumes.length > 0 && (
          <button className="af-btn-primary" onClick={() => setShowAdd(true)}>
            <Plus size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
            Add Resume
          </button>
        )}
      </div>

      {error && (
        <div className="c-resumes-modal-error" style={{ marginBottom: 16 }}>
          {error}
          <button
            onClick={() => setError(null)}
            style={{ float: 'right', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}
            aria-label="Dismiss"
          ><X size={14} /></button>
        </div>
      )}

      {resumes.length === 0 ? (
        <div className="c-resume-empty">
          <FileText size={32} strokeWidth={1.5} style={{ marginBottom: 12, opacity: 0.5 }} />
          <h3>No resumes yet</h3>
          <p>Add your first base resume. 后续可以为每个方向（backend / applied-ai / etc）建一份；apply 时按 JD 自动选最相关的 base 做 tailor。</p>
          <button className="af-btn-primary" onClick={() => setShowAdd(true)}>
            <Plus size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
            Add Resume
          </button>
        </div>
      ) : (
        <div className="c-resumes-grid">
          {resumes.map(r => (
            <div
              key={r.id}
              className="c-resume-card"
              onClick={() => { /* m3 will expand drawer */ }}
            >
              <div className="c-resume-actions" onClick={e => e.stopPropagation()}>
                <button
                  className="c-resume-actions-btn"
                  aria-label="Actions"
                  onClick={() => setOpenMenuId(openMenuId === r.id ? null : r.id)}
                >
                  <MoreVertical size={16} />
                </button>
                {openMenuId === r.id && (
                  <div className="c-resume-actions-menu" role="menu">
                    <button
                      onClick={() => handleSetDefault(r.id)}
                      disabled={r.is_default}
                    >
                      {r.is_default ? '★ Default' : 'Set as default'}
                    </button>
                    <button
                      className="danger"
                      onClick={() => { setOpenMenuId(null); setConfirmDelete(r) }}
                    >
                      Delete…
                    </button>
                  </div>
                )}
              </div>

              <div className="c-resume-card-header">
                <h3 className="c-resume-title">{r.title}</h3>
                {r.is_default && (
                  <span className="c-resume-default-badge" title="Default resume">
                    <Star size={12} fill="currentColor" /> Default
                  </span>
                )}
              </div>

              <span className={`c-resume-source c-resume-source-${r.source}`}>
                {r.source === 'manual' ? 'Manual' : 'Google Doc'}
              </span>

              {r.description && (
                <div className="c-resume-description">{r.description}</div>
              )}

              <div className="c-resume-footer">
                <span className="c-resume-id">{r.id}</span>
                <span>{fmtDate(r.last_synced_at ?? r.created_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <AddResumeDialog
          existingIds={new Set(resumes.map(r => r.id))}
          onClose={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); refresh() }}
        />
      )}

      {confirmDelete && (
        <ConfirmDeleteDialog
          resume={confirmDelete}
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => handleDelete(confirmDelete.id)}
        />
      )}
    </div>
  )
}

// ─── Dialogs ───

function AddResumeDialog({
  existingIds, onClose, onCreated,
}: {
  existingIds: Set<string>
  onClose: () => void
  onCreated: () => void
}) {
  const [id, setId] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [source, setSource] = useState<Source>('manual')
  const [gdocId, setGdocId] = useState('')
  const [setDefault, setSetDefault] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const idValid = ID_RE.test(id)
  const idAvailable = !existingIds.has(id)
  const canSubmit = idValid && idAvailable && title.trim().length > 0 && !submitting

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true); setErr(null)
    try {
      const body: Record<string, unknown> = {
        id,
        title: title.trim(),
        description: description.trim() || undefined,
        source,
        set_default: setDefault,
      }
      if (source === 'google_doc' && gdocId.trim()) body.gdoc_id = gdocId.trim()
      const r = await fetch('/api/career/resumes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        setErr(j.error || `HTTP ${r.status}`)
        return
      }
      onCreated()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Network error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="c-resumes-modal-overlay" onClick={onClose}>
      <form className="c-resumes-modal" onClick={e => e.stopPropagation()} onSubmit={submit}>
        <div className="c-resumes-modal-header">
          <h3>Add Resume</h3>
          <button type="button" className="c-resume-actions-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="c-resumes-modal-body">
          <div className="af-field">
            <label className="af-label">ID <span className="af-required-star">*</span></label>
            <input
              className={`af-input${id && (!idValid || !idAvailable) ? ' af-input-error' : ''}`}
              placeholder="backend / applied-ai / fullstack"
              value={id}
              onChange={e => setId(e.target.value)}
              onBlur={e => setId(slugify(e.target.value))}
              autoFocus
            />
            {id && !idValid && <span className="af-error">Use only a-z, 0-9, hyphens (max 40 chars).</span>}
            {id && idValid && !idAvailable && <span className="af-error">This id is already in use.</span>}
            {!id && <span className="af-help-text">Slug only (a-z, 0-9, hyphens). Used in file paths.</span>}
          </div>

          <div className="af-field">
            <label className="af-label">Title <span className="af-required-star">*</span></label>
            <input
              className="af-input"
              placeholder="Backend SDE"
              value={title}
              onChange={e => setTitle(e.target.value)}
            />
          </div>

          <div className="af-field">
            <label className="af-label">Description</label>
            <input
              className="af-input"
              placeholder="Distributed systems / infra / platform"
              value={description}
              onChange={e => setDescription(e.target.value)}
              maxLength={500}
            />
          </div>

          <div className="af-field">
            <label className="af-label">Source <span className="af-required-star">*</span></label>
            <div className="c-resumes-radio-group">
              <label>
                <input type="radio" checked={source === 'manual'} onChange={() => setSource('manual')} />
                Manual (edit in-app)
              </label>
              <label>
                <input type="radio" checked={source === 'google_doc'} onChange={() => setSource('google_doc')} />
                Google Doc (sync)
              </label>
            </div>
          </div>

          {source === 'google_doc' && (
            <div className="af-field">
              <label className="af-label">Google Doc ID (optional)</label>
              <input
                className="af-input"
                placeholder="1A2B3C... (or leave blank, set later)"
                value={gdocId}
                onChange={e => setGdocId(e.target.value)}
                maxLength={200}
              />
              <span className="af-help-text">Sync 操作在 03-cv-engine/02-google-docs-sync 接入。</span>
            </div>
          )}

          <div className="af-field">
            <label className="af-radio-label">
              <input type="checkbox" checked={setDefault} onChange={e => setSetDefault(e.target.checked)} />
              {' '}Set as default resume
            </label>
          </div>

          {err && <div className="c-resumes-modal-error">{err}</div>}
        </div>

        <div className="c-resumes-modal-footer">
          <button type="button" className="af-btn-add" onClick={onClose}>Cancel</button>
          <button type="submit" className="af-btn-primary" disabled={!canSubmit}>
            {submitting ? 'Creating…' : 'Create resume'}
          </button>
        </div>
      </form>
    </div>
  )
}

function ConfirmDeleteDialog({
  resume, onClose, onConfirm,
}: {
  resume: ResumeEntry
  onClose: () => void
  onConfirm: () => void
}) {
  const [confirmText, setConfirmText] = useState('')
  const canDelete = confirmText.trim().toLowerCase() === 'delete'

  return (
    <div className="c-resumes-modal-overlay" onClick={onClose}>
      <div className="c-resumes-modal" onClick={e => e.stopPropagation()}>
        <div className="c-resumes-modal-header">
          <h3>Delete resume?</h3>
          <button type="button" className="c-resume-actions-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="c-resumes-modal-body">
          <div className="c-resumes-warning">
            <strong>{resume.title}</strong> ({resume.id}) 的 <code>base.md</code>、<code>metadata.yml</code>、整个 <code>versions/</code> 目录都会被永久删除，无法撤销。
          </div>
          <div className="c-resumes-confirm-input">
            <label className="af-label">Type <code>delete</code> to confirm:</label>
            <input
              className="af-input"
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              autoFocus
              placeholder="delete"
            />
          </div>
        </div>
        <div className="c-resumes-modal-footer">
          <button type="button" className="af-btn-add" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="af-btn-primary"
            disabled={!canDelete}
            onClick={onConfirm}
            style={canDelete ? { background: '#cf222e' } : undefined}
          >
            Delete resume
          </button>
        </div>
      </div>
    </div>
  )
}
