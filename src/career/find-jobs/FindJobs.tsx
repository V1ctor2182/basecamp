// Find Jobs — the new outer page that replaces the old Pipeline /
// Shortlist / Settings>Portals / Settings>Preferences split.
//
// 04-career-system / find-jobs-redesign m1.b.
//
// Three collapsible sections:
//   ① Sources  — last scan summary + [Scan now] + [Manage] (link to /settings/portals)
//   ② Filters  — inline edit hard_filters (slim subset) + preview counts
//   ③ Candidates — JobCard grid of post-filter jobs (passes from pipeline.json)
//
// [View raw N→] in the Filters section opens RawJobsDrawer (m1.c).

import { useEffect, useMemo, useState, useCallback } from 'react'
import { ChevronDown, ChevronRight, RefreshCw, Layers, SlidersHorizontal, Eye, Send } from 'lucide-react'
import { Link } from 'react-router-dom'
import JobCard, { type JobCardModel } from './JobCard'
import RawJobsDrawer from './RawJobsDrawer'
import JobDetailDrawer from './JobDetailDrawer'
import './find-jobs.css'

type PipelineResp = {
  total: number
  filtered: number
  jobs: JobCardModel[]
  last_scan_at: string | null
}

type ScanStatus = {
  state: 'idle' | 'running' | 'unknown'
  started_at?: string | null
  last_run_at?: string | null
}

type RawSummary = {
  total: number
  passed: number
  dropped: number
  dropped_by_rule: Record<string, number>
  last_scan_at: string | null
}

type Preferences = {
  hard_filters: {
    seniority?: { allowed?: string[] }
    comp_floor?: { base_min?: number; currency?: string }
    posted_within_days?: number
    title_blocklist?: string[]
    title_allowlist?: string[]
    location?: {
      allowed_countries?: string[]
      allowed_cities?: string[]
      disallowed_countries?: string[]
    }
    disabled_rules?: string[]
  }
  // other prefs preserved on save
  [key: string]: unknown
}

const PAGE_SIZE = 24

export default function FindJobs() {
  const [pipeline, setPipeline] = useState<PipelineResp | null>(null)
  const [pipelineError, setPipelineError] = useState<string | null>(null)
  const [rawSummary, setRawSummary] = useState<RawSummary | null>(null)
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null)
  const [prefs, setPrefs] = useState<Preferences | null>(null)
  const [prefsDirty, setPrefsDirty] = useState(false)
  const [savingPrefs, setSavingPrefs] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [highlightFilter, setHighlightFilter] = useState<string | null>(null)
  const [rawDrawerOpen, setRawDrawerOpen] = useState(false)
  const [detailJob, setDetailJob] = useState<JobCardModel | null>(null)
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [scanning, setScanning] = useState(false)
  const [refiltering, setRefiltering] = useState(false)
  const [refilterMsg, setRefilterMsg] = useState<string | null>(null)
  const [applyMessage, setApplyMessage] = useState<string | null>(null)

  // ── data fetchers ────────────────────────────────────────────────────

  const url = useMemo(() => {
    const params = new URLSearchParams({
      sort: 'score',
      order: 'desc',
      limit: String(PAGE_SIZE),
      offset: String(offset),
    })
    if (search.trim()) params.set('q', search.trim())
    return `/api/career/finder/pipeline?${params}`
  }, [search, offset])

  useEffect(() => {
    const ctrl = new AbortController()
    fetch(url, { signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as PipelineResp
      })
      .then((j) => {
        setPipeline(j)
        setPipelineError(null)
      })
      .catch((e) => {
        if ((e as { name?: string })?.name === 'AbortError') return
        setPipelineError((e as Error).message)
      })
    return () => ctrl.abort()
  }, [url])

  const fetchSidecar = useCallback(async () => {
    try {
      const [raw, st, pf] = await Promise.all([
        fetch('/api/career/finder/raw-jobs?limit=1').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/career/finder/scan/status').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/career/preferences').then((r) => (r.ok ? r.json() : null)),
      ])
      if (raw) {
        setRawSummary({
          total: raw.total,
          passed: raw.passed,
          dropped: raw.dropped,
          dropped_by_rule: raw.dropped_by_rule || {},
          last_scan_at: raw.last_scan_at,
        })
      }
      if (st) setScanStatus(st)
      if (pf) setPrefs(pf)
    } catch {
      /* fail-soft */
    }
  }, [])

  useEffect(() => {
    fetchSidecar()
  }, [fetchSidecar])

  // ── actions ──────────────────────────────────────────────────────────

  async function runScan() {
    setScanning(true)
    try {
      await fetch('/api/career/finder/scan', { method: 'POST' })
      // poll status until idle
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        const st = await fetch('/api/career/finder/scan/status').then((r) => r.json())
        setScanStatus(st)
        if (st.state === 'idle') break
      }
      // refresh page data
      setOffset(0)
      fetchSidecar()
      fetch(url).then(async (r) => {
        if (!r.ok) return
        setPipeline(await r.json())
      })
    } finally {
      setScanning(false)
    }
  }

  function changeSearch(s: string) {
    setSearch(s)
    setOffset(0)
  }

  async function savePrefs() {
    if (!prefs) return
    setSavingPrefs(true)
    try {
      const r = await fetch('/api/career/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setPrefsDirty(false)
    } catch (e) {
      console.error('savePrefs', e)
    } finally {
      setSavingPrefs(false)
    }
  }

  function patchHardFilter(patch: (hf: Preferences['hard_filters']) => Preferences['hard_filters']) {
    if (!prefs) return
    const next = { ...prefs, hard_filters: patch({ ...prefs.hard_filters }) }
    setPrefs(next)
    setPrefsDirty(true)
  }

  async function reapplyFilters() {
    setRefiltering(true)
    setRefilterMsg(null)
    try {
      const r = await fetch('/api/career/finder/refilter', { method: 'POST' })
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean
        raw_count?: number
        kept?: number
        dropped?: number
        error?: string
      }
      if (!r.ok || !body.ok) {
        setRefilterMsg(`Failed: ${body.error || `HTTP ${r.status}`}`)
        return
      }
      setRefilterMsg(`✓ Re-filtered: ${body.kept}/${body.raw_count} now pass`)
      // Refresh candidate list + sidecar counts.
      setOffset(0)
      fetchSidecar()
      const url2 = `/api/career/finder/pipeline?sort=score&order=desc&limit=${PAGE_SIZE}&offset=0`
      fetch(url2).then(async (r2) => {
        if (!r2.ok) return
        setPipeline(await r2.json())
      })
    } catch (e) {
      setRefilterMsg(`Network error: ${e instanceof Error ? e.message : ''}`)
    } finally {
      setRefiltering(false)
    }
  }

  function adjustFilter(rule: string) {
    setHighlightFilter(rule)
    setFiltersOpen(true)
    setRawDrawerOpen(false)
    setTimeout(() => {
      const el = document.querySelector('[data-filter-section]')
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 50)
  }

  function startApply(job: JobCardModel) {
    // m1 just navigates to the existing Apply route. Full Apply tab
    // redesign lands in m2 of the redesign series.
    setApplyMessage(`Starting Mode 2 applier for ${job.company} — ${job.role}`)
    // The existing Apply.tsx route lives at /career/apply/:jobId
    window.location.href = `/career/apply/${encodeURIComponent(job.id)}`
  }

  // ── derived view state ───────────────────────────────────────────────

  const filterSummary = useMemo(() => prefs ? summarizeFilter(prefs) : '—', [prefs])
  const sourcesSummary = useMemo(() => {
    if (!rawSummary) return '—'
    const ago = rawSummary.last_scan_at ? formatRelative(rawSummary.last_scan_at) : 'never'
    return `${rawSummary.passed}/${rawSummary.total} passed · last scan ${ago}`
  }, [rawSummary])

  return (
    <div className="c-fj-root">
      <header className="c-fj-header">
        <h2 className="c-fj-title">Find Jobs</h2>
        <p className="c-fj-sub">
          数据源 → 筛选 → 候选职位 全部在这里. 点 [View] 看 JD 详情, 点 [Apply] 发起申请.
        </p>
      </header>

      {/* ① Sources */}
      <section className="c-fj-section">
        <button
          type="button"
          className="c-fj-section-head"
          onClick={() => setSourcesOpen((o) => !o)}
          aria-expanded={sourcesOpen}
        >
          {sourcesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Layers size={14} />
          <span className="c-fj-section-title">① Sources</span>
          <span className="c-fj-section-summary">{sourcesSummary}</span>
          <span className="c-fj-section-spacer" />
          <Link to="/career/settings/portals" className="c-fj-btn c-fj-btn-ghost" onClick={(e) => e.stopPropagation()}>
            Manage
          </Link>
          <button
            type="button"
            className="c-fj-btn c-fj-btn-ghost"
            disabled={scanning || scanStatus?.state === 'running'}
            onClick={(e) => {
              e.stopPropagation()
              runScan()
            }}
          >
            <RefreshCw size={13} className={scanning ? 'c-fj-spin' : ''} /> {scanning ? 'Scanning…' : 'Scan now'}
          </button>
        </button>
        {sourcesOpen && (
          <div className="c-fj-section-body">
            <p className="c-fj-muted">
              Configure data sources (Greenhouse / Ashby / Lever / GitHub markdown lists)
              in <Link to="/career/settings/portals">Settings → Portals</Link>.
            </p>
            {rawSummary && (
              <div className="c-fj-source-stats">
                <span><strong>{rawSummary.total}</strong> raw jobs</span>
                <span><strong>{rawSummary.passed}</strong> passed</span>
                <span><strong>{rawSummary.dropped}</strong> dropped</span>
                {rawSummary.last_scan_at && (
                  <span className="c-fj-muted">last scan: {new Date(rawSummary.last_scan_at).toLocaleString()}</span>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {/* ② Filters */}
      <section className="c-fj-section" data-filter-section>
        <button
          type="button"
          className="c-fj-section-head"
          onClick={() => setFiltersOpen((o) => !o)}
          aria-expanded={filtersOpen}
        >
          {filtersOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <SlidersHorizontal size={14} />
          <span className="c-fj-section-title">② Filters</span>
          <span className="c-fj-section-summary">{filterSummary}</span>
          <span className="c-fj-section-spacer" />
          {rawSummary && rawSummary.total > 0 && (
            <>
              <button
                type="button"
                className="c-fj-btn c-fj-btn-ghost"
                onClick={(e) => {
                  e.stopPropagation()
                  void reapplyFilters()
                }}
                disabled={refiltering}
                title="Re-apply current filters to the last scan's raw jobs without re-fetching ATS APIs. Use this after changing filters to see them take effect."
              >
                <RefreshCw size={13} className={refiltering ? 'c-fj-spin' : ''} />
                {refiltering ? 'Re-filtering…' : 'Re-filter all'}
              </button>
              <button
                type="button"
                className="c-fj-btn c-fj-btn-ghost"
                onClick={(e) => {
                  e.stopPropagation()
                  setRawDrawerOpen(true)
                }}
              >
                <Eye size={13} /> View raw {rawSummary.total}→
              </button>
            </>
          )}
        </button>
        {refilterMsg && (
          <p className={`c-fj-refilter-msg${refilterMsg.startsWith('✓') ? ' c-fj-refilter-msg-ok' : ' c-fj-refilter-msg-bad'}`}>
            {refilterMsg}
          </p>
        )}
        {filtersOpen && prefs && (
          <FilterEditor
            prefs={prefs}
            onPatch={patchHardFilter}
            dirty={prefsDirty}
            saving={savingPrefs}
            onSave={savePrefs}
            highlight={highlightFilter}
            droppedByRule={rawSummary?.dropped_by_rule || {}}
          />
        )}
      </section>

      {/* ③ Candidate jobs */}
      <section className="c-fj-section c-fj-section-cards">
        <div className="c-fj-cards-head">
          <h3 className="c-fj-section-title">③ Candidate jobs · {pipeline?.filtered ?? '…'}</h3>
          <input
            className="c-fj-search"
            type="search"
            placeholder="Filter by company or role…"
            value={search}
            onChange={(e) => changeSearch(e.target.value)}
          />
        </div>
        {pipelineError && (
          <p className="c-fj-error">Failed to load: {pipelineError}</p>
        )}
        {applyMessage && <p className="c-fj-muted">{applyMessage}</p>}
        {!pipeline ? (
          <p className="c-fj-muted">Loading…</p>
        ) : pipeline.total === 0 ? (
          <div className="c-fj-empty">
            <strong>No jobs scanned yet.</strong>
            <p>Configure sources in <Link to="/career/settings/portals">Settings → Portals</Link>, then click <em>Scan now</em>.</p>
          </div>
        ) : pipeline.filtered === 0 && search.trim() === '' ? (
          <div className="c-fj-empty">
            <strong>0 jobs pass your filters.</strong>
            <p>Scan returned <strong>{rawSummary?.total ?? pipeline.total}</strong> raw jobs, but
            hard filters dropped them all. Open <em>② Filters</em> above to loosen the rules,
            or click <em>View raw</em> to see what got dropped and why.</p>
          </div>
        ) : pipeline.filtered === 0 ? (
          <div className="c-fj-empty"><p>No jobs match your search.</p></div>
        ) : (
          <>
            <div className="c-fj-cards-grid">
              {pipeline.jobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  onView={(j) => setDetailJob(j)}
                  onApply={startApply}
                />
              ))}
            </div>
            <Pager
              offset={offset}
              pageSize={PAGE_SIZE}
              filtered={pipeline.filtered}
              onChange={setOffset}
            />
          </>
        )}
      </section>

      {/* Drawers */}
      {rawDrawerOpen && (
        <RawJobsDrawer
          onClose={() => setRawDrawerOpen(false)}
          onAdjustFilter={(rule) => adjustFilter(rule)}
          onApply={startApply}
          onView={(j) => setDetailJob(j)}
        />
      )}
      {detailJob && (
        <JobDetailDrawer
          jobId={detailJob.id}
          fallback={detailJob}
          onClose={() => setDetailJob(null)}
          onApply={startApply}
        />
      )}
    </div>
  )
}

// ─── FilterEditor — slim inline form for hard_filters ─────────────────

function FilterEditor({
  prefs,
  onPatch,
  dirty,
  saving,
  onSave,
  highlight,
  droppedByRule,
}: {
  prefs: Preferences
  onPatch: (p: (hf: Preferences['hard_filters']) => Preferences['hard_filters']) => void
  dirty: boolean
  saving: boolean
  onSave: () => void
  highlight: string | null
  droppedByRule: Record<string, number>
}) {
  const hf = prefs.hard_filters || {}
  const allowedSeniorities = hf.seniority?.allowed ?? []
  const compFloor = hf.comp_floor?.base_min ?? 0
  const postedDays = hf.posted_within_days ?? 0
  const titleBlock = (hf.title_blocklist ?? []).join(', ')
  const disabled = new Set(hf.disabled_rules ?? [])

  function setSeniorities(list: string[]) {
    onPatch((p) => ({ ...p, seniority: { allowed: list } }))
  }
  function setCompFloor(n: number) {
    onPatch((p) => ({
      ...p,
      comp_floor: { ...(p.comp_floor || {}), base_min: n, currency: p.comp_floor?.currency || 'USD' },
    }))
  }
  function setPostedDays(n: number) {
    onPatch((p) => ({ ...p, posted_within_days: n }))
  }
  function setTitleBlocklist(s: string) {
    const list = s.split(',').map((x) => x.trim()).filter(Boolean)
    onPatch((p) => ({ ...p, title_blocklist: list }))
  }
  function toggleRule(rule: string, nextEnabled: boolean) {
    onPatch((p) => {
      const existing = new Set(p.disabled_rules ?? [])
      if (nextEnabled) existing.delete(rule)
      else existing.add(rule)
      return { ...p, disabled_rules: [...existing] }
    })
  }

  return (
    <div className="c-fj-section-body c-fj-filter-body">
      <div className={`c-fj-filter-grid`}>
        <FilterField
          rule="seniority"
          highlighted={highlight === 'seniority'}
          label="Seniority allowlist"
          hint="Empty = match any seniority. Comma-separated."
          dropCount={droppedByRule.seniority}
          enabled={!disabled.has('seniority')}
          onToggle={(b) => toggleRule('seniority', b)}
        >
          <input
            type="text"
            className="c-fj-input"
            disabled={disabled.has('seniority')}
            value={allowedSeniorities.join(', ')}
            onChange={(e) =>
              setSeniorities(
                e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
            placeholder="IC3, IC4, IC5, Senior, Staff"
          />
        </FilterField>

        <FilterField
          rule="comp_floor"
          highlighted={highlight === 'comp_floor'}
          label="Min comp (USD)"
          hint="Drops jobs whose JD-stated comp is below. Disable to ignore comp entirely."
          dropCount={droppedByRule.comp_floor}
          enabled={!disabled.has('comp_floor')}
          onToggle={(b) => toggleRule('comp_floor', b)}
        >
          <input
            type="number"
            className="c-fj-input"
            disabled={disabled.has('comp_floor')}
            min={0}
            step={10000}
            value={compFloor}
            onChange={(e) => setCompFloor(Number(e.target.value) || 0)}
          />
        </FilterField>

        <FilterField
          rule="posted_within_days"
          highlighted={highlight === 'posted_within_days'}
          label="Posted within (days)"
          hint="0 = unlimited even when enabled. Common: 60 days."
          dropCount={droppedByRule.posted_within_days}
          enabled={!disabled.has('posted_within_days')}
          onToggle={(b) => toggleRule('posted_within_days', b)}
        >
          <input
            type="number"
            className="c-fj-input"
            disabled={disabled.has('posted_within_days')}
            min={0}
            value={postedDays}
            onChange={(e) => setPostedDays(Number(e.target.value) || 0)}
          />
        </FilterField>

        <FilterField
          rule="title_blocklist"
          highlighted={highlight === 'title_blocklist'}
          label="Title blocklist"
          hint="Comma-separated. Job dropped if role contains any of these (case-insensitive)."
          dropCount={droppedByRule.title_blocklist}
          enabled={!disabled.has('title_blocklist')}
          onToggle={(b) => toggleRule('title_blocklist', b)}
        >
          <input
            type="text"
            className="c-fj-input"
            disabled={disabled.has('title_blocklist')}
            value={titleBlock}
            onChange={(e) => setTitleBlocklist(e.target.value)}
            placeholder="Embedded, Firmware, Game Developer"
          />
        </FilterField>

        <FilterField
          rule="location"
          highlighted={highlight === 'location'}
          label="Location filter"
          hint="Edit in full Preferences page. Toggle to disable the whole rule (keeps your country/city list)."
          dropCount={droppedByRule.location}
          enabled={!disabled.has('location')}
          onToggle={(b) => toggleRule('location', b)}
        >
          <p className="c-fj-muted c-fj-filter-readonly">
            {summarizeLocation(prefs.hard_filters.location)}
          </p>
        </FilterField>

        <FilterField
          rule="company_blocklist"
          highlighted={highlight === 'company_blocklist'}
          label="Company blocklist"
          hint="Edit in full Preferences page. Toggle to disable without erasing the list."
          dropCount={droppedByRule.company_blocklist}
          enabled={!disabled.has('company_blocklist')}
          onToggle={(b) => toggleRule('company_blocklist', b)}
        >
          <p className="c-fj-muted c-fj-filter-readonly">
            {((prefs.hard_filters as { company_blocklist?: string[] }).company_blocklist || []).join(', ') || '— empty —'}
          </p>
        </FilterField>
      </div>

      <div className="c-fj-filter-foot">
        <p className="c-fj-muted">
          Need more options (location, company blocklist, jd_text)?{' '}
          <Link to="/career/settings/preferences">Open full Preferences →</Link>
        </p>
        <button
          type="button"
          className="c-fj-btn c-fj-btn-primary"
          disabled={!dirty || saving}
          onClick={onSave}
        >
          <Send size={13} /> {saving ? 'Saving…' : dirty ? 'Save filters' : 'Saved'}
        </button>
      </div>
    </div>
  )
}

function FilterField({
  rule,
  label,
  hint,
  highlighted,
  dropCount,
  enabled,
  onToggle,
  children,
}: {
  rule: string
  label: string
  hint: string
  highlighted: boolean
  dropCount?: number
  enabled: boolean
  onToggle: (next: boolean) => void
  children: React.ReactNode
}) {
  return (
    <div
      className={
        `c-fj-filter-field` +
        (highlighted ? ' c-fj-filter-field-hi' : '') +
        (enabled ? '' : ' c-fj-filter-field-off')
      }
    >
      <div className="c-fj-filter-header">
        <label className="c-fj-filter-label">
          {label}
          {typeof dropCount === 'number' && dropCount > 0 && (
            <span
              className={`c-fj-filter-dropcount${enabled ? '' : ' c-fj-filter-dropcount-off'}`}
              title={enabled ? 'Jobs dropped by this rule' : 'Jobs this rule WOULD drop if re-enabled'}
            >
              {dropCount}
            </span>
          )}
        </label>
        <label className="c-fj-filter-toggle" title={enabled ? 'Disable this rule' : 'Enable this rule'}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
            aria-label={`${enabled ? 'Disable' : 'Enable'} ${rule}`}
          />
          <span className="c-fj-filter-toggle-track">
            <span className="c-fj-filter-toggle-thumb" />
          </span>
          <span className="c-fj-filter-toggle-label">{enabled ? 'On' : 'Off'}</span>
        </label>
      </div>
      {children}
      <span className="c-fj-filter-hint">{hint}</span>
    </div>
  )
}

function summarizeLocation(loc?: {
  allowed_countries?: string[]
  allowed_cities?: string[]
  disallowed_countries?: string[]
}): string {
  if (!loc) return '— empty —'
  const allowed = [...(loc.allowed_countries || []), ...(loc.allowed_cities || [])]
  const disallowed = loc.disallowed_countries || []
  if (allowed.length === 0 && disallowed.length === 0) return '— empty —'
  const parts: string[] = []
  if (allowed.length) parts.push(`allow: ${allowed.join(', ')}`)
  if (disallowed.length) parts.push(`block: ${disallowed.join(', ')}`)
  return parts.join(' · ')
}

function Pager({
  offset,
  pageSize,
  filtered,
  onChange,
}: {
  offset: number
  pageSize: number
  filtered: number
  onChange: (n: number) => void
}) {
  const page = Math.floor(offset / pageSize) + 1
  const last = Math.max(1, Math.ceil(filtered / pageSize))
  if (last <= 1) return null
  return (
    <div className="c-fj-pager">
      <button
        type="button"
        className="c-fj-btn c-fj-btn-ghost"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - pageSize))}
      >
        ← Prev
      </button>
      <span className="c-fj-pager-label">Page {page} / {last}</span>
      <button
        type="button"
        className="c-fj-btn c-fj-btn-ghost"
        disabled={offset + pageSize >= filtered}
        onClick={() => onChange(offset + pageSize)}
      >
        Next →
      </button>
    </div>
  )
}

// ─── helpers ───────────────────────────────────────────────────────────

function summarizeFilter(prefs: Preferences): string {
  const hf = prefs.hard_filters || {}
  const parts: string[] = []
  const seniorities = hf.seniority?.allowed ?? []
  if (seniorities.length) parts.push(seniorities.join('/'))
  if (hf.comp_floor?.base_min) parts.push(`≥$${(hf.comp_floor.base_min / 1000).toFixed(0)}k`)
  if (hf.posted_within_days && hf.posted_within_days > 0) parts.push(`${hf.posted_within_days}d`)
  if (hf.title_blocklist?.length) parts.push(`no:${hf.title_blocklist.length}`)
  return parts.length ? parts.join(' · ') : 'no filters active'
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const diffMs = Date.now() - t
  const min = 60_000
  const hr = 60 * min
  const day = 24 * hr
  if (diffMs < min) return 'just now'
  if (diffMs < hr) return `${Math.floor(diffMs / min)}m ago`
  if (diffMs < day) return `${Math.floor(diffMs / hr)}h ago`
  return `${Math.floor(diffMs / day)}d ago`
}
