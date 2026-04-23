import { Link, Routes, Route, Navigate } from 'react-router-dom'
import { ArrowLeft, Briefcase } from 'lucide-react'
import CareerNav from './career/CareerNav'
import Overview from './career/Overview'
import Pipeline from './career/Pipeline'
import Shortlist from './career/Shortlist'
import Applied from './career/Applied'
import Prep from './career/Prep'
import Reports from './career/Reports'
import './career.css'

function SettingsPlaceholder() {
  return (
    <div className="c-page">
      <h2>Settings</h2>
      <p className="c-page-todo">Identity / Preferences / Portals / QA Bank / Narrative / Resumes 子页。</p>
      <p className="c-page-empty">Coming in m3.</p>
    </div>
  )
}

export default function CareerApp() {
  return (
    <div className="career">
      <header className="c-header">
        <div className="c-header-left">
          <Link to="/" className="c-back" aria-label="Back to Learn">
            <ArrowLeft size={16} />
          </Link>
          <Briefcase size={20} strokeWidth={2} />
          <h1>Career</h1>
        </div>
      </header>

      <CareerNav />

      <main className="c-body">
        <Routes>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<Overview />} />
          <Route path="pipeline" element={<Pipeline />} />
          <Route path="shortlist" element={<Shortlist />} />
          <Route path="applied" element={<Applied />} />
          <Route path="prep" element={<Prep />} />
          <Route path="prep/:company" element={<Prep />} />
          <Route path="reports" element={<Reports />} />
          <Route path="reports/:id" element={<Reports />} />
          <Route path="settings/*" element={<SettingsPlaceholder />} />
          <Route path="*" element={<Navigate to="overview" replace />} />
        </Routes>
      </main>
    </div>
  )
}
