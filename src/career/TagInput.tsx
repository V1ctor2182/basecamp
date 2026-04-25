import { useState, KeyboardEvent } from 'react'
import { X } from 'lucide-react'

type Props = {
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  disabled?: boolean
}

// Bounds match server-side Zod (PreferencesSchema STR/STRS): 200 chars per tag,
// 200 tags per array. Stops paste-bomb / accidental huge content from reaching
// the API where Zod would reject the whole save.
const MAX_TAG_LEN = 200
const MAX_TAGS = 200

export default function TagInput({ value, onChange, placeholder, disabled }: Props) {
  const [draft, setDraft] = useState('')

  function commit() {
    const v = draft.trim().slice(0, MAX_TAG_LEN)
    if (!v) return
    if (value.includes(v)) { setDraft(''); return }
    if (value.length >= MAX_TAGS) { setDraft(''); return }
    onChange([...value, v])
    setDraft('')
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',') {
      if (draft.trim()) { e.preventDefault(); commit() }
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1))
    }
  }

  function remove(i: number) {
    onChange(value.filter((_, j) => j !== i))
  }

  return (
    <div className={`af-tag-input${disabled ? ' af-tag-input-disabled' : ''}`}>
      {value.map((t, i) => (
        <span key={i} className="af-tag-pill">
          <span className="af-tag-text">{t}</span>
          {!disabled && (
            <button type="button" className="af-tag-remove" onClick={() => remove(i)} aria-label={`Remove ${t}`}>
              <X size={11} />
            </button>
          )}
        </span>
      ))}
      <input
        type="text"
        className="af-tag-input-field"
        value={draft}
        disabled={disabled}
        maxLength={MAX_TAG_LEN}
        placeholder={value.length === 0 ? placeholder : ''}
        onChange={e => setDraft(e.target.value.slice(0, MAX_TAG_LEN))}
        onKeyDown={onKey}
        onBlur={commit}
      />
    </div>
  )
}
