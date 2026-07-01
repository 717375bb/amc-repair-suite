import { useLocation } from 'react-router-dom'
import { Moon, Sun, Bell, UserCircle } from 'lucide-react'
import { navItems } from '../lib/nav'
import { useTheme } from '../lib/theme'

export function TopBar() {
  const location = useLocation()
  const { theme, toggleTheme } = useTheme()
  const current = navItems.find((item) => item.path === location.pathname)

  return (
    <header
      id="app-topbar"
      className="flex h-16 items-center justify-between border-b border-border bg-surface px-6"
    >
      <div>
        <h1 className="text-base font-semibold text-text">
          {current?.label ?? 'Dashboard'}
        </h1>
        {current && (
          <p className="text-xs text-muted">{current.description}</p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label="Notifications"
          className="flex h-9 w-9 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg hover:text-text"
        >
          <Bell size={18} />
        </button>

        <button
          type="button"
          aria-label="Toggle dark mode"
          onClick={toggleTheme}
          className="flex h-9 w-9 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg hover:text-text"
        >
          {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
        </button>

        <div className="flex items-center gap-2 border-l border-border pl-3">
          <UserCircle size={28} className="text-muted" />
          <div className="leading-tight">
            <p className="text-sm font-medium text-text">Repair Analyst</p>
            <p className="text-xs text-muted">PSA Airlines</p>
          </div>
        </div>
      </div>
    </header>
  )
}
