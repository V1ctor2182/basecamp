// Learning tab — visualises the 02-data-flywheel feedback loop.
//
// 07-applier/self-iteration/02-data-flywheel m4.
//
// 4 cards (collapsible later if needed; m4 ships them all open):
//   ① 30-day flywheel stats — counts of field-misclassified / field-edits
//      / site-failures + suggestion totals
//   ② Classifier error trend — Nivo ResponsiveLine, 14-day window of
//      "issues per day" (misclassified + heavy edits). Lower = better.
//   ③ Pending suggestions list — Approve/Reject buttons; inline proposal
//      preview (regex / mini-YAML)
//   ④ Site adapter coverage — domains × failures × has_adapter? table

import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { ResponsiveLine } from '@nivo/line'
import { TrendingDown, CheckCircle2, XCircle, RotateCcw, FileWarning, Globe } from 'lucide-react'
import './learning.css'

const REFRESH_MS = 30_000

// ─── Types (mirror server.mjs response shapes) ────────────────────────

type StatsResp = {
  since: string
  flywheels: {
    field_misclassified: number
    field_edits: number
    site_failures: number
  }
  suggestions: {
    total: number
    pending: number
    approved: number
    rejected: number
  }
  error_series: Array<{ date: string; issues: number }>
}

type ProposalEnvelope = {
  id: string
  type: 'classifier-rule' | 'site-adapter'
  created_at: string
  group_key: string
  feedback_type: string
  status: 'pending' | 'approved' | 'rejected'
  cost_usd?: number
  model_used?: string
  source_records: Array<Record<string, unknown>>
  proposal: Record<string, unknown>
}

type SuggestionsResp = {
  count: number
  suggestions: ProposalEnvelope[]
}

type SiteCoverageRow = {
  domain: string
  failures: number
  site_adapter_id: string | null
  has_adapter: boolean
}

type SiteCoverageResp = {
  count: number
  rows: SiteCoverageRow[]
}

// ─── Page ─────────────────────────────────────────────────────────────

export default function Learning() {
  const [stats, setStats] = useState<StatsResp | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<ProposalEnvelope[] | null>(null)
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null)
  const [coverage, setCoverage] = useState<SiteCoverageRow[] | null>(null)
  const [coverageError, setCoverageError] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // REVIEW C3 (adv) fix: a ref mirroring actionBusy that the
  // setInterval auto-refresh can read synchronously (state updates are
  // async; the interval tick captured at mount sees a stale value).
  // While an approve/reject is mid-flight, we skip the auto-refresh
  // to prevent a ghost 409 (interval refetch removes the item, then
  // the POST resolves and re-fetches).
  const actionBusyRef = useRef<string | null>(null)
  // REVIEW C4 (adv) fix: mountedRef so post-action setState calls bail
  // when the component has unmounted.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const fetchAll = useCallback(async (signal?: AbortSignal) => {
    // Parallel fetches; each section has its own error gate so one fail
    // doesn't blank the whole page.
    await Promise.all([
      fetch('/api/career/feedback/stats', { signal })
        .then(async (r) => {
          if (!r.ok) throw new Error(`stats HTTP ${r.status}`)
          const json = (await r.json()) as StatsResp
          setStats(json)
          setStatsError(null)
        })
        .catch((e) => {
          if ((e as { name?: string })?.name === 'AbortError') return
          setStatsError((e as Error).message)
        }),
      fetch('/api/career/feedback/suggestions?status=pending', { signal })
        .then(async (r) => {
          if (!r.ok) throw new Error(`suggestions HTTP ${r.status}`)
          const json = (await r.json()) as SuggestionsResp
          setSuggestions(json.suggestions)
          setSuggestionsError(null)
        })
        .catch((e) => {
          if ((e as { name?: string })?.name === 'AbortError') return
          setSuggestionsError((e as Error).message)
        }),
      fetch('/api/career/feedback/site-coverage', { signal })
        .then(async (r) => {
          if (!r.ok) throw new Error(`coverage HTTP ${r.status}`)
          const json = (await r.json()) as SiteCoverageResp
          setCoverage(json.rows)
          setCoverageError(null)
        })
        .catch((e) => {
          if ((e as { name?: string })?.name === 'AbortError') return
          setCoverageError((e as Error).message)
        }),
    ])
  }, [])

  useEffect(() => {
    const ctrl = new AbortController()
    fetchAll(ctrl.signal)
    const t = setInterval(() => {
      // REVIEW C3 (adv) fix: skip auto-refresh while an action is
      // mid-flight to avoid the action POST and interval refetch
      // racing on the suggestions list.
      if (actionBusyRef.current) return
      fetchAll(ctrl.signal)
    }, REFRESH_MS)
    return () => {
      ctrl.abort()
      clearInterval(t)
    }
  }, [fetchAll])

  async function actOnSuggestion(id: string, action: 'approve' | 'reject') {
    setActionBusy(id)
    actionBusyRef.current = id
    setActionError(null)
    const ac = new AbortController()
    try {
      // REVIEW C4 (adv) fix: pass signal so an unmount during the POST
      // doesn't leave a setState-on-unmounted-component leak.
      const r = await fetch(`/api/career/feedback/suggestions/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        signal: ac.signal,
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error || `HTTP ${r.status}`)
      }
      if (mountedRef.current) await fetchAll(ac.signal)
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return
      if (mountedRef.current) setActionError((e as Error).message)
    } finally {
      if (mountedRef.current) setActionBusy(null)
      actionBusyRef.current = null
    }
  }

  const lineData = useMemo(() => {
    // REVIEW H6 / #3 fix: drop the empty-string-x fallback. The chart
    // is only rendered when `stats` is loaded (gate below), so we only
    // need a defined series here.
    const series = stats?.error_series ?? []
    return [
      {
        id: 'issues',
        data: series.map((d) => ({ x: d.date.slice(5), y: d.issues })),
      },
    ]
  }, [stats?.error_series])

  return (
    <div className="c-learning-root">
      <header className="c-learning-header">
        <h2 className="c-learning-title">Learning</h2>
        <p className="c-learning-sub">
          Applier 越用越准 — 4 条飞轮数据 · AI 归纳的规则建议 · 站点覆盖度
        </p>
      </header>

      {/* Card ①: 30-day flywheel stats */}
      <section className="c-learning-card">
        <h3 className="c-learning-card-title">
          <TrendingDown size={16} /> 30-day flywheel stats
        </h3>
        {statsError ? (
          <p className="c-learning-error">Failed to load: {statsError}</p>
        ) : !stats ? (
          <p className="c-learning-loading">Loading…</p>
        ) : (
          <div className="c-learning-stats-grid">
            <Stat label="Misclassified fields" value={stats.flywheels.field_misclassified} />
            <Stat label="User edits to drafts" value={stats.flywheels.field_edits} />
            <Stat label="Site failures" value={stats.flywheels.site_failures} />
            <Stat label="Pending suggestions" value={stats.suggestions.pending} accent="warn" />
            <Stat label="Approved (lifetime)" value={stats.suggestions.approved} accent="ok" />
            <Stat label="Rejected (lifetime)" value={stats.suggestions.rejected} muted />
          </div>
        )}
      </section>

      {/* Card ②: Classifier error trend */}
      <section className="c-learning-card">
        <h3 className="c-learning-card-title">
          <TrendingDown size={16} /> Classifier error signals (14 days · misclassified + edits {'>'} 50 chars · lower = better)
        </h3>
        {statsError ? null : !stats || lineData[0].data.length === 0 ? (
          <p className="c-learning-loading">Loading…</p>
        ) : (
          <div className="c-learning-chart" style={{ height: 220 }}>
            <ResponsiveLine
              data={lineData}
              margin={{ top: 12, right: 24, bottom: 40, left: 36 }}
              xScale={{ type: 'point' }}
              yScale={{ type: 'linear', min: 0, max: 'auto' }}
              colors={['#e53e3e']}
              enablePoints
              pointSize={5}
              pointBorderWidth={1}
              pointColor={{ theme: 'background' }}
              useMesh
              axisBottom={{
                tickRotation: -45,
                tickSize: 4,
                tickValues: lineData[0].data.filter((_, i) => i % 2 === 0).map((d) => d.x),
              }}
              axisLeft={{ tickSize: 4 }}
              gridYValues={4}
              enableArea
              areaOpacity={0.08}
              curve="monotoneX"
            />
          </div>
        )}
      </section>

      {/* Card ③: Pending suggestions */}
      <section className="c-learning-card">
        <h3 className="c-learning-card-title">
          <FileWarning size={16} /> Pending AI suggestions
          {suggestions ? <span className="c-learning-pill">{suggestions.length}</span> : null}
        </h3>
        {actionError ? <p className="c-learning-error">{actionError}</p> : null}
        {suggestionsError ? (
          <p className="c-learning-error">Failed to load: {suggestionsError}</p>
        ) : !suggestions ? (
          <p className="c-learning-loading">Loading…</p>
        ) : suggestions.length === 0 ? (
          <p className="c-learning-empty">
            No pending suggestions. The flywheel kicks in at 5 records per site/domain — keep
            applying and the AI will propose new classifier rules or site-adapters here.
          </p>
        ) : (
          <ul className="c-learning-suggestions">
            {suggestions.map((s) => (
              <li key={s.id} className="c-learning-suggestion">
                <SuggestionHeader envelope={s} />
                <SuggestionPreview envelope={s} />
                <div className="c-learning-actions">
                  <button
                    className="c-learning-btn c-learning-btn-ok"
                    disabled={actionBusy === s.id}
                    onClick={() => actOnSuggestion(s.id, 'approve')}
                    aria-label={`Approve ${s.id}`}
                  >
                    <CheckCircle2 size={14} /> Approve
                  </button>
                  <button
                    className="c-learning-btn c-learning-btn-bad"
                    disabled={actionBusy === s.id}
                    onClick={() => actOnSuggestion(s.id, 'reject')}
                    aria-label={`Reject ${s.id}`}
                  >
                    <XCircle size={14} /> Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Card ④: Site adapter coverage */}
      <section className="c-learning-card">
        <h3 className="c-learning-card-title">
          <Globe size={16} /> Site adapter coverage (last 30 days)
        </h3>
        {coverageError ? (
          <p className="c-learning-error">Failed to load: {coverageError}</p>
        ) : !coverage ? (
          <p className="c-learning-loading">Loading…</p>
        ) : coverage.length === 0 ? (
          <p className="c-learning-empty">No site failures yet — applies have been clean.</p>
        ) : (
          <table className="c-learning-table">
            <thead>
              <tr>
                <th>Domain</th>
                <th className="c-learning-num">Failures</th>
                <th>Adapter</th>
                <th>Coverage</th>
              </tr>
            </thead>
            <tbody>
              {coverage.map((row) => (
                <tr key={row.domain}>
                  <td>{row.domain}</td>
                  <td className="c-learning-num">{row.failures}</td>
                  <td className="c-learning-muted">{row.site_adapter_id ?? '—'}</td>
                  <td>
                    {row.has_adapter ? (
                      <span className="c-learning-tag c-learning-tag-ok">Adapter loaded</span>
                    ) : (
                      <span className="c-learning-tag c-learning-tag-warn">No adapter</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <footer className="c-learning-footer">
        <button
          type="button"
          className="c-learning-btn c-learning-btn-ghost"
          onClick={() => fetchAll()}
          aria-label="Refresh stats"
        >
          <RotateCcw size={14} /> Refresh
        </button>
        <span className="c-learning-muted">Auto-refresh every 30s</span>
      </footer>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────

function Stat({
  label,
  value,
  accent,
  muted,
}: {
  label: string
  value: number
  accent?: 'ok' | 'warn'
  muted?: boolean
}) {
  return (
    <div
      className={[
        'c-learning-stat',
        accent === 'ok' ? 'c-learning-stat-ok' : '',
        accent === 'warn' ? 'c-learning-stat-warn' : '',
        muted ? 'c-learning-stat-muted' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="c-learning-stat-value">{value}</div>
      <div className="c-learning-stat-label">{label}</div>
    </div>
  )
}

function SuggestionHeader({ envelope }: { envelope: ProposalEnvelope }) {
  const created = new Date(envelope.created_at).toLocaleString()
  return (
    <header className="c-learning-suggestion-head">
      <span className="c-learning-tag c-learning-tag-type">{envelope.type}</span>
      <span className="c-learning-suggestion-group">{envelope.group_key}</span>
      <span className="c-learning-muted">·</span>
      <span className="c-learning-muted">{created}</span>
      {envelope.model_used ? (
        <span className="c-learning-muted">
          {' '}
          ·{' '}
          {envelope.model_used.includes('haiku')
            ? 'Haiku'
            : envelope.model_used.includes('sonnet')
              ? 'Sonnet'
              : envelope.model_used}
        </span>
      ) : null}
    </header>
  )
}

// REVIEW H4 (adv) fix: sanitize LLM-generated content before display.
// Control characters + bidi overrides + zero-width chars in a regex or
// rationale could spoof what the user sees (e.g. an RTL override
// making a malicious regex look benign). React already escapes HTML —
// this addresses the social-engineering layer above that.
// Strip control + bidi + zero-width chars before render. React escapes
// HTML; this addresses the social-engineering layer where an LLM-emitted
// regex/rationale could use RTL override or zero-width chars to spoof
// what the user sees vs what they're approving.
//   \u0000-\u001f C0 controls
//   \u007f-\u009f DEL + C1 controls
//   \u200b-\u200f zero-width + LRM/RLM
//   \u202a-\u202e bidi LRE/RLE/PDF/LRO/RLO (the spoofing vector)
//   \u2066-\u2069 bidi isolate marks
// eslint-disable-next-line no-control-regex
const _UNSAFE_DISPLAY_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]', 'g')
function sanitizeForDisplay(s: unknown): string {
  return String(s ?? '').replace(_UNSAFE_DISPLAY_RE, (ch) =>
    `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

function SuggestionPreview({ envelope }: { envelope: ProposalEnvelope }) {
  const p = envelope.proposal as Record<string, unknown>
  if (envelope.type === 'classifier-rule') {
    return (
      <div className="c-learning-suggestion-body">
        <div className="c-learning-kv">
          <span className="c-learning-k">regex</span>
          <code className="c-learning-v c-learning-v-code">{sanitizeForDisplay(p.regex)}</code>
        </div>
        <div className="c-learning-kv">
          <span className="c-learning-k">→ class</span>
          <code className="c-learning-v">{sanitizeForDisplay(p.class)}</code>
        </div>
        <div className="c-learning-kv">
          <span className="c-learning-k">maps to</span>
          <code className="c-learning-v">{sanitizeForDisplay(p.maps_to)}</code>
        </div>
        {p.rationale ? (
          <div className="c-learning-kv">
            <span className="c-learning-k">why</span>
            <span className="c-learning-v c-learning-rationale">{sanitizeForDisplay(p.rationale)}</span>
          </div>
        ) : null}
      </div>
    )
  }
  // site-adapter
  return (
    <div className="c-learning-suggestion-body">
      <div className="c-learning-kv">
        <span className="c-learning-k">id</span>
        <code className="c-learning-v">{sanitizeForDisplay(p.id)}</code>
      </div>
      <div className="c-learning-kv">
        <span className="c-learning-k">name</span>
        <span className="c-learning-v">{sanitizeForDisplay(p.name)}</span>
      </div>
      <div className="c-learning-kv">
        <span className="c-learning-k">flow.type</span>
        <code className="c-learning-v">
          {sanitizeForDisplay((p.flow as Record<string, unknown> | undefined)?.type ?? '?')}
        </code>
      </div>
      <details className="c-learning-yaml-details">
        <summary>Show full YAML</summary>
        <pre className="c-learning-yaml">{sanitizeForDisplay(JSON.stringify(p, null, 2))}</pre>
      </details>
    </div>
  )
}
