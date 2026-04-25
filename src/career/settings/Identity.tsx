import { useEffect, useMemo, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { deepMerge } from '../utils'
import './ats-form.css'

type EducationEntry = { school: string; degree: string; graduation: string; gpa?: string }
type LanguageEntry = { lang: string; level: 'Native' | 'Fluent' | 'Conversational' | 'Basic' }
type Identity = {
  name: string
  email: string
  phone: string
  links: { linkedin: string; github: string; portfolio: string }
  location: { current_city: string; current_country: string }
  legal: {
    visa_status: string
    visa_expiration: string
    needs_sponsorship_now: boolean
    needs_sponsorship_future: boolean
    authorized_us_yes_no: boolean
    citizenship: string
  }
  education: EducationEntry[]
  languages: LanguageEntry[]
}

const BLANK_IDENTITY: Identity = {
  name: '', email: '', phone: '',
  links: { linkedin: '', github: '', portfolio: '' },
  location: { current_city: '', current_country: '' },
  legal: {
    visa_status: '', visa_expiration: '',
    needs_sponsorship_now: false, needs_sponsorship_future: false,
    authorized_us_yes_no: true, citizenship: '',
  },
  education: [{ school: '', degree: '', graduation: '', gpa: '' }],
  languages: [{ lang: '', level: 'Native' }],
}

function isUrl(s: string) {
  try { new URL(s); return true } catch { return false }
}
function isEmail(s: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) }

// Split validation: missing required (doesn't block save) vs malformed (blocks save).
// m3: allow partial save — user fills one section at a time, saves between.
type ValidationResult = {
  missing: Record<string, true>        // empty but required (red * stays, doesn't block save)
  malformed: Record<string, string>    // bad format (red border + blocks save)
}

function validate(id: Identity): ValidationResult {
  const missing: Record<string, true> = {}
  const malformed: Record<string, string> = {}

  if (!id.name.trim()) missing.name = true
  if (!id.email.trim()) missing.email = true
  else if (!isEmail(id.email)) malformed.email = 'Invalid email'
  if (!id.phone.trim()) missing.phone = true

  if (!id.links.linkedin) missing['links.linkedin'] = true
  else if (!isUrl(id.links.linkedin)) malformed['links.linkedin'] = 'Must be a valid URL'
  if (!id.links.github) missing['links.github'] = true
  else if (!isUrl(id.links.github)) malformed['links.github'] = 'Must be a valid URL'
  if (!id.links.portfolio) missing['links.portfolio'] = true
  else if (!isUrl(id.links.portfolio)) malformed['links.portfolio'] = 'Must be a valid URL'

  if (!id.location.current_city.trim()) missing['location.current_city'] = true
  if (!id.location.current_country.trim()) missing['location.current_country'] = true
  if (!id.legal.visa_status.trim()) missing['legal.visa_status'] = true
  if (!id.legal.visa_expiration.trim()) missing['legal.visa_expiration'] = true
  if (!id.legal.citizenship.trim()) missing['legal.citizenship'] = true

  id.education.forEach((row, i) => {
    if (!row.school.trim()) missing[`education.${i}.school`] = true
    if (!row.degree.trim()) missing[`education.${i}.degree`] = true
    if (!row.graduation.trim()) missing[`education.${i}.graduation`] = true
  })
  id.languages.forEach((row, i) => {
    if (!row.lang.trim()) missing[`languages.${i}.lang`] = true
  })
  return { missing, malformed }
}

export default function Identity() {
  const [identity, setIdentity] = useState<Identity>(BLANK_IDENTITY)
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)

  const { missing, malformed } = useMemo(() => validate(identity), [identity])
  const missingCount = Object.keys(missing).length
  const malformedCount = Object.keys(malformed).length
  const canSave = malformedCount === 0    // missing 不阻塞 save (m3 partial-save)
  const isComplete = missingCount === 0 && malformedCount === 0

  // Load on mount
  useEffect(() => {
    fetch('/api/career/identity')
      .then(r => r.json())
      .then(data => { if (data) setIdentity(deepMerge(BLANK_IDENTITY, data)); setLoaded(true) })
      .catch(() => setLoaded(true))
  }, [])

  // Unsaved-changes prompt
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  function update<K extends keyof Identity>(key: K, value: Identity[K]) {
    setIdentity(prev => ({ ...prev, [key]: value }))
    setDirty(true)
    setSavedAt(null)
  }

  async function save() {
    setSaving(true); setServerError(null)
    try {
      const r = await fetch('/api/career/identity', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(identity),
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

  if (!loaded) return <div className="af-loading">Loading identity…</div>

  // Show inline error: malformed always (red border + message); missing only after
  // user has interacted (shown subtly — we still display red * on label but don't
  // fill the "error" slot until interaction to avoid first-load-all-red).
  const showErr = (key: string): string | undefined => {
    if (malformed[key]) return malformed[key]
    if ((dirty || savedAt !== null) && missing[key]) return 'Required'
    return undefined
  }
  // Red border only for malformed (hard errors). Missing uses subtle red *.
  const showBad = (key: string) => Boolean(malformed[key])

  return (
    <form className="af-form" onSubmit={e => { e.preventDefault(); if (canSave && dirty) save() }}>
      <div className="af-form-header">
        <h2 className="af-form-title">Identity</h2>
        <p className="af-form-subtitle">
          你是谁 — 填表用的稳定身份信息。Applier 从这里读取填 ATS 表单。identity.yml 文件本地保存，不进 git。
        </p>
      </div>

      {/* Section 1: Personal */}
      <section className="af-section">
        <h3 className="af-section-title">Personal Information</h3>
        <p className="af-section-desc">基本联系方式。所有 ATS 表单都会问。</p>

        <Field label="Full Name" required error={showErr('name')}>
          <input className={`af-input${showBad('name') ? ' af-input-error' : ''}`}
            placeholder="Chenyang Zhang" value={identity.name}
            onChange={e => update('name', e.target.value)} />
        </Field>

        <div className="af-field-row">
          <Field label="Email" required error={showErr('email')}>
            <input className={`af-input${showBad('email') ? ' af-input-error' : ''}`} type="email"
              placeholder="name@example.com" value={identity.email}
              onChange={e => update('email', e.target.value)} />
          </Field>
          <Field label="Phone" required error={showErr('phone')}>
            <input className={`af-input${showBad('phone') ? ' af-input-error' : ''}`} type="tel"
              placeholder="+1-555-555-5555" value={identity.phone}
              onChange={e => update('phone', e.target.value)} />
          </Field>
        </div>
      </section>

      {/* Section 2: Links */}
      <section className="af-section">
        <h3 className="af-section-title">Links</h3>
        <p className="af-section-desc">LinkedIn / GitHub / 个人网站 URL，ATS 常会单独问这 3 个字段。</p>

        <Field label="LinkedIn" required error={showErr('links.linkedin')}>
          <input className={`af-input${showBad('links.linkedin') ? ' af-input-error' : ''}`} type="url"
            placeholder="https://linkedin.com/in/your-handle" value={identity.links.linkedin}
            onChange={e => update('links', { ...identity.links, linkedin: e.target.value })} />
        </Field>
        <Field label="GitHub" required error={showErr('links.github')}>
          <input className={`af-input${showBad('links.github') ? ' af-input-error' : ''}`} type="url"
            placeholder="https://github.com/your-handle" value={identity.links.github}
            onChange={e => update('links', { ...identity.links, github: e.target.value })} />
        </Field>
        <Field label="Portfolio / Personal Website" required error={showErr('links.portfolio')}>
          <input className={`af-input${showBad('links.portfolio') ? ' af-input-error' : ''}`} type="url"
            placeholder="https://yourdomain.com" value={identity.links.portfolio}
            onChange={e => update('links', { ...identity.links, portfolio: e.target.value })} />
        </Field>
      </section>

      {/* Section 3: Location */}
      <section className="af-section">
        <h3 className="af-section-title">Location</h3>
        <p className="af-section-desc">当前地点。用于 ATS 默认地址字段 + Evaluator 地点匹配。</p>
        <div className="af-field-row">
          <Field label="Current City" required error={showErr('location.current_city')}>
            <input className={`af-input${showBad('location.current_city') ? ' af-input-error' : ''}`}
              placeholder="New York, NY" value={identity.location.current_city}
              onChange={e => update('location', { ...identity.location, current_city: e.target.value })} />
          </Field>
          <Field label="Current Country" required error={showErr('location.current_country')}>
            <input className={`af-input${showBad('location.current_country') ? ' af-input-error' : ''}`}
              placeholder="United States" value={identity.location.current_country}
              onChange={e => update('location', { ...identity.location, current_country: e.target.value })} />
          </Field>
        </div>
      </section>

      {/* Section 4: Work Authorization */}
      <section className="af-section">
        <h3 className="af-section-title">Work Authorization</h3>
        <p className="af-section-desc">
          visa 状态 + sponsorship 需求。ATS 法律必填；Applier 的 Legal classifier 直接读。
        </p>

        <div className="af-field-row">
          <Field label="Visa Status" required error={showErr('legal.visa_status')}>
            <input className={`af-input${showBad('legal.visa_status') ? ' af-input-error' : ''}`}
              placeholder="F-1 OPT / H1B / GC / US Citizen / ..." value={identity.legal.visa_status}
              onChange={e => update('legal', { ...identity.legal, visa_status: e.target.value })} />
          </Field>
          <Field label="Visa Expiration" required error={showErr('legal.visa_expiration')}>
            <input className={`af-input${showBad('legal.visa_expiration') ? ' af-input-error' : ''}`}
              placeholder="YYYY-MM-DD" value={identity.legal.visa_expiration}
              onChange={e => update('legal', { ...identity.legal, visa_expiration: e.target.value })} />
          </Field>
        </div>

        <Field label="Citizenship" required error={showErr('legal.citizenship')}>
          <input className={`af-input${showBad('legal.citizenship') ? ' af-input-error' : ''}`}
            placeholder="China (PRC) / United States / ..." value={identity.legal.citizenship}
            onChange={e => update('legal', { ...identity.legal, citizenship: e.target.value })} />
        </Field>

        <BoolRadio label="Authorized to work in the US?" required
          value={identity.legal.authorized_us_yes_no}
          onChange={v => update('legal', { ...identity.legal, authorized_us_yes_no: v })} />

        <BoolRadio label="Do you currently require visa sponsorship?" required
          value={identity.legal.needs_sponsorship_now}
          onChange={v => update('legal', { ...identity.legal, needs_sponsorship_now: v })} />

        <BoolRadio label="Will you require visa sponsorship in the future?" required
          value={identity.legal.needs_sponsorship_future}
          onChange={v => update('legal', { ...identity.legal, needs_sponsorship_future: v })} />
      </section>

      {/* Section 5: Education */}
      <section className="af-section">
        <h3 className="af-section-title">Education</h3>
        <p className="af-section-desc">按反时序排列（最近的在前）。至少填 1 条；GPA 可选。</p>
        <div className="af-rows">
          {identity.education.map((row, i) => (
            <div className="af-row" key={i}>
              <div className="af-row-header">
                <span className="af-row-index">Entry #{i + 1}</span>
                <button type="button" className="af-btn-remove"
                  disabled={identity.education.length === 1}
                  onClick={() => update('education', identity.education.filter((_, j) => j !== i))}>
                  <X size={12} /> Remove
                </button>
              </div>
              <Field label="School" required error={showErr(`education.${i}.school`)}>
                <input className={`af-input${showBad(`education.${i}.school`) ? ' af-input-error' : ''}`}
                  placeholder="Columbia University" value={row.school}
                  onChange={e => update('education', identity.education.map((r, j) => j === i ? { ...r, school: e.target.value } : r))} />
              </Field>
              <div className="af-field-row">
                <Field label="Degree" required error={showErr(`education.${i}.degree`)}>
                  <input className={`af-input${showBad(`education.${i}.degree`) ? ' af-input-error' : ''}`}
                    placeholder="MS Data Science" value={row.degree}
                    onChange={e => update('education', identity.education.map((r, j) => j === i ? { ...r, degree: e.target.value } : r))} />
                </Field>
                <Field label="Graduation" required error={showErr(`education.${i}.graduation`)}>
                  <input className={`af-input${showBad(`education.${i}.graduation`) ? ' af-input-error' : ''}`}
                    placeholder="2026" value={row.graduation}
                    onChange={e => update('education', identity.education.map((r, j) => j === i ? { ...r, graduation: e.target.value } : r))} />
                </Field>
              </div>
              <Field label="GPA">
                <input className="af-input"
                  placeholder="3.9 / 4.0 (optional)" value={row.gpa || ''}
                  onChange={e => update('education', identity.education.map((r, j) => j === i ? { ...r, gpa: e.target.value } : r))} />
              </Field>
            </div>
          ))}
        </div>
        <button type="button" className="af-btn-add"
          onClick={() => update('education', [...identity.education, { school: '', degree: '', graduation: '', gpa: '' }])}>
          <Plus size={14} /> Add Education
        </button>
      </section>

      {/* Section 6: Languages */}
      <section className="af-section">
        <h3 className="af-section-title">Languages</h3>
        <p className="af-section-desc">至少填 1 条（母语）。</p>
        <div className="af-rows">
          {identity.languages.map((row, i) => (
            <div className="af-row" key={i}>
              <div className="af-row-header">
                <span className="af-row-index">Entry #{i + 1}</span>
                <button type="button" className="af-btn-remove"
                  disabled={identity.languages.length === 1}
                  onClick={() => update('languages', identity.languages.filter((_, j) => j !== i))}>
                  <X size={12} /> Remove
                </button>
              </div>
              <div className="af-field-row">
                <Field label="Language" required error={showErr(`languages.${i}.lang`)}>
                  <input className={`af-input${showBad(`languages.${i}.lang`) ? ' af-input-error' : ''}`}
                    placeholder="English" value={row.lang}
                    onChange={e => update('languages', identity.languages.map((r, j) => j === i ? { ...r, lang: e.target.value } : r))} />
                </Field>
                <Field label="Level" required>
                  <select className="af-select" value={row.level}
                    onChange={e => update('languages', identity.languages.map((r, j) => j === i ? { ...r, level: e.target.value as LanguageEntry['level'] } : r))}>
                    <option value="Native">Native</option>
                    <option value="Fluent">Fluent</option>
                    <option value="Conversational">Conversational</option>
                    <option value="Basic">Basic</option>
                  </select>
                </Field>
              </div>
            </div>
          ))}
        </div>
        <button type="button" className="af-btn-add"
          onClick={() => update('languages', [...identity.languages, { lang: '', level: 'Native' }])}>
          <Plus size={14} /> Add Language
        </button>
      </section>

      {/* Submit bar */}
      <div className="af-submit-bar">
        <span className={`af-submit-status${dirty ? ' af-submit-dirty' : savedAt && isComplete ? ' af-submit-saved' : ''}`}>
          {saving ? 'Saving…' :
           serverError ? `Error: ${serverError}` :
           dirty ? (
             malformedCount > 0
               ? `${malformedCount} format error${malformedCount > 1 ? 's' : ''} — fix to save`
               : missingCount > 0
                 ? `Unsaved changes · ${missingCount} required still missing (OK to save partial)`
                 : 'Unsaved changes · ready to save'
           ) :
           savedAt ? (
             isComplete
               ? `✓ Saved at ${savedAt} · complete`
               : `✓ Saved at ${savedAt} · ${missingCount} required still missing`
           ) :
           missingCount > 0 ? `${missingCount} required field${missingCount > 1 ? 's' : ''} still missing` :
           'Ready'}
        </span>
        <button type="submit" className="af-btn-primary" disabled={!canSave || saving || !dirty}>
          {saving ? 'Saving…' : 'Save Identity'}
        </button>
      </div>
    </form>
  )
}

// ─── Helpers ───

function Field({ label, required, error, children }: {
  label: string; required?: boolean; error?: string; children: React.ReactNode
}) {
  return (
    <div className="af-field">
      <label className="af-label">
        {label}
        {required && <span className="af-required-star">*</span>}
      </label>
      {children}
      {error && <span className="af-error">{error}</span>}
    </div>
  )
}

function BoolRadio({ label, required, value, onChange }: {
  label: string; required?: boolean; value: boolean; onChange: (v: boolean) => void
}) {
  return (
    <div className="af-field">
      <label className="af-label">
        {label}
        {required && <span className="af-required-star">*</span>}
      </label>
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
