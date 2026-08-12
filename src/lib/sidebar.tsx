import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'

type SidebarContextValue = {
  collapsed: boolean
  toggleCollapsed: () => void
}

const SidebarContext = createContext<SidebarContextValue | undefined>(
  undefined,
)

const STORAGE_KEY = 'amc-repair-suite-sidebar-collapsed'

function getInitialCollapsed(): boolean {
  return localStorage.getItem(STORAGE_KEY) === 'true'
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState<boolean>(getInitialCollapsed)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(collapsed))
  }, [collapsed])

  const toggleCollapsed = () => setCollapsed((prev) => !prev)

  return (
    <SidebarContext.Provider value={{ collapsed, toggleCollapsed }}>
      {children}
    </SidebarContext.Provider>
  )
}

// Standard context+hook pairing; splitting into a second file for HMR
// purity isn't worth it for a hook this small.
// eslint-disable-next-line react-refresh/only-export-components
export function useSidebar() {
  const ctx = useContext(SidebarContext)
  if (!ctx) throw new Error('useSidebar must be used within SidebarProvider')
  return ctx
}
