import { useCallback, useEffect, useState, type DragEvent } from 'react'
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, PlayCircle, RotateCcw, StopCircle, UploadCloud, X } from 'lucide-react'
import { Badge, Card, CardHeader, PrimaryButton, SecondaryButton } from '../components/ui'
import { EnvironmentBar } from '../components/EnvironmentBar'
import { InvoicePriceRun } from '../lib/tabRuns'
import {
  ApiError,
  getActiveInvoicePriceJob,
  peekInvoicePriceFile,
  retryInvoicePriceRun,
  startInvoicePriceRun,
  type InvoicePriceOrderResult,
  type InvoicePriceRunStatusResponse,
  type MxiEnv,
} from '../lib/invoicePriceWriterApi'

/**
 * Invoice Price Writer — a new, independent, single-phase workstream (own
 * job slot server-side): read one billing/invoice sheet's "Template" tab,
 * update each order's price line in MXI, always reset Promised By to
 * tomorrow, re-authorize/reissue as needed. Unlike the ESD Finder, there's
 * no separate compare-then-approve gate — the sheet already fully
 * specifies what to do per row — so "peek" here is a local, non-MXI
 * preview only (row count + header validation), and clicking Run goes
 * straight to the real per-row job, live-streaming results as they land.
 */

const TERMINAL_STATUSES = new Set<InvoicePriceRunStatusResponse['status']>(['completed', 'failed', 'cancelled'])

function isTerminal(status: InvoicePriceRunStatusResponse['status'] | undefined): boolean {
  return !!status && TERMINAL_STATUSES.has(status)
}

function outcomeBadgeTone(result: InvoicePriceOrderResult): 'success' | 'warning' | 'danger' | 'neutral' {
  if (result.status === 'success') return 'success'
  if (result.status === 'failed') return 'danger'
  return 'warning' // skipped — always worth a second look, never hidden as if it were fine
}

function outcomeLabel(result: InvoicePriceOrderResult): string {
  switch (result.outcome) {
    case 'written':
      return 'Written — verified'
    case 'skipped_serial_mismatch':
      return 'Skipped — serial number mismatch'
    case 'skipped_order_not_found':
      return 'Skipped — order line not found'
    case 'skipped_multi_line':
      return 'Skipped — multiple lines on order'
    default:
      return result.status === 'failed' ? 'Failed — needs retry' : result.outcome
  }
}

function ResultRow({ result }: { result: InvoicePriceOrderResult }) {
  const [showDetail, setShowDetail] = useState(false)
  return (
    <tr className="border-b border-border last:border-0 hover:bg-bg">
      <td className="px-5 py-3 font-medium text-accent">{result.orderNumber}</td>
      <td className="px-5 py-3 text-muted">{result.serialNumberSheet}</td>
      <td className="px-5 py-3 text-muted">{result.originalPrice ?? '—'}</td>
      <td className="px-5 py-3 text-text">{result.newPrice}</td>
      <td className="px-5 py-3">
        <Badge tone={outcomeBadgeTone(result)}>{outcomeLabel(result)}</Badge>
        {result.errorMessage && (
          <div className="mt-1">
            <button type="button" onClick={() => setShowDetail((s) => !s)} className="text-xs text-accent hover:underline">
              {showDetail ? 'Hide' : 'Show'} details
            </button>
            {showDetail && (
              <pre className="mt-1 max-w-sm whitespace-pre-wrap rounded bg-bg p-2 text-xs text-muted">{result.errorMessage}</pre>
            )}
          </div>
        )}
      </td>
    </tr>
  )
}

const useInvoicePriceRun = InvoicePriceRun.useTrackedRun

export default function InvoicePriceWriter() {
  const [file, setFile] = useState<File | null>(null)
  const [rowCount, setRowCount] = useState<number | null>(null)
  const [peekError, setPeekError] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [env, setEnv] = useState<MxiEnv>('production')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeJobRunId, setActiveJobRunId] = useState<string | null>(null)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  // Run state lives in the provider (lib/tabRuns.tsx) as of the
  // parallel-jobs work. Held locally it was lost the moment this page
  // unmounted, so navigating away stopped polling while the backend job
  // carried on invisibly.
  const { runId, run: runStatus, startTracking, restart, cancel: cancelRun, clear: clearRun } = useInvoicePriceRun()
  const [retrying, setRetrying] = useState(false)
  // A retry re-runs the SAME runId so results merge into one table, which
  // means polling has to be restarted explicitly — the runId itself never
  // changes, and polling has already stopped at the terminal status. The
  // provider's restart() is that mechanism.

  const isRunning = !!runId && !isTerminal(runStatus?.status)

  // Attach to an already-active job on mount (e.g. after a page reload) —
  // same reasoning as ESD Finder's own attach check, just page-local rather
  // than a persistent-across-navigation provider, since this feature has
  // no multi-phase state worth preserving across tabs.
  useEffect(() => {
    getActiveInvoicePriceJob()
      .then((r) => {
        setActiveJobRunId(r.activeRunId)
        // Re-attaching to the run itself is the provider's job.
      })
      .catch(() => {
        /* non-fatal — Run will surface a 409 if a job really is active */
      })
  }, [])

  // Polling belongs to the provider now, so it survives this page
  // unmounting.


  const handleFile = useCallback(async (selected: File) => {
    setFile(selected)
    setRowCount(null)
    setPeekError(null)
    try {
      const { rowCount: count } = await peekInvoicePriceFile(selected)
      setRowCount(count)
    } catch (err) {
      setPeekError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err))
    }
  }, [])

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)
    if (isRunning) return
    const dropped = e.dataTransfer.files?.[0]
    if (dropped) void handleFile(dropped)
  }

  const removeFile = () => {
    setFile(null)
    setRowCount(null)
    setPeekError(null)
  }

  const handleRun = async () => {
    if (!file || rowCount === null) return
    setLoadError(null)
    try {
      const { runId: newRunId } = await startInvoicePriceRun(file, env)
      startTracking(newRunId)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setLoadError(`An Invoice Price Writer job is already running (${err.activeRunId ?? 'unknown'}).`)
      } else {
        setLoadError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  const handleCancelConfirmed = async () => {
    if (!runId) return
    setShowCancelConfirm(false)
    setCancelling(true)
    try {
      await cancelRun()
      // restart() polls immediately, so the real cancelled status lands
      // without asserting it locally first.
      restart()
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setCancelling(false)
    }
  }

  // CLAUDE_CODE_PROMPT (retry failed lines) — real, normal MXI/Playwright
  // timeouts mean some lines fail even when the write logic itself is
  // fine; retrying just the failed ones (not the whole sheet again) avoids
  // re-attempting rows that already succeeded, which writePriceLineUpdate
  // structurally refuses to do anyway (see getInvoicePriceRetryRows'
  // already-succeeded exclusion) but is still wasted time/risk to request.
  const handleRetry = async () => {
    if (!runId || !runStatus) return
    const failedOrderNumbers = runStatus.results.filter((r) => r.status === 'failed').map((r) => r.orderNumber)
    if (failedOrderNumbers.length === 0) return
    setLoadError(null)
    setRetrying(true)
    try {
      await retryInvoicePriceRun(runId, failedOrderNumbers)
      // The backend flips the job's status to 'running' synchronously
      // before this call returns — fetch it now so the UI reflects "in
      // progress" immediately rather than waiting for the next poll tick.
      // Prior results (including the ones just about to be retried) stay
      // visible throughout — this fetch doesn't clear them.
      restart()
      restart()
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setLoadError(err.message)
      } else {
        setLoadError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setRetrying(false)
    }
  }

  const resetToStart = () => {
    clearRun()
    setFile(null)
    setRowCount(null)
    setPeekError(null)
    getActiveInvoicePriceJob()
      .then((r) => setActiveJobRunId(r.activeRunId))
      .catch(() => {})
  }

  const canRun = !isRunning && !!file && rowCount !== null && !peekError

  return (
    <div className="space-y-5" data-workflow="invoice-price-writer">
      {loadError && (
        <div className="rounded-md border border-l-4 border-danger border-l-danger bg-danger-soft px-4 py-3 text-sm text-text">
          {loadError}
        </div>
      )}

      {activeJobRunId && !runId && (
        <div className="flex items-center justify-between rounded-md border border-l-4 border-warning border-l-warning bg-warning-soft px-4 py-3 text-sm text-text">
          <span>An Invoice Price Writer job is already running ({activeJobRunId}). Wait for it to finish before starting a new one.</span>
        </div>
      )}

      {!runId && (
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="Billing / Invoice sheet"
              description={`Drop one Excel file — its "Template" sheet's PO Number / Serial Number / Extended Amt columns will be read.`}
            />
            <div className="p-5">
              <div
                onDragOver={(e) => {
                  e.preventDefault()
                  if (!isRunning) setIsDragOver(true)
                }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={handleDrop}
                className={`flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-8 text-center transition-colors ${
                  isRunning
                    ? 'cursor-not-allowed border-border bg-bg opacity-60'
                    : isDragOver
                      ? 'border-accent bg-accent-soft'
                      : 'border-border bg-bg hover:border-accent'
                }`}
              >
                <UploadCloud size={24} className={isDragOver ? 'text-accent' : 'text-muted'} />
                <p className="text-sm text-text">
                  Drag a file here, or{' '}
                  <label
                    htmlFor="invoice-price-drop"
                    className={isRunning ? 'text-muted' : 'cursor-pointer font-medium text-accent hover:underline'}
                  >
                    browse
                  </label>
                </p>
                <input
                  id="invoice-price-drop"
                  type="file"
                  accept=".xlsx,.xlsb,.xls"
                  disabled={isRunning}
                  className="hidden"
                  onChange={(e) => {
                    const selected = e.target.files?.[0]
                    if (selected) void handleFile(selected)
                    e.target.value = ''
                  }}
                />
              </div>

              {file && (
                <ul className="mt-4 space-y-2">
                  <li
                    className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${
                      peekError ? 'border-danger bg-danger-soft' : 'border-border bg-surface'
                    }`}
                  >
                    <div className="flex items-center gap-2 overflow-hidden">
                      <FileSpreadsheet size={15} className={peekError ? 'text-danger' : 'text-muted'} />
                      <span className="truncate text-text">{file.name}</span>
                      {rowCount !== null && !peekError && <Badge tone="neutral">{rowCount} row(s)</Badge>}
                      {peekError && <span className="truncate text-xs text-danger">{peekError}</span>}
                    </div>
                    <button type="button" onClick={removeFile} className="shrink-0 text-muted hover:text-danger" aria-label={`Remove ${file.name}`}>
                      <X size={16} />
                    </button>
                  </li>
                </ul>
              )}
            </div>
          </Card>

          <EnvironmentBar env={env} onChange={setEnv} disabled={isRunning} />

          <div className="flex justify-end">
            <PrimaryButton onClick={handleRun} disabled={!canRun}>
              <PlayCircle size={16} />
              Run Updates in MXI
            </PrimaryButton>
          </div>
        </div>
      )}

      {runId && (
        <Card>
          <CardHeader
            title="Invoice Price Writer — run"
            description={
              isRunning
                ? `Processing${runStatus?.rowCount ? ` — ${runStatus.results.length} of ${runStatus.rowCount} row(s)` : ''}...`
                : `Run against ${runStatus?.writeEnv ?? env} complete: ${runStatus?.results.filter((r) => r.status === 'success').length ?? 0} written, ${runStatus?.results.filter((r) => r.status === 'failed').length ?? 0} failed, ${runStatus?.results.filter((r) => r.status === 'skipped').length ?? 0} skipped.`
            }
            action={
              isRunning ? (
                <SecondaryButton onClick={() => setShowCancelConfirm(true)} disabled={cancelling}>
                  <StopCircle size={16} />
                  Cancel
                </SecondaryButton>
              ) : (
                <div className="flex gap-2">
                  {(runStatus?.results.filter((r) => r.status === 'failed').length ?? 0) > 0 && (
                    <SecondaryButton onClick={handleRetry} disabled={retrying}>
                      {retrying ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />}
                      Retry {runStatus?.results.filter((r) => r.status === 'failed').length} failed
                    </SecondaryButton>
                  )}
                  <SecondaryButton onClick={resetToStart}>Start another run</SecondaryButton>
                </div>
              )
            }
          />

          {runStatus?.duplicateCount ? (
            <div className="mx-5 mb-2 flex items-center gap-2 rounded-md border border-l-4 border-warning border-l-warning bg-warning-soft px-4 py-2 text-xs text-text">
              <AlertTriangle size={14} className="text-warning" />
              {runStatus.duplicateCount} duplicate PO Number(s) in the sheet — processed anyway, worth a second look.
            </div>
          ) : null}

          {isRunning && !runStatus && (
            <div className="flex items-center gap-3 p-6">
              <Loader2 size={20} className="animate-spin text-accent" />
              <p className="text-sm text-muted">Starting...</p>
            </div>
          )}

          {runStatus && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
                    <th className="px-5 py-3 font-medium">Order #</th>
                    <th className="px-5 py-3 font-medium">Serial #</th>
                    <th className="px-5 py-3 font-medium">Original Price</th>
                    <th className="px-5 py-3 font-medium">New Price</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {runStatus.results.map((result, i) => (
                    <ResultRow key={`${result.orderNumber}-${i}`} result={result} />
                  ))}
                  {runStatus.results.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-5 py-6 text-center text-muted">
                        {isRunning ? 'Waiting for the first row...' : 'No rows processed.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {!isRunning && runStatus && (
            <div className="flex items-center gap-1.5 border-t border-border px-5 py-3 text-xs text-muted">
              <CheckCircle2 size={13} />
              Run complete — every "Written" row above was independently re-read from MXI afterward to confirm the price and date actually landed.
            </div>
          )}
        </Card>
      )}

      {showCancelConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <Card className="w-full max-w-md p-6">
            <div className="flex items-center gap-2 text-danger">
              <AlertTriangle size={20} />
              <h3 className="text-sm font-semibold">Cancel this run?</h3>
            </div>
            <p className="mt-3 text-sm text-text">
              Rows already written stay written — this only stops the run before it reaches the next order.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <SecondaryButton onClick={() => setShowCancelConfirm(false)}>Keep running</SecondaryButton>
              <PrimaryButton onClick={handleCancelConfirmed}>Yes, cancel</PrimaryButton>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
