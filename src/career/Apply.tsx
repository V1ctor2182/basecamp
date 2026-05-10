// Mode 1 Simplify Hybrid — Apply page.
//
// 07-applier/01-mode1-simplify-hybrid m5. End-to-end Mode 1 user flow:
//   1. User clicks Apply on Shortlist → lands here at /career/apply/:jobId
//   2. On mount: GET /apply/draft/:jobId — if 404, auto-POST /apply/draft
//      to generate one (one-time + re-pulled via "Generate fresh draft")
//   3. Field cards grouped by class (hard / legal / open / file):
//      - hard: read-only label + value + [Copy] button
//      - legal: read-only + Copy + source_ref hint
//      - open: editable textarea + Copy (copies the EDITED value)
//      - file: Tailored PDF link + Copy (copies the path)
//   4. Mark Submitted: native confirm() modal then POST /apply/submitted
//      with edited field values → status transitions Evaluated → Applied
//      AND each field appended to qa-bank/history.jsonl (Applier
//      flywheel ② data source).
//
// Constraint #1: Mode 1 NEVER auto-Submits. Mark Submitted is the only
// path that flips the application state.
// Constraint #4: Mark Submitted requires native confirm() with explicit
// "Did you click Submit in the browser?" prompt.

import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import {
  ArrowLeft,
  AlertTriangle,
  Loader2,
  Copy,
  Check,
  RefreshCw,
  Send,
  FileText,
} from 'lucide-react'
import './apply.css'

type FieldClass = 'hard' | 'legal' | 'open' | 'file'
type Confidence = 'high' | 'medium' | 'low'

type DraftField = {
  label: string
  class: FieldClass
  suggested_value: string
  confidence: Confidence
  source_ref?: string
}

type Draft = {
  jobId: string
  fields: DraftField[]
  generated_at: string
  model: string
  cost_usd: number
}

const CLASS_ORDER: FieldClass[] = ['hard', 'legal', 'open', 'file']
const CLASS_LABELS: Record<FieldClass, string> = {
  hard: 'Identity (factual)',
  legal: 'Legal / EEO',
  open: 'Open-ended',
  file: 'File upload',
}

const CONFIDENCE_LABELS: Record<Confidence, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

export default function Apply() {
  const { jobId } = useParams<{ jobId: string }>()
  const navigate = useNavigate()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [submitToast, setSubmitToast] = useState<string | null>(null)
  const [copyTick, setCopyTick] = useState<string | null>(null)

  // Initial load: GET existing draft, auto-POST if 404. We deliberately
  // 404→auto-generate so the user lands on a populated page after one
  // click rather than two.
  useEffect(() => {
    if (!jobId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const r = await fetch(`/api/career/apply/draft/${encodeURIComponent(jobId)}`)
        if (r.status === 404) {
          // Auto-generate first draft
          if (cancelled) return
          await generateDraft({ silent: true })
          return
        }
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          throw new Error(j.error ?? `HTTP ${r.status}`)
        }
        const data = (await r.json()) as Draft
        if (!cancelled) {
          setDraft(data)
          // Seed edits with suggested_value for every field
          const seed: Record<string, string> = {}
          for (const f of data.fields) seed[f.label] = f.suggested_value
          setEdits(seed)
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? 'Failed to load draft')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  async function generateDraft(opts: { force?: boolean; silent?: boolean } = {}) {
    if (!jobId) return
    setGenerating(true)
    setError(null)
    try {
      const r = await fetch('/api/career/apply/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, force: opts.force === true }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j.hint ?? j.error ?? j.detail ?? `HTTP ${r.status}`)
      }
      const data = (await r.json()) as Draft
      setDraft(data)
      const seed: Record<string, string> = {}
      for (const f of data.fields) seed[f.label] = f.suggested_value
      setEdits(seed)
    } catch (e) {
      setError((e as Error).message ?? 'Failed to generate draft')
    } finally {
      setGenerating(false)
      if (opts.silent) setLoading(false)
    }
  }

  async function copyValue(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopyTick(label)
      setTimeout(() => setCopyTick((cur) => (cur === label ? null : cur)), 1200)
    } catch {
      // Older browsers / permission denied — surface inline error
      setError('Clipboard write failed — select + copy manually.')
    }
  }

  async function markSubmitted() {
    if (!jobId || !draft) return
    // Constraint #4: explicit confirm with the locked prompt text
    const ok = window.confirm(
      'Did you click Submit in the browser?\n\nThis marks the application as Applied + appends ' +
        'your final answers to qa-bank/history.jsonl. The status transition cannot be undone via Mode 1.'
    )
    if (!ok) return
    setSubmitting(true)
    setError(null)
    try {
      const fields = draft.fields.map((f) => ({
        label: f.label,
        final_answer: edits[f.label] ?? f.suggested_value,
        class: f.class,
      }))
      const r = await fetch('/api/career/apply/submitted', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, fields }),
      })
      const data = await r.json()
      if (!r.ok) {
        // 400 with current_status/allowed_next surfaces actionable info
        if (data.current_status && Array.isArray(data.allowed_next)) {
          throw new Error(
            `${data.error}. Current status: ${data.current_status}. Next: ${data.allowed_next.join(', ')}`
          )
        }
        throw new Error(data.error ?? `HTTP ${r.status}`)
      }
      const partialNote = data.partial
        ? ` (partial: ${data.history_lines_added}/${data.total_fields} fields appended)`
        : ''
      setSubmitToast(`Marked Applied${partialNote}. Redirecting…`)
      // Brief pause so user reads the toast, then go to /career/applied
      setTimeout(() => navigate('/career/applied'), 1500)
    } catch (e) {
      setError((e as Error).message ?? 'Mark Submitted failed')
    } finally {
      setSubmitting(false)
    }
  }

  const fieldsByClass = useMemo(() => {
    const out: Record<FieldClass, DraftField[]> = { hard: [], legal: [], open: [], file: [] }
    if (!draft) return out
    for (const f of draft.fields) {
      if (CLASS_ORDER.includes(f.class)) out[f.class].push(f)
    }
    return out
  }, [draft])

  if (!jobId) {
    return (
      <div className="c-page">
        <h2>Apply</h2>
        <div className="ap-error"><AlertTriangle size={14} /> Missing jobId in URL.</div>
      </div>
    )
  }

  return (
    <div className="c-page ap-page">
      <div className="ap-topbar">
        <button
          type="button"
          className="ap-back"
          onClick={() => navigate('/career/shortlist')}
        >
          <ArrowLeft size={14} /> Shortlist
        </button>
        <div className="ap-actions">
          <button
            type="button"
            className="ap-action-btn"
            onClick={() => generateDraft({ force: true })}
            disabled={generating || submitting}
          >
            <RefreshCw size={12} className={generating ? 'ap-spin' : ''} />{' '}
            {generating ? 'Generating…' : 'Generate fresh draft'}
          </button>
        </div>
      </div>

      <header className="ap-header">
        <h2 className="ap-title">Apply — {jobId}</h2>
        <div className="ap-subhead">
          Mode 1 Simplify Hybrid · copy/paste flow · you submit in the browser, then click Mark Submitted below.
        </div>
      </header>

      {error && (
        <div className="ap-error">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {submitToast && (
        <div className="ap-toast-ok">
          <Check size={14} /> {submitToast}
        </div>
      )}

      {loading && !draft ? (
        <div className="ap-loading">
          <Loader2 size={14} className="ap-spin" /> Loading draft… (auto-generates if none exists)
        </div>
      ) : !draft ? (
        <div className="ap-empty">
          No draft yet. Click "Generate fresh draft" above.{' '}
          <Link to="/career/shortlist" className="ap-link">Back to Shortlist</Link>
        </div>
      ) : (
        <>
          {CLASS_ORDER.map((cls) => {
            const fields = fieldsByClass[cls]
            if (fields.length === 0) return null
            return (
              <section key={cls} className="ap-section">
                <h3 className="ap-section-title">{CLASS_LABELS[cls]}</h3>
                <div className="ap-fields">
                  {fields.map((f) => {
                    const value = edits[f.label] ?? f.suggested_value
                    const editable = f.class === 'open'
                    const copyTicked = copyTick === f.label
                    return (
                      <div key={f.label} className={`ap-field ap-field-${f.class}`}>
                        <div className="ap-field-head">
                          <span className="ap-field-label">{f.label}</span>
                          <span className={`ap-confidence ap-conf-${f.confidence}`}>
                            {CONFIDENCE_LABELS[f.confidence]}
                          </span>
                        </div>
                        {editable ? (
                          <textarea
                            className="ap-field-textarea"
                            value={value}
                            onChange={(e) =>
                              setEdits((prev) => ({ ...prev, [f.label]: e.target.value }))
                            }
                            rows={4}
                            placeholder="Edit before copy/paste…"
                          />
                        ) : f.class === 'file' ? (
                          <div className="ap-field-file">
                            <FileText size={14} />
                            <code className="ap-field-file-path">{value}</code>
                          </div>
                        ) : (
                          <div className="ap-field-value">{value || <em>(empty)</em>}</div>
                        )}
                        <div className="ap-field-foot">
                          {f.source_ref && (
                            <span className="ap-source-ref">
                              <code>{f.source_ref}</code>
                            </span>
                          )}
                          <button
                            type="button"
                            className={`ap-copy-btn${copyTicked ? ' ap-copy-btn-ok' : ''}`}
                            onClick={() => copyValue(f.label, value)}
                            disabled={!value}
                            aria-label={`Copy ${f.label}`}
                          >
                            {copyTicked ? <Check size={12} /> : <Copy size={12} />}
                            {copyTicked ? 'Copied' : 'Copy'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </section>
            )
          })}

          <div className="ap-submit-bar">
            <div className="ap-submit-info">
              {draft.fields.length} fields drafted by {draft.model} for ${draft.cost_usd.toFixed(4)}
              · Mode 1 NEVER auto-Submits. Click Submit in the browser FIRST, then mark below.
            </div>
            <button
              type="button"
              className="ap-submit-btn"
              onClick={markSubmitted}
              disabled={submitting || generating}
            >
              <Send size={14} />
              {submitting ? 'Marking…' : 'Mark submitted'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
