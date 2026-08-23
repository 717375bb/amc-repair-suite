import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileText, Loader2, Mail, PlayCircle, RotateCcw, StopCircle, Undo2, X } from 'lucide-react'
import { Badge, Card, CardHeader, PrimaryButton, SecondaryButton } from '../components/ui'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { ApiError } from '../lib/api'
import { EnvironmentBar } from '../components/EnvironmentBar'
import {
  cancelQuoteRun,
  getActiveQuoteJob,
  getQuoteRun,
  setQuoteDisposition,
  startQuoteIngest,
  startQuoteWrite,
  type HumanSettableDisposition,
  type MxiEnv,
  type QuoteDisposition,
  type QuoteExtractionRow,
  type QuoteRunStatusResponse,
  resolveWriteAction,
  type QuoteWriteResult,
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

/**
 * Names the ACTION, not just the state. NREP and BER are no longer dead
 * ends — they route to scrap pricing — so showing them as a bare red
 * "NREP" would wrongly read as "nothing will happen to this row".
 */
function dispositionBadge(
  d: QuoteDisposition,
  suggestsExchange: boolean,
): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  switch (d) {
    case 'excluded_nrep':
      return { label: 'NREP · scrap price', tone: 'warning' }
    case 'excluded_ber':
      return { label: 'BER · scrap price', tone: 'warning' }
    case 'excluded_other':
      return { label: 'Excluded', tone: 'neutral' }
    default:
      return suggestsExchange
        ? { label: 'Convert to exchange', tone: 'warning' }
        : { label: 'Price + ESD', tone: 'success' }
  }
}

/**
 * Per-row MXI write outcome.
 *
 * Deliberately shows a successful write whose EMAIL didn't get marked read
 * as a success with a footnote, not as a failure — the price and ESD really
 * did land in MXI, and reporting that as failed would invite someone to
 * "retry" a write that already happened.
 */
function WriteStatusCell({
  result,
  excluded,
  jobDone,
}: {
  result: QuoteWriteResult | undefined
  excluded: boolean
  jobDone: boolean
}) {
  const [showDetail, setShowDetail] = useState(false)

  if (excluded) return <span className="text-xs text-muted">Not submitted (excluded)</span>
  if (!result) {
    if (jobDone) return <span className="text-xs text-muted">Not attempted</span>
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted">
        <Loader2 size={13} className="animate-spin" />
        Writing...
      </span>
    )
  }

  if (result.status === 'success') {
    return (
      <div>
        <span className="flex items-center gap-1.5 text-xs font-medium text-success">
          <CheckCircle2 size={13} />
          Written — verified
        </span>
        {result.markedRead ? (
          <p className="mt-0.5 text-xs text-muted">Email marked read</p>
        ) : (
          <p className="mt-0.5 text-xs text-warning" title={result.markReadError ?? undefined}>
            Written, but the email couldn&apos;t be marked read
          </p>
        )}
        {/* Which authorize/issue path this order took. Shown on success
            too — "already authorized, issue clicked" is a normal outcome
            that used to be completely invisible. */}
        {result.issueDetail && (
          <p className="mt-0.5 max-w-xs text-xs text-muted" title={result.issueDetail}>
            {result.issueDetail.startsWith('Already authorized') ? 'Already authorized · issued' : 'Authorized · issued'}
          </p>
        )}
      </div>
    )
  }

  if (result.status === 'skipped') {
    return <span className="text-xs text-muted">Skipped — {result.errorMessage ?? 'not eligible'}</span>
  }

  return (
    <div>
      <span className="flex items-center gap-1.5 text-xs font-semibold text-danger">
        <AlertTriangle size={13} />
        Write failed
      </span>
      <p className="mt-0.5 text-xs text-muted">Email left unread, so it stays in the queue.</p>
      {result.errorMessage && (
        <button type="button" onClick={() => setShowDetail((s) => !s)} className="mt-0.5 text-xs text-accent hover:underline">
          {showDetail ? 'Hide' : 'Show'} details
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
export default function VendorQuotes() {
  const [runId, setRunId] = useState<string | null>(null)
  const [run, setRun] = useState<QuoteRunStatusResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeJobRunId, setActiveJobRunId] = useState<string | null>(null)
  const [maxMessages, setMaxMessages] = useState(10)
  const [unreadOnly, setUnreadOnly] = useState(true)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [env, setEnv] = useState<MxiEnv>('production')
  const [showWriteConfirm, setShowWriteConfirm] = useState(false)
  /** How many rows this write actually submitted — the progress bar's denominator. */
  const [submittedCount, setSubmittedCount] = useState<number | null>(null)
  /** Bumped to restart polling when a new phase begins on an existing runId (see the poll effect). */
  const [pollEpoch, setPollEpoch] = useState(0)

  const pollRef = useRef<number | null>(null)
  const isRunning = !!runId && !isTerminal(run?.status)

  /**
   * REAL UX BUG, from a real incident: the error banner renders at the top
   * of the page, but the row-level BER/X buttons live far down a long
   * table. A failed request therefore showed an error the user never saw,
   * making a genuine 404 (stale backend) look like a button that simply
   * did nothing. Errors now pull the page back to the banner, so a failure
   * is impossible to mistake for "nothing happened".
   */
  const errorRef = useRef<HTMLDivElement | null>(null)
  const reportError = (message: string) => {
    setLoadError(message)
    // After paint, so the banner actually exists to scroll to.
    requestAnimationFrame(() => errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  }

  useEffect(() => {
    getActiveQuoteJob()
      .then((r) => setActiveJobRunId(r.activeRunId))
      .catch(() => {
        /* non-fatal — Run surfaces a 409 if one really is active */
      })
  }, [])

  /**
   * Poll while a run is in flight. Extraction is ~7s per PDF, so rows
   * stream in progressively rather than all landing at the end.
   *
   * REAL BUG FOUND AND FIXED (user-reported twice): this effect used to be
   * keyed on `[runId]` alone. Polling stops when a run reaches a terminal
   * status — correct — but a WRITE reuses the SAME runId, so the effect
   * never re-ran and the client never polled again. The write genuinely
   * ran server-side while the UI sat frozen on the completed-ingest
   * snapshot: `kind` stayed 'ingest', `isWriting` was never true, and no
   * progress appeared at all. `pollEpoch` is bumped whenever a new phase
   * starts on an existing runId, which is what restarts polling.
   */
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
        if (!cancelled) reportError(err instanceof Error ? err.message : String(err))
      }
    }

    void tick()
    pollRef.current = window.setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      if (pollRef.current) window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [runId, pollEpoch])

  const handleRun = async () => {
    setLoadError(null)
    setRun(null)
    try {
      const { runId: newRunId } = await startQuoteIngest({ maxMessages, unreadOnly })
      setRunId(newRunId)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        reportError(`A Vendor Quote job is already running (${err.activeRunId ?? "unknown"}).`)
      } else {
        reportError(err instanceof Error ? err.message : String(err))
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
      reportError(err instanceof Error ? err.message : String(err))
    } finally {
      setCancelling(false)
    }
  }

  // Optimistic local overrides, so clicking BER/X updates the row
  // immediately instead of waiting for the next 2s poll. The server is
  // still the source of truth — a failed call rolls the entry back out.
  const [pendingDisposition, setPendingDisposition] = useState<Record<number, QuoteDisposition>>({})

  const rows = run?.rows ?? []
  const effectiveDisposition = (r: QuoteExtractionRow): QuoteDisposition =>
    pendingDisposition[r.extractionId] ?? r.disposition

  const handleDisposition = async (row: QuoteExtractionRow, disposition: HumanSettableDisposition) => {
    if (!runId) return
    const previous = effectiveDisposition(row)
    setPendingDisposition((prev) => ({ ...prev, [row.extractionId]: disposition }))
    try {
      await setQuoteDisposition(row.extractionId, disposition, runId)
    } catch (err) {
      setPendingDisposition((prev) => ({ ...prev, [row.extractionId]: previous }))
      reportError(err instanceof Error ? err.message : String(err))
    }
  }

  const writeResults = run?.writeResults ?? []
  const writeResultByExtraction = useMemo(
    () => new Map(writeResults.map((r) => [r.extractionId, r])),
    [writeResults],
  )
  const hasWriteRun = writeResults.length > 0 || run?.kind === 'write'
  const isWriting = isRunning && run?.kind === 'write'

  /**
   * Live write progress. `total` is the number actually submitted for this
   * write (captured when the run started), not the number of rows on
   * screen — excluded/BER/NREP rows were never submitted and counting them
   * would make the progress bar stall short of 100% forever.
   */
  const writeProgress = useMemo(() => {
    const written = writeResults.filter((r) => r.status === 'success').length
    const failed = writeResults.filter((r) => r.status === 'failed').length
    const skipped = writeResults.filter((r) => r.status === 'skipped').length
    const amountWritten = writeResults
      .filter((r) => r.status === 'success' && r.writtenPrice)
      .reduce((sum, r) => sum + (Number(r.writtenPrice) || 0), 0)
    return {
      done: writeResults.length,
      total: Math.max(submittedCount ?? 0, writeResults.length),
      written,
      failed,
      skipped,
      amountWritten,
    }
  }, [writeResults, submittedCount])

  const handleWriteConfirmed = async () => {
    setShowWriteConfirm(false)
    if (!runId) return
    setLoadError(null)
    const ids = willWrite.map((r) => r.extractionId)
    setSubmittedCount(ids.length)
    try {
      await startQuoteWrite(runId, ids, env)
      // Optimistically flip the local snapshot to the write phase so the
      // progress card appears on THIS tick rather than up to POLL_MS later
      // — the server already set status='running' before returning 202, so
      // this only anticipates what the next poll confirms.
      setRun((prev) => (prev ? { ...prev, kind: 'write', status: 'running', phase: 'writing', writeEnv: env } : prev))
      // Restart polling: the run reached a terminal status after ingest, so
      // the poll interval was cleared. Without this the write runs blind.
      setPollEpoch((e) => e + 1)
    } catch (err) {
      setSubmittedCount(null)
      if (err instanceof ApiError && err.status === 409) {
        reportError(`A Vendor Quote job is already running (${err.activeRunId ?? "unknown"}).`)
      } else {
        reportError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  const { quotes, skipped, needsReview, willWrite, nrepCount, berCount } = useMemo(() => {
    const q = rows.filter((r) => r.documentKind === 'quote')
    return {
      quotes: q,
      skipped: rows.filter((r) => r.documentKind !== 'quote'),
      needsReview: q.filter((r) => r.needsReview),
      // Excludes anything already successfully written. The runner would
      // skip those anyway (its already-written guard), but offering
      // "Write 8 to MXI" when all 8 would be skipped reads as broken.
      // Action-aware, not just 'pending'. NREP rows are now writable — they
      // route to scrap pricing. BER rows are deliberately NOT counted: the
      // runner blocks them because the extracted price is that quote's
      // REPAIR cost, not a scrap fee, so there is no correct number to
      // write yet. Counting them would promise a write that can't happen.
      willWrite: q.filter((r) => {
        const disp = pendingDisposition[r.extractionId] ?? r.disposition
        if (resolveWriteAction(disp, r.suggestsExchange) === 'none') return false
        if (disp === 'excluded_ber') return false
        return writeResultByExtraction.get(r.extractionId)?.status !== 'success'
      }),
      berCount: q.filter((r) => (pendingDisposition[r.extractionId] ?? r.disposition) === 'excluded_ber').length,
      nrepCount: q.filter((r) => r.vendorSaysNonRepairable).length,
    }
  }, [rows, pendingDisposition, writeResultByExtraction])

  return (
    <div className="space-y-5" data-workflow="vendor-quotes">
      {loadError && (
        <div
          ref={errorRef}
          className="flex items-start gap-2 rounded-md border border-l-4 border-danger border-l-danger bg-danger-soft px-4 py-3 text-sm text-text"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" />
          <span className="flex-1">{loadError}</span>
          <button
            type="button"
            onClick={() => setLoadError(null)}
            aria-label="Dismiss error"
            className="shrink-0 text-muted hover:text-danger"
          >
            <X size={15} />
          </button>
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

          {/* Live write progress. Deliberately its own card rather than a line
              in the summary: a write is spending real money against real
              orders, and while it's happening it should be the most
              prominent thing on the page. */}
          {isWriting && (
            <Card className="border-accent p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Loader2 size={20} className="animate-spin text-accent" />
                  <div>
                    <p className="text-sm font-semibold text-text">
                      Writing to {run.writeEnv ?? env} — {writeProgress.done} of {writeProgress.total}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {writeProgress.written} written
                      {writeProgress.failed > 0 ? `, ${writeProgress.failed} failed` : ''}
                      {writeProgress.skipped > 0 ? `, ${writeProgress.skipped} skipped` : ''}
                      {writeProgress.amountWritten > 0
                        ? ` · ${money(writeProgress.amountWritten, 'USD')} committed so far`
                        : ''}
                    </p>
                  </div>
                </div>
                <SecondaryButton onClick={() => setShowCancelConfirm(true)} disabled={cancelling}>
                  <StopCircle size={16} />
                  {cancelling ? 'Cancelling...' : 'Cancel write'}
                </SecondaryButton>
              </div>

              <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-bg">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-300"
                  style={{
                    width: `${writeProgress.total > 0 ? Math.round((writeProgress.done / writeProgress.total) * 100) : 0}%`,
                  }}
                />
              </div>

              {/* The amounts themselves, as they land — the specific thing
                  worth watching during a money write. */}
              {writeResults.length > 0 && (
                <ul className="mt-4 max-h-44 space-y-1 overflow-y-auto">
                  {writeResults.map((r) => (
                    <li key={r.extractionId} className="flex items-center gap-2 text-xs">
                      {r.status === 'success' ? (
                        <CheckCircle2 size={12} className="shrink-0 text-success" />
                      ) : r.status === 'skipped' ? (
                        <X size={12} className="shrink-0 text-muted" />
                      ) : (
                        <AlertTriangle size={12} className="shrink-0 text-danger" />
                      )}
                      <span className="font-medium text-accent">{r.orderNumber}</span>
                      {r.writtenPrice && <span className="text-text">{money(Number(r.writtenPrice), 'USD')}</span>}
                      {r.writtenEsd && <span className="text-muted">ESD {r.writtenEsd}</span>}
                      <span className={r.status === 'success' ? 'text-success' : 'text-muted'}>
                        {r.status === 'success' ? (r.markedRead ? 'written · email read' : 'written') : r.status}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex items-center gap-2 text-sm text-text">
              {isRunning ? (
                <>
                  <Loader2 size={16} className="animate-spin text-accent" />
                  {run.phase === 'writing'
                    ? `Writing to MXI — ${writeProgress.done} of ${writeProgress.total}`
                    : run.phase === 'reading-outlook'
                      ? 'Reading Outlook folder...'
                      : `Extracting PDFs...${run.pdfCount ? ` (${rows.length} of ${run.pdfCount})` : ''}`}
                </>
              ) : hasWriteRun ? (
                <>
                  <CheckCircle2 size={16} className="text-success" />
                  {run.status === 'cancelled' ? 'Write cancelled — ' : 'Write complete — '}
                  {writeProgress.written} written
                  {writeProgress.failed > 0 ? `, ${writeProgress.failed} failed` : ''}
                  {writeProgress.skipped > 0 ? `, ${writeProgress.skipped} skipped` : ''}
                  {writeProgress.amountWritten > 0 ? ` · ${money(writeProgress.amountWritten, 'USD')} total` : ''}
                </>
              ) : (
                <>
                  <CheckCircle2 size={16} className="text-success" />
                  {run.status === 'cancelled' ? 'Cancelled — ' : 'Done — '}
                  {quotes.length} quote(s), {willWrite.length} will write
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

          {nrepCount > 0 && (
            <div className="rounded-md border border-l-4 border-danger border-l-danger bg-danger-soft px-4 py-3 text-sm text-text">
              <span className="font-semibold">{nrepCount} quote(s): the vendor says the part is NON-REPAIRABLE.</span>{' '}
              These are excluded from the MXI write automatically and tagged for the scrap process. Undo on a row if you
              disagree with that read.
            </div>
          )}

          {berCount > 0 && (
            <div className="rounded-md border border-l-4 border-warning border-l-warning bg-warning-soft px-4 py-3 text-sm text-text">
              <span className="font-semibold">{berCount} quote(s) marked BER need a scrap fee before they can be written.</span>{' '}
              A BER call is made on an ordinary repair quote, so the extracted amount is that quote&apos;s repair cost — not a
              scrap fee. Writing it would charge the wrong amount, so those rows are held back.
            </div>
          )}

          {needsReview.length > 0 && (
            <div className="rounded-md border border-l-4 border-warning border-l-warning bg-warning-soft px-4 py-3 text-sm text-text">
              {needsReview.length} quote(s) need a look before they could be written — see the flagged rows below.
            </div>
          )}

          {!isRunning && quotes.length > 0 && (
            <>
              <EnvironmentBar env={env} onChange={setEnv} disabled={isRunning} />
              <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-4 py-3">
                <p className="text-sm text-text">
                  {willWrite.length > 0 ? (
                    <>
                      <span className="font-semibold">{willWrite.length}</span> quote(s) will be written to{' '}
                      <span className="font-semibold">{env}</span> — price, Price Type=QUOTE, and ESD as Promise By.
                      Their emails get marked read only after the write is verified.
                    </>
                  ) : (
                    'No quotes are currently marked to write — every row is excluded.'
                  )}
                </p>
                <PrimaryButton onClick={() => setShowWriteConfirm(true)} disabled={willWrite.length === 0}>
                  <PlayCircle size={16} />
                  Write {willWrite.length} to MXI
                </PrimaryButton>
              </div>
            </>
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
                    <th className="px-5 py-3 font-medium">Disposition</th>
                    {hasWriteRun && <th className="px-5 py-3 font-medium">Write status</th>}
                    <th className="px-5 py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {quotes.map((r) => {
                    const disp = effectiveDisposition(r)
                    const excluded = disp === 'excluded_other'
                    const badge = dispositionBadge(disp, r.suggestsExchange)
                    return (
                    <tr
                      key={r.extractionId}
                      className={`border-b border-border last:border-0 ${
                        excluded ? 'opacity-55' : r.needsReview ? 'bg-warning-soft/40' : 'hover:bg-bg'
                      }`}
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
                        {/* An exchange takes a completely different MXI path
                            (Convert Repair To Exchange, not a price line), so
                            it must be obvious before anyone hits Write. */}
                        {r.suggestsExchange && (
                          <div className="mt-1">
                            <Badge tone="warning">EXCHANGE</Badge>
                            {r.exchangeEvidence && (
                              <p className="mt-0.5 max-w-[14rem] text-xs italic text-muted" title={r.exchangeEvidence}>
                                “{r.exchangeEvidence}”
                              </p>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                        {disp === 'excluded_nrep' && r.nonRepairableEvidence && (
                          <p className="mt-1 max-w-[16rem] text-xs italic text-muted" title={r.nonRepairableEvidence}>
                            “{r.nonRepairableEvidence}”
                          </p>
                        )}
                      </td>
                      {hasWriteRun && (
                        <td className="px-5 py-3">
                          <WriteStatusCell
                            result={writeResultByExtraction.get(r.extractionId)}
                            excluded={excluded}
                            jobDone={!isRunning}
                          />
                        </td>
                      )}
                      <td className="px-5 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          {hasWriteRun ? (
                            <span className="text-xs text-muted">—</span>
                          ) : disp === 'pending' ? (
                            <>
                              <button
                                type="button"
                                onClick={() => handleDisposition(r, 'excluded_ber')}
                                title="Mark Beyond Economical Repair — excludes it from MXI and tags it for the scrap process"
                                className="rounded border border-border px-2 py-1 text-xs font-medium text-text hover:border-danger hover:text-danger"
                              >
                                BER
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDisposition(r, 'excluded_other')}
                                title="Don't write this one to MXI (no reason needed)"
                                aria-label={`Exclude ${r.orderNumber ?? r.fileName}`}
                                className="rounded border border-border p-1 text-muted hover:border-danger hover:text-danger"
                              >
                                <X size={14} />
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleDisposition(r, 'pending')}
                              title={
                                disp === 'excluded_nrep'
                                  ? 'Vendor called this non-repairable. Put it back in the write set if you disagree.'
                                  : 'Put this back in the write set'
                              }
                              className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs font-medium text-accent hover:bg-accent-soft"
                            >
                              {disp === 'excluded_nrep' ? <Undo2 size={13} /> : <RotateCcw size={13} />}
                              Undo
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    )
                  })}
                  {quotes.length === 0 && (
                    <tr>
                      <td colSpan={10} className="px-5 py-6 text-center text-muted">
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

      {showWriteConfirm && (
        <ConfirmDialog
          title={`Write ${willWrite.length} quote(s) to ${env}?`}
          message={
            `This updates real orders in ${env}: Unit Price, Price Type = QUOTE, and Promise By set to each quote's ESD. ` +
            `Each source email is marked read only after its write is verified — anything that fails stays unread and can be re-run. ` +
            `Excluded, BER, and NREP rows are not touched.`
          }
          confirmLabel={`Yes, write to ${env}`}
          cancelLabel="Never mind"
          onConfirm={handleWriteConfirmed}
          onCancel={() => setShowWriteConfirm(false)}
        />
      )}

      {showCancelConfirm && (
        <ConfirmDialog
          title={isWriting ? 'Cancel this write?' : 'Cancel this run?'}
          message={
            isWriting
              ? "This stops after the current order. Orders already written are real and stay written — they are not rolled back. Anything not yet attempted is simply left alone, still unread in the folder, and can be run again."
              : "This stops after the current PDF. Quotes already extracted stay recorded. Nothing has been written to MXI or your mailbox, so there's nothing to undo."
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
