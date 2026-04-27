import { useEffect } from 'react'
import { Link, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { ArrowLeft, Briefcase } from 'lucide-react'
import CareerNav from './career/CareerNav'
import Overview from './career/Overview'
import Pipeline from './career/Pipeline'
import Shortlist from './career/Shortlist'
import Applied from './career/Applied'
import Prep from './career/Prep'
import Reports from './career/Reports'
import SettingsLayout from './career/settings/SettingsLayout'
import Identity from './career/settings/Identity'
import Preferences from './career/settings/Preferences'
import Portals from './career/settings/Portals'
import QABank from './career/settings/QABank'
import Narrative from './career/settings/Narrative'
import ProofPoints from './career/settings/ProofPoints'
import Resumes from './career/settings/Resumes'
import './career.css'

const LAST_TAB_KEY = 'career-last-tab'
const VALID_TABS = ['overview', 'pipeline', 'shortlist', 'applied', 'prep', 'reports', 'settings']

// localStorage can throw in Safari private mode, when over quota, or when
// disabled by extension. Don't crash the app boot for a UX nicety.
function readLastTab(): string {
  try {
    const raw = localStorage.getItem(LAST_TAB_KEY)
    return raw && VALID_TABS.includes(raw) ? raw : 'overview'
  } catch {
    return 'overview'
  }
}

function RootRedirect() {
  return <Navigate to={readLastTab()} replace />
}

export default function CareerApp() {
  const location = useLocation()

  // Persist last top-level tab whenever route changes
  useEffect(() => {
    const match = location.pathname.match(/^\/career\/([^/]+)/)
    const tab = match?.[1]
    if (tab && VALID_TABS.includes(tab)) {
      try { localStorage.setItem(LAST_TAB_KEY, tab) } catch { /* private mode / quota */ }
    }
  }, [location.pathname])

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
          <Route index element={<RootRedirect />} />
          <Route path="overview" element={<Overview />} />
          <Route path="pipeline" element={<Pipeline />} />
          <Route path="shortlist" element={<Shortlist />} />
          <Route path="applied" element={<Applied />} />
          <Route path="prep" element={<Prep />} />
          <Route path="prep/:company" element={<Prep />} />
          <Route path="reports" element={<Reports />} />
          <Route path="reports/:id" element={<Reports />} />
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="identity" replace />} />
            <Route path="identity" element={<Identity />} />
            <Route path="preferences" element={<Preferences />} />
            <Route path="portals" element={<Portals />} />
            <Route path="qa-bank" element={<QABank />} />
            <Route path="narrative" element={<Narrative />} />
            <Route path="proof-points" element={<ProofPoints />} />
            <Route path="resumes" element={<Resumes />} />
            <Route path="*" element={<Navigate to="identity" replace />} />
          </Route>
          <Route path="*" element={<Navigate to="overview" replace />} />
        </Routes>
      </main>
    </div>
  )
}
