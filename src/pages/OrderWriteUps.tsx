import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, Loader2, PlayCircle, RefreshCw, Search, XCircle } from 'lucide-react'
import { Badge, Card, CardHeader, PrimaryButton, SecondaryButton } from '../components/ui'
import {
  ApiError,
  getActiveJob,
  getRunStatus,
  getVendors,
  startDiscovery,
  startExecute,
  type DiscoveredLineSummary,
  type MxiEnv,
  type RunLogEvent,
  type RunStatusResponse,
  type VendorListEntry,
} from '../lib/api'
import { useExecuteRun } from '../lib/executeRun'

type Phase = 'select' | 'discovering' | 'review' | 'executing' | 'execute-done'

const POLL_MS = 2000
const CLOCK_TICK_MS = 15000

/**
 * "Snapshot age" / "elapsed time" displays need the current time, but
 * reading Date.now() directly in a render body is an impure read (React's
 * purity rules flag it — a render should be a deterministic function of
 * props/state). This hook makes "now" real state instead, ticking on an
 * interval so those displays still update live without a per-render impure read.
 */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

// ---------------------------------------------------------------------------
// Environment selector — stage is always the default; production requires a
// separate, explicit confirmation before it can be used to Run or Confirm.
// ---------------------------------------------------------------------------
function EnvironmentBar({
  env,
  onChange,
  disabled,
}: {
  env: MxiEnv
  onChange: (env: MxiEnv) => void
  disabled: boolean
}) {
  const [showProdConfirm, setShowProdConfirm] = useState(false)

  return (
    <div
      className={`flex items-center justify-between rounded-md border px-4 py-2.5 ${
        env === 'production' ? 'border-danger bg-danger-soft' : 'border-border bg-surface'
      }`}
    >
      <div className="flex items-center gap-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Environment</span>
        <div className="flex overflow-hidden rounded-md border border-border">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange('stage')}
            className={`px-3 py-1 text-sm font-medium ${env === 'stage' ? 'bg-accent text-white' : 'bg-surface text-text hover:bg-bg'}`}
          >
            Stage
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              if (env !== 'production') setShowProdConfirm(true)
            }}
            className={`px-3 py-1 text-sm font-medium ${env === 'production' ? 'bg-danger text-white' : 'bg-surface text-text hover:bg-bg'}`}
          >
            Production
          </button>
        </div>
      </div>
      {env === 'production' && (
        <span className="flex items-center gap-1.5 text-xs font-semibold text-danger">
          <AlertTriangle size={14} />
          Writes will hit REAL Maintenix data
        </span>
      )}

      {showProdConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <Card className="w-full max-w-md p-6">
            <div className="flex items-center gap-2 text-danger">
              <AlertTriangle size={20} />
              <h3 className="text-sm font-semibold">Switch to Production?</h3>
            </div>
            <p className="mt-3 text-sm text-text">
              Writes from this run will hit <strong>real Maintenix data</strong>. This is not the default — confirm
              this is intentional before proceeding.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <SecondaryButton onClick={() => setShowProdConfirm(false)}>Cancel</SecondaryButton>
              <PrimaryButton
                onClick={() => {
                  onChange('production')
                  setShowProdConfirm(false)
                }}
              >
                Yes, use Production
              </PrimaryButton>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// A single log/line row — color-coded, plain-English summary first, full
// technical detail collapsed behind a toggle. Never infers success from the
// absence of an error: every row renders exactly the backend-reported status.
// ---------------------------------------------------------------------------
function statusVisual(status: RunLogEvent['status'] | DiscoveredLineSummary['status']) {
  switch (status) {
    case 'completed':
      return { icon: CheckCircle2, className: 'text-success', border: 'border-l-success' }
    case 'exception':
      return { icon: AlertTriangle, className: 'text-warning', border: 'border-l-warning' }
    case 'skipped':
      return { icon: XCircle, className: 'text-muted', border: 'border-l-border' }
    case 'retrying':
      // Distinct from 'exception': this is not a needs-review state, it's
      // a transient hiccup the backend is already automatically retrying
      // (see CLAUDE_CODE_PROMPT_WRITEUP_FAILSAFE.md's Layer 3 second pass).
      return { icon: RefreshCw, className: 'text-accent animate-spin', border: 'border-l-accent' }
    case 'in_progress':
    default:
      return { icon: Loader2, className: 'text-accent animate-spin', border: 'border-l-accent' }
  }
}

function LogRow({ event }: { event: RunLogEvent }) {
  const [showDetail, setShowDetail] = useState(false)
  const { icon: Icon, className, border } = statusVisual(event.status)

  return (
    <div className={`border-l-4 ${border} bg-surface px-4 py-3`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <Icon size={16} className={`mt-0.5 shrink-0 ${className}`} />
          <div>
            <p className="text-sm font-medium text-text">
              {event.vendorDisplayName} — {event.description} (PN: {event.partNumber}, SN: {event.serialNumber})
            </p>
            <p className="mt-0.5 text-sm text-muted">{event.summary}</p>
          </div>
        </div>
        {event.detail && (
          <button type="button" onClick={() => setShowDetail((s) => !s)} className="shrink-0 text-xs text-accent hover:underline">
            {showDetail ? 'Hide' : 'Show'} technical details
          </button>
        )}
      </div>
      {showDetail && event.detail && (
        <pre className="mt-2 whitespace-pre-wrap rounded bg-bg p-2.5 text-xs text-muted">{event.detail}</pre>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function OrderWriteUps() {
  const [phase, setPhase] = useState<Phase>('select')
  const [env, setEnv] = useState<MxiEnv>('stage')
  const [vendors, setVendors] = useState<VendorListEntry[]>([])
  const [selectedVendorIds, setSelectedVendorIds] = useState<Set<string>>(new Set())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeJobRunId, setActiveJobRunId] = useState<string | null>(null)

  const [discoveryRun, setDiscoveryRun] = useState<RunStatusResponse | null>(null)
  const [selectedLineIds, setSelectedLineIds] = useState<Set<string>>(new Set())

  // CLAUDE_CODE_PROMPT_WRITEUP_FAILSAFE.md frontend QOL #2 — execute run
  // state + its polling loop now live in a provider mounted at the app
  // root (see main.tsx), not in this page component, so they survive
  // navigating away and back. See lib/executeRun.tsx's own docstring.
  const { runId: trackedExecuteRunId, run: executeRun, events: executeEvents, totalLines: executeTotalLines, done: executeDone, startTracking, clearTracking } = useExecuteRun()

  // Initial load: vendor list + whether a job is already active (State A's
  // "disabled while a job is active, with a link to the running job").
  useEffect(() => {
    getVendors()
      .then(setVendors)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : String(err)))
    getActiveJob()
      .then((r) => setActiveJobRunId(r.activeRunId))
      .catch(() => {
        /* non-fatal — Run will surface a 409 if a job really is active */
      })
  }, [])

  // Re-attach, derived rather than synced via an effect (no setState-in-
  // effect cascade): whenever a tracked execute run exists and the raw
  // local `phase` hasn't itself advanced past 'select' (either this page
  // just mounted fresh while a run from earlier in the session is still
  // going, or the ExecuteRunProvider re-attached to an already-running job
  // on app start), the execute view is what should actually render —
  // regardless of what `phase` itself says. Once `phase` is explicitly
  // 'discovering' or 'review', those take priority (a tracked run only
  // ever means an EARLIER execute step, never overrides in-flight discovery).
  const effectivePhase: Phase =
    phase === 'discovering' || phase === 'review'
      ? phase
      : trackedExecuteRunId
        ? (executeDone ? 'execute-done' : 'executing')
        : phase

  const toggleVendor = (id: string) => {
    setSelectedVendorIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleRun = async () => {
    setLoadError(null)
    try {
      const { runId } = await startDiscovery([...selectedVendorIds], env)
      setPhase('discovering')
      pollDiscovery(runId)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setLoadError(`A job is already running (${err.activeRunId ?? 'unknown'}).`)
      } else {
        setLoadError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  const pollDiscovery = useCallback((runId: string) => {
    const tick = async () => {
      try {
        const status = await getRunStatus(runId)
        setDiscoveryRun(status)
        if (status.status === 'running' || status.status === 'pending') {
          setTimeout(tick, POLL_MS)
        } else {
          // All lines default-selected, per State B's spec — exceptions are
          // never selectable (informational only).
          const selectable = (status.lines ?? []).filter((l) => l.status === 'completed').map((l) => l.lineId)
          setSelectedLineIds(new Set(selectable))
          setPhase('review')
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err))
      }
    }
    tick()
  }, [])

  const toggleLine = (id: string) => {
    setSelectedLineIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleConfirm = async () => {
    if (!discoveryRun) return
    setLoadError(null)
    try {
      const { executeRunId } = await startExecute(discoveryRun.runId, [...selectedLineIds], env)
      startTracking(executeRunId, selectedLineIds.size)
      setPhase('executing')
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setLoadError(`A job is already running (${err.activeRunId ?? 'unknown'}).`)
      } else {
        setLoadError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  // Frontend QOL #3 (Brayden, confirmed 2026-08-10): a manual "retry these"
  // control alongside the automatic second pass. Reuses /api/execute as-is
  // (no new backend endpoint) — lineIds are deterministically reconstructible
  // as `${vendorId}::${partNumber}::${serialNumber}` (see jobManager.ts's own
  // lineIdFor), matching the ORIGINAL discovery run's still-in-scope lines
  // (a line execute-time-failed but discovery-time-eligible is still
  // 'completed'/selectable there). Only available within the same session
  // that ran discovery — if this page was freshly re-mounted mid-run
  // (discoveryRun lost, execute run re-attached from the provider instead),
  // this control simply doesn't render; a known, acceptable limitation.
  const handleRetryFailed = async () => {
    if (!discoveryRun) return
    const failedLineIds = [
      ...new Set(
        executeEvents
          .filter((e) => e.status === 'exception' || e.status === 'skipped')
          .map((e) => `${e.vendorId}::${e.partNumber}::${e.serialNumber}`),
      ),
    ]
    if (failedLineIds.length === 0) return
    setLoadError(null)
    try {
      const { executeRunId } = await startExecute(discoveryRun.runId, failedLineIds, env)
      startTracking(executeRunId, failedLineIds.length)
      setPhase('executing')
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setLoadError(`A job is already running (${err.activeRunId ?? 'unknown'}).`)
      } else {
        setLoadError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  const resetToStart = () => {
    setPhase('select')
    setDiscoveryRun(null)
    clearTracking()
    setSelectedLineIds(new Set())
    setSelectedVendorIds(new Set())
    getActiveJob()
      .then((r) => setActiveJobRunId(r.activeRunId))
      .catch(() => {})
  }

  const jobIsActive =
    effectivePhase === 'discovering' || effectivePhase === 'executing' || (!!activeJobRunId && effectivePhase === 'select')

  return (
    <div className="space-y-5" data-workflow="order-write-ups">
      <EnvironmentBar env={env} onChange={setEnv} disabled={effectivePhase !== 'select'} />

      {loadError && (
        <div className="rounded-md border border-l-4 border-danger border-l-danger bg-danger-soft px-4 py-3 text-sm text-text">
          {loadError}
        </div>
      )}

      {activeJobRunId && effectivePhase === 'select' && (
        <div className="flex items-center justify-between rounded-md border border-l-4 border-warning border-l-warning bg-warning-soft px-4 py-3 text-sm text-text">
          <span>A write-up job is already running ({activeJobRunId}). Wait for it to finish before starting a new one.</span>
        </div>
      )}

      {effectivePhase === 'select' && (
        <SelectState
          vendors={vendors}
          selectedVendorIds={selectedVendorIds}
          onToggleVendor={toggleVendor}
          onRun={handleRun}
          disabled={jobIsActive}
        />
      )}

      {effectivePhase === 'discovering' && <RunningBanner label="Running discovery" env={env} />}

      {effectivePhase === 'review' && discoveryRun && (
        <ReviewState
          run={discoveryRun}
          selectedLineIds={selectedLineIds}
          onToggleLine={toggleLine}
          onSelectAll={(ids) => setSelectedLineIds(new Set(ids))}
          onConfirm={handleConfirm}
          onCancel={resetToStart}
        />
      )}

      {(effectivePhase === 'executing' || effectivePhase === 'execute-done') && (
        <ExecuteState
          run={executeRun}
          events={executeEvents}
          totalLines={executeTotalLines}
          done={effectivePhase === 'execute-done'}
          onReset={resetToStart}
          onRetryFailed={discoveryRun ? handleRetryFailed : undefined}
        />
      )}
    </div>
  )
}

function RunningBanner({ label, env }: { label: string; env: MxiEnv }) {
  return (
    <Card className="flex items-center gap-3 p-6">
      <Loader2 size={20} className="animate-spin text-accent" />
      <div>
        <p className="text-sm font-semibold text-text">
          {label} ({env})...
        </p>
        <p className="mt-0.5 text-xs text-muted">This can take a few minutes — results appear once discovery finishes.</p>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// State A — Select
// ---------------------------------------------------------------------------
function SelectState({
  vendors,
  selectedVendorIds,
  onToggleVendor,
  onRun,
  disabled,
}: {
  vendors: VendorListEntry[]
  selectedVendorIds: Set<string>
  onToggleVendor: (id: string) => void
  onRun: () => void
  disabled: boolean
}) {
  const canRun = !disabled && selectedVendorIds.size > 0 && vendors.length > 0

  const [query, setQuery] = useState('')
  // Filters by vendor code OR name — selection state (selectedVendorIds) is
  // keyed by id and untouched by the filter, so narrowing the list never
  // silently deselects a vendor picked before a search term was typed.
  const filteredVendors = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return vendors
    return vendors.filter((v) => v.code?.toLowerCase().includes(q) || v.displayName.toLowerCase().includes(q))
  }, [vendors, query])

  return (
    <Card className={disabled ? 'opacity-60' : ''}>
      <CardHeader title="Select vendors" description="Choose which write-up workflows to scan for open, eligible lines." />
      <div className="border-b border-border px-5 py-3">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={disabled}
            placeholder="Search by vendor code or name..."
            className="w-full rounded-md border border-border bg-bg py-2 pl-9 pr-3 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>
      </div>
      <div className="divide-y divide-border">
        {filteredVendors.map((v) => (
          <label
            key={v.id}
            className={`flex items-center justify-between px-5 py-3 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-bg'}`}
          >
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                disabled={disabled}
                checked={selectedVendorIds.has(v.id)}
                onChange={() => onToggleVendor(v.id)}
                className="h-4 w-4 rounded border-border accent-accent"
              />
              <span className="text-sm text-text">
                {v.code ? <span className="font-medium text-accent">{v.code}</span> : null}
                {v.code ? ' — ' : ''}
                {v.displayName}
              </span>
            </div>
            <Badge tone="neutral">{v.searchKind === 'partNumber' ? 'Part number list' : 'Vendor code search'}</Badge>
          </label>
        ))}
        {vendors.length === 0 && <p className="px-5 py-6 text-sm text-muted">Loading vendors...</p>}
        {vendors.length > 0 && filteredVendors.length === 0 && (
          <p className="px-5 py-6 text-sm text-muted">No vendors match "{query}".</p>
        )}
      </div>
      <div className="flex justify-end border-t border-border px-5 py-4">
        <PrimaryButton onClick={onRun} disabled={!canRun}>
          <PlayCircle size={16} />
          Run
        </PrimaryButton>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// State B — Review
// ---------------------------------------------------------------------------
function ReviewState({
  run,
  selectedLineIds,
  onToggleLine,
  onSelectAll,
  onConfirm,
  onCancel,
}: {
  run: RunStatusResponse
  selectedLineIds: Set<string>
  onToggleLine: (id: string) => void
  onSelectAll: (ids: string[]) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const lines = run.lines ?? []
  const selectable = lines.filter((l) => l.status === 'completed')
  const exceptions = lines.filter((l) => l.status === 'exception')

  const now = useNow(CLOCK_TICK_MS)
  const ageMinutes = run.completedAt ? Math.round((now - new Date(run.completedAt).getTime()) / 60000) : 0
  const isStale = ageMinutes > 15

  return (
    <div className="space-y-4">
      <div
        className={`flex items-center gap-2 rounded-md border px-4 py-2.5 text-sm ${
          isStale ? 'border-warning bg-warning-soft text-text' : 'border-border bg-surface text-muted'
        }`}
      >
        <Clock size={15} className={isStale ? 'text-warning' : 'text-muted'} />
        Discovered {ageMinutes} minute{ageMinutes === 1 ? '' : 's'} ago.
        {isStale && ' This snapshot is getting old — lines may have already been handled elsewhere. Consider re-running discovery.'}
      </div>

      <Card>
        <CardHeader
          title="Eligible lines"
          description={`${selectable.length} line(s) ready to write up — all selected by default.`}
          action={
            <div className="flex gap-2">
              <SecondaryButton onClick={() => onSelectAll(selectable.map((l) => l.lineId))}>Select all</SecondaryButton>
              <SecondaryButton onClick={() => onSelectAll([])}>Select none</SecondaryButton>
            </div>
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
                <th className="px-5 py-3 font-medium"></th>
                <th className="px-5 py-3 font-medium">Part No</th>
                <th className="px-5 py-3 font-medium">Serial</th>
                <th className="px-5 py-3 font-medium">Description</th>
                <th className="px-5 py-3 font-medium">Vendor</th>
                <th className="px-5 py-3 font-medium">Routing / Location</th>
              </tr>
            </thead>
            <tbody>
              {selectable.map((line) => (
                <tr key={line.lineId} className="border-b border-border last:border-0 hover:bg-bg">
                  <td className="px-5 py-3">
                    <input
                      type="checkbox"
                      checked={selectedLineIds.has(line.lineId)}
                      onChange={() => onToggleLine(line.lineId)}
                      className="h-4 w-4 rounded border-border accent-accent"
                    />
                  </td>
                  <td className="px-5 py-3 text-text">{line.partNumber}</td>
                  <td className="px-5 py-3 text-text">{line.serialNumber}</td>
                  <td className="px-5 py-3 text-muted">{line.description}</td>
                  <td className="px-5 py-3 text-muted">{line.vendorDisplayName}</td>
                  <td className="px-5 py-3 text-muted">{line.routedTo ?? '—'}</td>
                </tr>
              ))}
              {selectable.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-6 text-center text-muted">
                    No eligible lines found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {exceptions.length > 0 && (
        <Card className="border-warning">
          <CardHeader title="Exceptions — needs manual review" description={`${exceptions.length} line(s) found but not selectable.`} />
          <div className="divide-y divide-border">
            {Object.entries(
              exceptions.reduce<Record<string, DiscoveredLineSummary[]>>((acc, l) => {
                const key = l.exceptionType ?? 'other'
                ;(acc[key] ??= []).push(l)
                return acc
              }, {}),
            ).map(([type, group]) => (
              <div key={type} className="border-l-4 border-l-warning bg-warning-soft/40 px-5 py-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-warning">
                  {type.replace(/_/g, ' ')} ({group.length})
                </p>
                <ul className="space-y-1.5">
                  {group.map((line) => (
                    <li key={line.lineId} className="text-sm text-text">
                      <span className="font-medium">
                        {line.partNumber} / {line.serialNumber}
                      </span>{' '}
                      <span className="text-muted">— {line.summary}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="flex justify-end gap-2">
        <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
        <PrimaryButton onClick={onConfirm}>
          <CheckCircle2 size={16} />
          Confirm ({selectedLineIds.size} line{selectedLineIds.size === 1 ? '' : 's'})
        </PrimaryButton>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// State C — Execute
// ---------------------------------------------------------------------------
function ExecuteState({
  run,
  events,
  totalLines,
  done,
  onReset,
  onRetryFailed,
}: {
  run: RunStatusResponse | null
  events: RunLogEvent[]
  totalLines: number
  done: boolean
  onReset: () => void
  /** Undefined when the original discovery run is out of scope (e.g. this page was freshly re-mounted mid-run) — the manual retry control simply doesn't render then. */
  onRetryFailed?: () => void
}) {
  const counts = run?.counts ?? { completed: 0, skipped: 0, exception: 0, inProgress: 0, total: 0 }
  const currentLine = Math.min(counts.total + (counts.inProgress > 0 ? 1 : 0), totalLines || counts.total)
  const now = useNow(CLOCK_TICK_MS)
  const startedAt = run?.startedAt ? new Date(run.startedAt).getTime() : now
  const elapsedMinutes = Math.round((now - startedAt) / 60000)
  const progressPct = totalLines > 0 ? Math.round((counts.total / totalLines) * 100) : 0
  const failedCount = done ? events.filter((e) => e.status === 'exception' || e.status === 'skipped').length : 0

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-text">
              {done ? 'Run finished' : `Line ${currentLine} of ${totalLines}`}
            </p>
            <p className="mt-1 text-xs text-muted">
              {counts.completed} completed · {counts.exception} need review · {counts.skipped} skipped ·{' '}
              {Math.max(totalLines - counts.total, 0)} remaining · elapsed {elapsedMinutes} min. Runs typically take
              60-90 seconds per line, so this can take a while — it isn't hung.
            </p>
            {!done && (
              <div className="mt-2 h-1.5 w-64 overflow-hidden rounded-full bg-bg">
                <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${progressPct}%` }} />
              </div>
            )}
          </div>
          {run && (
            <Badge tone={run.status === 'failed' ? 'danger' : run.status === 'partial' ? 'warning' : run.status === 'completed' ? 'success' : 'accent'}>
              {run.status}
            </Badge>
          )}
        </div>
        {run?.fatalError && (
          <div className="mt-3 rounded-md border border-danger bg-danger-soft px-3 py-2 text-sm text-text">
            <strong>Run halted:</strong> {run.fatalError}
          </div>
        )}
      </Card>

      <div className="space-y-2">
        {events
          .filter((e) => e.status !== 'in_progress')
          // Frontend QOL #1 — newest line on top: reversed for display only,
          // the underlying events array (and its seq ordering) is untouched.
          .slice()
          .reverse()
          .map((e, i) => (
            <LogRow key={`${e.seq}-${i}`} event={e} />
          ))}
        {events.length === 0 && !done && <p className="px-2 text-sm text-muted">Waiting for the first line to finish...</p>}
      </div>

      {done && (
        <div className="flex items-center justify-end gap-2">
          {onRetryFailed && failedCount > 0 && (
            <SecondaryButton onClick={onRetryFailed}>
              <RefreshCw size={16} />
              Retry {failedCount} failed line{failedCount === 1 ? '' : 's'}
            </SecondaryButton>
          )}
          <PrimaryButton onClick={onReset}>Start another run</PrimaryButton>
        </div>
      )}
    </div>
  )
}
