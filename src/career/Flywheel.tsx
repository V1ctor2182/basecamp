// Flywheel dashboard — single page that consolidates the data-flywheel
// state into one operator-facing view.
//
// 07-applier/self-iteration/04-flywheel-dashboard.
//
// m2 ships the first two cards (this file). m3 adds two more cards
// (rule history + self-test report). m4 retires Learning/Iteration
// "(debug)" tabs and points them here.
//
//   ① Failure records (30d, by site)
//       - Verify failures   (/api/career/feedback/verify-failures, m1)
//       - Site failures     (/api/career/feedback/site-coverage)
//       - Field edits       (/api/career/feedback/stats — flat count)
//   ② Pending AI proposals (/api/career/feedback/suggestions)
//
// Principle (from project memory: "No silent errors"): each section has
// its own error gate so one section failing surfaces inline rather than
// blanking the whole page or quietly degrading to an empty state.

import { useEffect, useState, useCallback, useRef } from 'react'
import {
  CheckCircle2,
  XCircle,
  RotateCcw,
  FileWarning,
  AlertTriangle,
  Edit3,
  History,
  ClipboardCheck,
} from 'lucide-react'
import './flywheel.css'

const REFRESH_MS = 30_000

// ─── Types ────────────────────────────────────────────────────────────

type VerifyStatus = 'mismatch' | 'fill_error' | 'not_seen' | 'unverifiable'
const VERIFY_STATUSES: VerifyStatus[] = ['mismatch', 'fill_error', 'not_seen', 'unverifiable']

type VerifyFailuresResp = {
  since: string
  total: number
  by_status: Record<VerifyStatus, number>
  by_site: Record<string, Record<VerifyStatus, number>>
}

type SiteCoverageRow = {
  domain: string
  failures: number
  site_adapter_id: string | null
  has_adapter: boolean
}

type SiteCoverageResp = { rows: SiteCoverageRow[]; count: number }

type StatsResp = {
  flywheels: { field_misclassified: number; field_edits: number; site_failures: number }
  suggestions: { total: number; pending: number; approved: number; rejected: number }
}

type ProposalEnvelope = {
  id: string
  type: 'classifier-rule' | 'site-adapter'
  created_at: string
  group_key: string
  feedback_type: string
  status: 'pending' | 'approved' | 'rejected'
  model_used?: string
  source_records: Array<Record<string, unknown>>
  proposal: Record<string, unknown>
}

type SuggestionsResp = { count: number; suggestions: ProposalEnvelope[] }

// m3 — self-test report (m1 endpoint payload).
type SelftestCounts = {
  verified: number
  mismatch: number
  fill_error: number
  unverifiable: number
  not_seen: number
  manual: number
}

type SelftestJob = {
  jobId: string
  label?: string
  url?: string
  outcome: string
  error?: string | null
  counts?: Partial<SelftestCounts>
}

type SelftestReport = {
  ran_at: string | null
  fixture: string | null
  jobs: SelftestJob[]
  totals: Partial<SelftestCounts>
  by_outcome: Record<string, number>
  // m1 surfaces this only on JSON parse failure of the report file.
  error?: string
}

const SELFTEST_COUNT_KEYS: Array<keyof SelftestCounts> = [
  'verified',
  'mismatch',
  'fill_error',
  'unverifiable',
  'not_seen',
  'manual',
]

// ─── Page ─────────────────────────────────────────────────────────────

export default function Flywheel() {
  const [verify, setVerify] = useState<VerifyFailuresResp | null>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [coverage, setCoverage] = useState<SiteCoverageRow[] | null>(null)
  const [coverageError, setCoverageError] = useState<string | null>(null)
  const [stats, setStats] = useState<StatsResp | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<ProposalEnvelope[] | null>(null)
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null)
  const [approved, setApproved] = useState<ProposalEnvelope[] | null>(null)
  const [rejected, setRejected] = useState<ProposalEnvelope[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [selftest, setSelftest] = useState<SelftestReport | null>(null)
  const [selftestError, setSelftestError] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // Auto-refresh interval reads this synchronously to skip a tick while
  // an approve/reject POST is mid-flight (state updates are async).
  const actionBusyRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const fetchAll = useCallback(async (signal?: AbortSignal) => {
    await Promise.all([
      fetch('/api/career/feedback/verify-failures', { signal })
        .then(async (r) => {
          if (!r.ok) throw new Error(`verify-failures HTTP ${r.status}`)
          const json = (await r.json()) as VerifyFailuresResp
          setVerify(json)
          setVerifyError(null)
        })
        .catch((e) => {
          if ((e as { name?: string })?.name === 'AbortError') return
          setVerifyError((e as Error).message)
        }),
      fetch('/api/career/feedback/site-coverage', { signal })
        .then(async (r) => {
          if (!r.ok) throw new Error(`site-coverage HTTP ${r.status}`)
          const json = (await r.json()) as SiteCoverageResp
          setCoverage(json.rows)
          setCoverageError(null)
        })
        .catch((e) => {
          if ((e as { name?: string })?.name === 'AbortError') return
          setCoverageError((e as Error).message)
        }),
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
      // m3 — rule history: approved + rejected proposals, fetched in
      // parallel. Both feed Card ③ and share one error gate (a single
      // failure of either is rare; consolidating keeps the card concise).
      Promise.all([
        fetch('/api/career/feedback/suggestions?status=approved', { signal }).then(
          async (r) => {
            if (!r.ok) throw new Error(`approved HTTP ${r.status}`)
            return (await r.json()) as SuggestionsResp
          },
        ),
        fetch('/api/career/feedback/suggestions?status=rejected', { signal }).then(
          async (r) => {
            if (!r.ok) throw new Error(`rejected HTTP ${r.status}`)
            return (await r.json()) as SuggestionsResp
          },
        ),
      ])
        .then(([a, x]) => {
          setApproved(a.suggestions)
          setRejected(x.suggestions)
          setHistoryError(null)
        })
        .catch((e) => {
          if ((e as { name?: string })?.name === 'AbortError') return
          setHistoryError((e as Error).message)
        }),
      // m3 — self-test report (read-only; from-page trigger is Deferred).
      fetch('/api/career/feedback/selftest-report', { signal })
        .then(async (r) => {
          if (!r.ok) throw new Error(`selftest-report HTTP ${r.status}`)
          const json = (await r.json()) as SelftestReport
          setSelftest(json)
          // Surface a parse-failure marker even though the HTTP was 200 —
          // the m1 endpoint embeds `error` on a corrupt report file.
          setSelftestError(json.error ?? null)
        })
        .catch((e) => {
          if ((e as { name?: string })?.name === 'AbortError') return
          setSelftestError((e as Error).message)
        }),
    ])
  }, [])

  useEffect(() => {
    const ctrl = new AbortController()
    fetchAll(ctrl.signal)
    const t = setInterval(() => {
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
      const r = await fetch(
        `/api/career/feedback/suggestions/${encodeURIComponent(id)}/${action}`,
        { method: 'POST', signal: ac.signal },
      )
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

  return (
    <div className="c-fw-root">
      <header className="c-fw-header">
        <h2 className="c-fw-title">Flywheel</h2>
        <p className="c-fw-sub">
          Applier 数据飞轮 — 失败记录 · 待审 AI 提议 · 自测报告（m3 上线）
        </p>
      </header>

      {/* Card ①: Failure records */}
      <section className="c-fw-card">
        <h3 className="c-fw-card-title">
          <AlertTriangle size={16} /> Failure records (last 30 days, by site)
        </h3>

        {/* ①a verify-failures */}
        <div className="c-fw-sub">
          <h4 className="c-fw-sub-title">Post-fill verification failures</h4>
          {verifyError ? (
            <p className="c-fw-error">Failed to load: {verifyError}</p>
          ) : !verify ? (
            <p className="c-fw-loading">Loading…</p>
          ) : verify.total === 0 ? (
            <p className="c-fw-empty">No verify failures recorded. Run the self-test to populate this.</p>
          ) : (
            <VerifyFailuresTable resp={verify} />
          )}
        </div>

        {/* ①b site-failures by domain */}
        <div className="c-fw-sub">
          <h4 className="c-fw-sub-title">Apply failures (by domain)</h4>
          {coverageError ? (
            <p className="c-fw-error">Failed to load: {coverageError}</p>
          ) : !coverage ? (
            <p className="c-fw-loading">Loading…</p>
          ) : coverage.length === 0 ? (
            <p className="c-fw-empty">No site failures yet — applies have been clean.</p>
          ) : (
            <table className="c-fw-table">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th className="c-fw-num">Failures</th>
                  <th>Adapter</th>
                  <th>Coverage</th>
                </tr>
              </thead>
              <tbody>
                {coverage.map((row) => (
                  <tr key={row.domain}>
                    <td>{row.domain}</td>
                    <td className="c-fw-num">{row.failures}</td>
                    <td className="c-fw-muted">{row.site_adapter_id ?? '—'}</td>
                    <td>
                      {row.has_adapter ? (
                        <span className="c-fw-tag c-fw-tag-ok">Adapter loaded</span>
                      ) : (
                        <span className="c-fw-tag c-fw-tag-warn">No adapter</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ①c field-edits — flat counts (no by-site index for field-edits). */}
        <div className="c-fw-sub">
          <h4 className="c-fw-sub-title">
            <Edit3 size={13} /> Classifier-output edits & misclassifications (30d totals)
          </h4>
          {statsError ? (
            <p className="c-fw-error">Failed to load: {statsError}</p>
          ) : !stats ? (
            <p className="c-fw-loading">Loading…</p>
          ) : (
            <div className="c-fw-stats-row">
              <Stat label="User edits to drafts" value={stats.flywheels.field_edits} />
              <Stat label="Misclassified fields" value={stats.flywheels.field_misclassified} />
              <Stat label="Site failures (total)" value={stats.flywheels.site_failures} />
            </div>
          )}
          <p className="c-fw-note">
            Field-edits records don't always carry a site tag (the editor doesn't
            always know which adapter handled the form). Edits aggregate flat;
            verify + site failures group by site/domain above.
          </p>
        </div>
      </section>

      {/* Card ②: Pending AI proposals */}
      <section className="c-fw-card">
        <h3 className="c-fw-card-title">
          <FileWarning size={16} /> Pending AI proposals
          {suggestions ? <span className="c-fw-pill">{suggestions.length}</span> : null}
        </h3>
        {actionError ? <p className="c-fw-error">{actionError}</p> : null}
        {suggestionsError ? (
          <p className="c-fw-error">Failed to load: {suggestionsError}</p>
        ) : !suggestions ? (
          <p className="c-fw-loading">Loading…</p>
        ) : suggestions.length === 0 ? (
          <p className="c-fw-empty">
            No pending proposals. The inducers cluster at ≥5 records per site/domain —
            keep applying and proposals will queue here for approval.
          </p>
        ) : (
          <ul className="c-fw-suggestions">
            {suggestions.map((s) => (
              <li key={s.id} className="c-fw-suggestion">
                <SuggestionHeader envelope={s} />
                <SuggestionPreview envelope={s} />
                <div className="c-fw-actions">
                  <button
                    className="c-fw-btn c-fw-btn-ok"
                    disabled={actionBusy === s.id}
                    onClick={() => actOnSuggestion(s.id, 'approve')}
                    aria-label={`Approve ${s.id}`}
                  >
                    <CheckCircle2 size={14} /> Approve
                  </button>
                  <button
                    className="c-fw-btn c-fw-btn-bad"
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

      {/* Card ③: Rule history — applied + rejected */}
      <section className="c-fw-card">
        <h3 className="c-fw-card-title">
          <History size={16} /> Rule history
          {approved && rejected ? (
            <span className="c-fw-pill c-fw-pill-muted">
              {approved.length + rejected.length}
            </span>
          ) : null}
        </h3>
        {historyError ? (
          <p className="c-fw-error">Failed to load: {historyError}</p>
        ) : !approved || !rejected ? (
          <p className="c-fw-loading">Loading…</p>
        ) : approved.length === 0 && rejected.length === 0 ? (
          <p className="c-fw-empty">
            No proposals have been acted on yet. Approving or rejecting a pending
            proposal above moves it here.
          </p>
        ) : (
          <div className="c-fw-history">
            <RuleHistoryList
              title="Applied"
              accent="ok"
              items={approved}
              emptyText="None approved yet."
            />
            <RuleHistoryList
              title="Rejected"
              accent="bad"
              items={rejected}
              emptyText="None rejected yet."
            />
          </div>
        )}
      </section>

      {/* Card ④: Self-test report (read-only — from-page trigger is Deferred) */}
      <section className="c-fw-card">
        <h3 className="c-fw-card-title">
          <ClipboardCheck size={16} /> Applier self-test report
        </h3>
        {/* When the report file is missing the endpoint returns an empty
            shell (ran_at: null) — that's "never run", not an error. The
            parse-failure marker (selftestError when payload includes
            error) renders inline below the loading branch. */}
        {!selftest ? (
          <p className="c-fw-loading">Loading…</p>
        ) : selftest.ran_at == null ? (
          <p className="c-fw-empty">
            No self-test report on file. Run{' '}
            <code className="c-fw-v-code">node scripts/applier-selftest.mjs</code> to
            populate this.
          </p>
        ) : (
          <SelftestReportBlock report={selftest} />
        )}
        {selftestError ? (
          <p className="c-fw-error">{selftestError}</p>
        ) : null}
      </section>

      <footer className="c-fw-footer">
        <button
          type="button"
          className="c-fw-btn c-fw-btn-ghost"
          onClick={() => fetchAll()}
          aria-label="Refresh"
        >
          <RotateCcw size={14} /> Refresh
        </button>
        <span className="c-fw-muted">Auto-refresh every 30s</span>
      </footer>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────

function VerifyFailuresTable({ resp }: { resp: VerifyFailuresResp }) {
  const sites = Object.keys(resp.by_site).sort()
  return (
    <table className="c-fw-table">
      <thead>
        <tr>
          <th>Site</th>
          {VERIFY_STATUSES.map((st) => (
            <th key={st} className="c-fw-num">
              {st}
            </th>
          ))}
          <th className="c-fw-num">Total</th>
        </tr>
      </thead>
      <tbody>
        {sites.map((site) => {
          const row = resp.by_site[site]
          const total = VERIFY_STATUSES.reduce((sum, st) => sum + (row[st] ?? 0), 0)
          return (
            <tr key={site}>
              <td>{site}</td>
              {VERIFY_STATUSES.map((st) => (
                <td key={st} className="c-fw-num">
                  {row[st] ?? 0}
                </td>
              ))}
              <td className="c-fw-num c-fw-num-strong">{total}</td>
            </tr>
          )
        })}
        <tr className="c-fw-row-total">
          <td>Total</td>
          {VERIFY_STATUSES.map((st) => (
            <td key={st} className="c-fw-num">
              {resp.by_status[st] ?? 0}
            </td>
          ))}
          <td className="c-fw-num c-fw-num-strong">{resp.total}</td>
        </tr>
      </tbody>
    </table>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="c-fw-stat">
      <div className="c-fw-stat-value">{value}</div>
      <div className="c-fw-stat-label">{label}</div>
    </div>
  )
}

function SuggestionHeader({ envelope }: { envelope: ProposalEnvelope }) {
  const created = new Date(envelope.created_at).toLocaleString()
  return (
    <header className="c-fw-suggestion-head">
      <span className="c-fw-tag c-fw-tag-type">{envelope.type}</span>
      <span className="c-fw-suggestion-group">{envelope.group_key}</span>
      <span className="c-fw-muted">·</span>
      <span className="c-fw-muted">{created}</span>
      {envelope.model_used ? (
        <span className="c-fw-muted">
          {' · '}
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

// Strip control + bidi + zero-width chars from LLM-emitted strings before
// rendering. React escapes HTML; this addresses the social-engineering
// layer where an LLM-emitted regex/rationale could use RTL overrides or
// zero-width chars to spoof what the user sees vs. what they're approving.
// eslint-disable-next-line no-control-regex
const _UNSAFE_DISPLAY_RE = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]',
  'g',
)
function sanitizeForDisplay(s: unknown): string {
  return String(s ?? '').replace(_UNSAFE_DISPLAY_RE, (ch) =>
    `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

function RuleHistoryList({
  title,
  accent,
  items,
  emptyText,
}: {
  title: string
  accent: 'ok' | 'bad'
  items: ProposalEnvelope[]
  emptyText: string
}) {
  return (
    <div className="c-fw-history-col">
      <h4 className="c-fw-sub-title">
        <span className={`c-fw-tag c-fw-tag-${accent === 'ok' ? 'ok' : 'warn'}`}>
          {title}
        </span>
        <span className="c-fw-muted">({items.length})</span>
      </h4>
      {items.length === 0 ? (
        <p className="c-fw-empty">{emptyText}</p>
      ) : (
        <ul className="c-fw-history-list">
          {items.map((e) => (
            <li key={e.id} className="c-fw-history-item">
              <div className="c-fw-history-line">
                <span className="c-fw-tag c-fw-tag-type">{e.type}</span>
                <span className="c-fw-suggestion-group">{e.group_key}</span>
                <span className="c-fw-muted">·</span>
                <span className="c-fw-muted">{new Date(e.created_at).toLocaleDateString()}</span>
              </div>
              <div className="c-fw-history-line c-fw-history-preview">
                {ruleHistoryPreview(e)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ruleHistoryPreview(envelope: ProposalEnvelope): string {
  const p = envelope.proposal
  if (envelope.type === 'classifier-rule') {
    const regex = sanitizeForDisplay(p.regex)
    const cls = sanitizeForDisplay(p.class)
    const mapsTo = sanitizeForDisplay(p.maps_to)
    return `/${regex}/i → ${cls} (${mapsTo})`
  }
  // site-adapter
  const id = sanitizeForDisplay(p.id)
  const flowType = sanitizeForDisplay(
    (p.flow as Record<string, unknown> | undefined)?.type ?? '?',
  )
  return `${id} · flow=${flowType}`
}

function SelftestReportBlock({ report }: { report: SelftestReport }) {
  const fixtureName = (report.fixture ?? '').split('/').pop() || '—'
  const ranAt = report.ran_at ? new Date(report.ran_at).toLocaleString() : '—'
  const totals = report.totals ?? {}
  const outcomes = Object.entries(report.by_outcome ?? {})
  return (
    <div className="c-fw-selftest">
      <div className="c-fw-selftest-meta">
        <span>
          <span className="c-fw-muted">Last run:</span> {ranAt}
        </span>
        <span>
          <span className="c-fw-muted">Fixture:</span>{' '}
          <code className="c-fw-v-code">{fixtureName}</code>
        </span>
        <span>
          <span className="c-fw-muted">Jobs:</span> {report.jobs.length}
        </span>
      </div>

      {outcomes.length > 0 ? (
        <div className="c-fw-selftest-outcomes">
          {outcomes.map(([k, v]) => (
            <span key={k} className="c-fw-tag c-fw-tag-type">
              {k}: {v}
            </span>
          ))}
        </div>
      ) : null}

      <div className="c-fw-stats-row">
        {SELFTEST_COUNT_KEYS.map((k) => (
          <Stat key={k} label={k} value={totals[k] ?? 0} />
        ))}
      </div>

      {report.jobs.length > 0 ? (
        <table className="c-fw-table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Outcome</th>
              {SELFTEST_COUNT_KEYS.map((k) => (
                <th key={k} className="c-fw-num">
                  {k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.jobs.map((j) => (
              <tr key={j.jobId}>
                <td>
                  <div>{j.label ?? j.jobId}</div>
                  {j.error ? (
                    <div className="c-fw-error c-fw-history-preview">{j.error}</div>
                  ) : null}
                </td>
                <td>
                  <span
                    className={`c-fw-tag c-fw-tag-${j.outcome === 'completed' ? 'ok' : 'warn'}`}
                  >
                    {j.outcome}
                  </span>
                </td>
                {SELFTEST_COUNT_KEYS.map((k) => (
                  <td key={k} className="c-fw-num">
                    {j.counts?.[k] ?? 0}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  )
}

function SuggestionPreview({ envelope }: { envelope: ProposalEnvelope }) {
  const p = envelope.proposal
  if (envelope.type === 'classifier-rule') {
    return (
      <div className="c-fw-suggestion-body">
        <div className="c-fw-kv">
          <span className="c-fw-k">regex</span>
          <code className="c-fw-v c-fw-v-code">{sanitizeForDisplay(p.regex)}</code>
        </div>
        <div className="c-fw-kv">
          <span className="c-fw-k">→ class</span>
          <code className="c-fw-v">{sanitizeForDisplay(p.class)}</code>
        </div>
        <div className="c-fw-kv">
          <span className="c-fw-k">maps to</span>
          <code className="c-fw-v">{sanitizeForDisplay(p.maps_to)}</code>
        </div>
        {p.rationale ? (
          <div className="c-fw-kv">
            <span className="c-fw-k">why</span>
            <span className="c-fw-v c-fw-rationale">{sanitizeForDisplay(p.rationale)}</span>
          </div>
        ) : null}
      </div>
    )
  }
  return (
    <div className="c-fw-suggestion-body">
      <div className="c-fw-kv">
        <span className="c-fw-k">id</span>
        <code className="c-fw-v">{sanitizeForDisplay(p.id)}</code>
      </div>
      <div className="c-fw-kv">
        <span className="c-fw-k">name</span>
        <span className="c-fw-v">{sanitizeForDisplay(p.name)}</span>
      </div>
      <div className="c-fw-kv">
        <span className="c-fw-k">flow.type</span>
        <code className="c-fw-v">
          {sanitizeForDisplay((p.flow as Record<string, unknown> | undefined)?.type ?? '?')}
        </code>
      </div>
      <details className="c-fw-yaml-details">
        <summary>Show full YAML</summary>
        <pre className="c-fw-yaml">{sanitizeForDisplay(JSON.stringify(p, null, 2))}</pre>
      </details>
    </div>
  )
}

