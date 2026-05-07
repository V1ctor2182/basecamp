import { useEffect, useState } from 'react'
import {
  X,
  AlertTriangle,
  Loader2,
  CheckCircle,
  Wand2,
  RefreshCw,
  Download,
} from 'lucide-react'
import DiffViewer from './DiffViewer'
import './tailorPanel.css'

const AUTO_SELECT_VALUE = '__auto_select__'

type ResumeIndexEntry = {
  id: string
  title: string
  is_default: boolean
}

type TailorRunResp = {
  tailored_markdown: string
  base_markdown: string
  output_path: string
  cost_usd: number
  model: string
  picked_resume_id: string
  picked_reason: string
  picked_via: 'explicit' | 'auto-select'
  status: 'tailored'
}

type Props = {
  jobId: string
  jobRole?: string
  jobCompany?: string
  onClose: () => void
}

export default function TailorPanel({ jobId, jobRole, jobCompany, onClose }: Props) {
  const [resumes, setResumes] = useState<ResumeIndexEntry[]>([])
  const [resumeChoice, setResumeChoice] = useState<string>(AUTO_SELECT_VALUE)
  const [userHint, setUserHint] = useState('')
  const [hintRevealed, setHintRevealed] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<TailorRunResp | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [downloadingPdf, setDownloadingPdf] = useState(false)

  // Esc-key dismiss (matches ReportViewer a11y pattern)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !downloadingPdf) onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, downloadingPdf])

  // Load the resume index once on open. Picker defaults to Auto-Select;
  // explicit choices come from this list. Surface fetch failure so a
  // broken /api/career/resumes endpoint doesn't silently leave the user
  // thinking only one resume exists (review fix HIGH).
  useEffect(() => {
    let cancelled = false
    fetch('/api/career/resumes')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data) => {
        if (!cancelled) setResumes(Array.isArray(data?.resumes) ? data.resumes : [])
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setResumes([])
          setError(`Resume list unavailable (${e.message}) — Auto-Select will still work`)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function runTailor() {
    if (running) return
    setRunning(true)
    setError(null)
    try {
      const body: { jobId: string; resumeId?: string; userHint?: string } = { jobId }
      if (resumeChoice !== AUTO_SELECT_VALUE) body.resumeId = resumeChoice
      if (userHint.trim()) body.userHint = userHint.trim()

      const r = await fetch('/api/career/cv/tailor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) {
        // 412 / 404 / 502 — surface the server error verbatim
        setError(data?.error ?? `HTTP ${r.status}`)
        return
      }
      setResult(data as TailorRunResp)
    } catch (e) {
      setError((e as Error).message ?? 'Network error')
    } finally {
      setRunning(false)
    }
  }

  async function approveAndDownload() {
    if (!result || downloadingPdf) return
    setDownloadingPdf(true)
    setError(null)
    try {
      const r = await fetch('/api/career/render/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resume_markdown: result.tailored_markdown }),
      })
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string }
        setError(`PDF render failed: ${j.error ?? `HTTP ${r.status}`}`)
        return
      }
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `resume-${jobId}-${result.picked_resume_id}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // Defer revoke past the synchronous click handler — Safari / slow
      // disks have been observed to cancel the download if the URL is
      // revoked too eagerly (review fix HIGH).
      setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (e) {
      setError(`PDF render error: ${(e as Error).message ?? 'unknown'}`)
    } finally {
      setDownloadingPdf(false)
    }
  }

  function reject() {
    // Reveal the hint textarea inline; do NOT close the modal. User adds
    // guidance and clicks Re-run to invoke /tailor again with userHint.
    setHintRevealed(true)
    setResult(null)
  }

  const canApprove = result != null && !downloadingPdf
  const titleSuffix =
    jobRole && jobCompany ? ` · ${jobRole} @ ${jobCompany}` : ''

  return (
    <div className="tp-modal-overlay" onClick={() => !downloadingPdf && onClose()}>
      <div
        className="tp-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tp-modal-title-h3"
      >
        <header className="tp-modal-header">
          <div className="tp-modal-title">
            <Wand2 size={18} />
            <h3 id="tp-modal-title-h3">Tailor Resume{titleSuffix}</h3>
          </div>
          <button
            type="button"
            className="tp-modal-close"
            onClick={onClose}
            disabled={downloadingPdf}
            aria-label="Close tailor panel"
          >
            <X size={18} />
          </button>
        </header>

        <div className="tp-modal-body">
          {/* Run controls — always visible, lets user reconfigure between runs */}
          <section className="tp-controls">
            <label className="tp-field">
              <span className="tp-field-label">Resume</span>
              <select
                className="tp-select"
                value={resumeChoice}
                onChange={(e) => setResumeChoice(e.target.value)}
                disabled={running || downloadingPdf}
              >
                <option value={AUTO_SELECT_VALUE}>Auto-Select (best match)</option>
                {resumes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                    {r.is_default ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </label>

            {hintRevealed && (
              <label className="tp-field">
                <span className="tp-field-label">
                  Hint for the next run (e.g. &ldquo;don&rsquo;t modify Summary&rdquo;)
                </span>
                <textarea
                  className="tp-textarea"
                  value={userHint}
                  onChange={(e) => setUserHint(e.target.value)}
                  placeholder="Tell Sonnet what to change about its previous attempt…"
                  rows={3}
                  disabled={running || downloadingPdf}
                />
              </label>
            )}

            <div className="tp-actions">
              <button
                type="button"
                className="tp-btn-primary"
                disabled={running || downloadingPdf}
                onClick={runTailor}
              >
                {running ? (
                  <>
                    <Loader2 size={14} className="tp-spin" /> Tailoring…
                  </>
                ) : hintRevealed ? (
                  <>
                    <RefreshCw size={14} /> Re-run with hint
                  </>
                ) : (
                  <>
                    <Wand2 size={14} /> Run Tailor
                  </>
                )}
              </button>
            </div>
          </section>

          {error && (
            <div className="tp-error">
              <AlertTriangle size={14} /> {error}
            </div>
          )}

          {/* Result + diff frame — appears after a successful run */}
          {result && (
            <>
              <section className="tp-meta">
                <span className="tp-meta-pill">
                  Resume: <strong>{result.picked_resume_id}</strong>
                  {result.picked_via === 'auto-select' && (
                    <span className="tp-meta-sub"> (auto: {result.picked_reason})</span>
                  )}
                </span>
                <span className="tp-meta-pill">
                  Cost: ${(result.cost_usd ?? 0).toFixed(4)}
                </span>
                <span className="tp-meta-pill tp-meta-pill-mono">{result.model}</span>
              </section>

              <DiffViewer
                base={result.base_markdown}
                tailored={result.tailored_markdown}
              />

              <section className="tp-decision">
                <p className="tp-decision-prompt">
                  Review the diff. Approve to render PDF, or Reject to add a
                  hint and re-run. Constraint #1: every metric/claim must be
                  in base.md or proof-points.md — flag fabrications by
                  rejecting.
                </p>
                <div className="tp-decision-actions">
                  <button
                    type="button"
                    className="tp-btn-reject"
                    onClick={reject}
                    disabled={downloadingPdf}
                  >
                    Reject &amp; Re-run
                  </button>
                  <button
                    type="button"
                    className="tp-btn-approve"
                    onClick={approveAndDownload}
                    disabled={!canApprove}
                  >
                    {downloadingPdf ? (
                      <>
                        <Loader2 size={14} className="tp-spin" /> Rendering PDF…
                      </>
                    ) : (
                      <>
                        <CheckCircle size={14} /> Approve &amp; Download PDF
                      </>
                    )}
                    {!downloadingPdf && <Download size={14} />}
                  </button>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
