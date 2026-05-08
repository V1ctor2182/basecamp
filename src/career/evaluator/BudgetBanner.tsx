// Budget banner — Pipeline-tab-top status of today's Sonnet+Tailor spend.
// Polls /api/career/evaluate/budget every 30s and renders one of three
// visual states based on the response:
//
//   normal  — small inline ribbon with cost breakdown + budget total
//   warning — yellow banner at ≥80% of budget (with dismiss)
//   paused  — red banner at ≥100% of budget (with dismiss + Edit budget link)
//
// constraint-budget-gate-001 #2: banner is the user-facing channel — never
// silent. Dismiss is per-state via sessionStorage so a state TRANSITION
// (warning→paused or back) re-emerges the banner; hard refresh also clears.

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, AlertCircle, X } from 'lucide-react'
import './budgetBanner.css'

type BudgetByCallerEntry = {
  total_cost: number
  total_tokens: number
  record_count: number
}

type BudgetResp = {
  today_total_usd: number
  daily_budget_usd: number
  paused: boolean
  warning: boolean
  by_caller: Record<string, BudgetByCallerEntry>
  day_start: string
}

type BannerState = 'paused' | 'warning' | 'normal'

const REFRESH_MS = 30_000
const STAGE_A_KEY = 'evaluator:stage-a'
const STAGE_B_KEY = 'evaluator:stage-b'
const TAILOR_KEY = 'cv-tailor'

function dismissKey(state: BannerState): string {
  return `bg-banner-dismissed-${state}`
}

function isDismissed(state: BannerState): boolean {
  if (typeof sessionStorage === 'undefined') return false
  // Safari private mode / disabled storage throws on access — caller
  // gets "not dismissed" which is the safe fallback (banner shows).
  try {
    return sessionStorage.getItem(dismissKey(state)) === '1'
  } catch {
    return false
  }
}

function setDismissed(state: BannerState): void {
  if (typeof sessionStorage === 'undefined') return
  // Wrap in try/catch — Safari private mode throws QuotaExceededError on
  // first setItem; failing-to-persist-dismiss is acceptable (banner will
  // re-show on next render, user can dismiss again).
  try {
    sessionStorage.setItem(dismissKey(state), '1')
  } catch {
    /* swallow */
  }
}

function clearDismissed(state: BannerState): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.removeItem(dismissKey(state))
  } catch {
    /* swallow */
  }
}

function callerCount(by_caller: Record<string, BudgetByCallerEntry>, key: string): number {
  return by_caller[key]?.record_count ?? 0
}
function callerCost(by_caller: Record<string, BudgetByCallerEntry>, key: string): number {
  return by_caller[key]?.total_cost ?? 0
}

function deriveState(data: BudgetResp): BannerState {
  if (data.paused) return 'paused'
  if (data.warning) return 'warning'
  return 'normal'
}

export default function BudgetBanner() {
  const [data, setData] = useState<BudgetResp | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Lazy-init from sessionStorage so the first render after data arrives
  // doesn't briefly show a banner the user already dismissed (review fix
  // for 1-frame flash).
  const [dismissedState, setDismissedState] = useState<BannerState | null>(() => {
    // We don't know the current state yet (data is null), so seed with
    // 'warning' if dismissed — that's the only dismissible state. paused
    // state is NOT dismissible per constraint #2 (must always surface
    // hard blocks).
    return isDismissed('warning') ? 'warning' : null
  })
  const prevStateRef = useRef<BannerState | null>(null)

  async function fetchBudget(signal?: AbortSignal) {
    try {
      const r = await fetch('/api/career/evaluate/budget', { signal })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const json = (await r.json()) as BudgetResp
      setData(json)
      setError(null)
    } catch (e) {
      const name = (e as { name?: string })?.name
      if (name === 'AbortError') return
      setError((e as Error).message ?? 'Failed to load budget')
    }
  }

  useEffect(() => {
    const ctrl = new AbortController()
    fetchBudget(ctrl.signal)
    // Pass the same signal so polling fetches abort cleanly on unmount —
    // prevents setState-after-unmount when a poll is mid-flight (lessons
    // from m5 of stage-b-sonnet).
    const t = setInterval(() => fetchBudget(ctrl.signal), REFRESH_MS)
    return () => {
      ctrl.abort()
      clearInterval(t)
    }
  }, [])

  // Reset the dismissed state when the banner state TRANSITIONS, so the
  // user sees the new state even if they previously dismissed an old one.
  // Also clear the dismiss marker for the OTHER states so re-entering them
  // shows the banner again (sessionStorage stays as the longest-lived
  // intent record — only the current dismiss persists).
  useEffect(() => {
    if (!data) return
    const current = deriveState(data)
    const prev = prevStateRef.current
    if (current !== prev) {
      // State transition — clear all OTHER dismisses; keep current's dismiss
      // intact (user may have dismissed and we shouldn't re-show on that
      // exact same state).
      const all: BannerState[] = ['paused', 'warning', 'normal']
      for (const s of all) {
        if (s !== current) clearDismissed(s)
      }
      setDismissedState(isDismissed(current) ? current : null)
      prevStateRef.current = current
    }
  }, [data])

  if (error && !data) {
    // Compact error state — don't dominate the page on transient failures.
    return (
      <div className="bg-banner bg-banner-error" role="status" aria-live="polite">
        <AlertCircle size={14} /> Budget status unavailable: {error}
      </div>
    )
  }

  if (!data) return null

  // Mid-session fetch error AFTER data arrived — banner still shows the
  // stale data, but with a "stale" indicator (review fix per constraint #2:
  // never silent. A failing poll without an indicator would mislead the
  // user about real-time spend.)
  const isStale = error && data

  const state = deriveState(data)
  const stageA_n = callerCount(data.by_caller, STAGE_A_KEY)
  const stageA_c = callerCost(data.by_caller, STAGE_A_KEY)
  const stageB_n = callerCount(data.by_caller, STAGE_B_KEY)
  const stageB_c = callerCost(data.by_caller, STAGE_B_KEY)
  const tailor_n = callerCount(data.by_caller, TAILOR_KEY)
  const tailor_c = callerCost(data.by_caller, TAILOR_KEY)
  const today = data.today_total_usd
  const budget = data.daily_budget_usd
  const remaining = Math.max(0, budget - today)
  const pctUsed = budget > 0 ? Math.round((today / budget) * 100) : 0

  // constraint #2: paused state is NOT dismissible. It's a hard block —
  // every Sonnet/Tailor call will return 402, so the user MUST see the
  // banner to understand why the pipeline is failing. Only `warning`
  // state is dismissible (it's a heads-up, not a hard block).
  if (state === 'warning' && dismissedState === 'warning') {
    return null
  }

  const staleSuffix = isStale ? (
    <span className="bg-banner-stale" title={`Update failed: ${error}`}>
      {' '}(stale)
    </span>
  ) : null

  if (state === 'paused') {
    return (
      <div
        className="bg-banner bg-banner-paused"
        role="status"
        aria-live="polite"
        data-state="paused"
      >
        <AlertCircle size={16} className="bg-banner-icon" />
        <div className="bg-banner-text">
          <strong>今日 Sonnet+Tailor 预算 ${budget.toFixed(2)} 用尽</strong>
          {' '}(已用 ${today.toFixed(4)}) — 明天继续，或{' '}
          <Link to="/career/settings/preferences" className="bg-banner-link">
            Edit budget →
          </Link>
          {staleSuffix}
        </div>
      </div>
    )
  }

  if (state === 'warning') {
    return (
      <div
        className="bg-banner bg-banner-warning"
        role="status"
        aria-live="polite"
        data-state="warning"
      >
        <AlertTriangle size={16} className="bg-banner-icon" />
        <div className="bg-banner-text">
          <strong>Sonnet 预算还剩 ${remaining.toFixed(2)}</strong>
          {' '}({pctUsed}% used of ${budget.toFixed(2)}) —{' '}
          <Link to="/career/settings/preferences" className="bg-banner-link">
            Edit budget
          </Link>
          {staleSuffix}
        </div>
        <button
          type="button"
          className="bg-banner-dismiss"
          onClick={() => {
            setDismissed('warning')
            setDismissedState('warning')
          }}
          aria-label="Dismiss budget banner"
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  // Normal state — small inline ribbon
  return (
    <div className="bg-banner bg-banner-normal" role="status" data-state="normal">
      <span className="bg-banner-ribbon">
        <strong>Today:</strong>
        {' '}A×{stageA_n} (${stageA_c.toFixed(2)})
        {' | '}B×{stageB_n} (${stageB_c.toFixed(2)})
        {' | '}Tailor×{tailor_n} (${tailor_c.toFixed(2)})
        {' | '}<strong>${today.toFixed(2)}</strong> / ${budget.toFixed(2)} budget
        {staleSuffix}
      </span>
    </div>
  )
}
