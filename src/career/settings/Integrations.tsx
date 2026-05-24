// Integrations — Settings tab to manage third-party credentials in one
// place. Persists to data/config.json via /api/config (m1 backend).
//
// 04-career-system/09-integrations-credentials m2.
//
// Three cards (Anthropic / Google OAuth / GitHub) each own their own
// edit + save + error state, so a save failure on one card doesn't
// blank the others. Secret fields display masked-only — the input is
// empty when a value exists, with a placeholder showing the mask;
// users overwrite via typing, or hit Clear to explicitly delete.
// Plain fields (githubUsername) show the current value live.

import { useEffect, useRef, useState } from 'react'
import {
  Sparkles,
  Cloud,
  Github,
  KeyRound,
  CheckCircle2,
  XCircle,
  Trash2,
  AlertCircle,
  RotateCcw,
} from 'lucide-react'
import './ats-form.css'
import './integrations.css'

// Mirrors the m1 GET /api/config response shape. The legacy flat
// {githubUsername, hasToken} fields are unused here (TrackerApp consumer);
// the nested objects below are what this page reads.
type MaskedLeaf = { set: boolean; masked?: string }
type ConfigGetResp = {
  githubUsername: string
  hasToken: boolean
  anthropic: MaskedLeaf
  google: { clientId: MaskedLeaf; clientSecret: MaskedLeaf }
  github: { username: string; token: MaskedLeaf }
}

// Local input state. Empty string === user hasn't typed anything; on
// save we omit empty strings from the PUT so a blank Save click doesn't
// clobber the existing value. Clearing is a separate explicit action.
type EditState = {
  anthropicApiKey: string
  googleClientId: string
  googleClientSecret: string
  githubUsername: string
  githubToken: string
}

const BLANK_EDIT: EditState = {
  anthropicApiKey: '',
  googleClientId: '',
  googleClientSecret: '',
  githubUsername: '',
  githubToken: '',
}

// Per-card transient feedback. `null` means no message currently shown.
type CardKey = 'anthropic' | 'google' | 'github'
type CardFeedback = { kind: 'saved' | 'cleared' | 'error'; message: string } | null

export default function Integrations() {
  const [config, setConfig] = useState<ConfigGetResp | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [edit, setEdit] = useState<EditState>(BLANK_EDIT)
  const [busyCard, setBusyCard] = useState<CardKey | null>(null)
  const [feedback, setFeedback] = useState<Record<CardKey, CardFeedback>>({
    anthropic: null,
    google: null,
    github: null,
  })

  // REVIEW C2: guard setState after unmount + abort in-flight fetches
  // when navigating away mid-PUT. Without this, a refresh-after-PUT GET
  // could resolve after the user has left the page, blanking their next
  // visit's typed input via the cleanup paths in saveCard / clearField.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Initial load + retry. A fetch failure is surfaced inline — no silent
  // empty state ("everything is unset" would mislead the operator).
  function loadConfig(signal?: AbortSignal) {
    setLoading(true)
    fetch('/api/config', { signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as ConfigGetResp
      })
      .then((data) => {
        if (!mountedRef.current) return
        setConfig(data)
        setEdit((prev) => ({ ...prev, githubUsername: data.github.username || '' }))
        setLoadError(null)
        setLoading(false)
      })
      .catch((e) => {
        if ((e as { name?: string })?.name === 'AbortError') return
        if (!mountedRef.current) return
        setLoadError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
  }
  useEffect(() => {
    const ctrl = new AbortController()
    loadConfig(ctrl.signal)
    return () => ctrl.abort()
  }, [])

  // Auto-dismiss success/clear feedback after 4s so a "Saved" toast
  // doesn't linger and confuse the next save attempt. Errors stay until
  // the next action — they're load-bearing visibility.
  useEffect(() => {
    const timers: number[] = []
    for (const card of ['anthropic', 'google', 'github'] as CardKey[]) {
      const f = feedback[card]
      if (f && f.kind !== 'error') {
        const t = window.setTimeout(() => {
          if (!mountedRef.current) return
          setFeedback((cur) =>
            cur[card] === f ? { ...cur, [card]: null } : cur,
          )
        }, 4000)
        timers.push(t)
      }
    }
    return () => {
      for (const t of timers) window.clearTimeout(t)
    }
  }, [feedback])

  // PUT a partial config update. Returns the refreshed config on success.
  async function putConfig(card: CardKey, body: Record<string, string>) {
    setBusyCard(card)
    setFeedback((f) => ({ ...f, [card]: null }))
    try {
      const r = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error || `HTTP ${r.status}`)
      }
      // Refresh — GET returns updated masked state.
      const refreshed = await fetch('/api/config').then((r2) => r2.json() as Promise<ConfigGetResp>)
      if (!mountedRef.current) return null
      setConfig(refreshed)
      return refreshed
    } catch (e) {
      if (!mountedRef.current) return null
      setFeedback((f) => ({
        ...f,
        [card]: { kind: 'error', message: e instanceof Error ? e.message : 'Network error' },
      }))
      return null
    } finally {
      if (mountedRef.current) setBusyCard(null)
    }
  }

  // Build a PUT body from the editable strings, including only non-empty
  // values. An empty input is treated as "no change", NOT as clear —
  // clearing is the dedicated Clear button below.
  async function saveCard(card: CardKey, fields: Array<keyof EditState>) {
    const body: Record<string, string> = {}
    for (const f of fields) {
      const v = edit[f]
      if (v.trim() !== '') body[f] = v
    }
    if (Object.keys(body).length === 0) {
      setFeedback((f) => ({
        ...f,
        [card]: { kind: 'error', message: 'Nothing to save — enter a value or use Clear.' },
      }))
      return
    }
    const refreshed = await putConfig(card, body)
    if (refreshed) {
      // Wipe the edited inputs for this card so the placeholder shows
      // the new masked value, not the value the user just typed.
      const cleared: Partial<EditState> = {}
      for (const f of fields) {
        // Keep githubUsername editable; sync it to the server's view.
        if (f === 'githubUsername') cleared[f] = refreshed.github.username || ''
        else cleared[f] = ''
      }
      setEdit((prev) => ({ ...prev, ...cleared }))
      setFeedback((f) => ({ ...f, [card]: { kind: 'saved', message: 'Saved' } }))
    }
  }

  // Explicit clear of a single field. Sends '' which the m1 backend
  // interprets as "delete from config.json".
  // REVIEW H2: confirm before clearing — the trash icon is tiny and
  // sits inline next to the input; a misclick on a freshly-minted
  // Anthropic key would be unrecoverable.
  async function clearField(card: CardKey, field: keyof EditState, fieldLabel: string) {
    if (!window.confirm(`Clear ${fieldLabel}? This deletes it from data/config.json and cannot be undone.`)) {
      return
    }
    const refreshed = await putConfig(card, { [field]: '' })
    if (refreshed) {
      setEdit((prev) => ({
        ...prev,
        [field]: field === 'githubUsername' ? refreshed.github.username || '' : '',
      }))
      setFeedback((f) => ({ ...f, [card]: { kind: 'cleared', message: 'Cleared' } }))
    }
  }

  if (loadError) {
    return (
      <div className="af-form">
        <div className="af-form-header">
          <h2 className="af-form-title">Integrations</h2>
        </div>
        <p className="c-int-error">Failed to load config: {loadError}</p>
        <button
          type="button"
          className="af-btn-primary"
          onClick={() => loadConfig()}
          style={{ marginTop: 12 }}
        >
          <RotateCcw size={13} /> Retry
        </button>
      </div>
    )
  }
  if (loading || !config) {
    return <div className="af-loading">Loading integrations…</div>
  }

  return (
    <div className="af-form">
      <div className="af-form-header">
        <h2 className="af-form-title">Integrations</h2>
        <p className="af-form-subtitle">
          第三方凭证统一管理 — 写到本地 <code>data/config.json</code>(已 gitignored)。
          填了之后立即生效,不用重启服务。
        </p>
      </div>

      {/* Card 1 — Anthropic. Each card is its own <form> so Enter submits
          that card only (and 3 separate forms keeps the password-manager
          attribute scoped, per REVIEW C1/H3). */}
      <CredentialsForm
        onSubmit={() => saveCard('anthropic', ['anthropicApiKey'])}
      >
        <header className="c-int-card-head">
          <Sparkles size={16} />
          <h3 className="c-int-card-title">Anthropic API</h3>
          <StatusPill setCount={config.anthropic.set ? 1 : 0} total={1} />
        </header>
        <p className="c-int-card-desc">
          Claude API key — Stage B 评估 / Resume tailor / 飞轮 inducer / classifier 都用它。
          也可以走 <code>CAREER_LLM_BACKEND=cli</code> 让 Claude Code subscription 跑(改 env)。
        </p>
        <SecretField
          label="API key"
          placeholder="sk-ant-api03-..."
          current={config.anthropic}
          value={edit.anthropicApiKey}
          onChange={(v) => setEdit((p) => ({ ...p, anthropicApiKey: v }))}
          onClear={() => clearField('anthropic', 'anthropicApiKey', 'Anthropic API key')}
          inputsDisabled={busyCard === 'anthropic'}
          buttonsDisabled={busyCard !== null}
        />
        <CardActions
          saving={busyCard === 'anthropic'}
          feedback={feedback.anthropic}
          disabled={busyCard !== null && busyCard !== 'anthropic'}
        />
      </CredentialsForm>

      {/* Card 2 — Google OAuth */}
      <CredentialsForm
        onSubmit={() => saveCard('google', ['googleClientId', 'googleClientSecret'])}
      >
        <header className="c-int-card-head">
          <Cloud size={16} />
          <h3 className="c-int-card-title">Google OAuth</h3>
          <StatusPill
            setCount={(config.google.clientId.set ? 1 : 0) + (config.google.clientSecret.set ? 1 : 0)}
            total={2}
          />
        </header>
        <p className="c-int-card-desc">
          Google Cloud OAuth client — Resume 设置里的 Google Doc 同步用。
          在 <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Google Cloud Console → Credentials</a> 创建 "OAuth client ID"(Desktop or Web)。
        </p>
        <SecretField
          label="Client ID"
          placeholder="123456-xxxxx.apps.googleusercontent.com"
          current={config.google.clientId}
          value={edit.googleClientId}
          onChange={(v) => setEdit((p) => ({ ...p, googleClientId: v }))}
          onClear={() => clearField('google', 'googleClientId', 'Google OAuth client ID')}
          inputsDisabled={busyCard === 'google'}
          buttonsDisabled={busyCard !== null}
        />
        <SecretField
          label="Client secret"
          placeholder="GOCSPX-..."
          current={config.google.clientSecret}
          value={edit.googleClientSecret}
          onChange={(v) => setEdit((p) => ({ ...p, googleClientSecret: v }))}
          onClear={() => clearField('google', 'googleClientSecret', 'Google OAuth client secret')}
          inputsDisabled={busyCard === 'google'}
          buttonsDisabled={busyCard !== null}
        />
        <CardActions
          saving={busyCard === 'google'}
          feedback={feedback.google}
          disabled={busyCard !== null && busyCard !== 'google'}
        />
      </CredentialsForm>

      {/* Card 3 — GitHub */}
      <CredentialsForm
        onSubmit={() => saveCard('github', ['githubUsername', 'githubToken'])}
      >
        <header className="c-int-card-head">
          <Github size={16} />
          <h3 className="c-int-card-title">GitHub</h3>
          <StatusPill setCount={config.github.token.set ? 1 : 0} total={1} />
        </header>
        <p className="c-int-card-desc">
          GitHub username + Personal Access Token — Tracker 拉 commits / PRs / activity 用。
          username 可见(非密钥),token 是 secret。在
          {' '}<a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer">Settings → Developer settings → Personal access tokens</a> 生成。
        </p>
        <PlainField
          label="Username"
          placeholder="your-github-handle"
          value={edit.githubUsername}
          onChange={(v) => setEdit((p) => ({ ...p, githubUsername: v }))}
          disabled={busyCard === 'github'}
        />
        <SecretField
          label="Personal access token"
          placeholder="ghp_... or github_pat_..."
          current={config.github.token}
          value={edit.githubToken}
          onChange={(v) => setEdit((p) => ({ ...p, githubToken: v }))}
          onClear={() => clearField('github', 'githubToken', 'GitHub personal access token')}
          inputsDisabled={busyCard === 'github'}
          buttonsDisabled={busyCard !== null}
        />
        <CardActions
          saving={busyCard === 'github'}
          feedback={feedback.github}
          disabled={busyCard !== null && busyCard !== 'github'}
        />
      </CredentialsForm>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────

// REVIEW C1/H3: wrap each card's fields in a real <form> so Enter
// submits that card AND password managers (1Password, LastPass, Chrome
// built-in) treat each form as a discrete context. The data-* attrs
// below + autoComplete="off" disable autofill on a best-effort basis;
// password managers vary, so the placeholder-masked UX still defends
// against autofill repopulating an empty-looking input.
function CredentialsForm({
  onSubmit,
  children,
}: {
  onSubmit: () => void
  children: React.ReactNode
}) {
  return (
    <form
      className="c-int-card"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
      autoComplete="off"
      data-1p-ignore="true"
      data-lpignore="true"
    >
      {children}
    </form>
  )
}

function StatusPill({ setCount, total }: { setCount: number; total: number }) {
  const allSet = setCount === total
  const none = setCount === 0
  const className = `c-int-status ${
    allSet ? 'c-int-status-ok' : none ? 'c-int-status-unset' : 'c-int-status-partial'
  }`
  const label = allSet ? 'Configured' : none ? 'Not configured' : `${setCount}/${total} set`
  // REVIEW L4: differentiate partial (AlertCircle) from unset (KeyRound)
  // so the icon alone communicates state for colorblind operators.
  const Icon = allSet ? CheckCircle2 : none ? KeyRound : AlertCircle
  return (
    <span className={className}>
      <Icon size={12} /> {label}
    </span>
  )
}

function SecretField({
  label,
  placeholder,
  current,
  value,
  onChange,
  onClear,
  inputsDisabled,
  buttonsDisabled,
}: {
  label: string
  placeholder: string
  current: MaskedLeaf
  value: string
  onChange: (v: string) => void
  onClear: () => void
  inputsDisabled: boolean
  buttonsDisabled: boolean
}) {
  // When a secret is already set, the placeholder shows the masked tail
  // (e.g. ●●●●●●●●abcd) so the operator can confirm which key is there.
  // The input itself stays empty — we never round-trip the raw value.
  const ph = current.set && current.masked ? current.masked : placeholder
  return (
    <div className="c-int-row">
      <label className="af-label c-int-label">{label}</label>
      <div className="c-int-field">
        <input
          type="password"
          className="af-input c-int-input"
          placeholder={ph}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={inputsDisabled}
          autoComplete="off"
          spellCheck={false}
          // Disable browser password manager save prompts on a best-
          // effort basis (extensions ignore these inconsistently —
          // the empty-input + masked-placeholder UX is the real
          // defense). REVIEW C1.
          data-1p-ignore="true"
          data-lpignore="true"
          name="off"
        />
        {current.set && (
          <button
            type="button"
            className="c-int-btn c-int-btn-clear"
            onClick={onClear}
            disabled={buttonsDisabled}
            aria-label={`Clear ${label}`}
            title="Clear this field"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
      {/* REVIEW H1: spell out "blank = keep current" so the operator
          isn't surprised that hitting Save with an empty input doesn't
          clear the existing value. */}
      {current.set && (
        <span className="c-int-hint">
          Leave blank to keep the current value; type to replace, or use trash to clear.
        </span>
      )}
    </div>
  )
}

function PlainField({
  label,
  placeholder,
  value,
  onChange,
  disabled,
}: {
  label: string
  placeholder: string
  value: string
  onChange: (v: string) => void
  disabled: boolean
}) {
  return (
    <div className="c-int-row">
      <label className="af-label c-int-label">{label}</label>
      <div className="c-int-field">
        <input
          type="text"
          className="af-input c-int-input"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
    </div>
  )
}

function CardActions({
  saving,
  feedback,
  disabled,
}: {
  saving: boolean
  feedback: CardFeedback
  disabled: boolean
}) {
  return (
    <div className="c-int-actions">
      <button
        type="submit"
        className="af-btn-primary"
        disabled={saving || disabled}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      {feedback && (
        <span
          className={`c-int-toast c-int-toast-${feedback.kind}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.kind === 'error' ? <XCircle size={12} /> : <CheckCircle2 size={12} />}{' '}
          {feedback.message}
        </span>
      )}
    </div>
  )
}
