import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  cancelEsdRun,
  getActiveEsdJob,
  getEsdRunStatus,
  type EsdRunStatusResponse,
} from './esdFinderApi'
import { useReportRunActivity } from './activeRuns'

/**
 * CLAUDE_CODE_PROMPT (persistent run state + cancel button) — symmetric to
 * lib/orderWriteUpsRun.tsx for the ESD Finder tab's own two phases
 * (compare = read, write = write). See that file's docstring for the full
 * rationale (mounted once at the app root inside RequireAuth, survives
 * navigation, cancel semantics differ by phase).
 *
 * Unlike Order Write-Ups, there's no separate incremental log endpoint
 * here — GET /api/esd/runs/:runId already returns the full current
 * writeResults array (and compare's own `phase` string) on every poll, so
 * polling is a single fetch per tick, not two.
 */

const POLL_MS = 2000
const TERMINAL_STATUSES = new Set<EsdRunStatusResponse['status']>(['completed', 'failed', 'cancelled'])

function isTerminal(status: EsdRunStatusResponse['status'] | undefined): boolean {
  return !!status && TERMINAL_STATUSES.has(status)
}

interface EsdFinderRunContextValue {
  compareRunId: string | null
  compareRun: EsdRunStatusResponse | null

  writeRunId: string | null
  writeRun: EsdRunStatusResponse | null

  attachChecked: boolean

  startCompareTracking: (runId: string) => void
  startWriteTracking: (runId: string) => void
  /** Cancels whichever run (compare or write) is currently active. Cancelling a compare discards it; cancelling a write keeps both runs tracked so the review screen can reappear. */
  cancelActive: () => Promise<void>
  /** Full reset — used by "Start another run." */
  clearAll: () => void
}

const EsdFinderRunContext = createContext<EsdFinderRunContextValue | null>(null)

export function EsdFinderRunProvider({ children }: { children: ReactNode }) {
  const [compareRunId, setCompareRunId] = useState<string | null>(null)
  const [compareRun, setCompareRun] = useState<EsdRunStatusResponse | null>(null)

  const [writeRunId, setWriteRunId] = useState<string | null>(null)
  const [writeRun, setWriteRun] = useState<EsdRunStatusResponse | null>(null)

  const [attachChecked, setAttachChecked] = useState(false)
  const attachedRef = useRef(false)

  const loadCompareSnapshot = useCallback(async (runId: string) => {
    try {
      const status = await getEsdRunStatus(runId)
      setCompareRunId(runId)
      setCompareRun(status)
    } catch {
      // Non-fatal — the review-after-cancel screen just won't have a snapshot to show.
    }
  }, [])

  const startCompareTracking = useCallback((runId: string) => {
    setCompareRunId(runId)
    setCompareRun(null)
  }, [])

  const startWriteTracking = useCallback((runId: string) => {
    setWriteRunId(runId)
    setWriteRun(null)
  }, [])

  const clearAll = useCallback(() => {
    setCompareRunId(null)
    setCompareRun(null)
    setWriteRunId(null)
    setWriteRun(null)
  }, [])

  useEffect(() => {
    if (attachedRef.current) return
    attachedRef.current = true
    getActiveEsdJob()
      .then((r) => {
        if (r.activeRunId && r.kind === 'compare') {
          startCompareTracking(r.activeRunId)
        } else if (r.activeRunId && r.kind === 'write') {
          startWriteTracking(r.activeRunId)
        }
      })
      .catch(() => {
        // Non-fatal — if nothing is genuinely active, tracking simply never starts.
      })
      .finally(() => setAttachChecked(true))
  }, [startCompareTracking, startWriteTracking])

  // Compare polling.
  useEffect(() => {
    if (!compareRunId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      try {
        const status = await getEsdRunStatus(compareRunId)
        if (cancelled) return
        setCompareRun(status)
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
  }, [compareRunId])

  // Write polling — back-fills the source compare snapshot the first time
  // it's learned, same reasoning as orderWriteUpsRun.tsx's execute effect.
  useEffect(() => {
    if (!writeRunId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let compareSnapshotRequested = false

    const tick = async () => {
      try {
        const status = await getEsdRunStatus(writeRunId)
        if (cancelled) return
        setWriteRun(status)
        if (!compareSnapshotRequested && status.sourceCompareRunId) {
          compareSnapshotRequested = true
          void loadCompareSnapshot(status.sourceCompareRunId)
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
  }, [writeRunId, loadCompareSnapshot])

  const cancelActive = useCallback(async () => {
    if (writeRunId && !isTerminal(writeRun?.status)) {
      await cancelEsdRun(writeRunId)
      try {
        setWriteRun(await getEsdRunStatus(writeRunId))
      } catch {
        // The next poll tick will pick it up regardless.
      }
      return
    }
    if (compareRunId && !isTerminal(compareRun?.status)) {
      await cancelEsdRun(compareRunId)
      // Per explicit user direction: a cancelled read is discarded, not kept around.
      setCompareRunId(null)
      setCompareRun(null)
    }
  }, [writeRunId, writeRun, compareRunId, compareRun])

  // Same reporting contract as every other tab — see activeRuns.tsx.
  const esdRunning =
    (!!compareRunId && !isTerminal(compareRun?.status)) || (!!writeRunId && !isTerminal(writeRun?.status))
  const esdPhase =
    writeRunId && !isTerminal(writeRun?.status)
      ? (writeRun?.phase ?? 'writing')
      : compareRunId && !isTerminal(compareRun?.status)
        ? (compareRun?.phase ?? 'reading')
        : null
  useReportRunActivity('/esd-finder', esdRunning ? { running: true, phase: esdPhase } : null)

  return (
    <EsdFinderRunContext.Provider
      value={{
        compareRunId,
        compareRun,
        writeRunId,
        writeRun,
        attachChecked,
        startCompareTracking,
        startWriteTracking,
        cancelActive,
        clearAll,
      }}
    >
      {children}
    </EsdFinderRunContext.Provider>
  )
}

// Standard context+hook pairing; splitting into a second file for HMR
// purity isn't worth it for a hook this small.
// eslint-disable-next-line react-refresh/only-export-components
export function useEsdFinderRun(): EsdFinderRunContextValue {
  const ctx = useContext(EsdFinderRunContext)
  if (!ctx) throw new Error('useEsdFinderRun must be used within EsdFinderRunProvider')
  return ctx
}
