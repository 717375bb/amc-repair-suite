import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  cancelRun,
  getActiveJob,
  getRunLog,
  getRunStatus,
  type DiscoveredLineSummary,
  type RunLogEvent,
  type RunStatusResponse,
} from './api'
import { useReportRunActivity } from './activeRuns'

/**
 * CLAUDE_CODE_PROMPT (persistent run state + cancel button) — supersedes
 * the earlier executeRun.tsx (execute-tracking only). Order Write-Ups now
 * has two phases that both need to survive navigating away and back:
 * discovery (the read) and execute (the write). Both live here, in one
 * provider mounted once at the app root (see main.tsx), so their polling
 * loops never stop just because the page showing them isn't currently
 * mounted, and a fresh page mount re-reads whatever this provider already
 * knows rather than starting over.
 *
 * Cancel semantics, per explicit user direction:
 * - Cancelling a discovery (read) run discards it entirely — nothing to
 *   preserve, since nothing was written.
 * - Cancelling an execute (write) run does NOT clear execute state — it's
 *   kept around (alongside the discovery run that fed it) specifically so
 *   the review screen can be shown again afterward with already-attempted
 *   lines excluded (see notYetAttemptedLines below) rather than either
 *   losing the original discovery snapshot or risking a duplicate order
 *   from re-running an already-completed line.
 */

const POLL_MS = 2000
const TERMINAL_STATUSES = new Set<RunStatusResponse['status']>(['completed', 'failed', 'partial', 'cancelled'])

function isTerminal(status: RunStatusResponse['status'] | undefined): boolean {
  return !!status && TERMINAL_STATUSES.has(status)
}

interface OrderWriteUpsRunContextValue {
  discoveryRunId: string | null
  discoveryRun: RunStatusResponse | null

  executeRunId: string | null
  executeRun: RunStatusResponse | null
  executeEvents: RunLogEvent[]

  /**
   * Only meaningful once both a discoveryRun and an executeRun are known
   * (i.e. after starting or reverting-from an execute run). Discovery
   * lines with status 'completed' (selectable) that have NOT yet appeared
   * as a terminal (non in_progress/retrying) execute-log entry — the safe
   * re-offer set after an execute cancel, so re-confirming can never
   * duplicate a line that already got a real order.
   */
  notYetAttemptedLines: DiscoveredLineSummary[] | null

  /** True once activeJob re-attachment has been checked at least once — lets the page distinguish "nothing tracked" from "still checking." */
  attachChecked: boolean

  startDiscoveryTracking: (runId: string) => void
  startExecuteTracking: (runId: string) => void
  /** Cancels whichever run (discovery or execute) is currently active. See the module docstring for what happens to state afterward. */
  cancelActive: () => Promise<void>
  /** Full reset — used by "Start another run." */
  clearAll: () => void
}

const OrderWriteUpsRunContext = createContext<OrderWriteUpsRunContextValue | null>(null)

export function OrderWriteUpsRunProvider({ children }: { children: ReactNode }) {
  const [discoveryRunId, setDiscoveryRunId] = useState<string | null>(null)
  const [discoveryRun, setDiscoveryRun] = useState<RunStatusResponse | null>(null)

  const [executeRunId, setExecuteRunId] = useState<string | null>(null)
  const [executeRun, setExecuteRun] = useState<RunStatusResponse | null>(null)
  const [executeEvents, setExecuteEvents] = useState<RunLogEvent[]>([])
  const executeSeqRef = useRef(-1)

  const [attachChecked, setAttachChecked] = useState(false)
  const attachedRef = useRef(false)

  // One-time fetch (not polling — a discovery run backing an execute run
  // is already terminal by definition) so the review screen has something
  // to render even after a fresh remount mid-execute.
  const loadDiscoverySnapshot = useCallback(async (runId: string) => {
    try {
      const status = await getRunStatus(runId)
      setDiscoveryRunId(runId)
      setDiscoveryRun(status)
    } catch {
      // Non-fatal — the review-after-cancel screen just won't have a
      // snapshot to show; the run itself is unaffected.
    }
  }, [])

  const startDiscoveryTracking = useCallback((runId: string) => {
    setDiscoveryRunId(runId)
    setDiscoveryRun(null)
  }, [])

  const startExecuteTracking = useCallback((runId: string) => {
    executeSeqRef.current = -1
    setExecuteEvents([])
    setExecuteRun(null)
    setExecuteRunId(runId)
  }, [])

  const clearAll = useCallback(() => {
    setDiscoveryRunId(null)
    setDiscoveryRun(null)
    executeSeqRef.current = -1
    setExecuteRunId(null)
    setExecuteRun(null)
    setExecuteEvents([])
  }, [])

  // Re-attach exactly once, on the provider's own first mount.
  useEffect(() => {
    if (attachedRef.current) return
    attachedRef.current = true
    getActiveJob()
      .then((r) => {
        if (r.activeRunId && r.kind === 'discovery') {
          startDiscoveryTracking(r.activeRunId)
        } else if (r.activeRunId && r.kind === 'execute') {
          startExecuteTracking(r.activeRunId)
        }
      })
      .catch(() => {
        // Non-fatal — if nothing is genuinely active, tracking simply never starts.
      })
      .finally(() => setAttachChecked(true))
  }, [startDiscoveryTracking, startExecuteTracking])

  // Discovery polling.
  useEffect(() => {
    if (!discoveryRunId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      try {
        const status = await getRunStatus(discoveryRunId)
        if (cancelled) return
        setDiscoveryRun(status)
        if (!isTerminal(status.status)) timer = setTimeout(tick, POLL_MS)
      } catch {
        if (!cancelled) timer = setTimeout(tick, POLL_MS)
      }
    }
    tick()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [discoveryRunId])

  // Execute polling — also back-fills the source discovery snapshot the
  // first time it's learned, so the review-after-cancel screen works even
  // when this provider never itself tracked that discovery run's live
  // progress (e.g. a fresh reattach straight into an execute run).
  useEffect(() => {
    if (!executeRunId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let discoverySnapshotRequested = false

    const tick = async () => {
      try {
        const [status, logPage] = await Promise.all([getRunStatus(executeRunId), getRunLog(executeRunId, executeSeqRef.current)])
        if (cancelled) return
        if (logPage.events.length > 0) {
          setExecuteEvents((prev) => [...prev, ...logPage.events])
          executeSeqRef.current = logPage.latestSeq
        }
        setExecuteRun(status)
        if (!discoverySnapshotRequested && status.sourceDiscoveryRunId) {
          discoverySnapshotRequested = true
          void loadDiscoverySnapshot(status.sourceDiscoveryRunId)
        }
        if (!isTerminal(status.status)) timer = setTimeout(tick, POLL_MS)
      } catch {
        if (!cancelled) timer = setTimeout(tick, POLL_MS)
      }
    }
    tick()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [executeRunId, loadDiscoverySnapshot])

  const cancelActive = useCallback(async () => {
    if (executeRunId && !isTerminal(executeRun?.status)) {
      await cancelRun(executeRunId)
      try {
        setExecuteRun(await getRunStatus(executeRunId))
      } catch {
        // The next poll tick will pick it up regardless.
      }
      return
    }
    if (discoveryRunId && !isTerminal(discoveryRun?.status)) {
      await cancelRun(discoveryRunId)
      // Per explicit user direction: a cancelled read is discarded, not kept around.
      setDiscoveryRunId(null)
      setDiscoveryRun(null)
    }
  }, [executeRunId, executeRun, discoveryRunId, discoveryRun])

  const notYetAttemptedLines = useMemo<DiscoveredLineSummary[] | null>(() => {
    if (!discoveryRun?.lines || !executeRun) return null
    const attemptedKeys = new Set(
      executeEvents
        .filter((e) => e.status !== 'in_progress' && e.status !== 'retrying')
        .map((e) => `${e.vendorId}::${e.partNumber}::${e.serialNumber}`),
    )
    return discoveryRun.lines.filter((l) => l.status === 'completed' && !attemptedKeys.has(l.lineId))
  }, [discoveryRun, executeRun, executeEvents])

  // Reports into the shared registry so the sidebar can show this tab as
  // running from anywhere. Read-only: this provider remains the single
  // owner of its own polling and cancel semantics.
  const owRunning =
    (!!discoveryRunId && !isTerminal(discoveryRun?.status)) || (!!executeRunId && !isTerminal(executeRun?.status))
  const owPhase =
    executeRunId && !isTerminal(executeRun?.status)
      ? 'writing'
      : discoveryRunId && !isTerminal(discoveryRun?.status)
        ? 'finding lines'
        : null
  useReportRunActivity('/order-write-ups', owRunning ? { running: true, phase: owPhase, done: executeEvents.length || undefined } : null)

  return (
    <OrderWriteUpsRunContext.Provider
      value={{
        discoveryRunId,
        discoveryRun,
        executeRunId,
        executeRun,
        executeEvents,
        notYetAttemptedLines,
        attachChecked,
        startDiscoveryTracking,
        startExecuteTracking,
        cancelActive,
        clearAll,
      }}
    >
      {children}
    </OrderWriteUpsRunContext.Provider>
  )
}

// Standard context+hook pairing; splitting into a second file for HMR
// purity isn't worth it for a hook this small.
// eslint-disable-next-line react-refresh/only-export-components
export function useOrderWriteUpsRun(): OrderWriteUpsRunContextValue {
  const ctx = useContext(OrderWriteUpsRunContext)
  if (!ctx) throw new Error('useOrderWriteUpsRun must be used within OrderWriteUpsRunProvider')
  return ctx
}
