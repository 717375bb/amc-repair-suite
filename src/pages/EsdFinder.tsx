import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, PlayCircle, RotateCcw, StopCircle, UploadCloud, X } from 'lucide-react'
import { Badge, Card, CardHeader, PrimaryButton, SecondaryButton } from '../components/ui'
import { EnvironmentBar } from '../components/EnvironmentBar'
import { ConfirmDialog } from '../components/ConfirmDialog'
import {
  ApiError,
  getActiveEsdJob,
  peekFile,
  startCompare,
  startWrite,
  type DuplicateOrderNumber,
  type EsdCompareResultRow,
  type EsdRunStatusResponse,
  type EsdWriteOrderResult,
  type MxiEnv,
} from '../lib/esdFinderApi'
import { useEsdFinderRun } from '../lib/esdFinderRun'

type Phase = 'upload' | 'comparing' | 'review'
type ReviewScreen = 'actionable' | 'non-actionable'

function isEsdRunTerminal(status: EsdRunStatusResponse['status'] | undefined): boolean {
  return !!status && status !== 'running' && status !== 'pending'
}

interface StagedFile {
  file: File
  rowCount: number | null
  error: string | null
}

// ---------------------------------------------------------------------------
// A single drop zone — used for both Vendor OOR(s) (multi) and CRA OOR
// (single). Peeks each dropped/selected file immediately (real row count or
// a real rejection message), per the spec's State A requirement — never
// silently stages a file that later turns out to be unparseable.
// ---------------------------------------------------------------------------
function DropZone({
  label,
  description,
  multiple,
  role,
  staged,
  onAdd,
  onRemove,
  disabled,
}: {
  label: string
  description: string
  multiple: boolean
  role: 'vendor' | 'cra'
  staged: StagedFile[]
  onAdd: (files: File[]) => void
  onRemove: (file: File) => void
  disabled: boolean
}) {
  const [isDragOver, setIsDragOver] = useState(false)

  const handleFiles = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    const files = multiple ? Array.from(fileList) : [fileList[0]]
    onAdd(files)
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)
    if (disabled) return
    handleFiles(e.dataTransfer.files)
  }

  const inputId = `esd-finder-drop-${role}`

  return (
    <Card>
      <CardHeader title={label} description={description} />
      <div className="p-5">
        <div
          onDragOver={(e) => {
            e.preventDefault()
            if (!disabled) setIsDragOver(true)
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDrop}
          className={`flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-8 text-center transition-colors ${
            disabled
              ? 'cursor-not-allowed border-border bg-bg opacity-60'
              : isDragOver
                ? 'border-accent bg-accent-soft'
                : 'border-border bg-bg hover:border-accent'
          }`}
        >
          <UploadCloud size={24} className={isDragOver ? 'text-accent' : 'text-muted'} />
          <p className="text-sm text-text">
            Drag {multiple ? 'file(s)' : 'a file'} here, or{' '}
            <label htmlFor={inputId} className={disabled ? 'text-muted' : 'cursor-pointer font-medium text-accent hover:underline'}>
              browse
            </label>
          </p>
          <input
            id={inputId}
            type="file"
            accept=".xlsx,.xlsb,.xls"
            multiple={multiple}
            disabled={disabled}
            className="hidden"
            onChange={(e) => {
              handleFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </div>

        {staged.length > 0 && (
          <ul className="mt-4 space-y-2">
            {staged.map((s) => (
              <li
                key={`${s.file.name}-${s.file.lastModified}`}
                className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${
                  s.error ? 'border-danger bg-danger-soft' : 'border-border bg-surface'
                }`}
              >
                <div className="flex items-center gap-2 overflow-hidden">
                  <FileSpreadsheet size={15} className={s.error ? 'text-danger' : 'text-muted'} />
                  <span className="truncate text-text">{s.file.name}</span>
                  {s.rowCount !== null && !s.error && <Badge tone="neutral">{s.rowCount} row(s)</Badge>}
                  {s.error && <span className="truncate text-xs text-danger">{s.error}</span>}
                </div>
                <button
                  type="button"
                  onClick={() => onRemove(s.file)}
                  className="shrink-0 text-muted hover:text-danger"
                  aria-label={`Remove ${s.file.name}`}
                >
                  <X size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Duplicate-order banner — visible from both review screens, per the spec.
// ---------------------------------------------------------------------------
function DuplicateBanner({ duplicates }: { duplicates: DuplicateOrderNumber[] }) {
  if (duplicates.length === 0) return null
  return (
    <Card className="border-danger">
      <CardHeader
        title="Duplicate Order Numbers found — resolve before writing"
        description={`${duplicates.length} order number(s) appear more than once across the uploaded vendor file(s). This should not happen — these orders are excluded from the write set until resolved.`}
      />
      <div className="divide-y divide-border">
        {duplicates.map((d) => (
          <div key={d.orderNumber} className="border-l-4 border-l-danger bg-danger-soft/40 px-5 py-3">
            <p className="text-sm font-semibold text-text">{d.orderNumber}</p>
            <ul className="mt-1 space-y-0.5">
              {d.occurrences.map((o, i) => (
                <li key={i} className="text-xs text-muted">
                  {o.sourceFileName} {o.vendorName ? `— ${o.vendorName}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  )
}

/**
 * Display-only: cleanCell() (parsers/cellUtils.ts, shared with the existing
 * CLI pipeline, unchanged) converts a Date-typed Excel cell via
 * `.toISOString()`, so a raw field like mxiEsdRaw can genuinely be
 * "2026-09-02T00:00:00.000Z" rather than a plain date — that's existing,
 * pre-existing pipeline behavior, not something to alter here. This only
 * trims the display to the date portion; the underlying value/DB record is
 * untouched.
 */
function formatRawDate(value: string | null): string {
  if (!value) return '—'
  const isoMatch = value.match(/^(\d{4}-\d{2}-\d{2})T/)
  return isoMatch ? isoMatch[1] : value
}

function flagBadgeTone(flag: EsdCompareResultRow['flag']): 'success' | 'warning' | 'neutral' {
  if (flag === 'ok') return 'success'
  if (flag === 'no_esd_found') return 'warning'
  return 'neutral'
}

// ---------------------------------------------------------------------------
// Per-row write status — a distinct, never-hidden "Write failed — needs
// retry" state (amber/red), verbatim error behind a technical-details
// toggle, plain-English summary always visible. Never renders a bare
// "pending" row as if it were already a success.
// ---------------------------------------------------------------------------
function WriteStatusCell({ result, jobDone }: { result: EsdWriteOrderResult | undefined; jobDone: boolean }) {
  const [showDetail, setShowDetail] = useState(false)

  if (!result) {
    // CLAUDE_CODE_PROMPT (cancel button) — distinguishes "still genuinely
    // in progress" (perpetual spinner, correct while the job is running)
    // from "the job is over and this one simply never got attempted"
    // (e.g. a cancel stopped the run before reaching it) — the old
    // unconditional "Writing..." would otherwise spin forever here even
    // after the whole run had already stopped.
    if (jobDone) {
      return <span className="text-xs text-muted">Not attempted — cancelled</span>
    }
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted">
        <Loader2 size={13} className="animate-spin" />
        Writing...
      </span>
    )
  }
  if (result.status === 'success') {
    return (
      <span className="flex items-center gap-1.5 text-xs font-medium text-success">
        <CheckCircle2 size={13} />
        Written — verified
      </span>
    )
  }
  if (result.status === 'skipped') {
    return <span className="text-xs text-muted">Skipped — {result.errorMessage ?? 'already handled'}</span>
  }
  return (
    <div>
      <span className="flex items-center gap-1.5 text-xs font-semibold text-danger">
        <AlertTriangle size={13} />
        Write failed — needs retry
      </span>
      <p className="mt-0.5 text-xs text-muted">MXI didn't respond as expected — safe to retry.</p>
      {result.errorMessage && (
        <button type="button" onClick={() => setShowDetail((s) => !s)} className="mt-0.5 text-xs text-accent hover:underline">
          {showDetail ? 'Hide' : 'Show'} technical details
        </button>
      )}
      {showDetail && result.errorMessage && (
        <pre className="mt-1 max-w-xs whitespace-pre-wrap rounded bg-bg p-2 text-xs text-muted">{result.errorMessage}</pre>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function EsdFinder() {
  const [vendorStaged, setVendorStaged] = useState<StagedFile[]>([])
  const [craStaged, setCraStaged] = useState<StagedFile[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeJobRunId, setActiveJobRunId] = useState<string | null>(null)

  const [reviewScreen, setReviewScreen] = useState<ReviewScreen>('actionable')
  const [removedOrderNumbers, setRemovedOrderNumbers] = useState<Set<string>>(new Set())
  const [env, setEnv] = useState<MxiEnv>('stage')
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  // CLAUDE_CODE_PROMPT (persistent run state + cancel button) — compare AND
  // write state + their polling loops both live in a provider mounted at
  // the app root (see components/RequireAuth.tsx), not in this page
  // component, so they survive navigating away and back. See
  // lib/esdFinderRun.tsx's own docstring.
  const {
    compareRunId,
    compareRun: runStatus,
    writeRunId,
    writeRun: writeStatus,
    startCompareTracking,
    startWriteTracking,
    cancelActive,
    clearAll,
  } = useEsdFinderRun()

  const isWriting = !!writeRunId && !isEsdRunTerminal(writeStatus?.status)
  const effectivePhase: Phase = useMemo(() => {
    if (compareRunId) {
      return isEsdRunTerminal(runStatus?.status) ? 'review' : 'comparing'
    }
    return 'upload'
  }, [compareRunId, runStatus])

  useEffect(() => {
    getActiveEsdJob()
      .then((r) => setActiveJobRunId(r.activeRunId))
      .catch(() => {
        /* non-fatal — Run will surface a 409 if a job really is active */
      })
  }, [])

  const addFiles = async (files: File[], role: 'vendor' | 'cra', setStaged: typeof setVendorStaged) => {
    const targetFiles = role === 'cra' ? files.slice(0, 1) : files
    const pending: StagedFile[] = targetFiles.map((file) => ({ file, rowCount: null, error: null }))
    setStaged((prev) => (role === 'cra' ? pending : [...prev, ...pending]))

    for (const file of targetFiles) {
      try {
        const { rowCount } = await peekFile(file, role)
        setStaged((prev) => prev.map((s) => (s.file === file ? { ...s, rowCount } : s)))
      } catch (err) {
        const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err)
        setStaged((prev) => prev.map((s) => (s.file === file ? { ...s, error: message } : s)))
      }
    }
  }

  const removeVendorFile = (file: File) => setVendorStaged((prev) => prev.filter((s) => s.file !== file))
  const removeCraFile = () => setCraStaged([])

  const validVendorFiles = vendorStaged.filter((s) => !s.error && s.rowCount !== null)
  const validCraFile = craStaged.find((s) => !s.error && s.rowCount !== null)
  const jobIsActive = effectivePhase === 'comparing' || isWriting || !!activeJobRunId

  const handleRun = async () => {
    if (!validCraFile) return
    setLoadError(null)
    try {
      const { runId: newRunId } = await startCompare(
        validVendorFiles.map((s) => s.file),
        validCraFile.file,
      )
      setRemovedOrderNumbers(new Set())
      startCompareTracking(newRunId)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setLoadError(`An ESD Finder job is already running (${err.activeRunId ?? 'unknown'}).`)
      } else {
        setLoadError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  const handleRunUpdates = async (orderNumbers: string[]) => {
    if (!runStatus || orderNumbers.length === 0) return
    setLoadError(null)
    try {
      const { runId: newWriteRunId } = await startWrite(runStatus.runId, orderNumbers, env)
      startWriteTracking(newWriteRunId)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setLoadError(`An ESD Finder job is already running (${err.activeRunId ?? 'unknown'}).`)
      } else {
        setLoadError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  const resetToStart = () => {
    clearAll()
    setVendorStaged([])
    setCraStaged([])
    setRemovedOrderNumbers(new Set())
    getActiveEsdJob()
      .then((r) => setActiveJobRunId(r.activeRunId))
      .catch(() => {})
  }

  // CLAUDE_CODE_PROMPT (cancel button) — cancelling a compare (read)
  // discards it entirely (nothing was written); cancelling a write leaves
  // whatever already succeeded standing and just stops there — the review
  // screen keeps showing the same compare results, with not-yet-attempted
  // orders retry-eligible (see WriteStatusCell/failedOrderNumbers below).
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

  const canRun = !jobIsActive && validVendorFiles.length > 0 && !!validCraFile

  return (
    <div className="space-y-5" data-workflow="esd-finder">
      {loadError && (
        <div className="rounded-md border border-l-4 border-danger border-l-danger bg-danger-soft px-4 py-3 text-sm text-text">
          {loadError}
        </div>
      )}

      {activeJobRunId && effectivePhase === 'upload' && (
        <div className="flex items-center justify-between rounded-md border border-l-4 border-warning border-l-warning bg-warning-soft px-4 py-3 text-sm text-text">
          <span>An ESD Finder job is already running ({activeJobRunId}). Wait for it to finish before starting a new one.</span>
        </div>
      )}

      {effectivePhase === 'upload' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <DropZone
              label="Vendor OOR(s)"
              description="Drop one or more vendor open-order report files. Rows from all files are pooled together."
              multiple
              role="vendor"
              staged={vendorStaged}
              onAdd={(files) => addFiles(files, 'vendor', setVendorStaged)}
              onRemove={removeVendorFile}
              disabled={jobIsActive}
            />
            <DropZone
              label="CRA OOR"
              description="Drop exactly one CRA open-order report file."
              multiple={false}
              role="cra"
              staged={craStaged}
              onAdd={(files) => addFiles(files, 'cra', setCraStaged)}
              onRemove={removeCraFile}
              disabled={jobIsActive}
            />
          </div>
          <div className="flex justify-end">
            <PrimaryButton onClick={handleRun} disabled={!canRun}>
              <PlayCircle size={16} />
              Run Comparison
            </PrimaryButton>
          </div>
        </div>
      )}

      {effectivePhase === 'comparing' && (
        <Card className="flex items-center justify-between gap-3 p-6">
          <div className="flex items-center gap-3">
            <Loader2 size={20} className="animate-spin text-accent" />
            <div>
              <p className="text-sm font-semibold text-text">
                Running comparison{runStatus?.phase ? ` — ${runStatus.phase}` : ''}...
              </p>
              <p className="mt-0.5 text-xs text-muted">
                AI inference over the matched orders can take a few minutes — this isn't hung.
              </p>
            </div>
          </div>
          <SecondaryButton onClick={() => setShowCancelConfirm(true)} disabled={cancelling}>
            <StopCircle size={16} />
            {cancelling ? 'Cancelling...' : 'Cancel'}
          </SecondaryButton>
        </Card>
      )}

      {effectivePhase === 'review' && runStatus && (
        <ReviewState
          runStatus={runStatus}
          reviewScreen={reviewScreen}
          onChangeScreen={setReviewScreen}
          removedOrderNumbers={removedOrderNumbers}
          onToggleRemoved={(orderNumber) =>
            setRemovedOrderNumbers((prev) => {
              const next = new Set(prev)
              if (next.has(orderNumber)) next.delete(orderNumber)
              else next.add(orderNumber)
              return next
            })
          }
          env={env}
          onEnvChange={setEnv}
          isWriting={isWriting}
          writeStatus={writeStatus}
          onRunUpdates={handleRunUpdates}
          onReset={resetToStart}
          onCancelClick={isWriting ? () => setShowCancelConfirm(true) : undefined}
          cancelling={cancelling}
        />
      )}

      {showCancelConfirm && (
        <ConfirmDialog
          title={effectivePhase === 'comparing' ? 'Cancel this comparison?' : 'Cancel this write?'}
          message={
            effectivePhase === 'comparing'
              ? "This will stop the comparison where it's at and discard whatever's been found so far. Nothing was written, so there's nothing to undo."
              : "This will stop the write where it's at. Orders that already wrote successfully are untouched — only orders that haven't been attempted yet are stopped, and stay retry-eligible below."
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

// ---------------------------------------------------------------------------
// State B/C — Review + Write
// ---------------------------------------------------------------------------
function ReviewState({
  runStatus,
  reviewScreen,
  onChangeScreen,
  removedOrderNumbers,
  onToggleRemoved,
  env,
  onEnvChange,
  isWriting,
  writeStatus,
  onRunUpdates,
  onReset,
  onCancelClick,
  cancelling,
}: {
  runStatus: EsdRunStatusResponse
  reviewScreen: ReviewScreen
  onChangeScreen: (screen: ReviewScreen) => void
  removedOrderNumbers: Set<string>
  onToggleRemoved: (orderNumber: string) => void
  env: MxiEnv
  onEnvChange: (env: MxiEnv) => void
  isWriting: boolean
  writeStatus: EsdRunStatusResponse | null
  onRunUpdates: (orderNumbers: string[]) => void
  onReset: () => void
  /** Undefined whenever a write isn't currently in progress — nothing to cancel. */
  onCancelClick?: () => void
  cancelling: boolean
}) {
  if (runStatus.status === 'failed' || !runStatus.result) {
    return (
      <Card className="border-danger p-6">
        <div className="flex items-center gap-2 text-danger">
          <AlertTriangle size={18} />
          <p className="text-sm font-semibold">Comparison failed</p>
        </div>
        <p className="mt-2 text-sm text-text">{runStatus.fatalError ?? 'Unknown error.'}</p>
        <div className="mt-4 flex justify-end">
          <SecondaryButton onClick={onReset}>Start over</SecondaryButton>
        </div>
      </Card>
    )
  }

  const { records, duplicates, outputFilePath, summary } = runStatus.result
  const duplicateOrderNumbers = new Set(duplicates.map((d) => d.orderNumber.trim().toUpperCase()))
  const actionable = records.filter((r) => r.actionable)
  const nonActionable = records.filter((r) => !r.actionable)
  const writeableRows = actionable.filter(
    (r) => !removedOrderNumbers.has(r.orderNumber) && !duplicateOrderNumbers.has(r.orderNumber.trim().toUpperCase()),
  )

  const hasWriteRun = writeStatus !== null
  const writeResultByOrder = new Map((writeStatus?.writeResults ?? []).map((r) => [r.orderNumber, r]))
  const failedOrderNumbers = (writeStatus?.writeResults ?? []).filter((r) => r.status === 'failed').map((r) => r.orderNumber)
  const writeDone = hasWriteRun && !isWriting
  // CLAUDE_CODE_PROMPT (cancel button) — a cancelled write can leave orders
  // with NO result at all (never reached before the runner stopped), not
  // just failed ones — both are equally retry-eligible, so they're merged
  // into one list rather than only ever offering genuine failures.
  const writeWasCancelled = writeStatus?.status === 'cancelled'
  const notAttemptedOrderNumbers = writeWasCancelled
    ? writeableRows.map((r) => r.orderNumber).filter((o) => !writeResultByOrder.has(o))
    : []
  const retryableOrderNumbers = [...failedOrderNumbers, ...notAttemptedOrderNumbers]

  return (
    <div className="space-y-4">
      <Card className="flex items-center justify-between p-4">
        <div className="flex items-center gap-2 text-sm text-text">
          <CheckCircle2 size={16} className="text-success" />
          Comparison complete — {summary.processed} orders processed ({summary.aiCallsMade} AI call(s)).
        </div>
        <a
          href={`file:///${outputFilePath.replace(/\\/g, '/')}`}
          className="text-xs font-medium text-accent hover:underline"
          title={outputFilePath}
        >
          Output saved: {outputFilePath}
        </a>
      </Card>

      <DuplicateBanner duplicates={duplicates} />

      <EnvironmentBar env={env} onChange={onEnvChange} disabled={isWriting} />

      {isWriting && onCancelClick && (
        <div className="flex justify-end">
          <SecondaryButton onClick={onCancelClick} disabled={cancelling}>
            <StopCircle size={16} />
            {cancelling ? 'Cancelling...' : 'Cancel write'}
          </SecondaryButton>
        </div>
      )}

      <div className="flex overflow-hidden rounded-md border border-border w-fit">
        <button
          type="button"
          onClick={() => onChangeScreen('actionable')}
          className={`px-4 py-2 text-sm font-medium ${
            reviewScreen === 'actionable' ? 'bg-accent text-white' : 'bg-surface text-text hover:bg-bg'
          }`}
        >
          Actionable ({actionable.length})
        </button>
        <button
          type="button"
          onClick={() => onChangeScreen('non-actionable')}
          className={`px-4 py-2 text-sm font-medium ${
            reviewScreen === 'non-actionable' ? 'bg-accent text-white' : 'bg-surface text-text hover:bg-bg'
          }`}
        >
          Non-actionable ({nonActionable.length})
        </button>
      </div>

      {reviewScreen === 'actionable' ? (
        <Card>
          <CardHeader
            title="Actionable rows"
            description={
              hasWriteRun
                ? writeWasCancelled
                  ? `Write cancelled against ${writeStatus?.writeEnv ?? env}: ${writeStatus?.writeResults.filter((r) => r.status === 'success').length ?? 0} written before stopping, ${notAttemptedOrderNumbers.length} never attempted.`
                  : `Write run against ${writeStatus?.writeEnv ?? env}: ${writeStatus?.writeResults.filter((r) => r.status === 'success').length ?? 0} written, ${failedOrderNumbers.length} failed.`
                : `${writeableRows.length} of ${actionable.length} row(s) will be written to MXI.`
            }
            action={
              !hasWriteRun ? (
                <PrimaryButton onClick={() => onRunUpdates(writeableRows.map((r) => r.orderNumber))} disabled={isWriting || writeableRows.length === 0}>
                  {isWriting ? <Loader2 size={16} className="animate-spin" /> : <PlayCircle size={16} />}
                  Run Updates in MXI
                </PrimaryButton>
              ) : writeDone && retryableOrderNumbers.length > 0 ? (
                <SecondaryButton onClick={() => onRunUpdates(retryableOrderNumbers)} disabled={isWriting}>
                  <RotateCcw size={16} />
                  Retry {retryableOrderNumbers.length} {writeWasCancelled ? 'remaining' : 'failed'}
                </SecondaryButton>
              ) : undefined
            }
          />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
                  <th className="px-5 py-3 font-medium"></th>
                  <th className="px-5 py-3 font-medium">Order #</th>
                  <th className="px-5 py-3 font-medium">Vendor</th>
                  <th className="px-5 py-3 font-medium">P/N</th>
                  <th className="px-5 py-3 font-medium">Serial</th>
                  <th className="px-5 py-3 font-medium">Vendor ESD</th>
                  <th className="px-5 py-3 font-medium">MXI ESD</th>
                  <th className="px-5 py-3 font-medium">Delta (days)</th>
                  <th className="px-5 py-3 font-medium">Confidence</th>
                  <th className="px-5 py-3 font-medium">Notes to Receiver</th>
                  {hasWriteRun && <th className="px-5 py-3 font-medium">Write status</th>}
                </tr>
              </thead>
              <tbody>
                {actionable.map((row) => {
                  const isDuplicate = duplicateOrderNumbers.has(row.orderNumber.trim().toUpperCase())
                  const isRemoved = removedOrderNumbers.has(row.orderNumber)
                  const excluded = isDuplicate || isRemoved
                  const writeResult = writeResultByOrder.get(row.orderNumber)
                  const wasAttempted = excluded ? false : hasWriteRun
                  return (
                    <tr key={row.orderNumber} className={`border-b border-border last:border-0 ${excluded ? 'opacity-50' : 'hover:bg-bg'}`}>
                      <td className="px-5 py-3">
                        {isDuplicate ? (
                          <Badge tone="danger">Duplicate</Badge>
                        ) : hasWriteRun ? null : (
                          <button
                            type="button"
                            onClick={() => onToggleRemoved(row.orderNumber)}
                            className="text-muted hover:text-danger"
                            aria-label={isRemoved ? `Restore ${row.orderNumber}` : `Remove ${row.orderNumber}`}
                          >
                            {isRemoved ? <span className="text-xs text-accent hover:underline">Restore</span> : <X size={16} />}
                          </button>
                        )}
                      </td>
                      <td className="px-5 py-3 font-medium text-accent">{row.orderNumber}</td>
                      <td className="px-5 py-3 text-muted">{row.vendorName ?? '—'}</td>
                      <td className="px-5 py-3 text-muted">{row.partNumber ?? '—'}</td>
                      <td className="px-5 py-3 text-muted">{row.serialNumber ?? '—'}</td>
                      <td className="px-5 py-3 text-text">{row.inferredEsd ?? '—'}</td>
                      <td className="px-5 py-3 text-muted">{formatRawDate(row.mxiEsdRaw)}</td>
                      <td className="px-5 py-3 text-text">{row.deltaDaysVsMxi ?? '—'}</td>
                      <td className="px-5 py-3">
                        <Badge tone={flagBadgeTone(row.flag)}>{row.confidence ?? '—'}</Badge>
                      </td>
                      <td className="px-5 py-3 text-muted">{row.notesToReceiverPreview ?? '—'}</td>
                      {hasWriteRun && (
                        <td className="px-5 py-3">
                          {excluded ? (
                            <span className="text-xs text-muted">Not submitted (excluded)</span>
                          ) : wasAttempted ? (
                            <WriteStatusCell result={writeResult} jobDone={writeDone} />
                          ) : null}
                        </td>
                      )}
                    </tr>
                  )
                })}
                {actionable.length === 0 && (
                  <tr>
                    <td colSpan={hasWriteRun ? 11 : 10} className="px-5 py-6 text-center text-muted">
                      No actionable rows found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <Card>
          <CardHeader title="Non-actionable rows" description="Informational only — these are never written to MXI." />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
                  <th className="px-5 py-3 font-medium">Order #</th>
                  <th className="px-5 py-3 font-medium">Vendor</th>
                  <th className="px-5 py-3 font-medium">Flag</th>
                  <th className="px-5 py-3 font-medium">Classification</th>
                  <th className="px-5 py-3 font-medium">Reasoning</th>
                </tr>
              </thead>
              <tbody>
                {nonActionable.map((row) => (
                  <tr key={row.orderNumber} className="border-b border-border last:border-0 hover:bg-bg">
                    <td className="px-5 py-3 font-medium text-text">{row.orderNumber}</td>
                    <td className="px-5 py-3 text-muted">{row.vendorName ?? '—'}</td>
                    <td className="px-5 py-3">
                      <Badge tone={flagBadgeTone(row.flag)}>{row.flag.replace(/_/g, ' ')}</Badge>
                    </td>
                    <td className="px-5 py-3 text-muted">{row.classification ?? '—'}</td>
                    <td className="px-5 py-3 text-muted">{row.reasoningNote ?? '—'}</td>
                  </tr>
                ))}
                {nonActionable.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-5 py-6 text-center text-muted">
                      No non-actionable rows.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="flex justify-end">
        <SecondaryButton onClick={onReset}>Start another run</SecondaryButton>
      </div>
    </div>
  )
}
