import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useReportRunActivity, type RunKey } from './activeRuns'

/**
 * One run-tracking provider, shared by the tabs whose job lifecycle is the
 * same shape: start → poll GET /runs/:id until terminal → done.
 *
 * WHY THIS EXISTS (2026-08-27): Vendor Quotes, Scrapped Parts and the
 * Invoice Price Writer each held their `runId` in page-local `useState`.
 * Navigating away unmounted the page, the runId went with it, and polling
 * stopped — while the backend job carried on invisibly. That is precisely
 * what breaks "run them all at once and toggle between them": the job was
 * fine, the UI just forgot about it.
 *
 * Order Write-Ups and the ESD Finder already solved this with their own
 * providers mounted in RequireAuth. Those two are deliberately NOT
 * rewritten to use this: they carry real per-tab complexity (two phases,
 * differing cancel semantics, an incremental log endpoint) that proved
 * itself in production, and collapsing them into a generic shape would risk
 * a regression for no behavioural gain. They report into the same registry
 * instead, so the sidebar sees all five identically.
 */

const POLL_MS = 2000

/** The minimum a run status must expose for this to track it. */
export interface TrackableRunStatus {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  phase?: string | null
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

export function isTerminalStatus(status: TrackableRunStatus['status'] | undefined): boolean {
  return !!status && TERMINAL.has(status)
}

export interface TrackedRunApi<T extends TrackableRunStatus> {
  /** Recovers a job already running server-side when the app (re)mounts. */
  getActive: () => Promise<{ activeRunId: string | null }>
  getRun: (runId: string) => Promise<T>
  cancelRun: (runId: string) => Promise<unknown>
  /** Optional progress for the sidebar badge, derived from the tab's own status shape. */
  progressOf?: (run: T) => { done?: number; total?: number }
}

export interface TrackedRunValue<T extends TrackableRunStatus> {
  runId: string | null
  run: T | null
  /** True until the initial "is something already running?" check completes, so pages don't flash an empty state over a live job. */
  attachChecked: boolean
  isRunning: boolean
  startTracking: (runId: string) => void
  cancel: () => Promise<void>
  clear: () => void
}

export function createTrackedRun<T extends TrackableRunStatus>(
  key: RunKey,
  displayName: string,
  api: TrackedRunApi<T>,
) {
  const Ctx = createContext<TrackedRunValue<T> | null>(null)

  function Provider({ children }: { children: ReactNode }) {
    const [runId, setRunId] = useState<string | null>(null)
    const [run, setRun] = useState<T | null>(null)
    const [attachChecked, setAttachChecked] = useState(false)
    const attachedRef = useRef(false)

    // Re-attach to whatever the server already has in flight. Without this,
    // a page refresh mid-run would show an idle tab while the job kept
    // going — the same "UI forgot" failure this provider exists to fix,
    // just triggered by reload instead of navigation.
    useEffect(() => {
      if (attachedRef.current) return
      attachedRef.current = true
      let cancelled = false
      void (async () => {
        try {
          const { activeRunId } = await api.getActive()
          if (!cancelled && activeRunId) setRunId(activeRunId)
        } catch {
          // Non-fatal: the tab simply starts idle, and the user can still
          // start a run (the backend refuses with a 409 naming the active
          // one if there genuinely is one).
        } finally {
          if (!cancelled) setAttachChecked(true)
        }
      })()
      return () => {
        cancelled = true
      }
    }, [])

    // Poll while a run is tracked and not yet terminal.
    useEffect(() => {
      if (!runId) return
      let stopped = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const tick = async () => {
        try {
          const next = await api.getRun(runId)
          if (stopped) return
          setRun(next)
          if (isTerminalStatus(next.status)) return // settled — stop polling
        } catch {
          // Keep polling through a transient failure rather than silently
          // abandoning a live run; a genuinely gone run resolves to a
          // terminal status soon enough.
        }
        if (!stopped) timer = setTimeout(() => void tick(), POLL_MS)
      }

      void tick()
      return () => {
        stopped = true
        if (timer) clearTimeout(timer)
      }
    }, [runId])

    const isRunning = !!runId && !isTerminalStatus(run?.status)

    const progress = run && api.progressOf ? api.progressOf(run) : undefined
    useReportRunActivity(key, isRunning ? { running: true, phase: run?.phase ?? null, ...progress } : null)

    const startTracking = useCallback((next: string) => {
      setRunId(next)
      setRun(null)
    }, [])

    const cancel = useCallback(async () => {
      if (!runId) return
      await api.cancelRun(runId)
      // Deliberately no local state change — the next poll reports the real
      // cancelled status. Marking it cancelled here would be the UI
      // asserting an outcome the backend has not confirmed.
    }, [runId])

    const clear = useCallback(() => {
      setRunId(null)
      setRun(null)
    }, [])

    return (
      <Ctx.Provider value={{ runId, run, attachChecked, isRunning, startTracking, cancel, clear }}>
        {children}
      </Ctx.Provider>
    )
  }

  function useTrackedRun(): TrackedRunValue<T> {
    const ctx = useContext(Ctx)
    if (!ctx) throw new Error(`use${displayName}Run must be used within its provider`)
    return ctx
  }

  return { Provider, useTrackedRun }
}
