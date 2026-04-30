import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import './ats-form.css'
import './portals.css'

type SourceType = 'greenhouse' | 'ashby' | 'lever' | 'github-md' | 'scrape' | 'rss' | 'manual'

const FETCHABLE_TYPES: SourceType[] = ['greenhouse', 'ashby', 'lever', 'github-md']

type Source = {
  type: SourceType
  name: string
  config: Record<string, unknown>
  priority?: number
}

type Portals = { sources: Source[] }

const BLANK_SOURCE: Source = {
  type: 'greenhouse',
  name: '',
  config: { slug: '' },
  priority: 2,
}

function blankConfigFor(type: SourceType): Record<string, unknown> {
  switch (type) {
    case 'greenhouse':
    case 'ashby':
    case 'lever':
      return { slug: '' }
    case 'github-md':
      return { owner: '', repo: '', path: 'README.md', branch: 'main' }
    default:
      return {}
  }
}

function configKeysFor(type: SourceType): string[] {
  switch (type) {
    case 'greenhouse':
    case 'ashby':
    case 'lever':
      return ['slug']
    case 'github-md':
      return ['owner', 'repo', 'path', 'branch']
    default:
      return []
  }
}

export default function Portals() {
  const [data, setData] = useState<Portals>({ sources: [] })
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [scanRunning, setScanRunning] = useState(false)
  const [scanMsg, setScanMsg] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/career/finder/portals')
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        setData({ sources: Array.isArray(d.sources) ? d.sources : [] })
        setLoaded(true)
      })
      .catch(e => {
        if (cancelled) return
        setServerError(e instanceof Error ? e.message : 'Network error')
        setLoaded(true)
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    function h(e: BeforeUnloadEvent) {
      if (dirty) { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  const malformed = useMemo(() => {
    const errs: Record<number, string> = {}
    data.sources.forEach((s, i) => {
      if (!s.name.trim()) errs[i] = 'Name required'
      else if (FETCHABLE_TYPES.includes(s.type)) {
        const keys = configKeysFor(s.type)
        const missing = keys.filter(k => k === 'path' || k === 'branch'
          ? false
          : !String((s.config as any)[k] ?? '').trim())
        if (missing.length) errs[i] = `Config missing: ${missing.join(', ')}`
      }
    })
    return errs
  }, [data.sources])

  const canSave = !saving && Object.keys(malformed).length === 0

  function updateSource(i: number, patch: Partial<Source>) {
    setData(prev => ({
      sources: prev.sources.map((s, j) => j === i ? { ...s, ...patch } : s)
    }))
    setDirty(true); setSavedAt(null)
  }
  function updateConfig(i: number, key: string, value: string) {
    setData(prev => ({
      sources: prev.sources.map((s, j) =>
        j === i ? { ...s, config: { ...s.config, [key]: value } } : s
      )
    }))
    setDirty(true); setSavedAt(null)
  }
  function changeType(i: number, newType: SourceType) {
    setData(prev => ({
      sources: prev.sources.map((s, j) =>
        j === i ? { ...s, type: newType, config: blankConfigFor(newType) } : s
      )
    }))
    setDirty(true); setSavedAt(null)
  }
  function addSource() {
    setData(prev => ({ sources: [...prev.sources, { ...BLANK_SOURCE, config: { ...BLANK_SOURCE.config } }] }))
    setDirty(true); setSavedAt(null)
  }
  function removeSource(i: number) {
    setData(prev => ({ sources: prev.sources.filter((_, j) => j !== i) }))
    setDirty(true); setSavedAt(null)
  }

  async function save() {
    setSaving(true); setServerError(null)
    try {
      const r = await fetch('/api/career/finder/portals', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        setServerError(j.error || `HTTP ${r.status}`)
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
    setScanMsg(null); setScanRunning(true)
    try {
      const r = await fetch('/api/career/finder/scan', { method: 'POST' })
      const j = await r.json().catch(() => ({}))
      if (r.status === 202) {
        setScanMsg(`Scan started (id: ${j.scan_id?.slice(0, 8)}…)`)
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
    <form className="af-form" onSubmit={e => { e.preventDefault(); if (canSave && dirty) save() }}>
      <div className="af-form-header">
        <h2 className="af-form-title">Portals — 扫哪些公司</h2>
        <p className="af-form-subtitle">
          配置 Finder 数据源。ATS 类型 (Greenhouse / Ashby / Lever) 用 board slug；
          GitHub 社区 repo 用 owner / repo / path / branch。保存后下次 scan 即生效。
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
            Run scan now
          </button>
          {scanMsg && <span className="c-portals-scan-msg">{scanMsg}</span>}
        </div>

        {data.sources.length === 0 && (
          <p className="c-portals-empty">No sources configured. Click "Add source" to start.</p>
        )}

        <div className="c-portals-rows">
          {data.sources.map((s, i) => (
            <div key={i} className={`c-portals-row${malformed[i] ? ' c-portals-row-error' : ''}`}>
              <div className="c-portals-cell c-portals-cell-type">
                <label>Type</label>
                <select
                  className="af-input"
                  value={s.type}
                  onChange={e => changeType(i, e.target.value as SourceType)}
                >
                  <option value="greenhouse">greenhouse</option>
                  <option value="ashby">ashby</option>
                  <option value="lever">lever</option>
                  <option value="github-md">github-md</option>
                </select>
              </div>

              <div className="c-portals-cell c-portals-cell-name">
                <label>Name</label>
                <input
                  className={`af-input${!s.name.trim() ? ' af-input-error' : ''}`}
                  placeholder={s.type === 'github-md' ? 'SimplifyJobs New Grad' : 'Anthropic'}
                  value={s.name}
                  onChange={e => updateSource(i, { name: e.target.value })}
                />
              </div>

              <div className="c-portals-cell c-portals-cell-config">
                <label>Config</label>
                <div className="c-portals-config-fields">
                  {configKeysFor(s.type).map(k => (
                    <input
                      key={k}
                      className="af-input"
                      placeholder={k}
                      value={String((s.config as any)[k] ?? '')}
                      onChange={e => updateConfig(i, k, e.target.value)}
                    />
                  ))}
                </div>
              </div>

              <div className="c-portals-cell c-portals-cell-priority">
                <label>Pri</label>
                <input
                  className="af-input"
                  type="number" min={1} max={10}
                  value={s.priority ?? ''}
                  onChange={e => updateSource(i, { priority: e.target.value ? Number(e.target.value) : undefined })}
                />
              </div>

              <button
                type="button"
                className="c-portals-row-delete"
                onClick={() => removeSource(i)}
                aria-label="Delete source"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>

        {Object.entries(malformed).map(([i, msg]) => (
          <p key={i} className="c-portals-row-err-msg">Row #{Number(i) + 1}: {msg}</p>
        ))}
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
