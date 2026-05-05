import { useEffect, useState } from 'react'
import { X, AlertTriangle, Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type ReportData = {
  content: string
  evaluated_at: string
  total_score: number | null
  blocks_emitted: string[]
}

export default function ReportViewer({
  jobId,
  onClose,
}: {
  jobId: string
  onClose: () => void
}) {
  const [data, setData] = useState<ReportData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setData(null)
    setLoadError(null)
    fetch(`/api/career/evaluate/stage-b/report/${encodeURIComponent(jobId)}`)
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          throw new Error(j.error ?? `HTTP ${r.status}`)
        }
        return r.json() as Promise<ReportData>
      })
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch((e: Error) => {
        if (!cancelled) setLoadError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [jobId])

  // Esc key dismiss
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="sbb-modal-overlay" onClick={onClose}>
      <div
        className="sbb-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sbb-modal-title-h3"
      >
        <header className="sbb-modal-header">
          <div className="sbb-modal-title">
            <h3 id="sbb-modal-title-h3">Stage B Report</h3>
            {data && data.total_score != null && (
              <span className="sbb-modal-score">{data.total_score.toFixed(1)}/5</span>
            )}
            {data && data.blocks_emitted.length > 0 && (
              <span className="sbb-modal-blocks">
                {data.blocks_emitted.join(' · ')}
              </span>
            )}
          </div>
          <button
            type="button"
            className="sbb-modal-close"
            onClick={onClose}
            aria-label="Close report"
          >
            <X size={18} />
          </button>
        </header>
        <div className="sbb-modal-body">
          {loadError ? (
            <div className="sbb-modal-error">
              <AlertTriangle size={14} /> {loadError}
            </div>
          ) : !data ? (
            <div className="sbb-modal-loading">
              <Loader2 size={14} className="sbb-spin" /> Loading report…
            </div>
          ) : (
            <article className="sbb-modal-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.content}</ReactMarkdown>
            </article>
          )}
        </div>
        {data && (
          <footer className="sbb-modal-footer">
            Evaluated {new Date(data.evaluated_at).toLocaleString()}
          </footer>
        )}
      </div>
    </div>
  )
}
