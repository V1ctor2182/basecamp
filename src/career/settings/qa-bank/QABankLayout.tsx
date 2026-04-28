import { NavLink, Outlet } from 'react-router-dom'
import { Scale, FileText, History as HistoryIcon } from 'lucide-react'
import '../ats-form.css'

const TABS: Array<{ to: string; label: string; Icon: typeof Scale }> = [
  { to: 'legal', label: 'Legal', Icon: Scale },
  { to: 'templates', label: 'Templates', Icon: FileText },
  { to: 'history', label: 'History', Icon: HistoryIcon },
]

export default function QABankLayout() {
  return (
    <div className="c-qa-bank">
      <nav className="c-qa-tabs" aria-label="QA Bank sections">
        {TABS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `c-qa-tab-link${isActive ? ' c-qa-tab-link-active' : ''}`
            }
          >
            <Icon size={14} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="c-qa-tab-content">
        <Outlet />
      </div>
    </div>
  )
}
