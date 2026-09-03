import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

/**
 * A registry of every tab's currently-running job, so the sidebar can show
 * what is in flight without knowing anything about the individual tabs.
 *
 * WHY (2026-08-27, explicit user direction): tasks now run in parallel —
 * write-ups, the ESD writer and quotes can all be going at once, and you
 * need to see that from wherever you happen to be standing.
 *
 * Deliberately a REPORTING registry, not a controller. Each tab's own run
 * provider stays the single owner of its polling, its cancel semantics and
 * its phase names; it simply reports a small summary here. That keeps the
 * five tabs independent — a change to how quotes track a run cannot break
 * the ESD Finder — and means the sidebar has exactly one thing to render
 * rather than five special cases.
 */

/** Nav paths are the key: the sidebar already keys off them, so a badge lines up with no extra mapping. */
export type RunKey =
  | '/order-write-ups'
  | '/esd-finder'
  | '/email-quotes'
  | '/scrapped-parts'
  | '/invoice-price-writer'
  | '/backshop-repairs'

export interface RunActivity {
  /** Present and running. Absent from the map entirely when idle. */
  running: boolean
  /** Short phase word the backend already reports, e.g. "inferring", "writing". */
  phase?: string | null
  /** Completed count, when the tab knows one. */
  done?: number
  /** Total expected, when the tab knows one. */
  total?: number
}

interface ActiveRunsContextValue {
  activity: Readonly<Partial<Record<RunKey, RunActivity>>>
  report: (key: RunKey, activity: RunActivity | null) => void
  /** How many tabs are running something right now. */
  runningCount: number
}

const ActiveRunsContext = createContext<ActiveRunsContextValue | null>(null)

export function ActiveRunsProvider({ children }: { children: ReactNode }) {
  const [activity, setActivity] = useState<Partial<Record<RunKey, RunActivity>>>({})

  const report = useCallback((key: RunKey, next: RunActivity | null) => {
    setActivity((prev) => {
      const current = prev[key]
      // Drop the entry entirely when idle, so "is anything running" stays a
      // simple key count rather than a scan for running === false.
      if (!next || !next.running) {
        if (!current) return prev
        const copy = { ...prev }
        delete copy[key]
        return copy
      }
      // Skip no-op updates — this is called from inside polling loops, and
      // a new object every tick would re-render the whole sidebar twice a
      // second for no visible change.
      if (
        current &&
        current.running === next.running &&
        current.phase === next.phase &&
        current.done === next.done &&
        current.total === next.total
      ) {
        return prev
      }
      return { ...prev, [key]: next }
    })
  }, [])

  const value = useMemo<ActiveRunsContextValue>(
    () => ({ activity, report, runningCount: Object.keys(activity).length }),
    [activity, report],
  )

  return <ActiveRunsContext.Provider value={value}>{children}</ActiveRunsContext.Provider>
}

export function useActiveRuns(): ActiveRunsContextValue {
  const ctx = useContext(ActiveRunsContext)
  if (!ctx) throw new Error('useActiveRuns must be used within ActiveRunsProvider')
  return ctx
}

/**
 * Reports one tab's activity for as long as the calling provider is
 * mounted, and clears it on unmount.
 *
 * The unmount clear matters: these providers live inside RequireAuth, so a
 * logout unmounts them all at once. Without it the sidebar would keep
 * showing jobs as running against a session that no longer exists.
 */
export function useReportRunActivity(key: RunKey, activity: RunActivity | null): void {
  const { report } = useActiveRuns()
  const running = activity?.running ?? false
  const phase = activity?.phase ?? null
  const done = activity?.done
  const total = activity?.total

  useEffect(() => {
    report(key, running ? { running, phase, done, total } : null)
  }, [report, key, running, phase, done, total])

  useEffect(() => {
    return () => report(key, null)
  }, [report, key])
}
