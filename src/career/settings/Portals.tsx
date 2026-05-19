// Portals — configure which job boards Finder scans.
//
// 04-career-system / find-jobs-redesign m1 (Portals UX refactor).
//
// One URL field per source. Backend parses the URL (boards.greenhouse.io,
// jobs.ashbyhq.com, jobs.lever.co, github.com) into {type, config} and
// IMMEDIATELY test-fetches via the adapter so the user sees "✓ 405 jobs
// (Sample title 1, ...)" or "✗ HTTP 404" within ~1s — no more silent
// errors at scan time.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2, RefreshCw, CheckCircle2, XCircle, Loader } from 'lucide-react'
import './ats-form.css'
import './portals.css'
import { parsePortalUrl, buildPortalUrl } from '../finder/parsePortalUrl.mjs'

type SourceType = 'greenhouse' | 'ashby' | 'lever' | 'github-md'

type Source = {
  type: SourceType
  name: string
  config: Record<string, unknown>
  priority?: number
}

type Portals = { sources: Source[] }

type SourceRow = Source & {
  // UI-only — the URL the user sees. Reconstructed from {type, config}
  // on load via buildPortalUrl, and parsed back via parsePortalUrl on save.
  _url: string
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'invalid_url'; error: string }
  | { kind: 'testing' }
  | { kind: 'ok'; type: SourceType; count: number; sample_titles: string[]; duration_ms: number }
  | { kind: 'error'; type?: SourceType; error: string; duration_ms?: number }

type TestResponse = {
  ok: boolean
  type?: SourceType
  config?: Record<string, unknown>
  count?: number
  sample_titles?: string[]
  error?: string
  duration_ms?: number
}

const DEBOUNCE_MS = 600

function urlFor(source: Source): string {
  return buildPortalUrl(source.type, source.config) ?? ''
}

function rowFromSource(s: Source): SourceRow {
  return { ...s, _url: urlFor(s) }
}

function sourceFromRow(r: SourceRow): { source: Source | null; error: string | null } {
  const parsed = parsePortalUrl(r._url)
  if ('error' in parsed) return { source: null, error: parsed.error }
  return {
    source: {
      type: parsed.type as SourceType,
      name: r.name.trim(),
      config: parsed.config,
      priority: r.priority,
    },
    error: null,
  }
}

export default function Portals() {
  const [rows, setRows] = useState<SourceRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [scanRunning, setScanRunning] = useState(false)
  const [scanMsg, setScanMsg] = useState<string | null>(null)
  const [testStates, setTestStates] = useState<Record<number, TestState>>({})
  const debounceTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({})
  const abortControllers = useRef<Record<number, AbortController>>({})

  // ── load ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    fetch('/api/career/finder/portals')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        const sources = Array.isArray(d.sources) ? d.sources : []
        setRows(sources.map(rowFromSource))
        setLoaded(true)
      })
      .catch((e) => {
        if (cancelled) return
        setServerError(e instanceof Error ? e.message : 'Network error')
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Cleanup pending timers + aborts on unmount
  useEffect(() => {
    const timers = debounceTimers.current
    const controllers = abortControllers.current
    return () => {
      Object.values(timers).forEach((t) => clearTimeout(t))
      Object.values(controllers).forEach((c) => c.abort())
    }
  }, [])

  useEffect(() => {
    function h(e: BeforeUnloadEvent) {
      if (dirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  // ── per-row validation summary ───────────────────────────────────────
  const rowErrors = useMemo(() => {
    const out: Record<number, string> = {}
    rows.forEach((r, i) => {
      if (!r.name.trim()) {
        out[i] = 'Name required'
        return
      }
      const parsed = parsePortalUrl(r._url)
      if ('error' in parsed) out[i] = parsed.error
    })
    return out
  }, [rows])

  const canSave =
    !saving &&
    Object.keys(rowErrors).length === 0 &&
    rows.every((_, i) => {
      const t = testStates[i]
      // Allow save when row hasn't been tested (e.g. loaded from disk and
      // unchanged) OR the test came back ok. Block when test came back
      // invalid_url / error.
      return !t || t.kind === 'idle' || t.kind === 'ok'
    })

  // ── mutators ─────────────────────────────────────────────────────────
  function setRow(i: number, patch: Partial<SourceRow>) {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)))
    setDirty(true)
    setSavedAt(null)
  }

  function changeUrl(i: number, newUrl: string) {
    setRow(i, { _url: newUrl })
    // Reset prior test state immediately so stale ✓ doesn't linger
    setTestStates((prev) => ({ ...prev, [i]: { kind: 'idle' } }))
    if (debounceTimers.current[i]) clearTimeout(debounceTimers.current[i])
    if (abortControllers.current[i]) abortControllers.current[i].abort()

    // Fast-path: validate URL format synchronously — no need to wait
    // 600ms to tell user "Not a valid URL".
    if (newUrl.trim() === '') {
      // Empty → idle (Save will catch via rowErrors)
      return
    }
    const parsed = parsePortalUrl(newUrl)
    if ('error' in parsed) {
      setTestStates((prev) => ({ ...prev, [i]: { kind: 'invalid_url', error: parsed.error } }))
      return
    }

    // URL parses — debounce the actual test fetch.
    debounceTimers.current[i] = setTimeout(() => {
      void runTest(i, newUrl)
    }, DEBOUNCE_MS)
  }

  async function runTest(i: number, url: string) {
    const ctrl = new AbortController()
    abortControllers.current[i] = ctrl
    setTestStates((prev) => ({ ...prev, [i]: { kind: 'testing' } }))
    try {
      const r = await fetch(
        `/api/career/finder/portals/test?url=${encodeURIComponent(url)}`,
        { signal: ctrl.signal },
      )
      const body = (await r.json().catch(() => ({}))) as TestResponse
      if (body.ok) {
        setTestStates((prev) => ({
          ...prev,
          [i]: {
            kind: 'ok',
            type: body.type!,
            count: body.count ?? 0,
            sample_titles: body.sample_titles ?? [],
            duration_ms: body.duration_ms ?? 0,
          },
        }))
      } else {
        setTestStates((prev) => ({
          ...prev,
          [i]: {
            kind: 'error',
            type: body.type,
            error: body.error || `HTTP ${r.status}`,
            duration_ms: body.duration_ms,
          },
        }))
      }
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return
      setTestStates((prev) => ({
        ...prev,
        [i]: { kind: 'error', error: e instanceof Error ? e.message : 'Network error' },
      }))
    }
  }

  function addSource() {
    setRows((prev) => [
      ...prev,
      { type: 'greenhouse', name: '', config: { slug: '' }, priority: 2, _url: '' },
    ])
    setDirty(true)
    setSavedAt(null)
  }
  function removeSource(i: number) {
    setRows((prev) => prev.filter((_, j) => j !== i))
    setTestStates((prev) => {
      const next = { ...prev }
      delete next[i]
      return next
    })
    setDirty(true)
    setSavedAt(null)
  }

  function testNow(i: number) {
    const url = rows[i]?._url
    if (url) void runTest(i, url)
  }

  // ── save ─────────────────────────────────────────────────────────────
  async function save() {
    setSaving(true)
    setServerError(null)
    try {
      // Convert rows → sources via parsePortalUrl.
      const sources: Source[] = []
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]
        const { source, error } = sourceFromRow(r)
        if (error) {
          setServerError(`Row ${i + 1}: ${error}`)
          setSaving(false)
          return
        }
        if (source) sources.push(source)
      }
      const r = await fetch('/api/career/finder/portals', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        setServerError((j as { error?: string }).error || `HTTP ${r.status}`)
        return
      }
      setDirty(false)
      setSavedAt(new Date().toLocaleTimeString())
    } catch (e) {
      setServerError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setSaving(false)
    }
  }

  async function runScan() {
    setScanMsg(null)
    setScanRunning(true)
    try {
      const r = await fetch('/api/career/finder/scan', { method: 'POST' })
      const j = (await r.json().catch(() => ({}))) as { scan_id?: string; started_at?: string; error?: string }
      if (r.status === 202) {
        setScanMsg(`Scan started (id: ${(j.scan_id || '').slice(0, 8)}…)`)
      } else if (r.status === 409) {
        setScanMsg(`Scan already running (started ${j.started_at})`)
      } else {
        setScanMsg(`Error: ${j.error || r.status}`)
      }
    } catch (e) {
      setScanMsg(`Network error: ${e instanceof Error ? e.message : ''}`)
    } finally {
      setScanRunning(false)
    }
  }

  if (!loaded) return <div className="af-loading">Loading portals…</div>

  return (
    <form
      className="af-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (canSave && dirty) save()
      }}
    >
      <div className="af-form-header">
        <h2 className="af-form-title">Portals — 扫哪些公司</h2>
        <p className="af-form-subtitle">
          每行配置一个招聘看板. 粘公司 careers 页面跳转后的 URL (boards.greenhouse.io / jobs.ashbyhq.com /
          jobs.lever.co / github.com), 系统自动识别 ATS 类型 + 试拉一下确认能用. 保存后下次 scan 即生效.
        </p>
      </div>

      <section className="af-section">
        <div className="c-portals-toolbar">
          <button type="button" className="af-btn-add" onClick={addSource}>
            <Plus size={14} /> Add source
          </button>
          <button
            type="button"
            className="af-btn-add"
            onClick={runScan}
            disabled={scanRunning || dirty}
            title={dirty ? 'Save changes first' : ''}
          >
            <RefreshCw size={14} className={scanRunning ? 'c-portals-spin' : ''} />
            Run scan now
          </button>
          {scanMsg && <span className="c-portals-scan-msg">{scanMsg}</span>}
        </div>

        {rows.length === 0 && (
          <p className="c-portals-empty">No sources configured. Click "Add source" to start.</p>
        )}

        <div className="c-portals-rows">
          {rows.map((r, i) => (
            <PortalRow
              key={i}
              row={r}
              index={i}
              error={rowErrors[i]}
              testState={testStates[i]}
              onChangeUrl={(u) => changeUrl(i, u)}
              onChangeName={(n) => setRow(i, { name: n })}
              onChangePriority={(p) => setRow(i, { priority: p })}
              onTestNow={() => testNow(i)}
              onDelete={() => removeSource(i)}
            />
          ))}
        </div>
      </section>

      <div className="af-submit-bar">
        <button type="submit" className="af-submit-btn" disabled={!canSave || !dirty}>
          {saving ? 'Saving…' : dirty ? 'Save Portals' : 'Saved'}
        </button>
        {savedAt && !dirty && <span className="af-saved-at">Saved at {savedAt}</span>}
        {serverError && <span className="af-server-err">{serverError}</span>}
      </div>
    </form>
  )
}

// ─── Per-row component ────────────────────────────────────────────────

function PortalRow({
  row,
  index,
  error,
  testState,
  onChangeUrl,
  onChangeName,
  onChangePriority,
  onTestNow,
  onDelete,
}: {
  row: SourceRow
  index: number
  error?: string
  testState?: TestState
  onChangeUrl: (u: string) => void
  onChangeName: (n: string) => void
  onChangePriority: (p: number | undefined) => void
  onTestNow: () => void
  onDelete: () => void
}) {
  return (
    <div className={`c-portals-row-v2${error ? ' c-portals-row-v2-error' : ''}`}>
      <div className="c-portals-row-v2-head">
        <div className="c-portals-row-v2-name">
          <label>Name</label>
          <input
            className={`af-input${!row.name.trim() ? ' af-input-error' : ''}`}
            placeholder="Anthropic"
            value={row.name}
            onChange={(e) => onChangeName(e.target.value)}
          />
        </div>
        <div className="c-portals-row-v2-priority">
          <label>Pri</label>
          <input
            className="af-input"
            type="number"
            min={1}
            max={10}
            value={row.priority ?? ''}
            onChange={(e) => onChangePriority(e.target.value ? Number(e.target.value) : undefined)}
          />
        </div>
        <button
          type="button"
          className="c-portals-row-delete"
          onClick={onDelete}
          aria-label="Delete source"
          title={`Delete row ${index + 1}`}
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="c-portals-row-v2-url">
        <label>URL</label>
        <div className="c-portals-row-v2-url-input">
          <input
            className={`af-input${error && row._url.trim() ? ' af-input-error' : ''}`}
            type="url"
            placeholder="https://boards.greenhouse.io/anthropic"
            value={row._url}
            onChange={(e) => onChangeUrl(e.target.value)}
          />
          <button
            type="button"
            className="af-btn-add c-portals-test-btn"
            onClick={onTestNow}
            disabled={!row._url.trim() || testState?.kind === 'testing'}
            title="Test fetch this URL right now"
          >
            {testState?.kind === 'testing' ? (
              <>
                <Loader size={13} className="c-portals-spin" /> Testing…
              </>
            ) : (
              <>Test</>
            )}
          </button>
        </div>
        <TestBadge state={testState} />
      </div>
    </div>
  )
}

function TestBadge({ state }: { state?: TestState }) {
  if (!state || state.kind === 'idle') return null
  if (state.kind === 'invalid_url') {
    return (
      <div className="c-portals-test-result c-portals-test-result-bad">
        <XCircle size={13} />
        <span>{state.error}</span>
      </div>
    )
  }
  if (state.kind === 'testing') {
    return (
      <div className="c-portals-test-result c-portals-test-result-loading">
        <Loader size={13} className="c-portals-spin" />
        <span>Testing fetch…</span>
      </div>
    )
  }
  if (state.kind === 'error') {
    return (
      <div className="c-portals-test-result c-portals-test-result-bad">
        <XCircle size={13} />
        <div>
          <div>
            {state.type ? `${state.type} · ` : ''}fetch failed: {state.error}
          </div>
          {typeof state.duration_ms === 'number' && (
            <div className="c-portals-test-meta">{state.duration_ms}ms</div>
          )}
        </div>
      </div>
    )
  }
  // ok
  return (
    <div className="c-portals-test-result c-portals-test-result-ok">
      <CheckCircle2 size={13} />
      <div>
        <div>
          <strong>{state.type}</strong> · {state.count} jobs · {state.duration_ms}ms
        </div>
        {state.sample_titles.length > 0 && (
          <div className="c-portals-test-meta">
            sample: {state.sample_titles.slice(0, 3).join(' · ')}
          </div>
        )}
      </div>
    </div>
  )
}
