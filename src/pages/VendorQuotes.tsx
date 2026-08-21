import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileText, Loader2, Mail, PlayCircle, StopCircle } from 'lucide-react'
import { Badge, Card, CardHeader, PrimaryButton, SecondaryButton } from '../components/ui'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { ApiError } from '../lib/api'
import {
  cancelQuoteRun,
  getActiveQuoteJob,
  getQuoteRun,
  startQuoteIngest,
  type QuoteExtractionRow,
  type QuoteRunStatusResponse,
} from '../lib/quoteApi'

const POLL_MS = 2000

function isTerminal(status: QuoteRunStatusResponse['status'] | undefined): boolean {
  return !!status && status !== 'running' && status !== 'pending'
}

function money(value: number | null, currency: string | null): string {
  if (value === null) return '—'
  return `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ''}`
}

function esdBasisLabel(basis: string | null): string {
  switch (basis) {
    case 'completion_date_plus_10':
      return 'quote date +10'
    case 'today_plus_14':
      return 'today +14'
    case 'lead_time_days_from_today':
      return 'lead time'
    case 'stale_completion_date_fallback':
      return 'stale → today +14'
    default:
      return '—'
  }
}

function confidenceTone(c: QuoteExtractionRow['confidence']): 'success' | 'warning' | 'neutral' {
  if (c === 'high') return 'success'
  if (c === 'medium') return 'warning'
  return 'neutral'
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function VendorQuotes() {
  const [runId, setRunId] = useState<string | null>(null)
  const [run, setRun] = useState<QuoteRunStatusResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeJobRunId, setActiveJobRunId] = useState<string | null>(null)
  const [maxMessages, setMaxMessages] = useState(10)
  const [unreadOnly, setUnreadOnly] = useState(true)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  const pollRef = useRef<number | null>(null)
  const isRunning = !!runId && !isTerminal(run?.status)

  useEffect(() => {
    getActiveQuoteJob()
      .then((r) => setActiveJobRunId(r.activeRunId))
      .catch(() => {
        /* non-fatal — Run surfaces a 409 if one really is active */
      })
  }, [])

  // Poll while a run is in flight. Extraction is ~7s per PDF, so rows
  // stream in progressively rather than all landing at the end.
  useEffect(() => {
    if (!runId) return
    let cancelled = false

    const tick = async () => {
      try {
        const status = await getQuoteRun(runId)
        if (cancelled) return
        setRun(status)
        if (isTerminal(status.status)) {
          if (pollRef.current) window.clearInterval(pollRef.current)
          pollRef.current = null
          setActiveJobRunId(null)
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err))
      }
    }

    void tick()
    pollRef.current = window.setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      if (pollRef.current) window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [runId])

  const handleRun = async () => {
    setLoadError(null)
    setRun(null)
    try {
      const { runId: newRunId } = await startQuoteIngest({ maxMessages, unreadOnly })
      setRunId(newRunId)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setLoadError(`A Vendor Quote job is already running (${err.activeRunId ?? 'unknown'}).`)
      } else {
        setLoadError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  const handleCancelConfirmed = async () => {
    setShowCancelConfirm(false)
    if (!runId) return
    setCancelling(true)
    try {
      await cancelQuoteRun(runId)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setCancelling(false)
    }
  }

  const rows = run?.rows ?? []
  const { quotes, skipped, needsReview } = useMemo(() => {
    const q = rows.filter((r) => r.documentKind === 'quote')
    return {
      quotes: q,
      skipped: rows.filter((r) => r.documentKind !== 'quote'),
      needsReview: q.filter((r) => r.needsReview),
    }
  }, [rows])

  return (
    <div className="space-y-5" data-workflow="vendor-quotes">
      {loadError && (
        <div className="rounded-md border border-l-4 border-danger border-l-danger bg-danger-soft px-4 py-3 text-sm text-text">
          {loadError}
        </div>
      )}

      {activeJobRunId && !runId && (
        <div className="rounded-md border border-l-4 border-warning border-l-warning bg-warning-soft px-4 py-3 text-sm text-text">
          A Vendor Quote job is already running ({activeJobRunId}). Wait for it to finish before starting another.
        </div>
      )}

      <Card>
        <CardHeader
          title="Read quotes from Outlook"
          description="Reads vendor quote PDFs from your configured Quotes folder and extracts price, part, and ESD. Nothing is written to MXI or to your mailbox."
        />
        <div className="flex flex-wrap items-end gap-4 px-5 py-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Most recent</span>
            <input
              type="number"
              min={1}
              max={100}
              value={maxMessages}
              disabled={isRunning}
              onChange={(e) => setMaxMessages(Math.min(100, Math.max(1, Number(e.target.value) || 1)))}
              className="w-28 rounded-md border border-border bg-bg px-3 py-2 text-sm text-text focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>

          <label className="flex items-center gap-2 pb-2">
            <input
              type="checkbox"
              checked={unreadOnly}
              disabled={isRunning}
              onChange={(e) => setUnreadOnly(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-accent"
            />
            <span className="text-sm text-text">Unread only</span>
            <span className="text-xs text-muted">(already-processed quotes are marked read)</span>
          </label>

          <div className="ml-auto flex gap-2">
            {isRunning && (
              <SecondaryButton onClick={() => setShowCancelConfirm(true)} disabled={cancelling}>
                <StopCircle size={16} />
                {cancelling ? 'Cancelling...' : 'Cancel'}
              </SecondaryButton>
            )}
            <PrimaryButton onClick={handleRun} disabled={isRunning || !!activeJobRunId}>
              {isRunning ? <Loader2 size={16} className="animate-spin" /> : <PlayCircle size={16} />}
              Read quotes
            </PrimaryButton>
          </div>
        </div>
      </Card>

      {run && (
        <>
          {run.status === 'failed' && run.fatalError && (
            <Card className="border-danger p-5">
              <div className="flex items-center gap-2 text-danger">
                <AlertTriangle size={18} />
                <p className="text-sm font-semibold">Run failed</p>
              </div>
              <p className="mt-2 text-sm text-text">{run.fatalError}</p>
            </Card>
          )}

          <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex items-center gap-2 text-sm text-text">
              {isRunning ? (
                <>
                  <Loader2 size={16} className="animate-spin text-accent" />
                  {run.phase === 'reading-outlook' ? 'Reading Outlook folder...' : 'Extracting PDFs...'}
                  {run.pdfCount ? ` (${rows.length} of ${run.pdfCount})` : ''}
                </>
              ) : (
                <>
                  <CheckCircle2 size={16} className="text-success" />
                  {run.status === 'cancelled' ? 'Cancelled — ' : 'Done — '}
                  {quotes.length} quote(s)
                  {skipped.length > 0 ? `, ${skipped.length} non-quote PDF(s) skipped` : ''}
                  {needsReview.length > 0 ? `, ${needsReview.length} need review` : ''}
                </>
              )}
            </div>
            {run.folderPath && (
              <span className="flex items-center gap-1.5 text-xs text-muted">
                <Mail size={13} />
                {run.folderPath}
              </span>
            )}
          </Card>

          {needsReview.length > 0 && (
            <div className="rounded-md border border-l-4 border-warning border-l-warning bg-warning-soft px-4 py-3 text-sm text-text">
              {needsReview.length} quote(s) need a look before they could be written — see the flagged rows below.
            </div>
          )}

          <Card>
            <CardHeader title="Extracted quotes" description={`${quotes.length} quote(s) read from ${run.pdfCount ?? 0} PDF(s).`} />
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
                    <th className="px-5 py-3 font-medium">Order #</th>
                    <th className="px-5 py-3 font-medium">Vendor</th>
                    <th className="px-5 py-3 font-medium">P/N</th>
                    <th className="px-5 py-3 font-medium">Serial</th>
                    <th className="px-5 py-3 font-medium text-right">Price</th>
                    <th className="px-5 py-3 font-medium">ESD</th>
                    <th className="px-5 py-3 font-medium">Basis</th>
                    <th className="px-5 py-3 font-medium">Conf.</th>
                  </tr>
                </thead>
                <tbody>
                  {quotes.map((r) => (
                    <tr
                      key={r.extractionId}
                      className={`border-b border-border last:border-0 ${r.needsReview ? 'bg-warning-soft/40' : 'hover:bg-bg'}`}
                    >
                      <td className="px-5 py-3 font-medium text-accent">
                        {r.orderNumber ?? <span className="text-danger">missing</span>}
                      </td>
                      <td className="px-5 py-3 text-muted">{r.vendorName ?? '—'}</td>
                      <td className="px-5 py-3 text-muted">{r.partNumber ?? '—'}</td>
                      <td className="px-5 py-3 text-muted">{r.serialNumber ?? '—'}</td>
                      <td className="px-5 py-3 text-right font-medium text-text">{money(r.unitPrice, r.currency)}</td>
                      <td className="px-5 py-3 text-text">{r.resolvedEsd ?? '—'}</td>
                      <td className="px-5 py-3 text-xs text-muted" title={r.esdExplanation ?? undefined}>
                        {esdBasisLabel(r.esdBasis)}
                      </td>
                      <td className="px-5 py-3">
                        <Badge tone={confidenceTone(r.confidence)}>{r.confidence}</Badge>
                      </td>
                    </tr>
                  ))}
                  {quotes.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-5 py-6 text-center text-muted">
                        {isRunning ? 'Waiting for the first extraction...' : 'No quotes found.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {needsReview.length > 0 && (
              <div className="border-t border-border px-5 py-4">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Why these need review</p>
                <ul className="space-y-1.5">
                  {needsReview.map((r) => (
                    <li key={r.extractionId} className="text-sm text-text">
                      <span className="font-medium text-accent">{r.orderNumber ?? r.fileName}</span>
                      {' — '}
                      <span className="text-muted">{r.reviewReasons.join('; ')}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>

          {skipped.length > 0 && (
            <Card>
              <CardHeader
                title="Skipped attachments"
                description="PDFs in these emails that aren't quotes — never written to MXI."
              />
              <div className="divide-y divide-border">
                {skipped.map((r) => (
                  <div key={r.extractionId} className="flex items-center gap-3 px-5 py-3">
                    <FileText size={15} className="shrink-0 text-muted" />
                    <div className="min-w-0">
                      <p className="truncate text-sm text-text">{r.fileName}</p>
                      <p className="truncate text-xs text-muted">
                        {r.documentKind.replace(/_/g, ' ')} — {r.reasoningNote}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      {showCancelConfirm && (
        <ConfirmDialog
          title="Cancel this run?"
          message="This stops after the current PDF. Quotes already extracted stay recorded. Nothing has been written to MXI or your mailbox, so there's nothing to undo."
          confirmLabel="Yes, cancel"
          cancelLabel="Never mind"
          onConfirm={handleCancelConfirmed}
          onCancel={() => setShowCancelConfirm(false)}
        />
      )}
    </div>
  )
}
