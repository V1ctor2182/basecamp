import { NavLink } from 'react-router-dom'
import { useState } from 'react'
import {
  LayoutDashboard,
  Search,
  Send,
  User,
  Settings,
  ChevronDown,
  ListChecks,
  Star,
  MessagesSquare,
  TrendingDown,
  Activity,
} from 'lucide-react'

// find-jobs-redesign m1.e: collapse the 8-tab developer-flavored nav
// (Overview / Pipeline / Shortlist / Applied / Prep / Learning / Iteration / Settings)
// into 3 user-flavored tabs + an Advanced overflow. Old tabs stay
// accessible from Advanced so existing bookmarks don't 404.
const PRIMARY_TABS: Array<{ to: string; label: string; Icon: typeof LayoutDashboard }> = [
  { to: '/career/find-jobs', label: 'Find Jobs', Icon: Search },
  { to: '/career/applied', label: 'Apply & Track', Icon: Send },
  { to: '/career/settings', label: 'Profile', Icon: User },
]

const ADVANCED_TABS: Array<{ to: string; label: string; Icon: typeof LayoutDashboard }> = [
  { to: '/career/overview', label: 'Overview (legacy)', Icon: LayoutDashboard },
  { to: '/career/pipeline', label: 'Pipeline (legacy)', Icon: ListChecks },
  { to: '/career/shortlist', label: 'Shortlist (legacy)', Icon: Star },
  { to: '/career/prep', label: 'Interview Prep', Icon: MessagesSquare },
  { to: '/career/learning', label: 'Learning (debug)', Icon: TrendingDown },
  { to: '/career/iteration', label: 'Iteration (debug)', Icon: Activity },
]

export default function CareerNav() {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  return (
    <nav className="c-nav" aria-label="Career sections">
      {PRIMARY_TABS.map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) => `c-nav-tab${isActive ? ' c-nav-tab-active' : ''}`}
        >
          <Icon size={16} />
          <span>{label}</span>
        </NavLink>
      ))}
      <div className="c-nav-advanced-wrap">
        <button
          type="button"
          className="c-nav-tab c-nav-advanced-toggle"
          onClick={() => setAdvancedOpen((o) => !o)}
          aria-expanded={advancedOpen}
        >
          <Settings size={16} />
          <span>Advanced</span>
          <ChevronDown size={12} />
        </button>
        {advancedOpen && (
          <div className="c-nav-advanced-menu" onClick={() => setAdvancedOpen(false)}>
            {ADVANCED_TABS.map(({ to, label, Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) => `c-nav-advanced-item${isActive ? ' c-nav-advanced-item-active' : ''}`}
              >
                <Icon size={14} />
                <span>{label}</span>
              </NavLink>
            ))}
          </div>
        )}
      </div>
    </nav>
  )
}
