import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Moon, Sun, Bell, UserCircle, LogOut, KeyRound } from 'lucide-react'
import { navItems } from '../lib/nav'
import { useTheme } from '../lib/theme'
import { useAuth } from '../lib/authContext'

export function TopBar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { theme, toggleTheme } = useTheme()
  const { username, logout } = useAuth()
  const current = navItems.find((item) => item.path === location.pathname)
  const [menuOpen, setMenuOpen] = useState(false)

  const handleLogout = async () => {
    setMenuOpen(false)
    await logout()
    navigate('/login', { replace: true })
  }

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

        <div className="relative border-l border-border pl-3">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            className="flex items-center gap-2 rounded-md py-1 pr-1 hover:bg-bg"
          >
            <UserCircle size={28} className="text-muted" />
            <div className="text-left leading-tight">
              <p className="text-sm font-medium text-text">{username ?? '...'}</p>
              <p className="text-xs text-muted">PSA Airlines</p>
            </div>
          </button>

          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full z-20 mt-2 w-48 rounded-md border border-border bg-surface py-1 shadow-lg">
                <Link
                  to="/change-password"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-text hover:bg-bg"
                >
                  <KeyRound size={15} />
                  Change password
                </Link>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-danger hover:bg-bg"
                >
                  <LogOut size={15} />
                  Log out
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  )
}
