import { useEffect, useMemo, useState } from 'react'
import { Plus, X } from 'lucide-react'
import TagInput from '../TagInput'
import { deepMerge } from '../utils'
import './ats-form.css'

type TargetRole = { title: string; seniority: string; function?: string }
type CompTarget = { base_min?: number; base_max?: number; total_min?: number; total_max?: number; currency: string }
type LocationPref = {
  accept_any: boolean
  remote_only: boolean
  hybrid_max_days_onsite?: number
  preferred_cities: string[]
  acceptable_countries: string[]
}
type SoftPreferences = {
  company_types: string[]
  remote_culture: string[]
  tech_stack_preferred: string[]
  tech_stack_avoid: string[]
  industries_preferred: string[]
  industries_avoid: string[]
}
type ScoringWeights = {
  tech_match: number; comp_match: number; location_match: number
  company_match: number; growth_signal: number
}
type Thresholds = { strong: number; worth: number; consider: number; skip_below: number }
type Blocks = { block_b: boolean; block_c: boolean; block_d: boolean; block_e: boolean; block_f: boolean; block_g: boolean }
type EvaluatorStrategy = {
  stage_a: { enabled: boolean; model: string; threshold: number }
  stage_b: { enabled: boolean; model: string; blocks: Blocks }
}
type HardFilters = {
  source_filter: { blocked_sources: string[] }
  company_blocklist: string[]
  title_blocklist: string[]
  title_allowlist: string[]
  location: { allowed_countries: string[]; allowed_cities: string[]; disallowed_countries: string[] }
  seniority: { allowed: string[] }
  posted_within_days: number
  comp_floor: { base_min?: number; total_min?: number; currency: string }
  jd_text_blocklist: string[]
}

type Preferences = {
  targets: TargetRole[]
  comp_target: CompTarget
  location: LocationPref
  hard_filters: HardFilters
  soft_preferences: SoftPreferences
  scoring_weights: ScoringWeights
  thresholds: Thresholds
  evaluator_strategy: EvaluatorStrategy
}

const CURRENCY_OPTIONS = ['USD', 'EUR', 'GBP', 'CAD', 'CNY']
const SENIORITY_OPTIONS = ['IC1', 'IC2', 'IC3', 'IC4', 'IC5', 'IC6', 'Senior', 'Staff', 'Principal', 'Manager', 'Director', 'VP']

const BLOCK_META: { key: keyof Blocks; title: string; desc: string; required?: boolean }[] = [
  { key: 'block_b', title: 'Block B — Summary', desc: '岗位 TL;DR + 为什么值得考虑 (Tailor 依赖)', required: true },
  { key: 'block_c', title: 'Block C — Fit Analysis', desc: '技能 / 经验 / 背景逐项匹配打分' },
  { key: 'block_d', title: 'Block D — Comp & Location', desc: '薪资区间估算 + 地点 / remote policy 判定' },
  { key: 'block_e', title: 'Block E — Resume Hooks', desc: 'Tailor 用的改写建议 (Tailor 依赖)', required: true },
  { key: 'block_f', title: 'Block F — Risk Flags', desc: '红旗 + 文化警告 + 签证难点' },
  { key: 'block_g', title: 'Block G — Company Research', desc: '公司近况 / 新闻 / 融资 (可选深调研)' },
]

const SCORING_LABELS: { key: keyof ScoringWeights; label: string }[] = [
  { key: 'tech_match', label: 'Tech Match' },
  { key: 'comp_match', label: 'Comp Match' },
  { key: 'location_match', label: 'Location Match' },
  { key: 'company_match', label: 'Company Match' },
  { key: 'growth_signal', label: 'Growth Signal' },
]

type PreviewResult = {
  total_jobs: number
  would_drop: number
  would_pass: number
  breakdown: { rule: string; drops: number }[]
}

function BLANK(): Preferences {
  return {
    targets: [],
    comp_target: { currency: 'USD' },
    location: { accept_any: false, remote_only: false, preferred_cities: [], acceptable_countries: [] },
    hard_filters: {
      source_filter: { blocked_sources: [] },
      company_blocklist: [], title_blocklist: [], title_allowlist: [],
      location: { allowed_countries: [], allowed_cities: [], disallowed_countries: [] },
      seniority: { allowed: [] },
      posted_within_days: 0,
      comp_floor: { currency: 'USD' },
      jd_text_blocklist: [],
    },
    soft_preferences: {
      company_types: [], remote_culture: [], tech_stack_preferred: [],
      tech_stack_avoid: [], industries_preferred: [], industries_avoid: [],
    },
    scoring_weights: {
      tech_match: 0.2, comp_match: 0.2, location_match: 0.2, company_match: 0.2, growth_signal: 0.2,
    },
    thresholds: { strong: 4.5, worth: 4.0, consider: 3.5, skip_below: 3.0 },
    evaluator_strategy: {
      stage_a: { enabled: true, model: 'claude-haiku-4-5', threshold: 3.5 },
      stage_b: {
        enabled: true, model: 'claude-sonnet-4-6',
        blocks: { block_b: true, block_c: false, block_d: false, block_e: true, block_f: false, block_g: false },
      },
    },
  }
}

type ValidationResult = {
  missing: Record<string, true>
  malformed: Record<string, string>
}

function validate(p: Preferences): ValidationResult {
  const missing: Record<string, true> = {}
  const malformed: Record<string, string> = {}

  if (p.targets.length === 0) missing.targets = true
  p.targets.forEach((t, i) => {
    if (!t.title.trim()) missing[`targets.${i}.title`] = true
    if (!t.seniority.trim()) missing[`targets.${i}.seniority`] = true
  })

  // Compensation: all optional, but numbers must be valid numbers
  const checkNum = (key: string, v: number | undefined) => {
    if (v !== undefined && (!isFinite(v) || v < 0)) malformed[key] = 'Must be a positive number'
  }
  checkNum('comp_target.base_min', p.comp_target.base_min)
  checkNum('comp_target.base_max', p.comp_target.base_max)
  checkNum('comp_target.total_min', p.comp_target.total_min)
  checkNum('comp_target.total_max', p.comp_target.total_max)

  // Thresholds must be ordered: strong >= worth >= consider >= skip_below
  const { strong, worth, consider, skip_below } = p.thresholds
  if (!(strong >= worth && worth >= consider && consider >= skip_below)) {
    malformed['thresholds.order'] = 'Must satisfy strong ≥ worth ≥ consider ≥ skip_below'
  }

  // scoring_weights sum (validated in UI as warning, not malformed — partial-save)
  return { missing, malformed }
}

function sumWeights(w: ScoringWeights): number {
  return w.tech_match + w.comp_match + w.location_match + w.company_match + w.growth_signal
}

export default function Preferences() {
  const [prefs, setPrefs] = useState<Preferences>(BLANK)
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const { missing, malformed } = useMemo(() => validate(prefs), [prefs])
  const missingCount = Object.keys(missing).length
  const malformedCount = Object.keys(malformed).length
  const canSave = malformedCount === 0
  const isComplete = missingCount === 0 && malformedCount === 0

  const weightSum = sumWeights(prefs.scoring_weights)
  const weightSumOk = Math.abs(weightSum - 1.0) < 0.01

  useEffect(() => {
    fetch('/api/career/preferences')
      .then(r => r.json())
      .then(data => { if (data) setPrefs(deepMerge(BLANK(), data)); setLoaded(true) })
      .catch(() => setLoaded(true))
  }, [])

  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  function patch<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    setPrefs(prev => ({ ...prev, [key]: value }))
    setDirty(true)
    setSavedAt(null)
  }

  async function runPreview() {
    setPreviewing(true); setPreviewError(null)
    try {
      const r = await fetch('/api/career/preferences/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        setPreviewError(j.error || `HTTP ${r.status}`)
        return
      }
      setPreview(await r.json())
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setPreviewing(false)
    }
  }

  async function save() {
    setSaving(true); setServerError(null)
    try {
      const r = await fetch('/api/career/preferences', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs),
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

  if (!loaded) return <div className="af-loading">Loading preferences…</div>

  const showErr = (key: string): string | undefined => {
    if (malformed[key]) return malformed[key]
    if ((dirty || savedAt !== null) && missing[key]) return 'Required'
    return undefined
  }
  const showBad = (key: string) => Boolean(malformed[key])

  const numOrUndef = (s: string): number | undefined => {
    if (s.trim() === '') return undefined
    const n = Number(s)
    return isNaN(n) ? undefined : n
  }

  return (
    <form className="af-form" onSubmit={e => { e.preventDefault(); if (canSave && dirty) save() }}>
      <div className="af-form-header">
        <h2 className="af-form-title">Preferences</h2>
        <p className="af-form-subtitle">
          你想要什么 — 目标岗位 / 薪资 / 地点 / 软偏好 / 评分权重 / 评测策略。
          Finder / Evaluator / Shortlist 都读这里。preferences.yml 会 commit 进 git。
        </p>
      </div>

      {/* Section 1: Target Roles */}
      <section className="af-section">
        <h3 className="af-section-title">Target Roles</h3>
        <p className="af-section-desc">目标岗位（≥ 1 条）。多条时 OR 关系 — 任一 match 都算 pass。</p>
        <div className="af-rows">
          {prefs.targets.map((t, i) => (
            <div className="af-row" key={i}>
              <div className="af-row-header">
                <span className="af-row-index">Target #{i + 1}</span>
                <button type="button" className="af-btn-remove"
                  onClick={() => patch('targets', prefs.targets.filter((_, j) => j !== i))}>
                  <X size={12} /> Remove
                </button>
              </div>
              <div className="af-field-row">
                <Field label="Title" required error={showErr(`targets.${i}.title`)}>
                  <input className={`af-input${showBad(`targets.${i}.title`) ? ' af-input-error' : ''}`}
                    placeholder="Software Engineer" value={t.title}
                    onChange={e => patch('targets', prefs.targets.map((r, j) => j === i ? { ...r, title: e.target.value } : r))} />
                </Field>
                <Field label="Seniority" required error={showErr(`targets.${i}.seniority`)}>
                  <select className={`af-select${showBad(`targets.${i}.seniority`) ? ' af-input-error' : ''}`}
                    value={t.seniority}
                    onChange={e => patch('targets', prefs.targets.map((r, j) => j === i ? { ...r, seniority: e.target.value } : r))}>
                    <option value="">—</option>
                    {SENIORITY_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="Function (optional)">
                <input className="af-input"
                  placeholder="Backend / Infrastructure / Data / ML" value={t.function || ''}
                  onChange={e => patch('targets', prefs.targets.map((r, j) => j === i ? { ...r, function: e.target.value } : r))} />
              </Field>
            </div>
          ))}
        </div>
        <button type="button" className="af-btn-add"
          onClick={() => patch('targets', [...prefs.targets, { title: '', seniority: '' }])}>
          <Plus size={14} /> Add Target
        </button>
        {prefs.targets.length === 0 && showErr('targets') && <span className="af-error" style={{ marginTop: 8 }}>At least 1 target required</span>}
      </section>

      {/* Section 2: Compensation */}
      <section className="af-section">
        <h3 className="af-section-title">Compensation Target</h3>
        <p className="af-section-desc">期望薪资区间 (都可选；填哪个算哪个)。comp_target 用于 Evaluator 打分，comp_floor (Section 7) 才是 hard filter。</p>
        <div className="af-field-row">
          <Field label="Base Min" error={showErr('comp_target.base_min')}>
            <input type="number" className={`af-input af-input-number${showBad('comp_target.base_min') ? ' af-input-error' : ''}`}
              placeholder="150000" value={prefs.comp_target.base_min ?? ''}
              onChange={e => patch('comp_target', { ...prefs.comp_target, base_min: numOrUndef(e.target.value) })} />
          </Field>
          <Field label="Base Max" error={showErr('comp_target.base_max')}>
            <input type="number" className={`af-input af-input-number${showBad('comp_target.base_max') ? ' af-input-error' : ''}`}
              placeholder="220000" value={prefs.comp_target.base_max ?? ''}
              onChange={e => patch('comp_target', { ...prefs.comp_target, base_max: numOrUndef(e.target.value) })} />
          </Field>
        </div>
        <div className="af-field-row">
          <Field label="Total Min (base + bonus + equity)" error={showErr('comp_target.total_min')}>
            <input type="number" className={`af-input af-input-number${showBad('comp_target.total_min') ? ' af-input-error' : ''}`}
              placeholder="180000" value={prefs.comp_target.total_min ?? ''}
              onChange={e => patch('comp_target', { ...prefs.comp_target, total_min: numOrUndef(e.target.value) })} />
          </Field>
          <Field label="Total Max" error={showErr('comp_target.total_max')}>
            <input type="number" className={`af-input af-input-number${showBad('comp_target.total_max') ? ' af-input-error' : ''}`}
              placeholder="300000" value={prefs.comp_target.total_max ?? ''}
              onChange={e => patch('comp_target', { ...prefs.comp_target, total_max: numOrUndef(e.target.value) })} />
          </Field>
        </div>
        <Field label="Currency">
          <select className="af-select af-input-number" value={prefs.comp_target.currency}
            onChange={e => patch('comp_target', { ...prefs.comp_target, currency: e.target.value })}>
            {CURRENCY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
      </section>

      {/* Section 3: Location */}
      <section className="af-section">
        <h3 className="af-section-title">Location</h3>
        <p className="af-section-desc">地点偏好。accept_any on 时 Finder 不看地点；remote_only on 时只考虑 remote 岗。</p>

        <div className="af-field">
          <label className="af-radio-label">
            <input type="checkbox" checked={prefs.location.accept_any}
              onChange={e => patch('location', { ...prefs.location, accept_any: e.target.checked })} />
            {' '}Accept any location (bypass location checks)
          </label>
        </div>
        <div className="af-field">
          <label className="af-radio-label">
            <input type="checkbox" checked={prefs.location.remote_only} disabled={prefs.location.accept_any}
              onChange={e => patch('location', { ...prefs.location, remote_only: e.target.checked })} />
            {' '}Remote only
          </label>
        </div>

        <Field label="Hybrid max days onsite / week">
          <input type="number" className="af-input af-input-number"
            disabled={prefs.location.accept_any || prefs.location.remote_only}
            placeholder="2" value={prefs.location.hybrid_max_days_onsite ?? ''}
            onChange={e => patch('location', { ...prefs.location, hybrid_max_days_onsite: numOrUndef(e.target.value) })} />
        </Field>

        <Field label="Preferred Cities">
          <TagInput value={prefs.location.preferred_cities}
            disabled={prefs.location.accept_any}
            onChange={v => patch('location', { ...prefs.location, preferred_cities: v })}
            placeholder="New York, San Francisco (Enter to add)" />
        </Field>
        <Field label="Acceptable Countries">
          <TagInput value={prefs.location.acceptable_countries}
            disabled={prefs.location.accept_any}
            onChange={v => patch('location', { ...prefs.location, acceptable_countries: v })}
            placeholder="United States, Canada (Enter to add)" />
        </Field>
      </section>

      {/* Section 4: Soft Preferences */}
      <section className="af-section">
        <h3 className="af-section-title">Soft Preferences</h3>
        <p className="af-section-desc">软偏好 — 只影响 Evaluator 打分，不直接 drop。空=不偏好。</p>
        <div className="af-field-row">
          <Field label="Company Types (preferred)">
            <TagInput value={prefs.soft_preferences.company_types}
              onChange={v => patch('soft_preferences', { ...prefs.soft_preferences, company_types: v })}
              placeholder="startup, bigco, scaleup" />
          </Field>
          <Field label="Remote Culture (preferred)">
            <TagInput value={prefs.soft_preferences.remote_culture}
              onChange={v => patch('soft_preferences', { ...prefs.soft_preferences, remote_culture: v })}
              placeholder="async-first, remote-ok" />
          </Field>
        </div>
        <div className="af-field-row">
          <Field label="Tech Stack (preferred)">
            <TagInput value={prefs.soft_preferences.tech_stack_preferred}
              onChange={v => patch('soft_preferences', { ...prefs.soft_preferences, tech_stack_preferred: v })}
              placeholder="Python, Go, Rust" />
          </Field>
          <Field label="Tech Stack (avoid)">
            <TagInput value={prefs.soft_preferences.tech_stack_avoid}
              onChange={v => patch('soft_preferences', { ...prefs.soft_preferences, tech_stack_avoid: v })}
              placeholder="PHP, legacy Java" />
          </Field>
        </div>
        <div className="af-field-row">
          <Field label="Industries (preferred)">
            <TagInput value={prefs.soft_preferences.industries_preferred}
              onChange={v => patch('soft_preferences', { ...prefs.soft_preferences, industries_preferred: v })}
              placeholder="fintech, AI infra, devtools" />
          </Field>
          <Field label="Industries (avoid)">
            <TagInput value={prefs.soft_preferences.industries_avoid}
              onChange={v => patch('soft_preferences', { ...prefs.soft_preferences, industries_avoid: v })}
              placeholder="adtech, crypto" />
          </Field>
        </div>
      </section>

      {/* Section 5: Scoring & Thresholds */}
      <section className="af-section">
        <h3 className="af-section-title">Scoring & Thresholds</h3>
        <p className="af-section-desc">
          Evaluator Stage B 的打分权重 (5 项加和应为 1.0) + shortlist 阈值 (1-5 scale)。
        </p>

        <div className="af-field">
          <label className="af-label">Weights</label>
          {SCORING_LABELS.map(({ key, label }) => (
            <div className="af-slider-row" key={key}>
              <span className="af-slider-label">{label}</span>
              <input type="range" min={0} max={1} step={0.05} className="af-slider"
                value={prefs.scoring_weights[key]}
                onChange={e => patch('scoring_weights', { ...prefs.scoring_weights, [key]: Number(e.target.value) })} />
              <span className="af-slider-value">{prefs.scoring_weights[key].toFixed(2)}</span>
            </div>
          ))}
          <div className={`af-slider-sum ${weightSumOk ? 'af-slider-sum-ok' : 'af-slider-sum-bad'}`}>
            Sum: {weightSum.toFixed(2)} {weightSumOk ? '✓' : '(should be 1.00)'}
          </div>
        </div>

        <div className="af-field">
          <label className="af-label">Thresholds (1-5 scale)</label>
          {showErr('thresholds.order') && <span className="af-error">{showErr('thresholds.order')}</span>}
          <div className="af-field-row">
            <Field label="Strong (auto-shortlist)">
              <input type="number" step={0.1} min={1} max={5}
                className={`af-input af-input-number${showBad('thresholds.order') ? ' af-input-error' : ''}`}
                value={prefs.thresholds.strong}
                onChange={e => patch('thresholds', { ...prefs.thresholds, strong: Number(e.target.value) })} />
            </Field>
            <Field label="Worth (review)">
              <input type="number" step={0.1} min={1} max={5}
                className={`af-input af-input-number${showBad('thresholds.order') ? ' af-input-error' : ''}`}
                value={prefs.thresholds.worth}
                onChange={e => patch('thresholds', { ...prefs.thresholds, worth: Number(e.target.value) })} />
            </Field>
          </div>
          <div className="af-field-row">
            <Field label="Consider (maybe)">
              <input type="number" step={0.1} min={1} max={5}
                className={`af-input af-input-number${showBad('thresholds.order') ? ' af-input-error' : ''}`}
                value={prefs.thresholds.consider}
                onChange={e => patch('thresholds', { ...prefs.thresholds, consider: Number(e.target.value) })} />
            </Field>
            <Field label="Skip Below (auto-archive)">
              <input type="number" step={0.1} min={1} max={5}
                className={`af-input af-input-number${showBad('thresholds.order') ? ' af-input-error' : ''}`}
                value={prefs.thresholds.skip_below}
                onChange={e => patch('thresholds', { ...prefs.thresholds, skip_below: Number(e.target.value) })} />
            </Field>
          </div>
          <span className="af-help-text">
            Strong 4.5+ 自动进 shortlist · 低于 skip_below (3.0) 自动归档。
          </span>
        </div>
      </section>

      {/* Section 6: Evaluator Strategy */}
      <section className="af-section">
        <h3 className="af-section-title">Evaluator Strategy</h3>
        <p className="af-section-desc">
          Stage A (Haiku 快评) + Stage B (Sonnet 深评) 配置。Block B / E 是 Tailor 的依赖，强制开启。
        </p>

        <div className="af-field">
          <label className="af-label">Stage A (Haiku 快评)</label>
          <div className="af-strategy-row">
            <div>
              <label className="af-radio-label">
                <input type="checkbox" checked={prefs.evaluator_strategy.stage_a.enabled}
                  onChange={e => patch('evaluator_strategy', {
                    ...prefs.evaluator_strategy,
                    stage_a: { ...prefs.evaluator_strategy.stage_a, enabled: e.target.checked },
                  })} />
                {' '}Enabled
              </label>
            </div>
            <input className="af-input" placeholder="claude-haiku-4-5"
              value={prefs.evaluator_strategy.stage_a.model}
              onChange={e => patch('evaluator_strategy', {
                ...prefs.evaluator_strategy,
                stage_a: { ...prefs.evaluator_strategy.stage_a, model: e.target.value },
              })} />
            <input type="number" className="af-input" step={0.1} min={1} max={5}
              placeholder="3.5"
              value={prefs.evaluator_strategy.stage_a.threshold}
              onChange={e => patch('evaluator_strategy', {
                ...prefs.evaluator_strategy,
                stage_a: { ...prefs.evaluator_strategy.stage_a, threshold: Number(e.target.value) },
              })} />
          </div>
          <span className="af-help-text">Stage A threshold: 低于此分自动归档 (可 Force Sonnet 覆盖)。</span>
        </div>

        <div className="af-field">
          <label className="af-label">Stage B (Sonnet 深评)</label>
          <div className="af-strategy-row">
            <div>
              <label className="af-radio-label">
                <input type="checkbox" checked={prefs.evaluator_strategy.stage_b.enabled}
                  onChange={e => patch('evaluator_strategy', {
                    ...prefs.evaluator_strategy,
                    stage_b: { ...prefs.evaluator_strategy.stage_b, enabled: e.target.checked },
                  })} />
                {' '}Enabled
              </label>
            </div>
            <input className="af-input" placeholder="claude-sonnet-4-6"
              value={prefs.evaluator_strategy.stage_b.model}
              onChange={e => patch('evaluator_strategy', {
                ...prefs.evaluator_strategy,
                stage_b: { ...prefs.evaluator_strategy.stage_b, model: e.target.value },
              })} />
            <div />
          </div>
        </div>

        <div className="af-field">
          <label className="af-label">Stage B Blocks</label>
          <span className="af-help-text">6 Block 各自可 toggle — Block B / E 是 Tailor 依赖，强制开启。</span>
          <div className="af-block-card-grid">
            {BLOCK_META.map(({ key, title, desc, required }) => {
              const on = prefs.evaluator_strategy.stage_b.blocks[key]
              const cls = `af-block-card${on ? ' af-block-card-on' : ''}${required ? ' af-block-card-disabled' : ''}`
              return (
                <div className={cls} key={key}>
                  <div className="af-block-card-title">
                    <span>{title}</span>
                    <button type="button"
                      className={`af-toggle${on ? ' af-toggle-on' : ''}`}
                      disabled={required}
                      onClick={() => patch('evaluator_strategy', {
                        ...prefs.evaluator_strategy,
                        stage_b: {
                          ...prefs.evaluator_strategy.stage_b,
                          blocks: { ...prefs.evaluator_strategy.stage_b.blocks, [key]: !on },
                        },
                      })}
                      aria-label={`Toggle ${title}`}
                    />
                  </div>
                  <p className="af-block-card-desc">{desc}</p>
                  {required && <span className="af-block-card-badge">Required by Tailor</span>}
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {/* Section 7: Hard Filters */}
      <section className="af-section">
        <h3 className="af-section-title">Hard Filters</h3>
        <p className="af-section-desc">
          按顺序短路评估 — 上面规则命中立刻归档，不进下游。顺序：
          source → company → title → location → seniority → posted_days → comp → jd_text。
          空字段 = 不过滤。
        </p>

        <div className="af-subsection">
          <div className="af-subsection-title">
            <span className="af-filter-ordinal">1</span> source_filter
          </div>
          <p className="af-subsection-desc">屏蔽整个源 (最先跑 — 省调用成本)。典型值: linkedin / indeed / glassdoor。</p>
          <TagInput value={prefs.hard_filters.source_filter.blocked_sources}
            onChange={v => patch('hard_filters', {
              ...prefs.hard_filters, source_filter: { blocked_sources: v },
            })}
            placeholder="linkedin, indeed (Enter to add)" />
        </div>

        <div className="af-subsection">
          <div className="af-subsection-title">
            <span className="af-filter-ordinal">2</span> company_blocklist
          </div>
          <p className="af-subsection-desc">屏蔽特定公司。大小写不敏感。</p>
          <TagInput value={prefs.hard_filters.company_blocklist}
            onChange={v => patch('hard_filters', { ...prefs.hard_filters, company_blocklist: v })}
            placeholder="Palantir, Oracle, Meta" />
        </div>

        <div className="af-subsection">
          <div className="af-subsection-title">
            <span className="af-filter-ordinal">3</span> title filters
          </div>
          <p className="af-subsection-desc">
            allowlist 非空时只保留 title 命中任一关键词的岗位；blocklist 任一命中就 drop。
          </p>
          <div className="af-field-row">
            <Field label="title_blocklist">
              <TagInput value={prefs.hard_filters.title_blocklist}
                onChange={v => patch('hard_filters', { ...prefs.hard_filters, title_blocklist: v })}
                placeholder="Intern, Manager, Director" />
            </Field>
            <Field label="title_allowlist">
              <TagInput value={prefs.hard_filters.title_allowlist}
                onChange={v => patch('hard_filters', { ...prefs.hard_filters, title_allowlist: v })}
                placeholder="Software Engineer, SDE, Backend" />
            </Field>
          </div>
        </div>

        <div className="af-subsection">
          <div className="af-subsection-title">
            <span className="af-filter-ordinal">4</span> location
          </div>
          <p className="af-subsection-desc">全空 = 不过滤。allowed 非空时只保留命中者；disallowed 任一命中就 drop。</p>
          <Field label="allowed_countries">
            <TagInput value={prefs.hard_filters.location.allowed_countries}
              onChange={v => patch('hard_filters', {
                ...prefs.hard_filters, location: { ...prefs.hard_filters.location, allowed_countries: v },
              })}
              placeholder="United States, Canada" />
          </Field>
          <Field label="allowed_cities">
            <TagInput value={prefs.hard_filters.location.allowed_cities}
              onChange={v => patch('hard_filters', {
                ...prefs.hard_filters, location: { ...prefs.hard_filters.location, allowed_cities: v },
              })}
              placeholder="New York, San Francisco, Remote" />
          </Field>
          <Field label="disallowed_countries">
            <TagInput value={prefs.hard_filters.location.disallowed_countries}
              onChange={v => patch('hard_filters', {
                ...prefs.hard_filters, location: { ...prefs.hard_filters.location, disallowed_countries: v },
              })}
              placeholder="China, Russia" />
          </Field>
        </div>

        <div className="af-subsection">
          <div className="af-subsection-title">
            <span className="af-filter-ordinal">5</span> seniority
          </div>
          <p className="af-subsection-desc">非空时只保留 seniority 命中任一的岗位。</p>
          <TagInput value={prefs.hard_filters.seniority.allowed}
            onChange={v => patch('hard_filters', {
              ...prefs.hard_filters, seniority: { allowed: v },
            })}
            placeholder="IC3, IC4, Senior, Staff" />
        </div>

        <div className="af-subsection">
          <div className="af-subsection-title">
            <span className="af-filter-ordinal">6</span> posted_within_days
          </div>
          <p className="af-subsection-desc">只保留过去 N 天内发布的岗位。0 = 不限。</p>
          <Field label="days">
            <input type="number" className="af-input af-input-number" min={0} placeholder="30"
              value={prefs.hard_filters.posted_within_days}
              onChange={e => patch('hard_filters', {
                ...prefs.hard_filters, posted_within_days: Number(e.target.value) || 0,
              })} />
          </Field>
        </div>

        <div className="af-subsection">
          <div className="af-subsection-title">
            <span className="af-filter-ordinal">7</span> comp_floor
          </div>
          <p className="af-subsection-desc">薪资地板 — 岗位明示 (或通过 Levels.fyi 推断) 低于此值直接 drop。</p>
          <div className="af-field-row">
            <Field label="base_min">
              <input type="number" className="af-input af-input-number" min={0} placeholder="150000"
                value={prefs.hard_filters.comp_floor.base_min ?? ''}
                onChange={e => patch('hard_filters', {
                  ...prefs.hard_filters,
                  comp_floor: { ...prefs.hard_filters.comp_floor, base_min: numOrUndef(e.target.value) },
                })} />
            </Field>
            <Field label="total_min">
              <input type="number" className="af-input af-input-number" min={0} placeholder="200000"
                value={prefs.hard_filters.comp_floor.total_min ?? ''}
                onChange={e => patch('hard_filters', {
                  ...prefs.hard_filters,
                  comp_floor: { ...prefs.hard_filters.comp_floor, total_min: numOrUndef(e.target.value) },
                })} />
            </Field>
          </div>
          <Field label="currency">
            <select className="af-select af-input-number"
              value={prefs.hard_filters.comp_floor.currency}
              onChange={e => patch('hard_filters', {
                ...prefs.hard_filters,
                comp_floor: { ...prefs.hard_filters.comp_floor, currency: e.target.value },
              })}>
              {CURRENCY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        </div>

        <div className="af-subsection">
          <div className="af-subsection-title">
            <span className="af-filter-ordinal">8</span> jd_text_blocklist
          </div>
          <p className="af-subsection-desc">
            ⚠️ 需先 JD Enrich 完成才评估（最贵，最后跑）。JD 正文包含任一关键词 → drop。
          </p>
          <TagInput value={prefs.hard_filters.jd_text_blocklist}
            onChange={v => patch('hard_filters', { ...prefs.hard_filters, jd_text_blocklist: v })}
            placeholder="on-call, weekend, 996" />
        </div>

        {/* Preview dry-run bar */}
        <div className="af-preview-bar">
          <div className="af-preview-header">
            <span className="af-preview-title">Preview on current pipeline</span>
            <button type="button" className="af-btn-secondary"
              disabled={previewing}
              onClick={runPreview}>
              {previewing ? 'Running…' : 'Run Preview'}
            </button>
          </div>
          {previewing && <div className="af-preview-loading">Evaluating hard_filters against current pipeline.json…</div>}
          {previewError && <div className="af-preview-error">Error: {previewError}</div>}
          {preview && (
            <>
              <div className="af-preview-result">
                <div className="af-preview-stat">
                  <span className="af-preview-stat-value">{preview.total_jobs}</span>
                  <span className="af-preview-stat-label">Total</span>
                </div>
                <div className="af-preview-stat">
                  <span className="af-preview-stat-value" style={{ color: '#cf222e' }}>{preview.would_drop}</span>
                  <span className="af-preview-stat-label">Would drop</span>
                </div>
                <div className="af-preview-stat">
                  <span className="af-preview-stat-value" style={{ color: '#1a7f37' }}>{preview.would_pass}</span>
                  <span className="af-preview-stat-label">Would pass</span>
                </div>
              </div>
              <details className="af-preview-breakdown">
                <summary>Show breakdown by rule ({preview.breakdown.length})</summary>
                <ul className="af-preview-breakdown-list">
                  {preview.breakdown.map(b => (
                    <li className="af-preview-breakdown-row" key={b.rule}>
                      <span className="af-preview-breakdown-rule">{b.rule}</span>
                      <span className={`af-preview-breakdown-drops${b.drops === 0 ? ' af-preview-breakdown-drops-zero' : ''}`}>
                        {b.drops} drop{b.drops === 1 ? '' : 's'}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
        </div>
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
          {saving ? 'Saving…' : 'Save Preferences'}
        </button>
      </div>
    </form>
  )
}

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
