import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/authContext'
import { OrderWriteUpsRunProvider } from '../lib/orderWriteUpsRun'
import { EsdFinderRunProvider } from '../lib/esdFinderRun'
import { ActiveRunsProvider } from '../lib/activeRuns'
import { InvoicePriceRun, QuoteRun, ScrapRun } from '../lib/tabRuns'

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
    // ActiveRunsProvider wraps them all: every run provider reports into it
    // and the sidebar renders from it, so what's in flight is visible from
    // any tab. Added 2026-08-27 with the parallel-jobs work.
    //
    // The three trackers below (Quote/Scrap/InvoicePrice) are new for the
    // same reason. Those tabs used to hold their runId in page-local state,
    // so navigating away stopped their polling while the backend job
    // carried on invisibly — the UI forgot, not the job. Mounted here, for
    // the same reason the other two already were: their one-shot "re-attach
    // to a running job" check is meaningless before a session exists.
    <ActiveRunsProvider>
      <OrderWriteUpsRunProvider>
        <EsdFinderRunProvider>
          <QuoteRun.Provider>
            <ScrapRun.Provider>
              <InvoicePriceRun.Provider>
                <Outlet />
              </InvoicePriceRun.Provider>
            </ScrapRun.Provider>
          </QuoteRun.Provider>
        </EsdFinderRunProvider>
      </OrderWriteUpsRunProvider>
    </ActiveRunsProvider>
  )
}

/** Inverse guard for /login and /create-account — an already-logged-in user shouldn't see those again. */
export function RequireGuest() {
  const { status } = useAuth()

  if (status === 'loading') return null
  if (status === 'authenticated') return <Navigate to="/repair-orders" replace />
  return <Outlet />
}
