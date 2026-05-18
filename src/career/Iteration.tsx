// Iteration tab — observability layer for the self-iteration sub-epic.
//
// 07-applier/self-iteration/03-iteration-dashboard m2.
//
// Three sections (D Coverage detail + Promote modal → m3):
//   A. Health header — APPLY count / SUCCESS rate / 30d failures / calibration / pending counts
//   B. Event stream — paginated 30/page, "load more" via composite (ts, id) cursor
//   C. Pending Actions queue — Promote (placeholder buttons, m3 wires modal),
//      PR review (link to GitHub), Tier 2/3 (placeholder per locked m3-OQ)
//
// Polling: 30s setInterval with AbortController cleanup (D2). 0 LLM call
// on render (D5) — server aggregates over existing JSONL stores.

import { useEffect, useState, useCallback, useRef } from 'react'
import {
  Activity,
  Heart,
  ListChecks,
  Inbox,
  ExternalLink,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
} from 'lucide-react'
import './iteration.css'

const REFRESH_MS = 30_000
const EVENT_PAGE_SIZE = 30

// ─── Types (mirror src/career/iteration/eventStream.mjs response shapes) ──

type HealthResp = {
  window_days: number
  apply_count: number
  success_rate: number | null
  failure_count: number
  calibration_min: number | null
  pending_counts: {
    promote: number
    pr_review: number
    tier2: number
    tier3: number
  }
  generated_at: string
}

type EventKind =
  | 'evidence.captured'
  | 'field.edited'
  | 'field.misclassified'
  | 'suggestion.proposed'
  | 'suggestion.approved'
  | 'suggestion.rejected'
  | 'tuner.run'
  | 'apply.completed'
  | 'qa-bank.entry.added'

type EventRow = {
  id: string
  ts: string
  kind: EventKind
  ref?: string | null
  summary: string
  payload: Record<string, unknown>
}

type EventsResp = {
  events: EventRow[]
  hasMore: boolean
  nextCursor: { ts: string; id: string } | null
}

type PendingResp = {
  promote: Array<{
    id: string
    ts: string
    jobId?: string
    domain: string
    site_adapter_id?: string | null
    error_kind: string
    error_message: string
  }>
  pr_review: Array<{ id: string; ts: string; type: string; group_key: string }>
  tier2: unknown[]
  tier3: unknown[]
}

// ─── Page ─────────────────────────────────────────────────────────────

export default function Iteration() {
  const [health, setHealth] = useState<HealthResp | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [events, setEvents] = useState<EventRow[]>([])
  const [eventsError, setEventsError] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<{ ts: string; id: string } | null>(null)
  const [hasMore, setHasMore] = useState<boolean>(false)
  const [loadingMore, setLoadingMore] = useState<boolean>(false)
  const [pending, setPending] = useState<PendingResp | null>(null)
  const [pendingError, setPendingError] = useState<string | null>(null)

  // Mirror Learning.tsx pattern — mountedRef so post-async setState bails
  // when the component has unmounted, and an action-busy ref so polling
  // skips while a load-more is mid-flight.
  const mountedRef = useRef(true)
  const loadingMoreRef = useRef(false)
  // REVIEW HIGH 2 (adv) fix: track fetchMore's AbortController so the
  // unmount cleanup can abort an in-flight load-more (was leaking a full
  // network round-trip on rapid navigate-away).
  const fetchMoreCtrlRef = useRef<AbortController | null>(null)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      fetchMoreCtrlRef.current?.abort()
    }
  }, [])

  // First-page fetch: replaces the events list (used on mount + poll).
  const fetchAll = useCallback(async (signal?: AbortSignal) => {
    await Promise.all([
      fetch('/api/career/iteration/health', { signal })
        .then(async (r) => {
          if (!r.ok) throw new Error(`health HTTP ${r.status}`)
          if (!mountedRef.current) return
          setHealth((await r.json()) as HealthResp)
          setHealthError(null)
        })
        .catch((e) => {
          if ((e as { name?: string })?.name === 'AbortError') return
          if (mountedRef.current) setHealthError((e as Error).message)
        }),
      fetch(`/api/career/iteration/events?limit=${EVENT_PAGE_SIZE}`, { signal })
        .then(async (r) => {
          if (!r.ok) throw new Error(`events HTTP ${r.status}`)
          // REVIEW HIGH 1 (Plan + adv) fix: gate setEvents on
          // loadingMoreRef AT setState time, not just before fetchAll
          // start. Pre-fix sequence: 30s tick fires fetchAll's events
          // request, user clicks Load More mid-flight, load-more
          // appends pages, then the in-flight poll response arrives
          // and clobbers the append via setEvents(json.events). Now
          // we drop the poll's response if a load-more is racing.
          if (!mountedRef.current || loadingMoreRef.current) return
          const json = (await r.json()) as EventsResp
          setEvents(json.events)
          setHasMore(!!json.hasMore)
          setNextCursor(json.nextCursor)
          setEventsError(null)
        })
        .catch((e) => {
          if ((e as { name?: string })?.name === 'AbortError') return
          if (mountedRef.current) setEventsError((e as Error).message)
        }),
      fetch('/api/career/iteration/pending', { signal })
        .then(async (r) => {
          if (!r.ok) throw new Error(`pending HTTP ${r.status}`)
          if (!mountedRef.current) return
          setPending((await r.json()) as PendingResp)
          setPendingError(null)
        })
        .catch((e) => {
          if ((e as { name?: string })?.name === 'AbortError') return
          if (mountedRef.current) setPendingError((e as Error).message)
        }),
    ])
  }, [])

  // Append next-page (load-more button). Uses the cursor returned by the
  // first-page fetch; never replaces the head of the list.
  const fetchMore = useCallback(async () => {
    if (!nextCursor || loadingMoreRef.current) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    // REVIEW HIGH 2 (adv) fix: stash the controller on the ref so the
    // unmount cleanup can abort it. Previously fetchMore created a
    // local controller that survived unmount as a wasted round-trip.
    const ac = new AbortController()
    fetchMoreCtrlRef.current = ac
    try {
      const url =
        `/api/career/iteration/events?limit=${EVENT_PAGE_SIZE}` +
        `&before_ts=${encodeURIComponent(nextCursor.ts)}` +
        `&before_id=${encodeURIComponent(nextCursor.id)}`
      const r = await fetch(url, { signal: ac.signal })
      if (!r.ok) throw new Error(`events HTTP ${r.status}`)
      if (!mountedRef.current) return
      const json = (await r.json()) as EventsResp
      setEvents((prev) => [...prev, ...json.events])
      setHasMore(!!json.hasMore)
      setNextCursor(json.nextCursor)
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return
      if (mountedRef.current) setEventsError((e as Error).message)
    } finally {
      if (mountedRef.current) setLoadingMore(false)
      loadingMoreRef.current = false
      if (fetchMoreCtrlRef.current === ac) fetchMoreCtrlRef.current = null
    }
  }, [nextCursor])

  useEffect(() => {
    const ctrl = new AbortController()
    fetchAll(ctrl.signal)
    const t = setInterval(() => {
      // Skip auto-refresh while load-more is mid-flight to avoid clobbering
      // the appended pages with a fresh first-page replace.
      if (loadingMoreRef.current) return
      fetchAll(ctrl.signal)
    }, REFRESH_MS)
    return () => {
      ctrl.abort()
      clearInterval(t)
    }
  }, [fetchAll])

  return (
    <div className="c-iter-root">
      <header className="c-iter-header">
        <h2 className="c-iter-title">
          <Activity size={20} /> Iteration
        </h2>
        <p className="c-iter-sub">
          实时观察 applier 的自我迭代 — 健康度 · 事件流 · 等你做的事
        </p>
      </header>

      {/* A. Health header */}
      <section className="c-iter-card">
        <h3 className="c-iter-card-title">
          <Heart size={16} /> Health (last 30d)
        </h3>
        {healthError ? (
          <p className="c-iter-error">Failed to load: {healthError}</p>
        ) : !health ? (
          <p className="c-iter-loading">Loading…</p>
        ) : (
          <div className="c-iter-stats-grid">
            <Stat label="Apply count" value={health.apply_count} />
            <Stat
              label="Success rate"
              value={formatPercent(health.success_rate)}
              accent={successAccent(health.success_rate)}
            />
            <Stat
              label="30d failures"
              value={health.failure_count}
              accent={health.failure_count > 0 ? 'warn' : 'ok'}
            />
            <Stat
              label="01 calibration"
              value={formatPercent(health.calibration_min)}
              accent={calibrationAccent(health.calibration_min)}
            />
            <Stat
              label="Pending promote"
              value={health.pending_counts.promote}
              accent={health.pending_counts.promote > 0 ? 'warn' : 'muted'}
            />
            <Stat
              label="Pending PR review"
              value={health.pending_counts.pr_review}
              accent={health.pending_counts.pr_review > 0 ? 'warn' : 'muted'}
            />
          </div>
        )}
      </section>

      {/* B. Event stream */}
      <section className="c-iter-card">
        <h3 className="c-iter-card-title">
          <ListChecks size={16} /> Event stream
          {events.length > 0 && (
            <span className="c-iter-pill">{events.length}{hasMore ? '+' : ''}</span>
          )}
        </h3>
        {eventsError ? (
          <p className="c-iter-error">Failed to load: {eventsError}</p>
        ) : events.length === 0 ? (
          <p className="c-iter-empty">No events in the last 30 days.</p>
        ) : (
          <>
            <ol className="c-iter-events">
              {events.map((e) => (
                <EventCard key={`${e.kind}-${e.id}`} event={e} />
              ))}
            </ol>
            {hasMore && (
              <button
                type="button"
                className="c-iter-btn c-iter-btn-ghost"
                onClick={fetchMore}
                disabled={loadingMore}
              >
                <ChevronDown size={14} />
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </>
        )}
      </section>

      {/* C. Pending Actions queue */}
      <section className="c-iter-card">
        <h3 className="c-iter-card-title">
          <Inbox size={16} /> Pending Actions
        </h3>
        {pendingError ? (
          <p className="c-iter-error">Failed to load: {pendingError}</p>
        ) : !pending ? (
          <p className="c-iter-loading">Loading…</p>
        ) : (
          <div className="c-iter-pending">
            <PendingGroup
              kind="promote"
              title="🔴 Promote queue"
              count={pending.promote.length}
              tooltip="评估失败 → fixture corpus"
              items={pending.promote.slice(0, 5).map((p) => ({
                key: p.id,
                primary: `${p.domain}`,
                secondary: `${p.error_kind} — ${p.error_message.slice(0, 80)}`,
                action: <PromotePlaceholder id={p.id} />,
              }))}
              total={pending.promote.length}
            />
            <PendingGroup
              kind="pr_review"
              title="🟠 PR review"
              count={pending.pr_review.length}
              tooltip="Haiku-induced suggestions awaiting approve/reject"
              items={pending.pr_review.slice(0, 5).map((p) => ({
                key: p.id,
                primary: `${p.type} — ${p.group_key}`,
                secondary: `proposed ${formatRelative(p.ts)}`,
                action: (
                  <a
                    className="c-iter-btn c-iter-btn-ghost"
                    href="/career/learning"
                    title="Approve/Reject in Learning tab"
                  >
                    <ExternalLink size={14} /> Review
                  </a>
                ),
              }))}
              total={pending.pr_review.length}
            />
            <PendingGroup
              kind="tier2"
              title="⚪ Tier 2 backlog"
              count={0}
              tooltip="Pattern clustering not in V1 scope — placeholder per m3-OQ"
              items={[]}
              total={0}
            />
            <PendingGroup
              kind="tier3"
              title="⚫ Tier 3 backlog"
              count={0}
              tooltip="Architecture-change patterns — not in V1 scope"
              items={[]}
              total={0}
            />
          </div>
        )}
      </section>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────

type StatAccent = 'ok' | 'warn' | 'muted' | undefined

function Stat({ label, value, accent }: { label: string; value: number | string; accent?: StatAccent }) {
  const cls = ['c-iter-stat']
  if (accent === 'ok') cls.push('c-iter-stat-ok')
  else if (accent === 'warn') cls.push('c-iter-stat-warn')
  else if (accent === 'muted') cls.push('c-iter-stat-muted')
  return (
    <div className={cls.join(' ')}>
      <div className="c-iter-stat-value">{value}</div>
      <div className="c-iter-stat-label">{label}</div>
    </div>
  )
}

function EventCard({ event }: { event: EventRow }) {
  const tier = eventTier(event.kind)
  return (
    <li className={`c-iter-event c-iter-event-${tier}`}>
      <div className="c-iter-event-row">
        <span className={`c-iter-event-dot c-iter-event-dot-${tier}`} aria-hidden="true">
          {eventGlyph(event.kind)}
        </span>
        <span className="c-iter-event-kind">{eventLabel(event.kind)}</span>
        <span className="c-iter-event-ts" title={event.ts}>
          {formatRelative(event.ts)}
        </span>
      </div>
      <div className="c-iter-event-summary">{event.summary}</div>
      {event.ref && <div className="c-iter-event-ref">ref: {event.ref}</div>}
    </li>
  )
}

function PendingGroup({
  title,
  count,
  tooltip,
  items,
  total,
}: {
  kind: string
  title: string
  count: number
  tooltip: string
  items: Array<{ key: string; primary: string; secondary: string; action: React.ReactNode }>
  total: number
}) {
  return (
    <div className="c-iter-pending-group">
      <div className="c-iter-pending-head" title={tooltip}>
        <span className="c-iter-pending-title">{title}</span>
        <span
          className={`c-iter-pending-count${count > 0 ? ' c-iter-pending-count-on' : ''}`}
        >
          {count}
        </span>
      </div>
      {items.length === 0 ? (
        count === 0 ? (
          <p className="c-iter-pending-empty">
            <CheckCircle2 size={12} /> nothing pending
          </p>
        ) : null
      ) : (
        <ul className="c-iter-pending-list">
          {items.map((it) => (
            <li key={it.key} className="c-iter-pending-item">
              <div className="c-iter-pending-text">
                <div className="c-iter-pending-primary">{it.primary}</div>
                <div className="c-iter-pending-secondary">{it.secondary}</div>
              </div>
              <div className="c-iter-pending-action">{it.action}</div>
            </li>
          ))}
          {total > items.length && (
            <li className="c-iter-pending-more">
              … +{total - items.length} more (m3 modal will surface full list)
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

function PromotePlaceholder({ id }: { id: string }) {
  // m3 will wire the actual modal + POST /promote/:id. m2 ships the
  // queue display only; the disabled button keeps the visual contract
  // stable so m3 can swap behavior without re-layout.
  return (
    <button
      type="button"
      className="c-iter-btn c-iter-btn-ghost"
      disabled
      title={`Modal coming in m3. For now: curl -XPOST /api/career/iteration/promote/${id}`}
    >
      <AlertCircle size={14} /> Promote
    </button>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────

function formatPercent(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(1)}%`
}

function successAccent(rate: number | null): StatAccent {
  if (rate === null) return 'muted'
  if (rate >= 0.9) return 'ok'
  if (rate >= 0.6) return 'warn'
  return undefined
}

function calibrationAccent(min: number | null): StatAccent {
  if (min === null) return 'muted'
  if (min >= 0.9) return 'ok'
  if (min >= 0.6) return 'warn'
  return undefined
}

// REVIEW MEDIUM 1 (Plan + adv) fix: exhaustive switches via `never`
// assertion at the bottom. Adding a new EventKind in m1's eventStream.mjs
// would otherwise silently land in the catch-all and render with no
// distinct color / glyph / label. The `_ex satisfies never` line forces
// TypeScript to fail compilation when a case is missing.
function eventTier(kind: EventKind): 'good' | 'warn' | 'bad' | 'info' {
  switch (kind) {
    case 'apply.completed':
    case 'qa-bank.entry.added':
    case 'suggestion.approved':
      return 'good'
    case 'field.edited':
    case 'field.misclassified':
    case 'suggestion.proposed':
    case 'tuner.run':
      return 'warn'
    case 'evidence.captured':
      return 'bad'
    case 'suggestion.rejected':
      return 'info'
    default: {
      const _ex: never = kind
      void _ex
      return 'info'
    }
  }
}

function eventGlyph(kind: EventKind): string {
  switch (kind) {
    case 'apply.completed':
    case 'qa-bank.entry.added':
    case 'field.edited':
    case 'field.misclassified': return '🟢'
    case 'suggestion.proposed':
    case 'tuner.run': return '🟣'
    case 'suggestion.approved': return '🟠'
    case 'suggestion.rejected': return '🔵'
    case 'evidence.captured': return '🔴'
    default: {
      const _ex: never = kind
      void _ex
      return '⚪'
    }
  }
}

function eventLabel(kind: EventKind): string {
  switch (kind) {
    case 'evidence.captured': return 'Evidence captured'
    case 'field.edited': return 'Field edited'
    case 'field.misclassified': return 'Field misclassified'
    case 'suggestion.proposed': return 'Suggestion proposed'
    case 'suggestion.approved': return 'Suggestion approved'
    case 'suggestion.rejected': return 'Suggestion rejected'
    case 'tuner.run': return 'Tuner ran'
    case 'apply.completed': return 'Apply completed'
    case 'qa-bank.entry.added': return 'qa-bank entry'
    default: {
      const _ex: never = kind
      void _ex
      return String(kind)
    }
  }
}

/** Minimal relative time formatter — mirrors the convention used by
 *  Applied.tsx so users see consistent timestamps. */
function formatRelative(iso: string): string {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return iso
  const diffMs = Date.now() - ts
  const min = 60_000
  const hr = 60 * min
  const day = 24 * hr
  if (diffMs < min) return 'just now'
  if (diffMs < hr) return `${Math.floor(diffMs / min)}m ago`
  if (diffMs < day) return `${Math.floor(diffMs / hr)}h ago`
  if (diffMs < 30 * day) return `${Math.floor(diffMs / day)}d ago`
  return new Date(ts).toISOString().slice(0, 10)
}
