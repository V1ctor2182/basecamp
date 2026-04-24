import { NavLink, Outlet } from 'react-router-dom'
import { User, SlidersHorizontal, Globe, FileQuestion, BookText, FileText } from 'lucide-react'

const SUB_TABS: Array<{ to: string; label: string; Icon: typeof User }> = [
  { to: 'identity', label: 'Identity', Icon: User },
  { to: 'preferences', label: 'Preferences', Icon: SlidersHorizontal },
  { to: 'portals', label: 'Portals', Icon: Globe },
  { to: 'qa-bank', label: 'QA Bank', Icon: FileQuestion },
  { to: 'narrative', label: 'Narrative', Icon: BookText },
  { to: 'resumes', label: 'Resumes', Icon: FileText },
]

export default function SettingsLayout() {
  return (
    <div className="c-settings-layout">
      <aside className="c-settings-sidebar" aria-label="Settings sections">
        {SUB_TABS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `c-settings-sidebar-link${isActive ? ' c-settings-sidebar-link-active' : ''}`
            }
          >
            <Icon size={16} />
            <span>{label}</span>
          </NavLink>
        ))}
      </aside>

      <section className="c-settings-content">
        <Outlet />
      </section>
    </div>
  )
}
