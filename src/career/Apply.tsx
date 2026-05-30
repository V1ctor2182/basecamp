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

import { useEffect, useMemo, useRef, useState } from 'react'
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
} from 'lucide-react'
import { buildTriageState, CHIP_KINDS } from './apply/triage.mjs'
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
}

type Machine = {
  state: 'idle' | 'starting' | 'running' | 'awaiting-approval' | 'done'
  lastOutcome: 'completed' | 'paused' | 'error' | null
  lastError: string | null
  pending: Pending | null
  lastDraftInfo: Pending | null
  autoApprove: { enabled: boolean; count: number; log: unknown[] }
}

type StatusResp = { sessionId: string; session: Session; machine: Machine }

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

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Identifies the currently-displayed pending draft so we re-seed `edits`
  // only when a genuinely new approval gate arrives (not every poll tick).
  const pendingKeyRef = useRef<string | null>(null)

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

  // Decide the phase from a freshly-fetched status snapshot.
  function adoptStatus(s: StatusResp) {
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
      setStatus(s)
      maybeSeedEdits(s.machine.pending)
      // First successful poll graduates 'starting' → 'active'; a settled
      // machine goes to 'done'. Without this the page would stay stuck on
      // the "Launching browser…" spinner even after the machine reports.
      setPhase(s.machine.state === 'done' ? 'done' : 'active')
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
  async function markApplied() {
    if (!jobId || !status) return
    const ok = window.confirm(
      'Did you click Submit in the Chromium window?\n\n' +
        'This marks the application as Applied and records the filled fields. ' +
        'It does not submit the form for you.',
    )
    if (!ok) return
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
  const terminal =
    phase === 'done'
      ? outcome ?? (session?.status === 'completed' ? 'completed' : session?.status === 'paused' ? 'paused' : 'error')
      : null
  const vsum = verifySummary(session)

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
              onPause={pauseApply}
              onCancel={cancelApply}
              busy={busy}
            />
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
              <div className="ap-m2-panel-actions">
                {job?.url && (
                  <a className="ap-action-btn" href={job.url} target="_blank" rel="noreferrer">
                    <ExternalLink size={12} /> Open posting
                  </a>
                )}
                <button
                  type="button"
                  className="ap-submit-btn"
                  onClick={markApplied}
                  disabled={marking}
                >
                  <Send size={14} /> {marking ? 'Marking…' : 'Mark applied'}
                </button>
              </div>
            </div>
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
  onPause,
  onCancel,
  busy,
}: {
  session: Session
  onPause: () => void
  onCancel: () => void
  busy: boolean
}) {
  // [P3-OQ6] derive on every render — buildTriageState is pure and cheap
  // enough on the field counts a normal application emits (<200).
  const { entries, counts } = useMemo(
    () => buildTriageState(session),
    [session],
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
      {expanded && <TriageView entries={entries} />}
    </div>
  )
}

type TriageEntry =
  | {
      kind: 'group'
      groupKey: string
      fields: Array<{ refId: string; label: string; verify_status: string | null; verify_detail: string | null; required: boolean; stepIdx: number }>
      batch_hint: string | null
    }
  | {
      kind: 'standalone'
      field: {
        refId: string
        label: string
        verify_status: string | null
        verify_detail: string | null
        required: boolean
        stepIdx: number
      }
    }

function TriageView({ entries }: { entries: TriageEntry[] }) {
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
            // [review M3] groupKey is unique within a single triage build —
            // no `i` index needed; that would force re-mount on every sort
            // change and lose card-level state.
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
                  // [review H1] composite key — refId alone collides
                  // across steps (`__captcha`, `__file_0`).
                  <li key={`${f.stepIdx}::${f.refId}`}>
                    <strong>{f.label}</strong>
                    {f.verify_status && (
                      <span className="ap-m2-triage-status"> · {f.verify_status}</span>
                    )}
                    {!f.required && (
                      <span className="ap-m2-triage-opt"> · optional</span>
                    )}
                  </li>
                ))}
              </ul>
              <div className="ap-m2-triage-foot">
                <button
                  type="button"
                  className="ap-action-btn"
                  disabled
                  title="Per-field card actions land in m9"
                >
                  Batch retry (m9)
                </button>
              </div>
            </div>
          )
        }
        const f = e.field
        return (
          <div
            key={`s-${f.stepIdx}::${f.refId}`}
            className="ap-m2-triage-card ap-m2-triage-standalone"
            role="listitem"
          >
            <div className="ap-m2-triage-head">
              <span className="ap-m2-triage-icon" aria-hidden="true">◇</span>
              <span className="ap-m2-triage-title">
                <strong>{f.label}</strong>
                {f.verify_status && (
                  <span className="ap-m2-triage-status"> · {f.verify_status}</span>
                )}
                {!f.required && (
                  <span className="ap-m2-triage-opt"> · optional</span>
                )}
              </span>
            </div>
            {f.verify_detail && (
              <p className="ap-m2-triage-detail">{f.verify_detail}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}
