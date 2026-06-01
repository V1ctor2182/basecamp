// Mode 2 — Auto-fill Apply page.
//
// Drives the multi-step state machine (src/career/applier/multistep). The
// machine opens a real Chromium window, probes the live application form,
// fills fields step by step, and pauses at each step for operator review.
// It STOPS at the Submit page — it never auto-submits. The user clicks
// Submit in the browser window, then clicks "Mark applied" here.
//
// Flow:
//   1. GET /finder/job/:jobId           → job url + role/company
//   2. GET /multi-step/:jobId/status    → adopt an in-flight/old session
//   3. POST /multi-step/start           → spawn the machine
//   4. poll GET .../status every 1.5s   → render pending draft / progress
//   5. POST .../approve-step | .../pause per operator action
//   6. POST .../resume to continue a paused session
//   7. POST /apply/submitted            → mark the application Applied

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import {
  ArrowLeft,
  AlertTriangle,
  Loader2,
  Play,
  X,
  Monitor,
  Check,
  RotateCcw,
  ExternalLink,
  Send,
  ShieldCheck,
  Pause,
  ListChecks,
  Sparkles,
  Hand,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Crosshair,
  RotateCw,
} from 'lucide-react'
import { buildTriageState, CHIP_KINDS } from './apply/triage.mjs'
import {
  deriveTriedLadder,
  applySseEvent,
  DEFAULT_LADDER_NAMES as LADDER_NAMES,
} from './apply/cardActions.mjs'
import {
  requiredVerifyState,
  loopProgressState,
  escalationState,
  autoMarkDecision,
  missingSummary,
} from './apply/submitGate.mjs'
import {
  fieldRecoveryAffordances,
  shouldShowIdentifyAts,
  RECOVERY_ATSES,
} from './apply/recovery.mjs'
import './apply.css'

type Job = {
  id: string
  company?: string
  role?: string
  url?: string
  location?: string[]
  source?: { type: string; name: string } | null
}

type DraftField = {
  refId?: string
  label: string
  class: string
  // [review H1] subclass plumbing for Recovery 2 (phone/date alt-format
  // ladders). The classifier emits class='hard' + subclass='phone';
  // without this field, recovery.mjs altFormatLadder cannot ever fire.
  subclass?: string | null
  suggested_value?: string | null
  confidence?: string
  source_ref?: string
  block_approve?: boolean
  // a11y role of the underlying form control — drives the control-type
  // badge so the operator knows a field is a dropdown vs free text.
  role?: string
  // real option texts captured from a live dropdown — when present the
  // panel renders an actual <select> the operator picks from.
  options?: string[]
  // M1 post-fill verification — verified / mismatch / fill_error /
  // unverifiable. Set once the field has been through FILL+VERIFY.
  verify_status?: string
  verify_detail?: string
  // m8: whether the field is required. Defaults to true (most ATS fields
  // are mandatory); optional fields explicitly opt out.
  required?: boolean
  // m8: shared-ancestor signature for the Triage view same-root grouping.
  // Populated upstream by the snapshot phase; absent until then.
  control_fingerprint?: {
    ancestors?: string[]
    tag?: string
    role?: string
  }
}

type Control = 'dropdown' | 'radio' | 'checkbox' | 'file' | 'text'

const CONTROL_META: Record<Control, { label: string; hint: string }> = {
  dropdown: {
    label: 'Dropdown',
    hint: 'On the form this is a dropdown — type the answer you want; it is matched to the closest option.',
  },
  radio: {
    label: 'Radio choice',
    hint: 'On the form this is a radio choice — it is matched to the closest option.',
  },
  checkbox: { label: 'Checkbox', hint: 'On the form this is a checkbox.' },
  file: { label: 'File upload', hint: '' },
  text: { label: 'Text', hint: '' },
}

function controlOf(f: DraftField): Control {
  if (f.class === 'file') return 'file'
  switch (f.role) {
    case 'combobox':
    case 'listbox':
    case 'menu':
      return 'dropdown'
    case 'radio':
      return 'radio'
    case 'checkbox':
    case 'switch':
      return 'checkbox'
    default:
      return 'text'
  }
}

type Pending = {
  stepIdx: number
  totalSteps: number | null
  isDependentRecheck?: boolean
  draft: { fields: DraftField[] }
  requested_at: string
}

type SubmitAttempt = {
  attempt: number
  started_at: string
  form_errors: Array<{ field: string; error_code: string; error_msg: string }>
  fixes_tried: Array<{ field: string; fix_name: string; result: string }>
  outcome: string
}

type UserHint = {
  kind: 'resume_compress' | 'alt_format_choice' | 'ats_identification' | 'free_text'
  field_ref: string | null
  hint: string
  timestamp: string
  attempted_strategy?: string | null
  result: 'recorded_only' | 'strategy_tried_ok' | 'strategy_tried_fail' | 'pending_wire'
}

type Session = {
  jobId: string
  site_adapter: string
  job_url: string
  current_step: number
  total_steps: number | null
  per_step_draft: Record<string, { step_idx: number; fields: DraftField[] }>
  per_step_status: Record<string, string>
  status: 'active' | 'paused' | 'abandoned' | 'completed'
  started_at: string
  last_activity_at: string
  // m9: submit-first loop log; cards consume fixes_tried for their Tried row.
  submit_attempts?: SubmitAttempt[]
  // m11: per-Phase-4 recovery telemetry — operator-supplied hints.
  user_hints?: UserHint[]
}

type EscalationReason = {
  code: string
  detail?: string | null
  triggered_by?: 'user' | 'machine' | string
}

type Machine = {
  state: 'idle' | 'starting' | 'running' | 'awaiting-approval' | 'done'
  // m6/m7: 'escalated' is the new outcome when the submit-first loop
  // exhausts the policy gates or the user cancels.
  lastOutcome: 'completed' | 'paused' | 'error' | 'escalated' | null
  lastError: string | null
  pending: Pending | null
  lastDraftInfo: Pending | null
  // m7: escalation diagnostics surfaced by endpoint.mjs getStatus.
  escalationReason?: EscalationReason | null
  submitAttemptsRun?: number | null
  autoApprove: { enabled: boolean; count: number; log: unknown[] }
}

type StatusResp = {
  sessionId: string
  session: Session
  machine: Machine
  // m10: populated by Phase 2/m5's detectSubmitSuccess (wired in m14).
  // Placed at TOP LEVEL (not nested under `machine`) intentionally —
  // autoMarkDecision in submitGate.mjs reads it directly off the
  // response without unwrapping the machine block. Inconsistent with
  // machine.escalationReason (nested) but kept for m10's readable
  // status.submitDetectedBy access pattern.
  submitDetectedBy?: 'url_pattern' | 'thank_you_text' | 'network_signal' | 'user_fallback' | null
}

type Phase = 'idle' | 'starting' | 'active' | 'done'

// [P3-OQ6] Poll cadence — 2s for the m8 status board (was 1.5s). SSE is
// the eventual ladder rung but defer to a later phase; 2s polling is
// the simple version that fits the Mode 2 budget.
const POLL_MS = 2000

function api(path: string) {
  return `/api/career${path}`
}

// A short scalar value renders as <input>; long or multiline as <textarea>.
function isLongValue(v: string) {
  return v.length > 60 || v.includes('\n')
}

export default function Apply() {
  const { jobId } = useParams<{ jobId: string }>()
  const navigate = useNavigate()

  const [job, setJob] = useState<Job | null>(null)
  const [loadingJob, setLoadingJob] = useState(true)
  const [status, setStatus] = useState<StatusResp | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [autoApprove, setAutoApprove] = useState(false)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [marking, setMarking] = useState(false)
  const [markToast, setMarkToast] = useState<string | null>(null)
  // m9: per-refId verify_status overlay driven by SSE events. Wins over
  // the polled session value so the card flips green/yellow instantly
  // when the user types in the Chromium window.
  const [sseOverlay, setSseOverlay] = useState<Record<string, string>>({})
  // m9: per-refId card-action loading state (refId → 'focus'|'retry'|'skip')
  const [actionBusy, setActionBusy] = useState<Record<string, string>>({})
  // m9: transient toasts for action feedback
  const [actionToast, setActionToast] = useState<string | null>(null)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Identifies the currently-displayed pending draft so we re-seed `edits`
  // only when a genuinely new approval gate arrives (not every poll tick).
  const pendingKeyRef = useRef<string | null>(null)
  // m9: latest status snapshot, kept fresh by polling; SSE callbacks read
  // through here to avoid stale closure.
  const statusRef = useRef<StatusResp | null>(null)
  // m10: single-shot guard so autoMarkDecision triggers at most ONCE per
  // session lifecycle (prevents repeated navigation on subsequent polls).
  const autoMarkedRef = useRef(false)

  // ── Initial load: job metadata + adopt any existing session ───────────
  useEffect(() => {
    if (!jobId) return
    let cancelled = false
    ;(async () => {
      try {
        const [jr, sr] = await Promise.all([
          fetch(api(`/finder/job/${encodeURIComponent(jobId)}`)),
          fetch(api(`/applier/multi-step/${encodeURIComponent(jobId)}/status`)),
        ])
        if (cancelled) return
        if (jr.ok) {
          setJob((await jr.json()) as Job)
        } else {
          const j = await jr.json().catch(() => ({}))
          setError(j.error ?? `Could not load job ${jobId}`)
        }
        if (sr.ok) {
          const s = (await sr.json()) as StatusResp
          setStatus(s)
          adoptStatus(s)
        }
        // 404 from status = no session yet → phase stays 'idle'
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? 'Failed to load')
      } finally {
        if (!cancelled) setLoadingJob(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  // ── Polling lifecycle ─────────────────────────────────────────────────
  useEffect(() => {
    const shouldPoll = phase === 'active' || phase === 'starting'
    if (!shouldPoll) {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      return
    }
    if (pollRef.current) return // already polling
    pollRef.current = setInterval(poll, POLL_MS)
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // ── m9: SSE event subscription ────────────────────────────────────────
  //
  // Connect once per active session. Browser auto-reconnects on transient
  // network failure via EventSource's built-in retry. The hub's replay
  // buffer covers the missed-events gap on reconnect.
  useEffect(() => {
    if (!jobId) return
    if (phase !== 'active' && phase !== 'done') return

    const url = api(`/applier/multi-step/${encodeURIComponent(jobId)}/events`)
    let es: EventSource | null = null
    try {
      es = new EventSource(url)
    } catch {
      // EventSource constructor failed (rare — bad URL); silently skip.
      return
    }

    // Use a fields snapshot from CURRENT status — captured at subscribe
    // time + refreshed on poll updates via the closure below. Caller
    // uses applySseEvent which only needs the field with the matching
    // refId.
    const handleEvent = (eventName: string) => (e: MessageEvent) => {
      // Defensive parse — broken JSON should not crash the page.
      let payload: { ref?: string; field_ref?: string; value?: string; new_status?: string } = {}
      try {
        payload = JSON.parse(e.data ?? '{}')
      } catch {
        return
      }
      const targetRef = payload.ref ?? payload.field_ref ?? ''
      if (!targetRef) return

      // [review M7] If statusRef hasn't been populated by the initial
      // /status fetch yet, drop the event rather than verify against
      // suggested_value='' — that would force a 'stale' false-flag.
      // Action broadcasts (field_skip) carry new_status so they don't
      // need the field lookup; let them through.
      const session = statusRef.current?.session
      let field: { refId: string; suggested_value: string | null } | null = null
      const normTarget = targetRef.toLowerCase()
      if (session) {
        // First pass: strict refId match — handles refIds snapshot
        // minted directly from the input's name attr.
        outer: for (const step of Object.values(session.per_step_draft ?? {})) {
          for (const f of step.fields ?? []) {
            if (f.refId === targetRef) {
              field = {
                refId: f.refId ?? targetRef,
                suggested_value: f.suggested_value ?? '',
              }
              break outer
            }
          }
        }
        // [m14 review H1] Second pass: label-substring fallback. Useful
        // for synthetic refIds (__file_0, __captcha) and for snapshot-
        // minted refIds that diverge from the form's name attr (Workday
        // data-automation-id). Without this fallback the observer's
        // broadcast field_ref (which comes from name/id/aria-label) wouldn't
        // match the synthetic DraftField.refId.
        if (!field) {
          outerL: for (const step of Object.values(session.per_step_draft ?? {})) {
            for (const f of step.fields ?? []) {
              const labelNorm = (f.label ?? '').toLowerCase()
              if (!labelNorm || !normTarget) continue
              if (labelNorm.includes(normTarget) || normTarget.includes(labelNorm)) {
                field = {
                  refId: f.refId ?? targetRef,
                  suggested_value: f.suggested_value ?? '',
                }
                break outerL
              }
            }
          }
        }
      }
      const isActionEvent =
        eventName === 'field_skip' ||
        eventName === 'field_focus' ||
        eventName === 'field_retry'
      if (!field && !isActionEvent) {
        // Observer event with no resolved session — would yield a
        // false 'stale'. Drop and wait for the next poll to catch up.
        return
      }
      if (!field) {
        field = { refId: targetRef, suggested_value: '' }
      }
      const r = applySseEvent(field as any, eventName, payload as any)
      if (!r || !r.verify_status) return
      setSseOverlay((prev) => {
        if (prev[targetRef] === r.verify_status) return prev
        return { ...prev, [targetRef]: r.verify_status }
      })
    }

    // Observer events
    es.addEventListener('field_input', handleEvent('field_input') as EventListener)
    es.addEventListener('field_change', handleEvent('field_change') as EventListener)
    // Action broadcasts (from our own endpoints)
    es.addEventListener('field_skip', handleEvent('field_skip') as EventListener)
    es.addEventListener('field_focus', handleEvent('field_focus') as EventListener)
    es.addEventListener('field_retry', handleEvent('field_retry') as EventListener)

    es.onerror = () => {
      // EventSource auto-reconnects; we just log a single warning.
      // Don't surface to the user — polling continues to work.
    }

    return () => {
      try { es?.close() } catch { /* */ }
    }
  }, [jobId, phase])

  // Decide the phase from a freshly-fetched status snapshot.
  function adoptStatus(s: StatusResp) {
    statusRef.current = s
    const m = s.machine
    if (m.state === 'done') {
      setPhase('done')
    } else if (m.state === 'idle') {
      // Session on disk but no live machine — server restarted mid-apply,
      // or it is a previously paused/completed session. Treat as terminal;
      // the terminal view derives Resume/Retry from session.status.
      setPhase('done')
    } else {
      setPhase('active')
    }
    maybeSeedEdits(m.pending)
  }

  // Seed the edit buffer when a NEW approval gate appears.
  function maybeSeedEdits(pending: Pending | null) {
    if (!pending) {
      pendingKeyRef.current = null
      return
    }
    const key = `${pending.stepIdx}::${pending.requested_at}`
    if (pendingKeyRef.current === key) return
    pendingKeyRef.current = key
    const seed: Record<string, string> = {}
    for (const f of pending.draft.fields) {
      if (f.refId) seed[f.refId] = f.suggested_value ?? ''
    }
    setEdits(seed)
  }

  async function poll() {
    if (!jobId) return
    try {
      const r = await fetch(api(`/applier/multi-step/${encodeURIComponent(jobId)}/status`))
      if (!r.ok) return // transient — keep polling
      const s = (await r.json()) as StatusResp
      statusRef.current = s
      setStatus(s)
      maybeSeedEdits(s.machine.pending)
      // First successful poll graduates 'starting' → 'active'; a settled
      // machine goes to 'done'. Without this the page would stay stuck on
      // the "Launching browser…" spinner even after the machine reports.
      setPhase(s.machine.state === 'done' ? 'done' : 'active')

      // m10: auto-Mark decision based on detectSubmitSuccess signal.
      // [P3-OQ5] strong signal → navigate; user_fallback → confirm.
      // alreadyHandled guard prevents repeated triggers across polls.
      const decision = autoMarkDecision(
        s.machine,
        s.submitDetectedBy ?? null,
        autoMarkedRef.current,
      )
      if (decision === 'auto_redirect') {
        autoMarkedRef.current = true
        try {
          const fields = flattenSessionFields(s.session)
          const submitR = await fetch(api('/apply/submitted'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId, fields }),
          })
          // [review C1] Surface errors instead of silently navigating.
          // If POST fails, re-arm the guard so the user can retry via
          // the manual Mark button.
          if (!submitR.ok) {
            const j = await submitR.json().catch(() => ({}))
            autoMarkedRef.current = false
            const status = (j as { current_status?: string }).current_status
            const allowed = (j as { allowed_next?: string[] }).allowed_next
            if (status && Array.isArray(allowed)) {
              setError(`${(j as { error?: string }).error}. Current status: ${status}. Next: ${allowed.join(', ')}`)
            } else {
              setError((j as { error?: string }).error ?? `Auto-mark failed (HTTP ${submitR.status})`)
            }
            return
          }
        } catch (e) {
          autoMarkedRef.current = false
          setError((e as Error).message ?? 'Auto-mark failed')
          return
        }
        setMarkToast('Applied! Redirecting…')
        setTimeout(() => navigate('/career/applied'), 1200)
      } else if (decision === 'confirm_fallback') {
        autoMarkedRef.current = true
        const ok = window.confirm(
          'I detected you switched away from the browser, but I couldn\'t confirm the submit landed. ' +
          'Did the form actually accept the submission?\n\n' +
          'OK → mark Applied. Cancel → I\'ll keep the session open.',
        )
        if (ok) {
          // [review C2/M1] skipConfirm=true — confirm_fallback IS the
          // affirmation; markApplied's secondary confirm is redundant.
          void markApplied(true)
        }
      }
    } catch {
      // network blip — keep polling
    }
  }

  async function startMachine() {
    if (!jobId || !job?.url) return
    setBusy(true)
    setError(null)
    try {
      const r = await fetch(api('/applier/multi-step/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          jobUrl: job.url,
          autoApproveWhenSafe: autoApprove,
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `Start failed (HTTP ${r.status})`)
      pendingKeyRef.current = null
      autoMarkedRef.current = false  // m10: re-arm for the new session
      setPhase('starting')
      // Kick an immediate poll so the UI updates before the first interval.
      setTimeout(poll, 300)
    } catch (e) {
      setError((e as Error).message ?? 'Failed to start auto-fill')
    } finally {
      setBusy(false)
    }
  }

  async function approveStep(approved: boolean) {
    if (!jobId) return
    const pending = status?.machine.pending
    if (!pending) return
    setBusy(true)
    setError(null)
    try {
      // Only send fields the operator actually changed.
      const editList: { refId: string; suggested_value: string | null }[] = []
      for (const f of pending.draft.fields) {
        if (!f.refId) continue
        const next = edits[f.refId]
        if (next !== undefined && next !== (f.suggested_value ?? '')) {
          editList.push({ refId: f.refId, suggested_value: next })
        }
      }
      const r = await fetch(
        api(`/applier/multi-step/${encodeURIComponent(jobId)}/approve-step`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved, edits: editList }),
        },
      )
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `Approve failed (HTTP ${r.status})`)
      // Optimistically clear the pending panel; the next poll reflects truth.
      setStatus((cur) =>
        cur ? { ...cur, machine: { ...cur.machine, pending: null } } : cur,
      )
      pendingKeyRef.current = null
      setTimeout(poll, 300)
    } catch (e) {
      setError((e as Error).message ?? 'Approve failed')
    } finally {
      setBusy(false)
    }
  }

  // Cancel the apply: stop the server-side machine (so the browser stops
  // filling), then stay on THIS job's apply page — reset to the idle
  // Start panel so the operator can re-run or read, rather than bouncing
  // back to the Find Jobs list. Best-effort: the reset happens even if
  // the stop call fails (the machine settles on its own).
  // Bring the auto-fill Chromium window to the foreground — it routinely
  // ends up hidden behind the dashboard / IDE.
  async function revealBrowser() {
    if (!jobId) return
    try {
      const r = await fetch(
        api(`/applier/multi-step/${encodeURIComponent(jobId)}/reveal`),
        { method: 'POST' },
      )
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        setError(
          j.error
            ? `Couldn't show the browser: ${j.error}`
            : "Couldn't show the browser — it may have been closed.",
        )
      } else {
        setError(null)
      }
    } catch {
      setError('Could not reach the server to show the browser.')
    }
  }

  async function cancelApply() {
    setBusy(true)
    setError(null)
    if (jobId) {
      try {
        // [review C4] Cancel = ESCALATE the session (terminal). Hits the
        // dedicated /cancel endpoint (different from /pause). Falls back
        // to /pause if /cancel is unavailable on older servers.
        const r = await fetch(
          api(`/applier/multi-step/${encodeURIComponent(jobId)}/cancel`),
          { method: 'POST' },
        )
        if (!r.ok && r.status === 404) {
          // Older server without /cancel — fall back so we don't strand
          // the browser process.
          await fetch(api(`/applier/multi-step/${encodeURIComponent(jobId)}/pause`), {
            method: 'POST',
          })
        }
      } catch {
        // ignore — resetting the page is what matters
      }
    }
    setStatus(null)
    setEdits({})
    pendingKeyRef.current = null
    setPhase('idle')
    setBusy(false)
  }

  // m9: per-field card actions. All three send POST + listen for the
  // SSE broadcast (the response also flips local state for instant
  // feedback). Errors land in the action toast — they don't block other
  // actions because the field still exists.
  const showToast = useCallback((msg: string) => {
    setActionToast(msg)
    window.setTimeout(() => setActionToast((cur) => (cur === msg ? null : cur)), 2500)
  }, [])

  async function focusFieldAction(refId: string) {
    if (!jobId) return
    setActionBusy((prev) => ({ ...prev, [refId]: 'focus' }))
    try {
      const r = await fetch(
        api(`/applier/multi-step/${encodeURIComponent(jobId)}/focus-field`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: refId }),
        },
      )
      const j = await r.json().catch(() => ({}))
      // m13: handle structured 409 / 404 reasons for cleaner UX.
      if (!r.ok) {
        if (j.reason === 'no_live_page') {
          throw new Error('No live browser. Start or resume the apply first.')
        }
        if (j.reason === 'machine_busy') {
          throw new Error('The machine is filling — wait for the next approval gate.')
        }
        if (j.reason === 'ref_not_in_draft') {
          throw new Error('Field has been removed from the draft — refresh the cockpit.')
        }
        if (j.reason === 'field_not_on_page') {
          throw new Error(`"${j.label ?? refId}" isn't on the current page — refresh the form, then try again.`)
        }
        throw new Error(j.error ?? `Focus failed (HTTP ${r.status})`)
      }
      showToast(`Focused "${j.label ?? refId}" in the browser.`)
    } catch (e) {
      showToast((e as Error).message ?? 'Focus failed')
    } finally {
      setActionBusy((prev) => {
        const next = { ...prev }
        delete next[refId]
        return next
      })
    }
  }

  async function retryFieldAction(refId: string, strategy?: string) {
    if (!jobId) return
    setActionBusy((prev) => ({ ...prev, [refId]: 'retry' }))
    try {
      const r = await fetch(
        api(`/applier/multi-step/${encodeURIComponent(jobId)}/retry-field`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(strategy ? { ref: refId, strategy } : { ref: refId }),
        },
      )
      const j = await r.json().catch(() => ({}))
      // m13: handle structured 409/500 reasons.
      if (!r.ok) {
        if (j.reason === 'no_live_page') {
          throw new Error('No live browser. Start or resume the apply first.')
        }
        if (j.reason === 'machine_busy') {
          throw new Error('The machine is filling — wait for the next approval gate.')
        }
        if (j.reason === 'ref_not_in_draft') {
          throw new Error('Field has been removed from the draft — refresh the cockpit.')
        }
        if (j.reason === 'field_skipped') {
          throw new Error(j.error ?? 'Field is marked skipped.')
        }
        if (j.reason === 'fillWithFallback_threw') {
          throw new Error(
            j.code === 'ELEMENT_GONE'
              ? `Element gone — refresh the form in the browser, then retry.`
              : `Retry threw: ${j.error}`,
          )
        }
        throw new Error(j.error ?? `Retry failed (HTTP ${r.status})`)
      }
      const label = j.label ?? refId
      if (j.success) {
        showToast(`Retried "${label}" — ${j.fix_name} succeeded.`)
      } else {
        showToast(`Retried "${label}" — ${j.fix_name ?? 'all strategies failed'}.`)
      }
    } catch (e) {
      showToast((e as Error).message ?? 'Retry failed')
    } finally {
      setActionBusy((prev) => {
        const next = { ...prev }
        delete next[refId]
        return next
      })
    }
  }

  async function skipFieldAction(refId: string) {
    if (!jobId) return
    setActionBusy((prev) => ({ ...prev, [refId]: 'skip' }))
    // [review H3] Apply overlay BEFORE the POST so the UI flips
    // immediately, but record the previous overlay value so we can
    // revert if the server rejects the request.
    let prevOverlayValue: string | undefined
    setSseOverlay((prev) => {
      prevOverlayValue = prev[refId]
      return { ...prev, [refId]: 'skipped_by_user' }
    })
    try {
      const r = await fetch(
        api(`/applier/multi-step/${encodeURIComponent(jobId)}/skip-field`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: refId }),
        },
      )
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `Skip failed (HTTP ${r.status})`)
      showToast('Skipped.')
    } catch (e) {
      // Revert optimistic overlay on failure.
      setSseOverlay((prev) => {
        const next = { ...prev }
        if (prevOverlayValue === undefined) delete next[refId]
        else next[refId] = prevOverlayValue
        return next
      })
      showToast((e as Error).message ?? 'Skip failed')
    } finally {
      setActionBusy((prev) => {
        const next = { ...prev }
        delete next[refId]
        return next
      })
    }
  }

  async function copyValueAction(refId: string, value: string) {
    try {
      await navigator.clipboard.writeText(value)
      showToast(`Copied "${value.length > 30 ? value.slice(0, 30) + '…' : value}".`)
    } catch {
      showToast('Copy failed — your browser blocked clipboard access.')
    }
    void refId  // kept in signature for symmetry / future telemetry
  }

  // m11: Phase 4 recovery handlers. Same shape as m9 actions —
  // optimistic action-busy + toast feedback.
  async function _postRecovery(path: string, body: object, refIdForBusy: string, label: string) {
    if (!jobId) return null
    setActionBusy((prev) => ({ ...prev, [refIdForBusy]: label }))
    try {
      const r = await fetch(
        api(`/applier/multi-step/${encodeURIComponent(jobId)}/recover/${path}`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `Recovery failed (HTTP ${r.status})`)
      return j
    } catch (e) {
      showToast((e as Error).message ?? 'Recovery failed')
      return null
    } finally {
      setActionBusy((prev) => {
        const next = { ...prev }
        delete next[refIdForBusy]
        return next
      })
    }
  }

  async function recoverResumeCompressAction(refId: string) {
    const j = await _postRecovery('resume-compress', { ref: refId }, refId, 'resume_compress')
    if (j) {
      showToast(j.pending_wire
        ? 'Resume compression queued — live re-upload wiring lands in a future milestone.'
        : 'Resume re-rendered & re-uploaded.')
    }
  }

  async function recoverAltFormatsAction(refId: string, chosen: string) {
    const j = await _postRecovery('alt-formats', { ref: refId, chosen }, refId, 'alt_formats')
    if (j) {
      showToast(j.pending_wire
        ? `Alt format "${chosen}" recorded — live retry lands in a future milestone.`
        : `Retried with "${chosen}".`)
    }
  }

  async function recoverIdentifyAtsAction(ats: string) {
    // [review M6] Reserved keyspace prefix '__recovery_ats' that cannot
    // collide with a real refId (no snapshot ever emits this name).
    const j = await _postRecovery('identify-ats', { ats }, '__recovery_ats', 'identify_ats')
    if (j) {
      showToast(ats === 'skip'
        ? 'Skipped — won\'t ask again this session.'
        : `ATS recorded: ${ats}. Adapter reload lands in a future milestone.`)
    }
  }

  async function recoverUserHintAction(refId: string, hint: string) {
    const j = await _postRecovery('user-hint', { ref: refId, hint }, refId, 'user_hint')
    if (j) {
      if (j.parsed_strategy) {
        showToast(`Hint parsed → ${j.parsed_strategy} (${j.parse_confidence}). Live retry queued.`)
      } else {
        showToast('Hint recorded — couldn\'t parse a strategy. Flywheel will see it.')
      }
    }
  }

  // [review C4] Pause keeps the session alive (status='paused') so the
  // operator can Resume later — distinct from Cancel above. Doesn't
  // reset local UI; renders via the existing terminal-paused branch.
  async function pauseApply() {
    if (!jobId) return
    setBusy(true)
    setError(null)
    try {
      const r = await fetch(
        api(`/applier/multi-step/${encodeURIComponent(jobId)}/pause`),
        { method: 'POST' },
      )
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `Pause failed (HTTP ${r.status})`)
      // Land on the paused terminal screen (Resume button renders there).
      setPhase('done')
      setTimeout(poll, 300)
    } catch (e) {
      setError((e as Error).message ?? 'Pause failed')
    } finally {
      setBusy(false)
    }
  }

  async function resumeMachine() {
    if (!jobId) return
    setBusy(true)
    setError(null)
    try {
      const r = await fetch(
        api(`/applier/multi-step/${encodeURIComponent(jobId)}/resume`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId }),
        },
      )
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `Resume failed (HTTP ${r.status})`)
      pendingKeyRef.current = null
      setPhase('starting')
      setTimeout(poll, 300)
    } catch (e) {
      setError((e as Error).message ?? 'Resume failed')
    } finally {
      setBusy(false)
    }
  }

  // Mark the application Applied. Flattens every filled field across all
  // steps into the /apply/submitted contract (history.jsonl + status flip).
  // [review C2] skipConfirm=true is used by SubmitGate (the gate's green
  // state IS the affirmation) and by confirm_fallback (the user already
  // OK'd the auto-mark prompt). The legacy form-filled panel and the
  // escalation path pass false (default) — they keep the prompt.
  async function markApplied(skipConfirm = false) {
    if (!jobId || !status) return
    if (!skipConfirm) {
      const ok = window.confirm(
        'Did you click Submit in the Chromium window?\n\n' +
          'This marks the application as Applied and records the filled fields. ' +
          'It does not submit the form for you.',
      )
      if (!ok) return
    }
    setMarking(true)
    setError(null)
    try {
      const fields = flattenSessionFields(status.session)
      const r = await fetch(api('/apply/submitted'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, fields }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        if (j.current_status && Array.isArray(j.allowed_next)) {
          throw new Error(
            `${j.error}. Current status: ${j.current_status}. Next: ${j.allowed_next.join(', ')}`,
          )
        }
        throw new Error(j.error ?? `Mark applied failed (HTTP ${r.status})`)
      }
      setMarkToast('Marked Applied. Redirecting…')
      setTimeout(() => navigate('/career/applied'), 1400)
    } catch (e) {
      setError((e as Error).message ?? 'Mark applied failed')
    } finally {
      setMarking(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────
  if (!jobId) {
    return (
      <div className="c-page ap-page">
        <h2>Apply</h2>
        <div className="ap-error">
          <AlertTriangle size={14} /> Missing jobId in URL.
        </div>
      </div>
    )
  }

  const machine = status?.machine
  const session = status?.session
  const pending = machine?.pending ?? null
  const outcome = machine?.lastOutcome ?? null
  // Terminal display: prefer the live machine outcome; fall back to the
  // persisted session status (server-restart / old-session case).
  // m10: 'escalated' is a distinct terminal — render the escalation panel
  // instead of the form-filled or error one.
  const terminal =
    phase === 'done'
      ? outcome ?? (session?.status === 'completed' ? 'completed' : session?.status === 'paused' ? 'paused' : 'error')
      : null
  const vsum = verifySummary(session)
  // m10: escalation can also fire while phase is active (machine outcome
  // flips to escalated mid-loop before /status reports state='done').
  const escalation = machine ? escalationState(machine) : null

  return (
    <div className="c-page ap-page">
      <div className="ap-topbar">
        <button
          type="button"
          className="ap-back"
          onClick={() => navigate('/career/find-jobs')}
        >
          <ArrowLeft size={14} /> Find Jobs
        </button>
        <div className="ap-actions">
          {(phase === 'active' || phase === 'done') && (
            <button
              type="button"
              className="ap-action-btn"
              onClick={revealBrowser}
              title="Bring the auto-fill browser window to the front"
            >
              <Monitor size={12} /> Show filled form
            </button>
          )}
          {job?.url && (
            <a className="ap-action-btn" href={job.url} target="_blank" rel="noreferrer">
              <ExternalLink size={12} /> Open job posting
            </a>
          )}
        </div>
      </div>

      <header className="ap-header">
        <h2 className="ap-title">
          Apply — {job?.role ?? jobId}
          {job?.company ? <span className="ap-m2-company"> · {job.company}</span> : null}
        </h2>
        <div className="ap-subhead">
          Auto-fill · a real browser window fills the form step by step. It never
          submits — you click Submit yourself, then mark it applied here.
        </div>
      </header>

      {error && (
        <div className="ap-error">
          <AlertTriangle size={14} /> {error}
        </div>
      )}
      {markToast && (
        <div className="ap-toast-ok">
          <Check size={14} /> {markToast}
        </div>
      )}

      {loadingJob ? (
        <div className="ap-loading">
          <Loader2 size={14} className="ap-spin" /> Loading job…
        </div>
      ) : (
        <>
          {/* Progress bar — shown whenever a session exists */}
          {session && <ProgressBar session={session} machine={machine!} />}

          {/* m8: Status board — sticky top, envelope-driven counts/chips.
              Only show during active/done — idle has no session signal,
              and starting is the launch spinner. */}
          {session && (phase === 'active' || phase === 'done') && (
            <StatusBoard
              session={session}
              sseOverlay={sseOverlay}
              submitAttempts={session.submit_attempts ?? []}
              onPause={pauseApply}
              onCancel={cancelApply}
              onFocus={focusFieldAction}
              onRetry={retryFieldAction}
              onSkip={skipFieldAction}
              onCopy={copyValueAction}
              onResumeCompress={recoverResumeCompressAction}
              onAltFormats={recoverAltFormatsAction}
              onIdentifyAts={recoverIdentifyAtsAction}
              onUserHint={recoverUserHintAction}
              actionBusy={actionBusy}
              busy={busy}
            />
          )}
          {/* m10: Loop progress stepper — visible while submit-first
              loop has logged ≥ 1 attempt. Sits between the status
              board and the form panel so the operator can follow
              attempt → fix → attempt → ... in real time. */}
          {session && session.submit_attempts && session.submit_attempts.length > 0 && machine && (
            <LoopProgress
              attempts={session.submit_attempts}
              machine={machine}
            />
          )}
          {actionToast && (
            <div className="ap-toast-ok ap-m2-action-toast">
              {actionToast}
            </div>
          )}

          {/* IDLE — no session: start panel */}
          {phase === 'idle' && (
            <div className="ap-m2-panel">
              <div className="ap-m2-panel-body">
                <strong>Ready to auto-fill this application.</strong>
                <p>
                  Clicking Start opens a Chromium window and navigates to the job's
                  application form. The machine fills fields step by step and pauses
                  here for your review at each step. Keep the browser window visible.
                </p>
                {!job?.url && (
                  <p className="ap-m2-warn">
                    <AlertTriangle size={13} /> This job has no application URL — cannot auto-fill.
                  </p>
                )}
                <label className="ap-m2-check">
                  <input
                    type="checkbox"
                    checked={autoApprove}
                    onChange={(e) => setAutoApprove(e.target.checked)}
                  />
                  <ShieldCheck size={13} />
                  Auto-approve steps where every field is high-confidence and safe
                </label>
              </div>
              <button
                type="button"
                className="ap-submit-btn"
                onClick={startMachine}
                disabled={busy || !job?.url}
              >
                <Play size={14} /> {busy ? 'Starting…' : 'Start auto-fill'}
              </button>
            </div>
          )}

          {/* STARTING */}
          {phase === 'starting' && (
            <div className="ap-loading">
              <Loader2 size={14} className="ap-spin" /> Launching browser & probing the form…
            </div>
          )}

          {/* ACTIVE — machine running */}
          {phase === 'active' && !pending && (
            <div className="ap-loading">
              <Loader2 size={14} className="ap-spin" /> Machine working — filling fields / clicking Next…
              <button
                type="button"
                className="ap-action-btn ap-m2-inline-btn"
                onClick={cancelApply}
                disabled={busy}
              >
                <X size={12} /> Cancel
              </button>
            </div>
          )}

          {/* ACTIVE — awaiting approval */}
          {phase === 'active' && pending && (
            <ApprovalPanel
              pending={pending}
              edits={edits}
              setEdits={setEdits}
              onApprove={() => approveStep(true)}
              onCancel={cancelApply}
              busy={busy}
            />
          )}

          {/* DONE — terminal states */}
          {phase === 'done' && terminal === 'completed' && (
            <div
              className={`ap-m2-panel ${
                vsum.problems.length > 0
                  ? 'ap-m2-panel-err'
                  : vsum.todos.length > 0
                    ? 'ap-m2-panel-warn'
                    : 'ap-m2-panel-ok'
              }`}
            >
              <div className="ap-m2-panel-body">
                <strong>
                  {vsum.problems.length > 0 || vsum.todos.length > 0 ? (
                    <AlertTriangle size={15} />
                  ) : (
                    <Check size={15} />
                  )}
                  {vsum.problems.length > 0
                    ? 'Form filled — but some fields need a look.'
                    : vsum.todos.length > 0
                      ? `Form filled — ${vsum.todos.length} thing${vsum.todos.length === 1 ? '' : 's'} need you before Submit.`
                      : 'Form filled & verified — ready to submit.'}
                </strong>
                {vsum.total > 0 && (
                  <p className="ap-m2-verify-line">
                    {vsum.counts.verified > 0 && (
                      <span className="ap-m2-v-ok">✓ {vsum.counts.verified} verified</span>
                    )}
                    {vsum.counts.mismatch > 0 && (
                      <span className="ap-m2-v-bad">✗ {vsum.counts.mismatch} didn't land</span>
                    )}
                    {vsum.counts.fill_error > 0 && (
                      <span className="ap-m2-v-bad">✗ {vsum.counts.fill_error} fill error</span>
                    )}
                    {vsum.counts.unverifiable > 0 && (
                      <span className="ap-m2-v-warn">
                        ⚠ {vsum.counts.unverifiable} unverifiable
                      </span>
                    )}
                  </p>
                )}
                {vsum.problems.length > 0 && (
                  <ul className="ap-m2-problems">
                    {vsum.problems.map((p, i) => (
                      <li key={i}>
                        <strong>{p.label}</strong> — {p.status}
                        {p.detail ? <span className="ap-m2-problem-detail"> · {p.detail}</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
                {vsum.todos.length > 0 && (
                  <div className="ap-m2-todos">
                    <span className="ap-m2-todos-head">
                      Before you submit, do these yourself:
                    </span>
                    <ul>
                      {vsum.todos.map((t, i) => (
                        <li key={i}>
                          <strong>{t.label}</strong>
                          {t.status === 'manual' ? ' — manual' : ' — not captured'}
                          {t.detail ? (
                            <span className="ap-m2-problem-detail"> · {t.detail}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <p>
                  The machine filled every step up to the Submit page and stopped
                  there.{' '}
                  {vsum.problems.length > 0
                    ? 'Fix the flagged fields in the Chromium window, then Submit.'
                    : vsum.todos.length > 0
                      ? 'Handle the items above in the Chromium window, then Submit.'
                      : 'Review in the Chromium window and click Submit.'}{' '}
                  Then mark it applied below.
                </p>
                {machine && machine.autoApprove.count > 0 && (
                  <p className="ap-m2-note">
                    {machine.autoApprove.count} step(s) auto-approved.
                  </p>
                )}
              </div>
              {/* m10: Submit gate replaces the bare "Mark applied" button.
                  Gray (disabled + tooltip) while required fields outstanding;
                  green with [Open Chromium] + [Mark applied] when ready. */}
              {session && (
                <SubmitGate
                  session={session}
                  jobUrl={job?.url ?? null}
                  onReveal={revealBrowser}
                  // [review C2] skip the redundant confirm — gate's green
                  // state already affirms readiness.
                  onMark={() => void markApplied(true)}
                  marking={marking}
                />
              )}
            </div>
          )}

          {/* m10: Escalation panel — machine bailed out of the submit
              loop. Surface the reason and route the user to m9 cards. */}
          {phase === 'done' && terminal === 'escalated' && escalation && (
            <EscalationPanel
              escalation={escalation}
              // Keep the secondary confirm — the gate never showed green
              // in this path; we want the explicit affirmation.
              onMark={() => void markApplied()}
              marking={marking}
            />
          )}

          {phase === 'done' && terminal === 'paused' && (
            <div className="ap-m2-panel">
              <div className="ap-m2-panel-body">
                <strong>Paused.</strong>
                <p>
                  The apply session is paused. Resume to reopen the browser and
                  continue from step {(session?.current_step ?? 0) + 1}.
                </p>
              </div>
              <button
                type="button"
                className="ap-submit-btn"
                onClick={resumeMachine}
                disabled={busy}
              >
                <RotateCcw size={14} /> {busy ? 'Resuming…' : 'Resume'}
              </button>
            </div>
          )}

          {phase === 'done' && terminal === 'error' && (
            <div className="ap-m2-panel ap-m2-panel-err">
              <div className="ap-m2-panel-body">
                <strong>
                  <AlertTriangle size={15} /> Auto-fill stopped with an error.
                </strong>
                <p className="ap-m2-errtext">
                  {machine?.lastError ?? 'The machine could not finish this application.'}
                </p>
                {machine?.lastDraftInfo && (
                  <p className="ap-m2-note">
                    Stopped around step {machine.lastDraftInfo.stepIdx + 1}.
                  </p>
                )}
              </div>
              <button
                type="button"
                className="ap-submit-btn"
                onClick={startMachine}
                disabled={busy || !job?.url}
              >
                <RotateCcw size={14} /> {busy ? 'Restarting…' : 'Retry from start'}
              </button>
            </div>
          )}

          <div className="ap-m2-foot">
            <Link to="/career/find-jobs" className="ap-link">
              Back to Find Jobs
            </Link>
          </div>
        </>
      )}
    </div>
  )
}

// ── Progress bar ────────────────────────────────────────────────────────
function ProgressBar({ session, machine }: { session: Session; machine: Machine }) {
  const total = session.total_steps
  const cur = session.current_step
  const pct = total && total > 0 ? Math.min(100, Math.round((cur / total) * 100)) : null
  return (
    <div className="ap-m2-progress">
      <div className="ap-m2-progress-row">
        <span className="ap-m2-progress-label">
          Step {cur + 1}
          {total ? ` of ${total}` : ''}
          {' · '}
          {session.site_adapter}
        </span>
        <span className={`ap-m2-state ap-m2-state-${machine.state}`}>{machine.state}</span>
      </div>
      {pct !== null && (
        <div className="ap-m2-progress-track">
          <div className="ap-m2-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}

// ── Approval panel ──────────────────────────────────────────────────────
function ApprovalPanel({
  pending,
  edits,
  setEdits,
  onApprove,
  onCancel,
  busy,
}: {
  pending: Pending
  edits: Record<string, string>
  setEdits: React.Dispatch<React.SetStateAction<Record<string, string>>>
  onApprove: () => void
  onCancel: () => void
  busy: boolean
}) {
  const fields = pending.draft.fields
  return (
    <section className="ap-section ap-m2-approval">
      <div className="ap-m2-approval-head">
        <h3 className="ap-section-title">
          Review step {pending.stepIdx + 1}
          {pending.isDependentRecheck ? ' (re-check)' : ''} — {fields.length} field
          {fields.length === 1 ? '' : 's'}
        </h3>
        <span className="ap-m2-hint">Edit any value, then Approve to let the machine continue.</span>
      </div>

      <div className="ap-fields">
        {fields.map((f, i) => {
          const refId = f.refId ?? `field-${i}`
          const sv = f.suggested_value ?? ''
          const value = edits[refId] ?? sv
          const isManual = f.class === 'manual'
          const isFile = f.class === 'file'
          const ctrl = controlOf(f)
          const meta = CONTROL_META[ctrl]
          const opts = ctrl === 'dropdown' && Array.isArray(f.options) ? f.options : null
          return (
            <div key={refId} className={`ap-field ap-m2-field-${f.class}`}>
              <div className="ap-field-head">
                <span className="ap-field-label">{f.label}</span>
                <span className={`ap-m2-control ap-m2-control-${ctrl}`}>{meta.label}</span>
                <span className="ap-m2-class">{f.class}</span>
                {f.confidence && (
                  <span className={`ap-confidence ap-conf-${f.confidence}`}>
                    {f.confidence}
                  </span>
                )}
              </div>

              {isManual ? (
                <div className="ap-m2-manual">
                  <AlertTriangle size={13} /> Manual field — handle this directly in
                  the browser window (CAPTCHA, rich text, or unsupported control).
                </div>
              ) : isFile ? (
                <div className="ap-field-file">
                  <code className="ap-field-file-path">{value || '(no file)'}</code>
                </div>
              ) : opts && opts.length > 0 ? (
                <select
                  className="ap-m2-input ap-m2-select"
                  value={value}
                  onChange={(e) =>
                    setEdits((prev) => ({ ...prev, [refId]: e.target.value }))
                  }
                >
                  {!value && <option value="">— select —</option>}
                  {value && !opts.includes(value) && (
                    <option value={value}>{value} — (not a form option)</option>
                  )}
                  {opts.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : isLongValue(value) ? (
                <textarea
                  className="ap-field-textarea"
                  value={value}
                  rows={4}
                  onChange={(e) =>
                    setEdits((prev) => ({ ...prev, [refId]: e.target.value }))
                  }
                />
              ) : (
                <input
                  className="ap-m2-input"
                  value={value}
                  onChange={(e) =>
                    setEdits((prev) => ({ ...prev, [refId]: e.target.value }))
                  }
                />
              )}

              {!isManual && !isFile && !opts && meta.hint && (
                <div className="ap-m2-ctrl-hint">{meta.hint}</div>
              )}

              <div className="ap-field-foot">
                {f.source_ref && (
                  <span className="ap-source-ref">
                    <code>{f.source_ref}</code>
                  </span>
                )}
                {f.block_approve && (
                  <span className="ap-m2-block">
                    <AlertTriangle size={11} /> needs your review
                  </span>
                )}
              </div>
            </div>
          )
        })}
        {fields.length === 0 && (
          <div className="ap-empty">No fields to review on this step.</div>
        )}
      </div>

      <div className="ap-submit-bar">
        <div className="ap-submit-info">
          Approving fills these values into the live form and advances to the next step.
        </div>
        <div className="ap-m2-approval-btns">
          <button
            type="button"
            className="ap-action-btn"
            onClick={onCancel}
            disabled={busy}
          >
            <X size={12} /> Cancel
          </button>
          <button
            type="button"
            className="ap-submit-btn"
            onClick={onApprove}
            disabled={busy}
          >
            <Check size={14} /> {busy ? 'Approving…' : 'Approve & continue'}
          </button>
        </div>
      </div>
    </section>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────

// Scan a session's per-step drafts for M1 post-fill verification results.
// `problems` collects every field that did NOT cleanly verify — the panel
// shows them loudly so a failed fill is never hidden behind a green "done".
function verifySummary(session: Session | undefined) {
  const counts = {
    verified: 0,
    mismatch: 0,
    fill_error: 0,
    unverifiable: 0,
    not_seen: 0,
    manual: 0,
  }
  // problems = the machine tried and failed / couldn't confirm.
  // todos    = only the operator can do these (CAPTCHA, missed fields).
  const problems: { label: string; status: string; detail?: string }[] = []
  const todos: { label: string; status: string; detail?: string }[] = []
  for (const step of Object.values(session?.per_step_draft ?? {})) {
    for (const f of step.fields ?? []) {
      const st = f.verify_status
      if (st == null || !(st in counts)) continue
      counts[st as keyof typeof counts]++
      if (st === 'mismatch' || st === 'fill_error' || st === 'unverifiable') {
        problems.push({ label: f.label, status: st, detail: f.verify_detail })
      } else if (st === 'not_seen' || st === 'manual') {
        todos.push({ label: f.label, status: st, detail: f.verify_detail })
      }
    }
  }
  const total =
    counts.verified + counts.mismatch + counts.fill_error + counts.unverifiable
  return { counts, problems, todos, total }
}

// Map a Mode 2 classifier class onto the /apply/submitted 4-class enum.
function toSubmittedClass(cls: string): 'hard' | 'legal' | 'open' | 'file' {
  if (cls === 'legal') return 'legal'
  if (cls === 'file') return 'file'
  if (cls === 'hard' || cls === 'identity') return 'hard'
  return 'open'
}

// Flatten every filled field across all steps into the /apply/submitted
// fields contract. Deduplicates by label (last write wins), caps at 50.
function flattenSessionFields(session: Session) {
  const byLabel = new Map<string, { label: string; final_answer: string; class: string }>()
  const steps = Object.values(session.per_step_draft ?? {})
  for (const step of steps) {
    for (const f of step.fields ?? []) {
      const label = String(f.label ?? '').trim().slice(0, 200)
      if (!label) continue
      byLabel.set(label, {
        label,
        final_answer: String(f.suggested_value ?? '').slice(0, 2000),
        class: toSubmittedClass(f.class),
      })
    }
  }
  const out = Array.from(byLabel.values()).slice(0, 50)
  // /apply/submitted requires at least one field.
  if (out.length === 0) {
    out.push({ label: 'Auto-fill', final_answer: 'Completed via auto-fill', class: 'open' })
  }
  return out
}

// ── Status board + Triage view (m8) ─────────────────────────────────────
//
// The status board is sticky at the top of the active view: a verified/
// total ratio + chip counts (to_retry / unlabeled / manual) + actions
// (Start clean-up / Pause / Cancel). Clicking "Start clean-up" expands
// the Triage view below, which groups same-root failing fields and lists
// standalone failures (per-field cards land in m9).

const CHIP_META: Record<
  (typeof CHIP_KINDS)[number],
  { label: string; tone: 'warn' | 'info' | 'hand'; Icon: typeof ListChecks }
> = {
  to_retry: { label: 'To retry', tone: 'warn', Icon: ListChecks },
  unlabeled: { label: 'Unlabeled', tone: 'info', Icon: Sparkles },
  manual: { label: 'Manual', tone: 'hand', Icon: Hand },
}

function StatusBoard({
  session,
  sseOverlay,
  submitAttempts,
  onPause,
  onCancel,
  onFocus,
  onRetry,
  onSkip,
  onCopy,
  onResumeCompress,
  onAltFormats,
  onIdentifyAts,
  onUserHint,
  actionBusy,
  busy,
}: {
  session: Session
  sseOverlay: Record<string, string>
  submitAttempts: SubmitAttempt[]
  onPause: () => void
  onCancel: () => void
  onFocus: (refId: string) => void
  onRetry: (refId: string, strategy?: string) => void
  onSkip: (refId: string) => void
  onCopy: (refId: string, value: string) => void
  onResumeCompress: (refId: string) => void
  onAltFormats: (refId: string, chosen: string) => void
  onIdentifyAts: (ats: string) => void
  onUserHint: (refId: string, hint: string) => void
  actionBusy: Record<string, string>
  busy: boolean
}) {
  // [P3-OQ6] derive on every render — buildTriageState is pure and cheap
  // enough on the field counts a normal application emits (<200).
  // m9: overlay SSE-driven verify_status on top of polled session before
  // deriving — flips card colors instantly when user types in browser.
  // [review H2/M2] Overlay only applies when the polled session value is
  // NOT a terminal-truth state (verified / skipped_by_user). Once the
  // poll catches up to terminal truth, the overlay defers — prevents
  // stale 'stale' from sticking after the operator has actually fixed
  // the field through some other path.
  const TERMINAL_VERIFY_STATES = new Set(['verified', 'skipped_by_user'])
  const overlaidSession = useMemo(() => {
    if (!sseOverlay || Object.keys(sseOverlay).length === 0) return session
    const next = { ...session, per_step_draft: { ...session.per_step_draft } }
    for (const [k, v] of Object.entries(next.per_step_draft)) {
      const fields = (v?.fields ?? []).map((f) => {
        if (!f.refId) return f
        if (TERMINAL_VERIFY_STATES.has(f.verify_status ?? '')) return f
        const override = sseOverlay[f.refId]
        if (!override) return f
        return { ...f, verify_status: override }
      })
      next.per_step_draft[k] = { ...v, fields }
    }
    return next
  }, [session, sseOverlay])
  const { entries, counts } = useMemo(
    () => buildTriageState(overlaidSession),
    [overlaidSession],
  )
  const [expanded, setExpanded] = useState(false)

  const noWork =
    counts.chips.to_retry === 0 &&
    counts.chips.unlabeled === 0 &&
    counts.chips.manual === 0

  return (
    <div className="ap-m2-status-board" aria-label="Status board">
      <div className="ap-m2-sb-head">
        <div className="ap-m2-sb-counts">
          <span className="ap-m2-sb-ratio">
            <strong>{counts.verified}</strong>
            <span className="ap-m2-sb-slash"> / </span>
            <strong>{counts.total}</strong>
            <span className="ap-m2-sb-suffix"> verified</span>
          </span>
          {counts.pct !== null && (
            <span className="ap-m2-sb-pct">{counts.pct}%</span>
          )}
        </div>
        <div className="ap-m2-sb-actions">
          <button
            type="button"
            className="ap-action-btn"
            onClick={() => setExpanded((v) => !v)}
            // [review H3] Allow toggling closed even after work clears
            // mid-triage — otherwise the user is trapped with an open
            // empty panel they can't dismiss.
            disabled={busy || (noWork && !expanded)}
            aria-expanded={expanded}
            title={noWork && !expanded ? 'Nothing to clean up — all fields are verified.' : 'Show triage view'}
          >
            <ListChecks size={12} />
            {expanded ? 'Hide clean-up' : 'Start clean-up'}
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          <button
            type="button"
            className="ap-action-btn"
            onClick={onPause}
            disabled={busy}
          >
            <Pause size={12} /> Pause
          </button>
          <button
            type="button"
            className="ap-action-btn ap-m2-sb-cancel"
            onClick={onCancel}
            disabled={busy}
          >
            <X size={12} /> Cancel
          </button>
        </div>
      </div>
      <div className="ap-m2-sb-chips">
        {CHIP_KINDS.map((kind) => {
          const meta = CHIP_META[kind]
          const n = counts.chips[kind]
          const Icon = meta.Icon
          return (
            <span
              key={kind}
              className={`ap-m2-sb-chip ap-m2-sb-chip-${meta.tone} ${n === 0 ? 'ap-m2-sb-chip-zero' : ''}`}
              // [review L1] explicit aria-label so SRs hear "To retry: 5"
              // instead of "ListChecks To retry: 5".
              aria-label={`${meta.label}: ${n}`}
            >
              <Icon size={11} aria-hidden="true" /> {meta.label}: <strong>{n}</strong>
            </span>
          )
        })}
      </div>
      {/* m11: Recovery 3 — Identify ATS row. Sits at the top of the
          board when the loaded adapter is generic/unknown AND the
          operator hasn't already recorded an ATS identification this
          session. [review M5] Once recorded, collapse the row so
          duplicate clicks don't pile up user_hints entries. */}
      {shouldShowIdentifyAts(session) &&
        !(session.user_hints ?? []).some((h) => h.kind === 'ats_identification') && (
        <div className="ap-m2-sb-recovery" role="region" aria-label="Identify ATS">
          <span className="ap-m2-sb-recovery-head">
            <AlertTriangle size={11} aria-hidden="true" /> Which ATS is this?
            <span className="ap-m2-sb-recovery-context">
              (detected as: <code>{session.site_adapter}</code>)
            </span>
          </span>
          <div className="ap-m2-sb-recovery-row">
            {RECOVERY_ATSES.map((ats) => (
              <button
                key={ats}
                type="button"
                className="ap-action-btn"
                disabled={actionBusy['__recovery_ats'] != null}
                onClick={() => onIdentifyAts(ats)}
              >
                {ats === 'unknown' ? "I don't know" : ats === 'skip' ? 'Skip' : ats}
              </button>
            ))}
          </div>
        </div>
      )}
      {expanded && (
        <TriageView
          entries={entries}
          submitAttempts={submitAttempts}
          onFocus={onFocus}
          onRetry={onRetry}
          onSkip={onSkip}
          onCopy={onCopy}
          onResumeCompress={onResumeCompress}
          onAltFormats={onAltFormats}
          onUserHint={onUserHint}
          actionBusy={actionBusy}
        />
      )}
    </div>
  )
}

type TriageField = {
  refId: string
  label: string
  class: string
  // [review H1] subclass propagates classifier hints (e.g. 'phone' /
  // 'date' / 'resume') that the recovery.mjs altFormatLadder needs.
  subclass: string | null
  suggested_value: string | null
  verify_status: string | null
  verify_detail: string | null
  required: boolean
  stepIdx: number
  role: string | null
  control_fingerprint: { ancestors?: string[]; tag?: string; role?: string } | null
}

type TriageEntry =
  | { kind: 'group'; groupKey: string; fields: TriageField[]; batch_hint: string | null }
  | { kind: 'standalone'; field: TriageField }

function TriageView({
  entries,
  submitAttempts,
  onFocus,
  onRetry,
  onSkip,
  onCopy,
  onResumeCompress,
  onAltFormats,
  onUserHint,
  actionBusy,
}: {
  entries: TriageEntry[]
  submitAttempts: SubmitAttempt[]
  onFocus: (refId: string) => void
  onRetry: (refId: string, strategy?: string) => void
  onSkip: (refId: string) => void
  onCopy: (refId: string, value: string) => void
  onResumeCompress: (refId: string) => void
  onAltFormats: (refId: string, chosen: string) => void
  onUserHint: (refId: string, hint: string) => void
  actionBusy: Record<string, string>
}) {
  if (entries.length === 0) {
    return (
      <div className="ap-m2-triage-empty">
        <Check size={13} /> Nothing to triage — all fields are verified or in progress.
      </div>
    )
  }
  return (
    <div className="ap-m2-triage" role="list">
      {entries.map((e) => {
        if (e.kind === 'group') {
          return (
            <div
              key={`g-${e.groupKey}`}
              className="ap-m2-triage-card ap-m2-triage-group"
              role="listitem"
            >
              <div className="ap-m2-triage-head">
                <span className="ap-m2-triage-icon" aria-hidden="true">▣</span>
                <span className="ap-m2-triage-title">
                  {e.fields.length} fields share root{' '}
                  <code className="ap-m2-triage-root">{e.groupKey}</code>
                </span>
                {e.batch_hint && (
                  <span className="ap-m2-triage-hint">{e.batch_hint}</span>
                )}
              </div>
              <ul className="ap-m2-triage-members">
                {e.fields.map((f) => (
                  <li key={`${f.stepIdx}::${f.refId}`}>
                    <FieldCard
                      field={f}
                      submitAttempts={submitAttempts}
                      onFocus={onFocus}
                      onRetry={onRetry}
                      onSkip={onSkip}
                      onCopy={onCopy}
                      onResumeCompress={onResumeCompress}
                      onAltFormats={onAltFormats}
                      onUserHint={onUserHint}
                      actionBusy={actionBusy}
                      compact
                    />
                  </li>
                ))}
              </ul>
            </div>
          )
        }
        const f = e.field
        return (
          <FieldCard
            key={`s-${f.stepIdx}::${f.refId}`}
            field={f}
            submitAttempts={submitAttempts}
            onFocus={onFocus}
            onRetry={onRetry}
            onSkip={onSkip}
            onCopy={onCopy}
            onResumeCompress={onResumeCompress}
            onAltFormats={onAltFormats}
            onUserHint={onUserHint}
            actionBusy={actionBusy}
          />
        )
      })}
    </div>
  )
}

// ── m9: per-field FieldCard ─────────────────────────────────────────────
//
// Header: status icon + label · class badge + verify status
// KV rows: Expected / Form has / Control
// Tried row: 5-slot ladder showing per-strategy result
// Actions: [Copy] [Focus] [Retry] [Skip]
// `compact` skips the KV / Tried rows for group members where the parent
// card already shows the common signal.

const LADDER_ICON: Record<string, string> = {
  verified: '✓',
  fail: '✗',
  pending: '⏸',
  unknown: '?',
}

function FieldCard({
  field,
  submitAttempts,
  onFocus,
  onRetry,
  onSkip,
  onCopy,
  onResumeCompress,
  onAltFormats,
  onUserHint,
  actionBusy,
  compact,
}: {
  field: TriageField
  submitAttempts: SubmitAttempt[]
  onFocus: (refId: string) => void
  onRetry: (refId: string, strategy?: string) => void
  onSkip: (refId: string) => void
  onCopy: (refId: string, value: string) => void
  onResumeCompress: (refId: string) => void
  onAltFormats: (refId: string, chosen: string) => void
  onUserHint: (refId: string, hint: string) => void
  actionBusy: Record<string, string>
  compact?: boolean
}) {
  const busyKind = actionBusy[field.refId] ?? null
  const isVerified = field.verify_status === 'verified'
  const isSkipped = field.verify_status === 'skipped_by_user'
  const isStale = field.verify_status === 'stale'

  const headIcon = isVerified ? '✓' : isSkipped ? '✋' : isStale ? '⚠' : '✗'
  const headTone = isVerified ? 'ok' : isStale ? 'warn' : isSkipped ? 'mute' : 'err'

  const tried = useMemo(
    () => deriveTriedLadder(field, submitAttempts),
    [field, submitAttempts],
  )

  // m11: per-field recovery affordances (Recovery 1/2/4). Recovery 3
  // (identify ATS) is rendered in StatusBoard, not per-field.
  const aff = useMemo(
    () => fieldRecoveryAffordances(field, submitAttempts),
    [field, submitAttempts],
  )
  const [hintDraft, setHintDraft] = useState('')

  return (
    <div
      className={`ap-m2-triage-card ap-m2-field-card ap-m2-field-card-${headTone} ${compact ? 'ap-m2-field-card-compact' : ''}`}
      role={compact ? undefined : 'listitem'}
    >
      <div className="ap-m2-fc-head">
        <span className={`ap-m2-fc-icon ap-m2-fc-icon-${headTone}`} aria-hidden="true">{headIcon}</span>
        <span className="ap-m2-fc-label">{field.label}</span>
        <span className="ap-m2-fc-class">{field.class}</span>
        {field.verify_status && (
          <span className={`ap-m2-fc-status ap-m2-fc-status-${headTone}`}>
            {field.verify_status}
          </span>
        )}
        {!field.required && <span className="ap-m2-fc-opt">optional</span>}
      </div>

      {!compact && (
        <div className="ap-m2-fc-kv-rows">
          <div className="ap-m2-fc-kv">
            <span className="ap-m2-fc-kv-k">Expected</span>
            <code className="ap-m2-fc-kv-v">
              {field.suggested_value !== null && field.suggested_value !== ''
                ? field.suggested_value
                : '(none)'}
            </code>
          </div>
          {field.verify_detail && (
            <div className="ap-m2-fc-kv">
              <span className="ap-m2-fc-kv-k">Detail</span>
              <span className="ap-m2-fc-kv-v">{field.verify_detail}</span>
            </div>
          )}
          {field.role && (
            <div className="ap-m2-fc-kv">
              <span className="ap-m2-fc-kv-k">Control</span>
              <span className="ap-m2-fc-kv-v">{field.role}</span>
            </div>
          )}
        </div>
      )}

      {!compact && (
        <div className="ap-m2-fc-tried" aria-label="Strategy ladder">
          <span className="ap-m2-fc-tried-head">Tried:</span>
          {tried.map((t) => (
            <span
              key={t.name}
              className={`ap-m2-fc-tried-slot ap-m2-fc-tried-${t.state}`}
              title={`${t.name}: ${t.state}`}
            >
              <span aria-hidden="true">{LADDER_ICON[t.state]}</span> {t.name}
            </span>
          ))}
        </div>
      )}

      <div className="ap-m2-fc-actions">
        <button
          type="button"
          className="ap-action-btn"
          disabled={!field.suggested_value || busyKind != null}
          onClick={() => onCopy(field.refId, field.suggested_value ?? '')}
          title="Copy expected value to clipboard"
        >
          <Clipboard size={11} aria-hidden="true" /> Copy
        </button>
        <button
          type="button"
          className="ap-action-btn"
          disabled={busyKind != null || isSkipped}
          onClick={() => onFocus(field.refId)}
          title="Scroll to this field in the browser"
        >
          {busyKind === 'focus' ? <Loader2 size={11} className="ap-spin" /> : <Crosshair size={11} aria-hidden="true" />} Focus
        </button>
        <button
          type="button"
          className="ap-action-btn"
          disabled={busyKind != null || isSkipped}
          onClick={() => {
            // Pick the first pending strategy as a hint; falls back to
            // server default (full ladder) when none — keyboard_input
            // is often the next sensible escalation when click strategies
            // failed.
            const nextPending = tried.find((t) => t.state === 'pending')
            onRetry(field.refId, nextPending?.name)
          }}
          title="Retry filling this field"
        >
          {busyKind === 'retry' ? <Loader2 size={11} className="ap-spin" /> : <RotateCw size={11} aria-hidden="true" />} Retry
        </button>
        <button
          type="button"
          className="ap-action-btn ap-m2-fc-skip"
          disabled={busyKind != null || isSkipped}
          onClick={() => onSkip(field.refId)}
          title="Mark this field as user-handled"
        >
          {busyKind === 'skip' ? <Loader2 size={11} className="ap-spin" /> : <Hand size={11} aria-hidden="true" />} Skip
        </button>
      </div>

      {/* m11: Phase 4 recovery affordances — conditional per error_code
          / verify_status. Hidden when compact (group members inherit
          their parent's affordances) or when the field is already
          terminal (skipped / verified).
          [review H3] Wrap in <details> so the recovery row doesn't pile
          5 stacked rows per failing field. The user-hint affordance
          requires a terminal-failed state (fill_error / all_strategies_failed)
          so when it shows we OPEN the panel by default; otherwise the
          softer "tried a few things, want help?" affordances stay collapsed.
          [review L1] Enter submits the hint input. */}
      {!compact && !isSkipped && !isVerified && (aff.resumeCompress || aff.altFormats || aff.userHint) && (
        <details className="ap-m2-fc-recovery-wrap" open={aff.userHint}>
          <summary className="ap-m2-fc-recovery-summary">
            Recovery options
            {aff.resumeCompress && ' · resume compress'}
            {aff.altFormats && ' · alt formats'}
            {aff.userHint && ' · hint'}
          </summary>
          <div className="ap-m2-fc-recovery">
            {aff.resumeCompress && (
              <button
                type="button"
                className="ap-action-btn ap-m2-fc-recovery-btn"
                disabled={busyKind != null}
                onClick={() => onResumeCompress(field.refId)}
                title="Re-render the resume at compressed quality and retry the upload"
              >
                {busyKind === 'resume_compress' ? <Loader2 size={11} className="ap-spin" /> : '⚡'} Re-render compressed
              </button>
            )}
            {aff.altFormats && aff.altLadder && (
              <div className="ap-m2-fc-alt-row">
                <span className="ap-m2-fc-alt-label">⚡ Try alt format:</span>
                {aff.altLadder.slice(0, 4).map((alt: string) => (
                  <button
                    key={alt}
                    type="button"
                    className="ap-action-btn ap-m2-fc-recovery-btn ap-m2-fc-alt-btn"
                    disabled={busyKind != null}
                    onClick={() => onAltFormats(field.refId, alt)}
                    title={`Retry with ${alt}`}
                  >
                    {alt}
                  </button>
                ))}
              </div>
            )}
            {aff.userHint && (
              <div className="ap-m2-fc-hint-row">
                <input
                  type="text"
                  className="ap-m2-fc-hint-input"
                  placeholder="Tell me what worked for you in the browser…"
                  value={hintDraft}
                  onChange={(e) => setHintDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && hintDraft.trim().length > 0 && busyKind == null) {
                      onUserHint(field.refId, hintDraft.trim())
                      setHintDraft('')
                    }
                  }}
                  disabled={busyKind != null}
                  maxLength={500}
                />
                <button
                  type="button"
                  className="ap-action-btn ap-m2-fc-recovery-btn"
                  disabled={busyKind != null || hintDraft.trim().length === 0}
                  onClick={() => {
                    onUserHint(field.refId, hintDraft.trim())
                    setHintDraft('')
                  }}
                >
                  {busyKind === 'user_hint' ? <Loader2 size={11} className="ap-spin" /> : '📤'} Send hint
                </button>
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  )
}

// Reference LADDER_NAMES import for type-narrowing; the actual ladder
// labels come from triage.mjs via deriveTriedLadder.
void LADDER_NAMES

// ── m10: SubmitGate, LoopProgress, EscalationPanel ──────────────────────
//
// SubmitGate — gray (disabled + tooltip) when required fields outstanding;
// green ([Open Chromium] + [Mark applied]) when ready. Stays VISIBLE in
// both states (P3-OQ4 — never hide; tooltip explains).
//
// LoopProgress — horizontal stepper showing auto-fill → submit attempt →
// auto-fix → next attempt across the m6 submit-first loop. Visible when
// session.submit_attempts has ≥ 1 entry.
//
// EscalationPanel — shown when the loop has bailed (machine.lastOutcome
// = 'escalated'). Surface escalation_reason + guide the user to m9 field
// cards as the fallback path.

function SubmitGate({
  session,
  jobUrl,
  onReveal,
  onMark,
  marking,
}: {
  session: Session
  jobUrl: string | null
  onReveal: () => void
  onMark: () => void
  marking: boolean
}) {
  const state = useMemo(() => requiredVerifyState(session), [session])
  const tooltip = useMemo(() => missingSummary(state), [state])
  const tone = state.ready ? 'ok' : 'gray'

  return (
    <div
      className={`ap-m2-submit-gate ap-m2-submit-gate-${tone}`}
      role="region"
      aria-label="Mark application as applied"
    >
      <div className="ap-m2-sg-body">
        {state.ready ? (
          <>
            <strong>
              <Check size={14} /> All required fields verified.
            </strong>
            <p className="ap-m2-sg-note">
              Switch to the Chromium window, click <em>Submit</em> on the form,
              then mark it applied here. I&apos;ll auto-detect the page change
              when the submit-success wiring lands.
            </p>
          </>
        ) : (
          <>
            <strong>
              <AlertTriangle size={14} /> {state.missing.length} required field
              {state.missing.length === 1 ? '' : 's'} still need
              {state.missing.length === 1 ? 's' : ''} attention.
            </strong>
            {tooltip && <p className="ap-m2-sg-note">{tooltip}</p>}
          </>
        )}
        <p className="ap-m2-sg-counts">
          <strong>{state.verified}</strong> / <strong>{state.total}</strong>{' '}
          required verified.
        </p>
      </div>
      <div className="ap-m2-sg-actions">
        {jobUrl && (
          <a className="ap-action-btn" href={jobUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={12} /> Open posting
          </a>
        )}
        <button
          type="button"
          className="ap-action-btn"
          onClick={onReveal}
          disabled={marking}
          title="Bring the Chromium window to the front"
        >
          <Monitor size={12} /> Open Chromium
        </button>
        <button
          type="button"
          className="ap-submit-btn"
          onClick={onMark}
          disabled={marking || !state.ready}
          title={state.ready
            ? 'Mark this application as Applied'
            : (tooltip ?? 'Finish all required fields before marking applied')}
        >
          <Send size={14} /> {marking ? 'Marking…' : 'Mark applied'}
        </button>
      </div>
    </div>
  )
}

function LoopProgress({
  attempts,
  machine,
}: {
  attempts: SubmitAttempt[]
  machine: Machine
}) {
  const state = useMemo(
    () => loopProgressState(attempts, machine),
    [attempts, machine],
  )
  if (!state) return null
  // [review M6] Header reads "attempt N+1" when there's a pending tail
  // step (next attempt about to run); otherwise reads the current count.
  const hasPending = state.steps.some((s) => s.status === 'pending')
  const displayAttempt = hasPending
    ? Math.min(state.currentAttempt + 1, state.maxAttempts)
    : Math.min(state.currentAttempt, state.maxAttempts)
  return (
    <div className="ap-m2-loop-progress" aria-label="Submit loop progress">
      <div className="ap-m2-lp-head">
        <strong>
          Submit attempt {displayAttempt} of {state.maxAttempts}
          {state.finalized ? '' : ' · in progress'}
        </strong>
      </div>
      <ol className="ap-m2-lp-stepper">
        {state.steps.map((s, i) => (
          <li
            key={`${s.kind}-${i}`}
            className={`ap-m2-lp-step ap-m2-lp-step-${s.status}`}
          >
            <span className="ap-m2-lp-dot" aria-hidden="true">
              {s.status === 'done' ? '●' : s.status === 'in_progress' ? '◐' : '○'}
            </span>
            <span className="ap-m2-lp-step-body">
              <span className="ap-m2-lp-step-label">{s.label}</span>
              {s.detail && (
                <span className="ap-m2-lp-step-detail"> · {s.detail}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function EscalationPanel({
  escalation,
  onMark,
  marking,
}: {
  escalation: { code: string; detail: string | null; triggered_by: string; attempts_run: number | null }
  onMark: () => void
  marking: boolean
}) {
  const isUserCancel = escalation.code === 'user_cancel'
  return (
    <div className="ap-m2-panel ap-m2-panel-warn ap-m2-escalation">
      <div className="ap-m2-panel-body">
        <strong>
          <AlertTriangle size={15} /> Auto-fill handed control back to you.
        </strong>
        <p className="ap-m2-escalation-reason">
          <code className="ap-m2-escalation-code">{escalation.code}</code>
          {escalation.detail && <> · {escalation.detail}</>}
        </p>
        {escalation.attempts_run !== null && escalation.attempts_run > 0 && (
          <p className="ap-m2-note">
            Tried <strong>{escalation.attempts_run}</strong> submit attempt
            {escalation.attempts_run === 1 ? '' : 's'} before stopping.
          </p>
        )}
        <p>
          {isUserCancel
            ? 'You cancelled this session. Finish in the Chromium window if you want — then mark applied below.'
            : 'Use the field cards above to focus, retry, or skip the remaining fields, then click Submit yourself in the Chromium window.'}
        </p>
      </div>
      <div className="ap-m2-panel-actions">
        <button
          type="button"
          className="ap-submit-btn"
          onClick={onMark}
          disabled={marking}
          title="Mark this application as Applied — only after you've manually clicked Submit"
        >
          <Send size={14} /> {marking ? 'Marking…' : 'Mark applied'}
        </button>
      </div>
    </div>
  )
}
