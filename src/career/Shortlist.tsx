import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ClipboardPaste } from 'lucide-react'

export default function Shortlist() {
  const [pendingCount, setPendingCount] = useState<number | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    fetch('/api/career/finder/needs-manual', { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.jobs)) setPendingCount(data.jobs.length)
      })
      .catch(() => {
        // silent — Shortlist still renders the placeholder page
      })
    return () => ctrl.abort()
  }, [])

  return (
    <div className="c-page">
      <h2>Shortlist</h2>
      <p className="c-page-todo">Score ≥ 4.0 的已评估岗位，按分数排序。</p>
      <p className="c-page-ref">Spec: <code>06-evaluator/05-pipeline-ui</code> + <code>08-human-gate-tracker/02-career-dashboard-views</code></p>

      {pendingCount !== null && pendingCount > 0 && (
        <div
          style={{
            marginTop: 24,
            padding: '12px 16px',
            border: '1px solid #fbbf24',
            background: '#fef3c7',
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <ClipboardPaste size={18} />
          <span style={{ flex: 1, color: '#92400e', fontSize: 14 }}>
            {pendingCount} job{pendingCount === 1 ? '' : 's'} need manual JD paste — the enrich pipeline couldn't fetch the description.
          </span>
          <Link
            to="/career/shortlist/needs-manual"
            style={{
              padding: '6px 12px',
              border: '1px solid #92400e',
              background: '#fff',
              color: '#92400e',
              borderRadius: 6,
              fontSize: 13,
              textDecoration: 'none',
            }}
          >
            Paste now →
          </Link>
        </div>
      )}
    </div>
  )
}
