import { NavLink } from 'react-router-dom'
import { LayoutDashboard, ListChecks, Star, Send, MessagesSquare, Settings } from 'lucide-react'

const TABS: Array<{ to: string; label: string; Icon: typeof LayoutDashboard }> = [
  { to: '/career/overview', label: 'Overview', Icon: LayoutDashboard },
  { to: '/career/pipeline', label: 'Pipeline', Icon: ListChecks },
  { to: '/career/shortlist', label: 'Shortlist', Icon: Star },
  { to: '/career/applied', label: 'Applied', Icon: Send },
  { to: '/career/prep', label: 'Interview Prep', Icon: MessagesSquare },
  { to: '/career/settings', label: 'Settings', Icon: Settings },
]

export default function CareerNav() {
  return (
    <nav className="c-nav" aria-label="Career sections">
      {TABS.map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) => `c-nav-tab${isActive ? ' c-nav-tab-active' : ''}`}
        >
          <Icon size={16} />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  )
}
