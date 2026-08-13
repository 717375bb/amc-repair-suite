import type { ReactNode } from 'react'

/**
 * Deliberately separate from AppLayout — no sidebar, no TopBar. A logged-out
 * (or not-yet-registered) user has no workflows to navigate to yet.
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold text-text">Project Takeoff</h1>
          <p className="mt-1 text-sm text-muted">PSA Airlines component repair automation</p>
        </div>
        {children}
      </div>
    </div>
  )
}
