import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { getActiveJob, getRunLog, getRunStatus, type RunLogEvent, type RunStatusResponse } from './api'

/**
 * CLAUDE_CODE_PROMPT_WRITEUP_FAILSAFE.md frontend QOL #2 — the execute job
 * is a server-side child process with a single-flight activeRunId; it keeps
 * running regardless of what the UI does. Previously, OrderWriteUps.tsx
 * owned the run/events/polling state directly, so navigating away
 * (unmounting the page) tore all of it down and re-mounting started from
 * nothing — the run itself was fine, only the UI's own tracking was
 * fragile. Lifting that state and its polling loop into a provider mounted
 * once at the app root (see main.tsx) means it survives route changes:
 * this poll loop never stops just because the page showing it isn't
 * currently mounted, and a fresh page mount re-reads whatever this
 * provider already knows rather than starting over.
 */

const POLL_MS = 2000

interface ExecuteRunContextValue {
  runId: string | null
  run: RunStatusResponse | null
  events: RunLogEvent[]
  totalLines: number
  /** True once the tracked run has reached a terminal status. False if nothing is tracked. */
  done: boolean
  /** Called right after POST /api/execute succeeds, to start tracking the new run. */
  startTracking: (runId: string, totalLines: number) => void
  /** Called when the user explicitly starts a fresh flow (e.g. "Start another run"). */
  clearTracking: () => void
}

const ExecuteRunContext = createContext<ExecuteRunContextValue | null>(null)

export function ExecuteRunProvider({ children }: { children: ReactNode }) {
  const [runId, setRunId] = useState<string | null>(null)
  const [run, setRun] = useState<RunStatusResponse | null>(null)
  const [events, setEvents] = useState<RunLogEvent[]>([])
  const [totalLines, setTotalLines] = useState(0)
  const seqRef = useRef(-1)
  const attachedRef = useRef(false)

  // Re-attach to an already-running execute job exactly once, on the
  // provider's own first mount (app start) — not on every runId change.
  useEffect(() => {
    if (attachedRef.current) return
    attachedRef.current = true
    getActiveJob()
      .then((r) => {
        if (r.activeRunId && r.kind === 'execute') {
          seqRef.current = -1
          setEvents([])
          setRunId(r.activeRunId)
        }
      })
      .catch(() => {
        // Non-fatal — if nothing is genuinely active, polling simply never starts.
      })
  }, [])

  useEffect(() => {
    if (!runId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      try {
        const [status, logPage] = await Promise.all([getRunStatus(runId), getRunLog(runId, seqRef.current)])
        if (cancelled) return
        if (logPage.events.length > 0) {
          setEvents((prev) => [...prev, ...logPage.events])
          seqRef.current = logPage.latestSeq
        }
        setRun(status)
        if (status.status === 'running' || status.status === 'pending') {
          timer = setTimeout(tick, POLL_MS)
        }
      } catch {
        // A transient poll failure must never tear down the tracked run or
        // surface as a page-level error — the job itself is still running
        // server-side regardless of whether this one poll succeeded. Just
        // retry on the next tick, same as any other network hiccup would.
        if (!cancelled) timer = setTimeout(tick, POLL_MS)
      }
    }
    tick()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [runId])

  const startTracking = useCallback((newRunId: string, total: number) => {
    seqRef.current = -1
    setEvents([])
    setRun(null)
    setTotalLines(total)
    setRunId(newRunId)
  }, [])

  const clearTracking = useCallback(() => {
    seqRef.current = -1
    setRunId(null)
    setRun(null)
    setEvents([])
    setTotalLines(0)
  }, [])

  const done = run ? run.status !== 'running' && run.status !== 'pending' : false

  return (
    <ExecuteRunContext.Provider value={{ runId, run, events, totalLines, done, startTracking, clearTracking }}>
      {children}
    </ExecuteRunContext.Provider>
  )
}

// Standard context+hook pairing; splitting into a second file for HMR
// purity isn't worth it for a hook this small.
// eslint-disable-next-line react-refresh/only-export-components
export function useExecuteRun(): ExecuteRunContextValue {
  const ctx = useContext(ExecuteRunContext)
  if (!ctx) throw new Error('useExecuteRun must be used within ExecuteRunProvider')
  return ctx
}
