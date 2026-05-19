// Job detail drawer — opens when user clicks [View] on a JobCard.
//
// 04-career-system / find-jobs-redesign m1.d.
//
// Shows the full JD description + Stage A reasoning + Stage B report link.
// Re-fetches the full job from /api/career/finder/pipeline?q=<company>
// only when needed (the card-listing endpoint trims description for
// transport).

import { useEffect, useState } from 'react'
import { X, Send, ExternalLink, FileText } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { JobCardModel } from './JobCard'

type FullJob = JobCardModel & {
  description?: string | null
  evaluation?: {
    stage_a?: { score: number; verdict?: string; reasoning?: string } | null
    stage_b?: { score: number } | null
  } | null
  status?: string | null
}

export default function JobDetailDrawer({
  jobId,
  fallback,
  onClose,
  onApply,
}: {
  jobId: string
  fallback: JobCardModel
  onClose: () => void
  onApply: (job: JobCardModel) => void
}) {
  const [job, setJob] = useState<FullJob | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    // We don't have a /:id endpoint yet — fetch the whole pipeline + find
    // by id. With <500 jobs this is cheap; if it ever grows we'd add a
    // dedicated /finder/pipeline/:id route.
    fetch(`/api/career/finder/pipeline?limit=300`, { signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: { jobs: FullJob[] }) => {
        const found = data.jobs.find((j) => j.id === jobId)
        setJob(found ?? (fallback as FullJob))
      })
      .catch((e) => {
        if ((e as { name?: string })?.name === 'AbortError') return
        setError((e as Error).message)
        setJob(fallback as FullJob)
      })
    return () => ctrl.abort()
  }, [jobId, fallback])

  // ESC to close
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const view = job ?? (fallback as FullJob)
  const locText = Array.isArray(view.location) ? view.location.join(' · ') : (view.location ?? '')

  return (
    <div
      className="c-fj-drawer-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Job details"
    >
      <div className="c-fj-drawer c-fj-drawer-detail" onClick={(e) => e.stopPropagation()}>
        <header className="c-fj-drawer-head">
          <div>
            <p className="c-fj-detail-company">{view.company}</p>
            <h3 className="c-fj-drawer-title">{view.role}</h3>
          </div>
          <button
            type="button"
            className="c-fj-btn c-fj-btn-ghost c-fj-drawer-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </header>

        <div className="c-fj-detail-meta">
          {locText && <span>📍 {locText}</span>}
          {view.comp_hint && <span>💰 {view.comp_hint}</span>}
          {view.posted_at && <span>📅 posted {formatDate(view.posted_at)}</span>}
          {view.source && <span className="c-fj-card-source">{view.source.type}</span>}
        </div>

        {view.evaluation?.stage_a && (
          <div className="c-fj-detail-eval">
            <strong>Stage A score:</strong> {view.evaluation.stage_a.score.toFixed(1)}
            {view.evaluation.stage_a.verdict && (
              <> · <em>{view.evaluation.stage_a.verdict}</em></>
            )}
            {view.evaluation.stage_a.reasoning && (
              <p className="c-fj-detail-reasoning">{view.evaluation.stage_a.reasoning}</p>
            )}
          </div>
        )}

        {view.evaluation?.stage_b?.score != null && (
          <div className="c-fj-detail-eval c-fj-detail-eval-b">
            <strong>Stage B score:</strong> {view.evaluation.stage_b.score.toFixed(1)}
            <Link to={`/career/reports/${jobId}`} className="c-fj-btn c-fj-btn-ghost c-fj-detail-report">
              <FileText size={13} /> Full report
            </Link>
          </div>
        )}

        {error && <p className="c-fj-error">Detail fetch failed: {error}</p>}

        <div className="c-fj-detail-jd">
          <h4>Job description</h4>
          {view.description ? (
            <div className="c-fj-detail-jd-body" dangerouslySetInnerHTML={{ __html: sanitize(view.description) }} />
          ) : (
            <p className="c-fj-muted">No description on file.</p>
          )}
        </div>

        <footer className="c-fj-detail-foot">
          <a
            className="c-fj-btn c-fj-btn-ghost"
            href={view.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={13} /> Open ATS page
          </a>
          {view._passed !== false && (
            <button
              type="button"
              className="c-fj-btn c-fj-btn-primary"
              onClick={() => onApply(view)}
            >
              <Send size={13} /> Start applying
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

// Minimal sanitizer — strip <script> and on*= attributes. The descriptions
// come from ATS APIs which we trust, but we never inject untrusted HTML
// from the user.
function sanitize(html: string): string {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
}

function formatDate(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  return new Date(t).toISOString().slice(0, 10)
}
