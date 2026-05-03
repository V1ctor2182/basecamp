import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Plus, MoreVertical, Star, FileText, X, Pencil, Sparkles, ChevronDown } from 'lucide-react'
import TagInput from '../TagInput'
import { deepMerge } from '../utils'
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

type AutoSelectRanking = {
  id: string
  title: string
  score: number
  matched: {
    role_keywords: string[]
    jd_keywords: string[]
    negative_keywords: string[]
  }
  is_default: boolean
  created_at: string
}

type AutoSelectResponse = {
  picked: string
  picked_score: number
  picked_reason: string
  fallback_to_default: boolean
  rankings: AutoSelectRanking[]
}

type ResumeMetadata = {
  archetype?: string
  match_rules: {
    role_keywords: string[]
    jd_keywords: string[]
    negative_keywords: string[]
  }
  emphasize: {
    projects: string[]
    skills: string[]
    narrative?: string
  }
  renderer: {
    template: string
    font?: string
    accent_color: string
  }
}

const BLANK_METADATA: ResumeMetadata = {
  match_rules: { role_keywords: [], jd_keywords: [], negative_keywords: [] },
  emphasize: { projects: [], skills: [] },
  renderer: { template: 'default', accent_color: '#0969da' },
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
  const [notice, setNotice] = useState<string | null>(null)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<ResumeEntry | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [syncingId, setSyncingId] = useState<string | null>(null)

  // Auto-select tester (m2 of 04-auto-select).
  const [showTester, setShowTester] = useState(false)
  const [testJdText, setTestJdText] = useState('')
  const [testRole, setTestRole] = useState('')
  const [testResult, setTestResult] = useState<AutoSelectResponse | null>(null)
  const [testLoading, setTestLoading] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const [showAllRankings, setShowAllRankings] = useState(false)

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
    setNotice(null)
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

  async function handleDuplicate(source: ResumeEntry) {
    setOpenMenuId(null)
    setNotice(null)
    const existingIds = new Set(resumes.map(r => r.id))
    let newId = window.prompt(
      `New ID for the copy of "${source.title}":\n` +
      `(slug only — a-z, 0-9, hyphens, max 40)`,
      `${source.id}-copy`,
    )
    if (!newId) return
    newId = newId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    if (!ID_RE.test(newId)) { setError(`Invalid id "${newId}". Use a-z, 0-9, hyphens.`); return }
    if (existingIds.has(newId)) { setError(`Id "${newId}" is already in use.`); return }
    try {
      const r = await fetch(`/api/career/resumes/${source.id}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_id: newId }),
      })
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
    setNotice(null)
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

  async function handleSync(resume: ResumeEntry) {
    if (resume.source !== 'google_doc' || syncingId) return

    let requestedDocId: string | undefined
    if (!resume.gdoc_id) {
      const input = window.prompt(
        `Paste the Google Doc URL or ID for "${resume.title}".\n` +
        '(You only need to do this once.)'
      )
      if (!input?.trim()) return
      requestedDocId = input.trim()
    }

    setSyncingId(resume.id)
    setError(null)
    setNotice(null)
    try {
      const r = await fetch(`/api/career/resumes/${resume.id}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestedDocId ? { gdoc_id: requestedDocId } : {}),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) {
        if (data?.auth_required && data?.authorize_path) {
          window.open(data.authorize_path, '_blank', 'noopener,noreferrer')
          setNotice('Google authorization opened in a new tab. Finish that flow, then click Sync Now again.')
          return
        }
        setError(data.error || `HTTP ${r.status}`)
        return
      }
      await refresh()
      setNotice(
        data?.snapshot
          ? `Synced "${resume.title}" from Google Docs. Previous content was snapshotted to ${data.snapshot}.`
          : `Synced "${resume.title}" from Google Docs.`
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setSyncingId(null)
    }
  }

  async function runAutoSelect() {
    if (!testJdText.trim() || testLoading) return
    setTestLoading(true); setTestError(null)
    try {
      const r = await fetch('/api/career/resumes/auto-select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jd_text: testJdText,
          role: testRole.trim() || undefined,
        }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        setTestError(j.error || `HTTP ${r.status}`)
        setTestResult(null)
        return
      }
      setTestResult(await r.json())
    } catch (e) {
      setTestError(e instanceof Error ? e.message : 'Network error')
      setTestResult(null)
    } finally {
      setTestLoading(false)
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
        <div className="c-resumes-toolbar-actions">
          {resumes.length > 0 && (
            <button
              className="af-btn-add"
              onClick={() => setShowTester(v => !v)}
              style={{ marginTop: 0 }}
            >
              <Sparkles size={14} />
              Test auto-select
            </button>
          )}
          {resumes.length > 0 && (
            <button className="af-btn-primary" onClick={() => setShowAdd(true)}>
              <Plus size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
              Add Resume
            </button>
          )}
        </div>
      </div>

      {showTester && resumes.length > 0 && (
        <div className="c-resumes-tester-panel">
          <div className="c-resumes-tester-header">
            <h3>Test auto-select</h3>
            <button
              type="button"
              className="c-resume-actions-btn"
              onClick={() => setShowTester(false)}
              aria-label="Close tester"
            ><X size={14} /></button>
          </div>
          <p className="c-resumes-tester-help">
            Paste a job description and (optionally) a role title. Scoring runs against each resume's <code>match_rules</code> — useful for tuning your keywords.
          </p>

          <div className="c-resumes-tester-inputs">
            <div className="af-field">
              <label className="af-label">Role (optional)</label>
              <input
                className="af-input"
                placeholder="Backend SDE / Senior Platform Engineer"
                value={testRole}
                onChange={e => setTestRole(e.target.value)}
                maxLength={200}
              />
            </div>
            <div className="af-field">
              <label className="af-label">Job description <span className="af-required-star">*</span></label>
              <textarea
                className="af-input c-resumes-tester-textarea"
                placeholder="Paste full JD here…"
                value={testJdText}
                onChange={e => setTestJdText(e.target.value)}
                rows={6}
                maxLength={50_000}
              />
              <span className="af-help-text">{testJdText.length} / 50,000 chars</span>
            </div>
            <div>
              <button
                type="button"
                className="af-btn-primary"
                disabled={!testJdText.trim() || testLoading}
                onClick={runAutoSelect}
              >
                {testLoading ? 'Scoring…' : 'Run auto-select'}
              </button>
            </div>
          </div>

          {testError && (
            <div className="c-resumes-modal-error" style={{ marginTop: 12 }}>{testError}</div>
          )}

          {testResult && (
            <div className="c-resumes-tester-result">
              <div className="c-resumes-tester-result-header">
                <div>
                  <div className="c-resumes-tester-picked-label">Picked</div>
                  <div className="c-resumes-tester-picked-id">
                    {testResult.rankings.find(r => r.id === testResult.picked)?.title ?? testResult.picked}
                    <span className="c-resumes-tester-picked-mono"> ({testResult.picked})</span>
                  </div>
                </div>
                <div className="c-resumes-tester-score">
                  score <strong>{testResult.picked_score}</strong>
                </div>
              </div>
              <div className="c-resumes-tester-reason">
                {testResult.picked_reason}
                {testResult.fallback_to_default && (
                  <span className="c-resumes-tester-fallback-badge">fallback to default</span>
                )}
              </div>

              <button
                type="button"
                className="c-resumes-tester-toggle"
                onClick={() => setShowAllRankings(v => !v)}
              >
                <ChevronDown
                  size={12}
                  style={{ transform: showAllRankings ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
                />
                {showAllRankings ? 'Hide' : 'Show'} all rankings ({testResult.rankings.length})
              </button>

              {showAllRankings && (
                <div className="c-resumes-tester-rankings-wrap">
                  <table className="c-resumes-tester-rankings">
                    <thead>
                      <tr>
                        <th>#</th><th>id</th><th>title</th><th>score</th>
                        <th>role kw</th><th>jd kw</th><th>negative</th>
                      </tr>
                    </thead>
                    <tbody>
                      {testResult.rankings.map((r, i) => (
                        <tr
                          key={r.id}
                          className={r.id === testResult.picked ? 'c-resumes-tester-row-picked' : ''}
                        >
                          <td>{i + 1}</td>
                          <td className="c-resume-id">{r.id}</td>
                          <td>{r.title}</td>
                          <td className="c-resumes-tester-num">{r.score}</td>
                          <td>{r.matched.role_keywords.map(k => (
                            <span key={k} className="c-resumes-tester-kw-pill positive">{k}</span>
                          ))}</td>
                          <td>{r.matched.jd_keywords.map(k => (
                            <span key={k} className="c-resumes-tester-kw-pill positive">{k}</span>
                          ))}</td>
                          <td>{r.matched.negative_keywords.map(k => (
                            <span key={k} className="c-resumes-tester-kw-pill negative">{k}</span>
                          ))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

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

      {notice && (
        <div className="c-resumes-modal-note" style={{ marginBottom: 16 }}>
          {notice}
          <button
            onClick={() => setNotice(null)}
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
              className={`c-resume-card${expandedId === r.id ? ' c-resume-card-expanded' : ''}`}
              onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
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
                    <button onClick={() => handleDuplicate(r)}>
                      Duplicate…
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

              {expandedId === r.id && (
                <div onClick={e => e.stopPropagation()}>
                  <MetadataDrawer
                    resume={r}
                    onClose={() => setExpandedId(null)}
                    onSync={handleSync}
                    syncing={syncingId === r.id}
                  />
                </div>
              )}
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
              <label className="af-label">Google Doc ID or URL (optional)</label>
              <input
                className="af-input"
                placeholder="1A2B3C... or full docs.google.com URL"
                value={gdocId}
                onChange={e => setGdocId(e.target.value)}
                maxLength={500}
              />
              <span className="af-help-text">留空也可以，第一次点 Sync Now 时会再提示你粘一次。</span>
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

function MetadataDrawer({
  resume, onClose, onSync, syncing,
}: {
  resume: ResumeEntry
  onClose: () => void
  onSync: (resume: ResumeEntry) => void
  syncing: boolean
}) {
  const resumeId = resume.id
  const [meta, setMeta] = useState<ResumeMetadata>(BLANK_METADATA)
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setLoaded(false)
    setDirty(false)
    setSavedAt(null)
    setErr(null)
    fetch(`/api/career/resumes/${resumeId}/metadata`)
      .then(r => r.json())
      .then(data => { setMeta(deepMerge(BLANK_METADATA, data)); setLoaded(true) })
      .catch(e => { setErr(e instanceof Error ? e.message : 'Network error'); setLoaded(true) })
  }, [resumeId])

  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  function patch<K extends keyof ResumeMetadata>(key: K, value: ResumeMetadata[K]) {
    setMeta(prev => ({ ...prev, [key]: value }))
    setDirty(true)
    setSavedAt(null)
  }

  async function save() {
    setSaving(true); setErr(null)
    try {
      const r = await fetch(`/api/career/resumes/${resumeId}/metadata`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        setErr(j.error || `HTTP ${r.status}`)
        return
      }
      setDirty(false)
      setSavedAt(new Date().toLocaleTimeString())
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Network error')
    } finally {
      setSaving(false)
    }
  }

  // Sync hex<->color picker. Native <input type=color> normalizes case;
  // we keep the canonical text input as the source of truth.
  const accentColor = meta.renderer.accent_color
  const colorPickerValue = useMemo(() => {
    return /^#[0-9a-fA-F]{6}$/.test(accentColor) ? accentColor : '#0969da'
  }, [accentColor])

  if (!loaded) return <div className="af-loading">Loading metadata…</div>

  return (
    <div className="c-resume-drawer">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Metadata</h4>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {resume.source === 'manual' ? (
            <Link
              to={`/career/settings/resumes/${resumeId}/edit`}
              className="af-btn-add"
              style={{ marginTop: 0, padding: '4px 10px', fontSize: 12, textDecoration: 'none' }}
              title="Open the full-page editor for base.md content"
            >
              <Pencil size={12} /> Edit content
            </Link>
          ) : (
            <>
              <button
                type="button"
                className="af-btn-primary"
                style={{ marginTop: 0, padding: '4px 10px', fontSize: 12 }}
                onClick={() => onSync(resume)}
                disabled={syncing}
                title="Pull the latest markdown from this resume's Google Doc"
              >
                {syncing ? 'Syncing…' : 'Sync Now'}
              </button>
              <button
                type="button"
                className="af-btn-add"
                style={{ marginTop: 0, padding: '4px 10px', fontSize: 12, opacity: 0.7 }}
                disabled
                title="Google Doc resumes are read-only in the in-app editor to avoid source-of-truth conflicts."
              >
                <Pencil size={12} /> Managed by Google Doc
              </button>
            </>
          )}
          <button
            type="button"
            className="c-resume-actions-btn"
            onClick={onClose}
            aria-label="Collapse"
          ><X size={14} /></button>
        </div>
      </div>

      {resume.source === 'google_doc' && (
        <div className="c-resume-sync-note">
          This resume is synced from Google Docs, so in-app editing is disabled to avoid conflicts.
          {' '}
          {resume.gdoc_id ? (
            <>Current Doc ID: <code>{resume.gdoc_id}</code>.</>
          ) : (
            <>No Doc ID saved yet. The first sync will ask for a Google Doc URL or ID.</>
          )}
          {resume.last_synced_at && (
            <> Last synced: <strong>{fmtDate(resume.last_synced_at)}</strong>.</>
          )}
        </div>
      )}

      <section className="af-section">
        <h3 className="af-section-title">Archetype</h3>
        <p className="af-section-desc">短标签描述这份简历的方向，例如 "Backend SDE / L4"。</p>
        <input
          className="af-input"
          placeholder="Backend SDE / L4"
          value={meta.archetype ?? ''}
          onChange={e => patch('archetype', e.target.value)}
          maxLength={100}
        />
      </section>

      <section className="af-section">
        <h3 className="af-section-title">Match Rules</h3>
        <p className="af-section-desc">04-auto-select 用这些 keywords 选 base resume。匹配 role_keywords + jd_keywords 越多越优先；命中 negative_keywords 直接 skip。</p>
        <div className="af-field">
          <label className="af-label">Role keywords</label>
          <TagInput
            value={meta.match_rules.role_keywords}
            onChange={v => patch('match_rules', { ...meta.match_rules, role_keywords: v })}
            placeholder="Backend Engineer, SDE, Platform Engineer"
          />
        </div>
        <div className="af-field">
          <label className="af-label">JD keywords</label>
          <TagInput
            value={meta.match_rules.jd_keywords}
            onChange={v => patch('match_rules', { ...meta.match_rules, jd_keywords: v })}
            placeholder="distributed systems, microservices, kubernetes"
          />
        </div>
        <div className="af-field">
          <label className="af-label">Negative keywords</label>
          <TagInput
            value={meta.match_rules.negative_keywords}
            onChange={v => patch('match_rules', { ...meta.match_rules, negative_keywords: v })}
            placeholder="frontend-only, embedded, mobile"
          />
        </div>
      </section>

      <section className="af-section">
        <h3 className="af-section-title">Emphasize</h3>
        <p className="af-section-desc">tailor-engine 改写时按这些线索调重点。</p>
        <div className="af-field">
          <label className="af-label">Projects</label>
          <TagInput
            value={meta.emphasize.projects}
            onChange={v => patch('emphasize', { ...meta.emphasize, projects: v })}
            placeholder="learn-dashboard, ATS form, Playwright pipeline"
          />
        </div>
        <div className="af-field">
          <label className="af-label">Skills</label>
          <TagInput
            value={meta.emphasize.skills}
            onChange={v => patch('emphasize', { ...meta.emphasize, skills: v })}
            placeholder="TypeScript, Node, Zod"
          />
        </div>
        <div className="af-field">
          <label className="af-label">Narrative hint</label>
          <textarea
            className="af-input"
            placeholder="One-liner shaping how tailor-engine should narrate this resume's voice."
            value={meta.emphasize.narrative ?? ''}
            onChange={e => patch('emphasize', { ...meta.emphasize, narrative: e.target.value })}
            maxLength={2000}
            rows={3}
            style={{ resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>
      </section>

      <section className="af-section">
        <h3 className="af-section-title">Renderer</h3>
        <p className="af-section-desc">Per-resume 渲染默认值。`/api/career/render/pdf` 的 options 仍可 override。</p>
        <div className="af-field-row">
          <div className="af-field">
            <label className="af-label">Template</label>
            <input
              className="af-input"
              placeholder="default"
              value={meta.renderer.template}
              onChange={e => patch('renderer', { ...meta.renderer, template: e.target.value })}
              maxLength={50}
            />
          </div>
          <div className="af-field">
            <label className="af-label">Font (optional)</label>
            <input
              className="af-input"
              placeholder="system-ui"
              value={meta.renderer.font ?? ''}
              onChange={e => patch('renderer', { ...meta.renderer, font: e.target.value })}
              maxLength={50}
            />
          </div>
        </div>
        <div className="af-field">
          <label className="af-label">Accent color</label>
          <div className="c-resume-color-row">
            <input
              type="color"
              value={colorPickerValue}
              onChange={e => patch('renderer', { ...meta.renderer, accent_color: e.target.value })}
              aria-label="Accent color picker"
            />
            <input
              type="text"
              className="af-input"
              placeholder="#0969da"
              value={meta.renderer.accent_color}
              onChange={e => patch('renderer', { ...meta.renderer, accent_color: e.target.value })}
              maxLength={20}
            />
          </div>
        </div>
      </section>

      {err && <div className="c-resumes-modal-error">{err}</div>}

      <div className="c-resume-drawer-savebar">
        <span className={`c-resume-drawer-status${dirty ? ' dirty' : savedAt ? ' saved' : ''}`}>
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
          {saving ? 'Saving…' : 'Save Metadata'}
        </button>
      </div>
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
