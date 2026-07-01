import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from '../components/Sidebar'
import { TopBar } from '../components/TopBar'
import { navItems } from '../lib/nav'

export function AppLayout() {
  const location = useLocation()
  const current = navItems.find((item) => item.path === location.pathname)

  return (
    <div className="flex h-screen w-full bg-bg">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <main
          id="workflow-content"
          data-workflow={current?.key}
          className="flex-1 overflow-y-auto p-6"
        >
          <Outlet />
        </main>
      </div>
    </div>
  )
}
