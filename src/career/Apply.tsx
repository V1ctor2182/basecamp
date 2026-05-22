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

import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import {
  ArrowLeft,
  AlertTriangle,
  Loader2,
  Play,
  X,
  Check,
  RotateCcw,
  ExternalLink,
  Send,
  ShieldCheck,
} from 'lucide-react'
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

const POLL_MS = 1500

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
  async function cancelApply() {
    setBusy(true)
    setError(null)
    if (jobId) {
      try {
        await fetch(api(`/applier/multi-step/${encodeURIComponent(jobId)}/pause`), {
          method: 'POST',
        })
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
        {job?.url && (
          <div className="ap-actions">
            <a className="ap-action-btn" href={job.url} target="_blank" rel="noreferrer">
              <ExternalLink size={12} /> Open job posting
            </a>
          </div>
        )}
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
              className={`ap-m2-panel ${vsum.problems.length > 0 ? 'ap-m2-panel-err' : 'ap-m2-panel-ok'}`}
            >
              <div className="ap-m2-panel-body">
                <strong>
                  {vsum.problems.length > 0 ? (
                    <AlertTriangle size={15} />
                  ) : (
                    <Check size={15} />
                  )}
                  {vsum.problems.length > 0
                    ? 'Form filled — but some fields need a look.'
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
                <p>
                  The machine filled every step up to the Submit page and stopped
                  there.{' '}
                  {vsum.problems.length > 0
                    ? 'Fix the flagged fields in the Chromium window, then Submit.'
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
  const counts = { verified: 0, mismatch: 0, fill_error: 0, unverifiable: 0 }
  const problems: { label: string; status: string; detail?: string }[] = []
  for (const step of Object.values(session?.per_step_draft ?? {})) {
    for (const f of step.fields ?? []) {
      const st = f.verify_status
      if (st === 'verified' || st === 'mismatch' || st === 'fill_error' || st === 'unverifiable') {
        counts[st]++
        if (st !== 'verified') {
          problems.push({ label: f.label, status: st, detail: f.verify_detail })
        }
      }
    }
  }
  const total =
    counts.verified + counts.mismatch + counts.fill_error + counts.unverifiable
  return { counts, problems, total }
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
