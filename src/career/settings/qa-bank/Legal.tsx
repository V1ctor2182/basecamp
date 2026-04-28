import { useEffect, useMemo, useState } from 'react'
import { deepMerge } from '../../utils'
import '../ats-form.css'

type Legal = {
  work_authorization: {
    status?: string
    expiration?: string
    requires_sponsorship_now?: boolean
    requires_sponsorship_future?: boolean
    authorized_us_yes_no?: boolean
    citizenship?: string
  }
  eeo: {
    gender?: string
    ethnicity?: string
    veteran?: string
    disability?: string
    pronouns?: string
  }
  personal: {
    age_18_plus?: boolean
    criminal_record?: boolean
    can_pass_background_check?: boolean
    can_pass_drug_test?: boolean
    relocate_willing?: boolean
    travel_willing_percent?: number
  }
  how_did_you_hear_default?: string
}

const BLANK_LEGAL: Legal = {
  work_authorization: {},
  eeo: {},
  personal: {},
  how_did_you_hear_default: '',
}

// EEO dropdowns intentionally include "Decline to answer" — recommended for
// most US ATS forms (legal-safe; reduces discrimination signal).
const EEO_OPTIONS = {
  gender: ['Decline to answer', 'Male', 'Female', 'Non-binary', 'Other'],
  ethnicity: [
    'Decline to answer',
    'Asian',
    'Black or African American',
    'Hispanic or Latino',
    'Native American or Alaska Native',
    'Native Hawaiian or Pacific Islander',
    'White',
    'Two or more races',
    'Other',
  ],
  veteran: [
    'I am not a veteran',
    'I am a veteran',
    'Decline to answer',
  ],
  disability: [
    'Decline to answer',
    'No, I do not have a disability',
    'Yes, I have a disability',
  ],
  pronouns: ['Decline to answer', 'he/him', 'she/her', 'they/them', 'Other'],
}

type ValidationResult = {
  missing: Record<string, true>
  malformed: Record<string, string>
}

function validate(l: Legal): ValidationResult {
  const missing: Record<string, true> = {}
  const malformed: Record<string, string> = {}
  const tw = l.personal.travel_willing_percent
  if (tw !== undefined && (!isFinite(tw) || tw < 0 || tw > 100)) {
    malformed['personal.travel_willing_percent'] = 'Must be 0–100'
  }
  return { missing, malformed }
}

export default function Legal() {
  const [legal, setLegal] = useState<Legal>(BLANK_LEGAL)
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)

  const { missing, malformed } = useMemo(() => validate(legal), [legal])
  const malformedCount = Object.keys(malformed).length
  const canSave = malformedCount === 0

  useEffect(() => {
    fetch('/api/career/qa-bank/legal')
      .then(r => r.json())
      .then(data => { if (data) setLegal(deepMerge(BLANK_LEGAL, data)); setLoaded(true) })
      .catch(() => setLoaded(true))
  }, [])

  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  function patch<K extends keyof Legal>(key: K, value: Legal[K]) {
    setLegal(prev => ({ ...prev, [key]: value }))
    setDirty(true)
    setSavedAt(null)
  }

  async function save() {
    setSaving(true); setServerError(null)
    try {
      const r = await fetch('/api/career/qa-bank/legal', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(legal),
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

  if (!loaded) return <div className="af-loading">Loading legal answers…</div>

  const showErr = (key: string) => malformed[key]
  const showBad = (key: string) => Boolean(malformed[key])

  return (
    <form className="af-form" onSubmit={e => { e.preventDefault(); if (canSave && dirty) save() }}>
      <div className="af-form-header">
        <h2 className="af-form-title">Legal Answers</h2>
        <p className="af-form-subtitle">
          法律 / EEO / visa 固定答案 — Applier Class 2 Legal 直接读，纯查表不走 LLM。
          答案 100% 一致。本文件 gitignored — 内容不进 git。
        </p>
      </div>

      {/* Section 1: Work Authorization */}
      <section className="af-section">
        <h3 className="af-section-title">Work Authorization</h3>
        <p className="af-section-desc">visa 状态 + sponsorship。所有 ATS 法律必填。</p>

        <div className="af-field-row">
          <Field label="Status">
            <input className="af-input" placeholder="F-1 OPT / H1B / GC / US Citizen / ..."
              value={legal.work_authorization.status ?? ''}
              onChange={e => patch('work_authorization', { ...legal.work_authorization, status: e.target.value })} />
          </Field>
          <Field label="Visa Expiration">
            <input className="af-input" placeholder="YYYY-MM-DD"
              value={legal.work_authorization.expiration ?? ''}
              onChange={e => patch('work_authorization', { ...legal.work_authorization, expiration: e.target.value })} />
          </Field>
        </div>

        <Field label="Citizenship">
          <input className="af-input" placeholder="China (PRC) / United States / ..."
            value={legal.work_authorization.citizenship ?? ''}
            onChange={e => patch('work_authorization', { ...legal.work_authorization, citizenship: e.target.value })} />
        </Field>

        <BoolRadio label="Authorized to work in the US?"
          value={legal.work_authorization.authorized_us_yes_no}
          onChange={v => patch('work_authorization', { ...legal.work_authorization, authorized_us_yes_no: v })} />

        <BoolRadio label="Do you currently require visa sponsorship?"
          value={legal.work_authorization.requires_sponsorship_now}
          onChange={v => patch('work_authorization', { ...legal.work_authorization, requires_sponsorship_now: v })} />

        <BoolRadio label="Will you require visa sponsorship in the future?"
          value={legal.work_authorization.requires_sponsorship_future}
          onChange={v => patch('work_authorization', { ...legal.work_authorization, requires_sponsorship_future: v })} />
      </section>

      {/* Section 2: EEO */}
      <section className="af-section">
        <h3 className="af-section-title">EEO (Equal Employment Opportunity)</h3>
        <p className="af-section-desc">推荐全部 "Decline to answer" — 法律允许，避免歧视风险。</p>

        <div className="af-field-row">
          <Field label="Gender">
            <select className="af-select" value={legal.eeo.gender ?? ''}
              onChange={e => patch('eeo', { ...legal.eeo, gender: e.target.value })}>
              <option value="">—</option>
              {EEO_OPTIONS.gender.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
          <Field label="Ethnicity">
            <select className="af-select" value={legal.eeo.ethnicity ?? ''}
              onChange={e => patch('eeo', { ...legal.eeo, ethnicity: e.target.value })}>
              <option value="">—</option>
              {EEO_OPTIONS.ethnicity.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
        </div>

        <div className="af-field-row">
          <Field label="Veteran Status">
            <select className="af-select" value={legal.eeo.veteran ?? ''}
              onChange={e => patch('eeo', { ...legal.eeo, veteran: e.target.value })}>
              <option value="">—</option>
              {EEO_OPTIONS.veteran.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
          <Field label="Disability">
            <select className="af-select" value={legal.eeo.disability ?? ''}
              onChange={e => patch('eeo', { ...legal.eeo, disability: e.target.value })}>
              <option value="">—</option>
              {EEO_OPTIONS.disability.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
        </div>

        <Field label="Pronouns">
          <select className="af-select" value={legal.eeo.pronouns ?? ''}
            onChange={e => patch('eeo', { ...legal.eeo, pronouns: e.target.value })}>
            <option value="">—</option>
            {EEO_OPTIONS.pronouns.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
      </section>

      {/* Section 3: Personal */}
      <section className="af-section">
        <h3 className="af-section-title">Personal</h3>
        <p className="af-section-desc">通用筛选问题 + travel/relocate 意愿。</p>

        <BoolRadio label="Are you 18 or older?"
          value={legal.personal.age_18_plus}
          onChange={v => patch('personal', { ...legal.personal, age_18_plus: v })} />

        <BoolRadio label="Do you have a criminal record?"
          value={legal.personal.criminal_record}
          onChange={v => patch('personal', { ...legal.personal, criminal_record: v })} />

        <BoolRadio label="Can you pass a background check?"
          value={legal.personal.can_pass_background_check}
          onChange={v => patch('personal', { ...legal.personal, can_pass_background_check: v })} />

        <BoolRadio label="Can you pass a drug test?"
          value={legal.personal.can_pass_drug_test}
          onChange={v => patch('personal', { ...legal.personal, can_pass_drug_test: v })} />

        <BoolRadio label="Willing to relocate?"
          value={legal.personal.relocate_willing}
          onChange={v => patch('personal', { ...legal.personal, relocate_willing: v })} />

        <Field label="Travel willingness (% of time)" error={showErr('personal.travel_willing_percent')}>
          <input type="number" min={0} max={100} step={5}
            className={`af-input af-input-number${showBad('personal.travel_willing_percent') ? ' af-input-error' : ''}`}
            placeholder="25"
            value={legal.personal.travel_willing_percent ?? ''}
            onChange={e => patch('personal', {
              ...legal.personal,
              travel_willing_percent: e.target.value === '' ? undefined : Number(e.target.value),
            })} />
        </Field>
      </section>

      {/* Section 4: How did you hear */}
      <section className="af-section">
        <h3 className="af-section-title">How did you hear about us?</h3>
        <p className="af-section-desc">默认答案。可在 apply 时按公司 override。</p>

        <Field label="Default answer">
          <input className="af-input" placeholder="LinkedIn job posting"
            value={legal.how_did_you_hear_default ?? ''}
            onChange={e => patch('how_did_you_hear_default', e.target.value)} />
        </Field>
      </section>

      <div className="af-submit-bar">
        <span className={`af-submit-status${dirty ? ' af-submit-dirty' : savedAt ? ' af-submit-saved' : ''}`}>
          {saving ? 'Saving…' :
           serverError ? `Error: ${serverError}` :
           dirty ? (
             malformedCount > 0
               ? `${malformedCount} format error${malformedCount > 1 ? 's' : ''} — fix to save`
               : 'Unsaved changes · ready to save'
           ) :
           savedAt ? `✓ Saved at ${savedAt}` :
           'Ready'}
        </span>
        <button type="submit" className="af-btn-primary" disabled={!canSave || saving || !dirty}>
          {saving ? 'Saving…' : 'Save Legal'}
        </button>
      </div>
    </form>
  )
}

function Field({ label, error, children }: {
  label: string; error?: string; children: React.ReactNode
}) {
  return (
    <div className="af-field">
      <label className="af-label">{label}</label>
      {children}
      {error && <span className="af-error">{error}</span>}
    </div>
  )
}

function BoolRadio({ label, value, onChange }: {
  label: string; value: boolean | undefined; onChange: (v: boolean) => void
}) {
  return (
    <div className="af-field">
      <label className="af-label">{label}</label>
      <div className="af-radio-group">
        <label className="af-radio-label">
          <input type="radio" checked={value === true} onChange={() => onChange(true)} /> Yes
        </label>
        <label className="af-radio-label">
          <input type="radio" checked={value === false} onChange={() => onChange(false)} /> No
        </label>
      </div>
    </div>
  )
}
