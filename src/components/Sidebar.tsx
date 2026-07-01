import { NavLink } from 'react-router-dom'
import { Plane, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { navGroups } from '../lib/nav'
import { useSidebar } from '../lib/sidebar'

export function Sidebar() {
  const { collapsed, toggleCollapsed } = useSidebar()

  return (
    <aside
      id="app-sidebar"
      className={[
        'flex h-full flex-col border-r border-border bg-surface transition-[width] duration-150',
        collapsed ? 'w-[68px]' : 'w-64',
      ].join(' ')}
    >
      <div className="flex h-16 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2 overflow-hidden">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent text-white">
            <Plane size={18} strokeWidth={2.5} />
          </div>
          {!collapsed && (
            <div className="overflow-hidden whitespace-nowrap">
              <p className="text-sm font-semibold leading-tight text-text">
                PSA Repair Suite
              </p>
              <p className="text-xs leading-tight text-muted">
                Repair Operations
              </p>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg hover:text-text"
        >
          {collapsed ? (
            <PanelLeftOpen size={17} />
          ) : (
            <PanelLeftClose size={17} />
          )}
        </button>
      </div>

      <nav
        aria-label="Primary workflows"
        className="flex-1 overflow-y-auto px-3 py-4"
      >
        {navGroups.map((group) => (
          <div key={group.label} className="mb-4">
            {!collapsed && (
              <p className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                {group.label}
              </p>
            )}
            <ul className="space-y-1">
              {group.items.map((item) => (
                <li key={item.key}>
                  <NavLink
                    to={item.path}
                    data-nav-key={item.key}
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      [
                        'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                        collapsed ? 'justify-center' : '',
                        isActive
                          ? 'bg-accent-soft font-medium text-accent'
                          : 'text-text hover:bg-bg',
                      ].join(' ')
                    }
                  >
                    <item.icon size={17} strokeWidth={2} className="shrink-0" />
                    {!collapsed && (
                      <span className="flex-1 truncate">{item.label}</span>
                    )}
                    {!collapsed && item.status === 'soon' && (
                      <span className="shrink-0 rounded-full bg-bg px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
                        Soon
                      </span>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {!collapsed && (
        <div className="border-t border-border px-4 py-3">
          <p className="text-xs text-muted">v0.1.0 &middot; UI preview</p>
        </div>
      )}
    </aside>
  )
}
