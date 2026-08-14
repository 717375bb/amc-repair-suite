import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/authContext'
import { OrderWriteUpsRunProvider } from '../lib/orderWriteUpsRun'
import { EsdFinderRunProvider } from '../lib/esdFinderRun'

/**
 * Gates every real workflow route behind a valid session. 'loading' (the
 * initial /api/auth/me check on page load) renders nothing rather than
 * flashing the app shell or the login page — avoids a visible redirect
 * flicker on every normal page load for an already-logged-in user.
 *
 * OrderWriteUpsRunProvider/EsdFinderRunProvider live HERE (not at the app
 * root) as of #6: each does a one-shot, never-retried "re-attach to an
 * already-running job" check on its own first mount, which is meaningless
 * before a session exists. Mounting them only once authenticated means
 * that check fires exactly when it should — right as login succeeds —
 * instead of always hitting an anonymous 401 on the very first page load
 * and never trying again. (OrderWriteUpsRunProvider supersedes the earlier
 * execute-only ExecuteRunProvider — see its own docstring.)
 */
export function RequireAuth() {
  const { status } = useAuth()

  if (status === 'loading') return null
  if (status === 'unauthenticated') return <Navigate to="/login" replace />
  return (
    <OrderWriteUpsRunProvider>
      <EsdFinderRunProvider>
        <Outlet />
      </EsdFinderRunProvider>
    </OrderWriteUpsRunProvider>
  )
}

/** Inverse guard for /login and /create-account — an already-logged-in user shouldn't see those again. */
export function RequireGuest() {
  const { status } = useAuth()

  if (status === 'loading') return null
  if (status === 'authenticated') return <Navigate to="/repair-orders" replace />
  return <Outlet />
}
