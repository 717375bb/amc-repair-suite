import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, ClipboardCopy, Loader2, Mail, PlayCircle, RefreshCw, Search, StopCircle, XCircle } from 'lucide-react'
import { Badge, Card, CardHeader, PrimaryButton, SecondaryButton } from '../components/ui'
import { ConfirmDialog } from '../components/ConfirmDialog'
import {
  ApiError,
  getActiveJob,
  getCraGroups,
  getVendors,
  startDiscovery,
  startExecute,
  draftMaintenanceRecordsEmail,
  type CraGroupEntry,
  type DiscoveredLineSummary,
  type MxiEnv,
  type RunLogEvent,
  type RunStatusResponse,
  type VendorListEntry,
} from '../lib/api'
import { useOrderWriteUpsRun } from '../lib/orderWriteUpsRun'

type Phase = 'select' | 'discovering' | 'review' | 'executing' | 'execute-done'

const CLOCK_TICK_MS = 15000

function isRunTerminal(status: RunStatusResponse['status'] | undefined): boolean {
  return !!status && status !== 'running' && status !== 'pending'
}

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
// Environment selector — production is the default (per explicit user
// instruction, 2026-08-19). Switching TO production still requires a
// separate, explicit confirmation before it can be used to Run or Confirm —
// that safety gate is independent of which environment loads by default.
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

// ---------------------------------------------------------------------------
// CLAUDE_CODE_PROMPT (email-maintenance-records button, 2026-08-14) — per
// explicit user instruction: a zero-times-and-cycles exception line gets a
// draft email to Maintenance Records, with the exact requested blurb plus
// the real times/cycles table for that specific part. Mechanism: a
// mailto: link (opens whatever mail client is registered as the OS
// default, pre-filled — user reviews and hits Send themselves, nothing is
// auto-sent) PLUS a Copy button right next to it, since a mailto: link
// does nothing useful on a machine with no registered handler (a real,
// plausible gap in a corporate Office365/Outlook-web environment — not a
// security block, just a missing association) — confirmed with the user
// before building this. Same plain-text "Usage Parm\tTSN\tTSO\tTSI" table
// shape already used in the real Notes to Vendor text elsewhere in this
// codebase (composeNotesForNormalLine), not a new format.
// ---------------------------------------------------------------------------
const MAINTENANCE_RECORDS_EMAIL = 'DL_PSA_MaintenanceRecords@psaairlines.com'
// Fixed by explicit user direction: every one of these carries this exact
// subject. Mirrors MAINTENANCE_RECORDS_SUBJECT in maintenanceRecordsDraft.ts.
const MAINTENANCE_RECORDS_SUBJECT = 'Times and Cycles'

/**
 * Kept ONLY for the "Copy draft" fallback button. The real draft is
 * composed server-side by maintenanceRecordsDraft.ts, which is the single
 * source of truth for wording, recipient and subject — this must stay in
 * step with it, and the backend's unit tests cover that wording.
 *
 * Two changes from the mailto: era, both per explicit user direction:
 * the subject is now always "Times and Cycles", and because of that the
 * part identity moved INTO the body. It used to live only in the subject,
 * so a fixed subject would have left the records team unable to tell which
 * part was meant.
 */
function buildMaintenanceRecordsEmailDraft(event: RunLogEvent): { subject: string; body: string } {
  const tableRows = (event.usageRows ?? []).map((row) => `${row.label}\t${row.tsn}\t${row.tso}\t${row.tsi}`)
  // Barcode above the table, order number below it — kept identical to the
  // server's composeMaintenanceRecordsBody, which this must mirror.
  const barcode = event.barcode?.trim()
  const orderNumber = event.orderNumber?.trim()
  const body = [
    'Good morning Maintenance Records team!',
    '',
    'This part is showing with zero times and cycles. Can you please have this corrected? Thank you!',
    '',
    `PN: ${event.partNumber}    SN: ${event.serialNumber}`,
    ...(barcode ? [`Barcode: ${barcode}`] : []),
    'Usage Parm\tTSN\tTSO\tTSI',
    ...tableRows,
    ...(orderNumber ? ['', `Order Number: ${orderNumber}`] : []),
  ].join('\n')
  return { subject: MAINTENANCE_RECORDS_SUBJECT, body }
}

function LogRow({ event }: { event: RunLogEvent }) {
  const [showDetail, setShowDetail] = useState(false)
  const [copied, setCopied] = useState(false)
  const [draftState, setDraftState] = useState<'idle' | 'drafting' | 'drafted'>('idle')
  const [draftError, setDraftError] = useState<string | null>(null)
  const { icon: Icon, className, border } = statusVisual(event.status)
  // Keyed off the usage rows being present, NOT off the exception type.
  //
  // REAL BUG FIXED (2026-08-28): this used to require
  // exceptionType === 'zero_usage'. The "Create Order Only" feature routes
  // every zero-usage USSTG line to 'order_created_do_not_ship' instead, and
  // effectively every line is USSTG — so no zero_usage event has fired
  // since 2026-08-07 and this button silently stopped appearing. The parts
  // still had zero times and cycles; Records just never got told.
  //
  // The rows are what the draft is built from, so their presence is the
  // honest condition. A future third path that carries them gets the button
  // for free instead of quietly losing it again.
  const showEmailDraft = !!event.usageRows?.length

  // Creates the draft in the analyst's own Outlook Drafts via the backend.
  // Nothing is sent — the send path exists server-side but is off, and the
  // analyst reviews and sends every message themselves.
  const handleDraft = async () => {
    setDraftError(null)
    setDraftState('drafting')
    try {
      await draftMaintenanceRecordsEmail({
        partNumber: event.partNumber,
        serialNumber: event.serialNumber,
        usageRows: event.usageRows ?? [],
        barcode: event.barcode ?? null,
        orderNumber: event.orderNumber ?? null,
      })
      setDraftState('drafted')
    } catch (err) {
      // Report it rather than silently reverting to idle — the whole point
      // of moving off mailto: was that a failure used to be invisible. The
      // Copy button next to this stays available as the manual path.
      setDraftState('idle')
      setDraftError(err instanceof Error ? err.message : 'Could not create the Outlook draft.')
    }
  }

  const handleCopy = async () => {
    const { body } = buildMaintenanceRecordsEmailDraft(event)
    try {
      await navigator.clipboard.writeText(body)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can fail (permissions, non-secure context) — the
      // mailto: link right next to this button is the primary path either way.
    }
  }

  return (
    <div className={`border-l-4 ${border} bg-surface px-4 py-3`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <Icon size={16} className={`mt-0.5 shrink-0 ${className}`} />
          <div>
            <p className="text-sm font-medium text-text">
              {event.vendorId.toUpperCase()} - {event.vendorDisplayName} — {event.description} (PN: {event.partNumber}, SN: {event.serialNumber})
            </p>
            <p className="mt-0.5 text-sm text-muted">{event.summary}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {showEmailDraft && (
            <>
              <button
                type="button"
                onClick={handleDraft}
                disabled={draftState === 'drafting'}
                className="flex items-center gap-1 text-xs text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                title={`Creates a draft to ${MAINTENANCE_RECORDS_EMAIL} in your Outlook Drafts. Nothing is sent.`}
              >
                <Mail size={13} />
                {draftState === 'drafting'
                  ? 'Drafting…'
                  : draftState === 'drafted'
                    ? 'Draft created in Outlook'
                    : 'Draft to Maintenance Records'}
              </button>
              <button type="button" onClick={handleCopy} className="flex items-center gap-1 text-xs text-accent hover:underline">
                <ClipboardCopy size={13} />
                {copied ? 'Copied!' : 'Copy draft'}
              </button>
            </>
          )}
          {event.detail && (
            <button type="button" onClick={() => setShowDetail((s) => !s)} className="text-xs text-accent hover:underline">
              {showDetail ? 'Hide' : 'Show'} technical details
            </button>
          )}
        </div>
      </div>
      {showDetail && event.detail && (
        <pre className="mt-2 whitespace-pre-wrap rounded bg-bg p-2.5 text-xs text-muted">{event.detail}</pre>
      )}
      {draftError && (
        <p className="mt-2 text-xs text-danger">
          Couldn&apos;t create the Outlook draft: {draftError} Use &quot;Copy draft&quot; and paste it into a new
          email to {MAINTENANCE_RECORDS_EMAIL} instead.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function OrderWriteUps() {
  const [env, setEnv] = useState<MxiEnv>('production')
  const [vendors, setVendors] = useState<VendorListEntry[]>([])
  const [craGroups, setCraGroups] = useState<CraGroupEntry[]>([])
  const [selectedVendorIds, setSelectedVendorIds] = useState<Set<string>>(new Set())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeJobRunId, setActiveJobRunId] = useState<string | null>(null)
  // CLAUDE_CODE_PROMPT (cancel button) — tracks DESELECTIONS from an
  // implicit "everything eligible is selected by default" baseline,
  // instead of the selected set itself. The eligible set changes out from
  // under this page (a fresh discovery completing, or an execute cancel
  // reverting to review with a smaller not-yet-attempted set) — deriving
  // "selected" as eligible-minus-deselected at render time means a new
  // eligible set is correctly all-selected for free, with no effect
  // needed to re-initialize anything (a stale deselected id from an
  // earlier, unrelated eligible set simply never matches any current row).
  const [deselectedLineIds, setDeselectedLineIds] = useState<Set<string>>(new Set())
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  // CLAUDE_CODE_PROMPT (persistent run state + cancel button) — discovery
  // AND execute state + their polling loops both live in a provider
  // mounted at the app root (see components/RequireAuth.tsx), not in this
  // page component, so they survive navigating away and back. See
  // lib/orderWriteUpsRun.tsx's own docstring for the full design,
  // including cancel semantics and notYetAttemptedLines.
  const {
    discoveryRunId,
    discoveryRun,
    executeRunId,
    executeRun,
    executeEvents,
    notYetAttemptedLines,
    startDiscoveryTracking,
    startExecuteTracking,
    cancelActive,
    clearAll,
  } = useOrderWriteUpsRun()

  // Initial load: vendor list + whether a job is already active (State A's
  // "disabled while a job is active, with a link to the running job").
  useEffect(() => {
    getVendors()
      .then(setVendors)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : String(err)))
    // Non-fatal if this fails — the CRA dropdown just won't offer any
    // options; it's a convenience on top of the existing vendor search,
    // never a requirement for the page to function.
    getCraGroups()
      .then(setCraGroups)
      .catch(() => {})
    getActiveJob()
      .then((r) => setActiveJobRunId(r.activeRunId))
      .catch(() => {
        /* non-fatal — Run will surface a 409 if a job really is active */
      })
  }, [])

  // Fully derived from context — no separate local `phase` state to keep
  // in sync. An execute run that was cancelled routes back to 'review'
  // (see the module docstring); everything else is a straightforward
  // "which run, if any, is tracked and is it done" read.
  const effectivePhase: Phase = useMemo(() => {
    if (executeRunId) {
      if (executeRun?.status === 'cancelled') return 'review'
      if (executeRun && isRunTerminal(executeRun.status)) return 'execute-done'
      return 'executing'
    }
    if (discoveryRunId) {
      if (discoveryRun && isRunTerminal(discoveryRun.status)) return 'review'
      return 'discovering'
    }
    return 'select'
  }, [executeRunId, executeRun, discoveryRunId, discoveryRun])

  const cancelledExecute = executeRunId && executeRun?.status === 'cancelled' ? executeRun : null

  // The current eligible set — every 'completed' discovery line normally,
  // or only the not-yet-attempted subset after an execute cancel (see the
  // module docstring for why re-offering an already-completed line would
  // risk a duplicate order).
  const eligibleLineIds = useMemo(() => {
    if (cancelledExecute) return new Set((notYetAttemptedLines ?? []).map((l) => l.lineId))
    if (discoveryRun?.lines) return new Set(discoveryRun.lines.filter((l) => l.status === 'completed').map((l) => l.lineId))
    return new Set<string>()
  }, [cancelledExecute, notYetAttemptedLines, discoveryRun])

  const selectedLineIds = useMemo(() => {
    const result = new Set<string>()
    for (const id of eligibleLineIds) if (!deselectedLineIds.has(id)) result.add(id)
    return result
  }, [eligibleLineIds, deselectedLineIds])

  const toggleVendor = (id: string) => {
    setSelectedVendorIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // CLAUDE_CODE_PROMPT (CRA/vendor grouping, 2026-08-19) — additive union,
  // never a replace: per explicit user instruction, picking a CRA from the
  // dropdown adds its vendors to whatever's already selected (including
  // vendors picked via the existing type-ahead search), and picking a
  // second CRA afterward keeps the first CRA's vendors checked too —
  // "multiple CRA's is allowed" means selecting several in sequence, not a
  // multi-select control.
  // Shared by the CRA dropdown and the "Select all" button — both are an
  // additive union into whatever's already selected, never a replace.
  const selectVendors = (vendorIds: string[]) => {
    setSelectedVendorIds((prev) => new Set([...prev, ...vendorIds]))
  }

  const deselectVendors = (vendorIds: string[]) => {
    setSelectedVendorIds((prev) => {
      const next = new Set(prev)
      for (const id of vendorIds) next.delete(id)
      return next
    })
  }

  const handleRun = async () => {
    setLoadError(null)
    try {
      const { runId } = await startDiscovery([...selectedVendorIds], env)
      startDiscoveryTracking(runId)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setLoadError(`A job is already running (${err.activeRunId ?? 'unknown'}).`)
      } else {
        setLoadError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  const toggleLine = (id: string) => {
    setDeselectedLineIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id) // re-select
      else next.add(id) // deselect
      return next
    })
  }

  const handleConfirm = async () => {
    if (!discoveryRun) return
    setLoadError(null)
    try {
      const { executeRunId: newExecuteRunId } = await startExecute(discoveryRun.runId, [...selectedLineIds], env)
      startExecuteTracking(newExecuteRunId)
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
  // 'completed'/selectable there).
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
      const { executeRunId: newExecuteRunId } = await startExecute(discoveryRun.runId, failedLineIds, env)
      startExecuteTracking(newExecuteRunId)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setLoadError(`A job is already running (${err.activeRunId ?? 'unknown'}).`)
      } else {
        setLoadError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  const resetToStart = () => {
    clearAll()
    setDeselectedLineIds(new Set())
    setSelectedVendorIds(new Set())
    getActiveJob()
      .then((r) => setActiveJobRunId(r.activeRunId))
      .catch(() => {})
  }

  // CLAUDE_CODE_PROMPT (cancel button) — the confirmation dialog's own copy
  // differs by phase: a cancelled read is silently discarded (nothing was
  // written), a cancelled write leaves already-completed lines' real orders
  // standing and returns to review with only the untouched lines re-offered.
  const handleCancelConfirmed = async () => {
    setShowCancelConfirm(false)
    setCancelling(true)
    try {
      await cancelActive()
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setCancelling(false)
    }
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
          craGroups={craGroups}
          selectedVendorIds={selectedVendorIds}
          onToggleVendor={toggleVendor}
          onSelectCra={selectVendors}
          onSelectVendors={selectVendors}
          onDeselectVendors={deselectVendors}
          onRun={handleRun}
          disabled={jobIsActive}
        />
      )}

      {effectivePhase === 'discovering' && (
        <RunningBanner label="Running discovery" env={env} onCancelClick={() => setShowCancelConfirm(true)} cancelling={cancelling} />
      )}

      {effectivePhase === 'review' && discoveryRun && (
        <ReviewState
          run={discoveryRun}
          selectedLineIds={selectedLineIds}
          onToggleLine={toggleLine}
          onSelectAll={(ids) => {
            const idSet = new Set(ids)
            setDeselectedLineIds(new Set([...eligibleLineIds].filter((id) => !idSet.has(id))))
          }}
          onConfirm={handleConfirm}
          onCancel={resetToStart}
          restrictToLineIds={cancelledExecute ? eligibleLineIds : null}
          cancelledExecuteSummary={cancelledExecute ? cancelledExecute.counts : null}
        />
      )}

      {(effectivePhase === 'executing' || effectivePhase === 'execute-done') && (
        <ExecuteState
          run={executeRun}
          events={executeEvents}
          totalLines={executeRun?.targetLineCount ?? 0}
          done={effectivePhase === 'execute-done'}
          onReset={resetToStart}
          onRetryFailed={discoveryRun ? handleRetryFailed : undefined}
          onCancelClick={effectivePhase === 'executing' ? () => setShowCancelConfirm(true) : undefined}
          cancelling={cancelling}
        />
      )}

      {showCancelConfirm && (
        <ConfirmDialog
          title={effectivePhase === 'discovering' ? 'Cancel this scan?' : 'Cancel this run?'}
          message={
            effectivePhase === 'discovering'
              ? "This will stop the scan where it's at and discard whatever's been found so far. Nothing was written, so there's nothing to undo."
              : "This will stop the run where it's at. Lines that already completed keep their real orders — only lines that haven't started yet are stopped. You'll return to the review screen with just the not-yet-attempted lines to continue with, if you want to."
          }
          confirmLabel="Yes, cancel"
          cancelLabel="Never mind"
          onConfirm={handleCancelConfirmed}
          onCancel={() => setShowCancelConfirm(false)}
        />
      )}
    </div>
  )
}

function RunningBanner({
  label,
  env,
  onCancelClick,
  cancelling,
}: {
  label: string
  env: MxiEnv
  onCancelClick: () => void
  cancelling: boolean
}) {
  return (
    <Card className="flex items-center justify-between gap-3 p-6">
      <div className="flex items-center gap-3">
        <Loader2 size={20} className="animate-spin text-accent" />
        <div>
          <p className="text-sm font-semibold text-text">
            {label} ({env})...
          </p>
          <p className="mt-0.5 text-xs text-muted">This can take a few minutes — results appear once discovery finishes.</p>
        </div>
      </div>
      <SecondaryButton onClick={onCancelClick} disabled={cancelling}>
        <StopCircle size={16} />
        {cancelling ? 'Cancelling...' : 'Cancel'}
      </SecondaryButton>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// State A — Select
// ---------------------------------------------------------------------------
function SelectState({
  vendors,
  craGroups,
  selectedVendorIds,
  onToggleVendor,
  onSelectCra,
  onSelectVendors,
  onDeselectVendors,
  onRun,
  disabled,
}: {
  vendors: VendorListEntry[]
  craGroups: CraGroupEntry[]
  selectedVendorIds: Set<string>
  onToggleVendor: (id: string) => void
  onSelectCra: (vendorIds: string[]) => void
  onSelectVendors: (vendorIds: string[]) => void
  onDeselectVendors: (vendorIds: string[]) => void
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
      <CardHeader
        title="Select vendors"
        description="Choose which write-up workflows to scan for open, eligible lines."
        action={
          <div className="flex gap-2">
            <SecondaryButton
              onClick={() => onSelectVendors(filteredVendors.map((v) => v.id))}
              disabled={disabled || filteredVendors.length === 0}
            >
              Select all
            </SecondaryButton>
            <SecondaryButton
              onClick={() => onDeselectVendors(filteredVendors.map((v) => v.id))}
              disabled={disabled || filteredVendors.length === 0}
            >
              Deselect all
            </SecondaryButton>
            <SecondaryButton onClick={onRun} disabled={!canRun}>
              <PlayCircle size={16} />
              Run
            </SecondaryButton>
          </div>
        }
      />
      <div className="flex flex-col gap-2 border-b border-border px-5 py-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
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
        {craGroups.length > 0 && (
          <select
            value=""
            disabled={disabled}
            onChange={(e) => {
              const group = craGroups.find((g) => g.craCode === e.target.value)
              if (group) onSelectCra(group.vendorIds)
              e.target.value = ''
            }}
            className="rounded-md border border-border bg-bg py-2 px-3 text-sm text-text focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 sm:w-64"
            title="Selecting a CRA checks all of their vendors below — pick again for another CRA, selections add up."
          >
            <option value="" disabled>
              Select all vendors for a CRA...
            </option>
            {craGroups.map((g) => (
              <option key={g.craCode} value={g.craCode}>
                {g.craName} ({g.vendorIds.length})
              </option>
            ))}
          </select>
        )}
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
  restrictToLineIds,
  cancelledExecuteSummary,
}: {
  run: RunStatusResponse
  selectedLineIds: Set<string>
  onToggleLine: (id: string) => void
  onSelectAll: (ids: string[]) => void
  onConfirm: () => void
  onCancel: () => void
  /** CLAUDE_CODE_PROMPT (cancel button) — non-null after an execute cancel: only these not-yet-attempted lineIds are offered, so re-confirming can never duplicate an already-completed line's real order. Null for a fresh discovery (every completed line is offered, as before). */
  restrictToLineIds: Set<string> | null
  /** Counts from the cancelled execute run, shown as context for why the offered list is smaller than the original discovery. */
  cancelledExecuteSummary: RunStatusResponse['counts'] | null
}) {
  const lines = run.lines ?? []
  const selectable = (restrictToLineIds ? lines.filter((l) => restrictToLineIds.has(l.lineId)) : lines).filter(
    (l) => l.status === 'completed',
  )
  const exceptions = lines.filter((l) => l.status === 'exception')

  const now = useNow(CLOCK_TICK_MS)
  const ageMinutes = run.completedAt ? Math.round((now - new Date(run.completedAt).getTime()) / 60000) : 0
  const isStale = ageMinutes > 15

  return (
    <div className="space-y-4">
      {cancelledExecuteSummary && (
        <div className="flex items-center gap-2 rounded-md border border-warning bg-warning-soft px-4 py-2.5 text-sm text-text">
          <StopCircle size={15} className="text-warning" />
          Run cancelled — {cancelledExecuteSummary.completed} line(s) already completed (real orders, untouched) and{' '}
          {cancelledExecuteSummary.exception + cancelledExecuteSummary.skipped} needed review. Only the lines below never
          got attempted.
        </div>
      )}

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
  onCancelClick,
  cancelling,
}: {
  run: RunStatusResponse | null
  events: RunLogEvent[]
  totalLines: number
  done: boolean
  onReset: () => void
  /** Undefined when the original discovery run is out of scope (e.g. this page was freshly re-mounted mid-run) — the manual retry control simply doesn't render then. */
  onRetryFailed?: () => void
  /** Undefined once the run is done — nothing left to cancel. */
  onCancelClick?: () => void
  cancelling: boolean
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
          <div className="flex items-center gap-2">
            {run && (
              <Badge tone={run.status === 'failed' ? 'danger' : run.status === 'partial' ? 'warning' : run.status === 'completed' ? 'success' : 'accent'}>
                {run.status}
              </Badge>
            )}
            {onCancelClick && (
              <SecondaryButton onClick={onCancelClick} disabled={cancelling}>
                <StopCircle size={16} />
                {cancelling ? 'Cancelling...' : 'Cancel'}
              </SecondaryButton>
            )}
          </div>
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
