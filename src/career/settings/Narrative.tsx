import { useEffect, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import ReactMarkdown from 'react-markdown'
import './ats-form.css'

export default function Narrative() {
  const [content, setContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/career/narrative')
      .then(r => r.json())
      .then(data => { setContent(data?.content ?? ''); setLoaded(true) })
      .catch(() => setLoaded(true))
  }, [])

  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  function onChange(v: string) {
    setContent(v)
    setDirty(true)
    setSavedAt(null)
  }

  async function save() {
    setSaving(true); setServerError(null)
    try {
      const r = await fetch('/api/career/narrative', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
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

  if (!loaded) return <div className="af-loading">Loading narrative…</div>

  return (
    <form className="af-form narrative-form" onSubmit={e => { e.preventDefault(); if (dirty && !saving) save() }}>
      <div className="af-form-header">
        <h2 className="af-form-title">Narrative</h2>
        <p className="af-form-subtitle">
          你的人设 / north star / 写作风格 — Applier 起草开放题、Evaluator Stage B 评估匹配度都读。
          骨架 H2 段名是和下游模块的软契约：删段名前确认下游不依赖。
        </p>
      </div>

      <div className="narrative-split">
        <div className="narrative-editor-pane">
          <CodeMirror
            value={content}
            onChange={onChange}
            extensions={[markdown()]}
            theme="light"
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: true,
            }}
            style={{ height: '100%', fontSize: 14 }}
          />
        </div>
        <div className="narrative-preview-pane">
          <ReactMarkdown>{content}</ReactMarkdown>
        </div>
      </div>

      <div className="af-submit-bar">
        <span className={`af-submit-status${dirty ? ' af-submit-dirty' : savedAt ? ' af-submit-saved' : ''}`}>
          {saving ? 'Saving…' :
           serverError ? `Error: ${serverError}` :
           dirty ? 'Unsaved changes' :
           savedAt ? `✓ Saved at ${savedAt}` :
           'Ready'}
        </span>
        <button type="submit" className="af-btn-primary" disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save Narrative'}
        </button>
      </div>
    </form>
  )
}
