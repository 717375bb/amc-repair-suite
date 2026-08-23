import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, PlayCircle, StopCircle, UploadCloud, X } from 'lucide-react'
import { Card, CardHeader, PrimaryButton, SecondaryButton } from '../components/ui'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { EnvironmentBar } from '../components/EnvironmentBar'
import { ApiError } from '../lib/api'
import type { MxiEnv } from '../lib/quoteApi'
import {
  cancelScrapRun,
  getActiveScrapJob,
  getScrapRun,
  startInHouseScrap,
  startVendorScrap,
  previewSerialList,
  type ScrapRunStatusResponse,
} from '../lib/scrapApi'

const POLL_MS = 2000

type ScrapKind = 'vendor' | 'in_house'

function isTerminal(status: ScrapRunStatusResponse['status'] | undefined): boolean {
  return !!status && status !== 'running' && status !== 'pending'
}

function phaseLabel(phase: string | null): string {
  switch (phase) {
    case 'reading-certificate':
      return 'Reading the scrap certificate...'
    case 'certificate-read':
      return 'Certificate read — starting the scrap...'
    case 'scrapping':
      return 'Scrapping in MXI...'
    default:
      return 'Working...'
  }
}

export default function ScrapOut() {
  const [kind, setKind] = useState<ScrapKind>('vendor')
  const [env, setEnv] = useState<MxiEnv>('production')
  const [certificate, setCertificate] = useState<File | null>(null)
  const [serialNumber, setSerialNumber] = useState('')
  const [isDragOver, setIsDragOver] = useState(false)

  const [runId, setRunId] = useState<string | null>(null)
  const [run, setRun] = useState<ScrapRunStatusResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeJobRunId, setActiveJobRunId] = useState<string | null>(null)
  const [showConfirm, setShowConfirm] = useState(false)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  const pollRef = useRef<number | null>(null)
  const errorRef = useRef<HTMLDivElement | null>(null)
  const isRunning = !!runId && !isTerminal(run?.status)

  const reportError = (message: string) => {
    setLoadError(message)
    requestAnimationFrame(() => errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  }

  useEffect(() => {
    getActiveScrapJob()
      .then((r) => setActiveJobRunId(r.activeRunId))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!runId) return
    let cancelled = false
    const tick = async () => {
      try {
        const status = await getScrapRun(runId)
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
  }, [runId])

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return
    setCertificate(files[0])
  }

  // Parsed for preview only — the SERVER's own parse is authoritative.
  const parsedSerials = useMemo(() => previewSerialList(serialNumber), [serialNumber])
  const succeeded = (run?.results ?? []).filter((r) => r.status === 'success').length
  const anyFailed = (run?.results ?? []).some((r) => r.status === 'failed')
  const canRun = kind === 'vendor' ? !!certificate : parsedSerials.serials.length > 0

  const handleConfirmed = async () => {
    setShowConfirm(false)
    setLoadError(null)
    setRun(null)
    try {
      const { runId: newRunId } =
        kind === 'vendor'
          ? await startVendorScrap({ certificate: certificate!, env })
          : await startInHouseScrap(serialNumber, env)
      setRunId(newRunId)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        reportError(`A scrap job is already running (${err.activeRunId ?? 'unknown'}).`)
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
      await cancelScrapRun(runId)
    } catch (err) {
      reportError(err instanceof Error ? err.message : String(err))
    } finally {
      setCancelling(false)
    }
  }

  const reset = () => {
    setRunId(null)
    setRun(null)
    setCertificate(null)
    setSerialNumber('')
    setLoadError(null)
  }

  return (
    <div className="space-y-5" data-workflow="scrap-out">
      {loadError && (
        <div
          ref={errorRef}
          className="flex items-start gap-2 rounded-md border border-l-4 border-danger border-l-danger bg-danger-soft px-4 py-3 text-sm text-text"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" />
          <span className="flex-1">{loadError}</span>
          <button type="button" onClick={() => setLoadError(null)} aria-label="Dismiss" className="shrink-0 text-muted hover:text-danger">
            <X size={15} />
          </button>
        </div>
      )}

      {activeJobRunId && !runId && (
        <div className="rounded-md border border-l-4 border-warning border-l-warning bg-warning-soft px-4 py-3 text-sm text-text">
          A scrap job is already running ({activeJobRunId}). Wait for it to finish.
        </div>
      )}

      <div className="rounded-md border border-l-4 border-danger border-l-danger bg-danger-soft px-4 py-3 text-sm text-text">
        <span className="font-semibold">Scrapping is irreversible.</span> This physically scraps the part in MXI — it
        cannot be undone from here, and the same serial can only be scrapped once.
      </div>

      {/* Vendor / in-house toggle */}
      <div className="flex overflow-hidden rounded-md border border-border w-fit">
        {(['vendor', 'in_house'] as const).map((k) => (
          <button
            key={k}
            type="button"
            disabled={isRunning}
            onClick={() => setKind(k)}
            className={`px-4 py-2 text-sm font-medium disabled:cursor-not-allowed ${
              kind === k ? 'bg-accent text-white' : 'bg-surface text-text hover:bg-bg'
            }`}
          >
            {k === 'vendor' ? 'Scrapped at vendor' : 'In-house scrap'}
          </button>
        ))}
      </div>

      {kind === 'vendor' ? (
        <Card>
          <CardHeader
            title="Vendor scrap"
            description="Drop the vendor's scrap certificate. The order number and serial are read from it — you don't need to type them."
          />
          <div className="p-5">
            <div
              onDragOver={(e: DragEvent<HTMLDivElement>) => {
                e.preventDefault()
                if (!isRunning) setIsDragOver(true)
              }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={(e: DragEvent<HTMLDivElement>) => {
                e.preventDefault()
                setIsDragOver(false)
                if (!isRunning) handleFiles(e.dataTransfer.files)
              }}
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
                Drag the scrap certificate here, or{' '}
                <label htmlFor="scrap-cert" className={isRunning ? 'text-muted' : 'cursor-pointer font-medium text-accent hover:underline'}>
                  browse
                </label>
              </p>
              <input
                id="scrap-cert"
                type="file"
                accept=".pdf"
                disabled={isRunning}
                className="hidden"
                onChange={(e) => {
                  handleFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </div>

            {certificate && (
              <div className="mt-4 flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2 text-sm">
                <span className="flex items-center gap-2 overflow-hidden">
                  <FileSpreadsheet size={15} className="text-muted" />
                  <span className="truncate text-text">{certificate.name}</span>
                </span>
                {!isRunning && (
                  <button type="button" onClick={() => setCertificate(null)} className="text-muted hover:text-danger" aria-label="Remove">
                    <X size={16} />
                  </button>
                )}
              </div>
            )}
          </div>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="In-house scrap"
            description="No certificate — an in-house scrap is PSA's own decision. Enter the serial number of the part."
          />
          <div className="p-5">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Serial number(s)
              </span>
              <textarea
                value={serialNumber}
                disabled={isRunning}
                rows={5}
                onChange={(e) => setSerialNumber(e.target.value)}
                placeholder={'233398\nD5300-120\n...'}
                className="w-full max-w-lg rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
            <p className="mt-1.5 text-xs text-muted">
              One per line, or separated by commas. Paste a whole list — they run one at a time, in order.
            </p>

            {parsedSerials.serials.length > 0 && (
              <p className="mt-2 text-sm text-text">
                <span className="font-semibold">{parsedSerials.serials.length}</span> serial
                {parsedSerials.serials.length === 1 ? '' : 's'} will be scrapped
                {parsedSerials.duplicatesRemoved > 0 && (
                  <span className="text-muted">
                    {' '}
                    ({parsedSerials.duplicatesRemoved} duplicate
                    {parsedSerials.duplicatesRemoved === 1 ? '' : 's'} ignored — scrapping the same serial twice would
                    attempt to destroy something already gone)
                  </span>
                )}
                .
              </p>
            )}

            <p className="mt-2 text-xs text-muted">
              The repair shop is derived from each item&apos;s own current location (DAY routes to REPAIR2/SHOP2). If
              none of the expected locations exist for a site, that serial stops rather than guessing — the rest of the
              list still runs.
            </p>
          </div>
        </Card>
      )}

      <EnvironmentBar env={env} onChange={setEnv} disabled={isRunning} />

      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-4 py-3">
        <p className="text-sm text-text">
          {canRun
            ? `Ready to scrap in ${env}.`
            : kind === 'vendor'
              ? 'Upload a scrap certificate to continue.'
              : 'Enter a serial number to continue.'}
        </p>
        <div className="flex gap-2">
          {isRunning && (
            <SecondaryButton onClick={() => setShowCancelConfirm(true)} disabled={cancelling}>
              <StopCircle size={16} />
              {cancelling ? 'Cancelling...' : 'Cancel'}
            </SecondaryButton>
          )}
          <PrimaryButton onClick={() => setShowConfirm(true)} disabled={!canRun || isRunning || !!activeJobRunId}>
            {isRunning ? <Loader2 size={16} className="animate-spin" /> : <PlayCircle size={16} />}
            Scrap in MXI
          </PrimaryButton>
        </div>
      </div>

      {run && (
        <Card className={anyFailed || run.status === 'failed' ? 'border-danger' : ''}>
          <CardHeader
            title={isRunning ? 'In progress' : succeeded > 0 && !anyFailed ? 'Scrapped' : 'Result'}
            description={
              `${run.kind === 'vendor' ? 'Vendor scrap' : 'In-house scrap'} in ${run.env}` +
              (run.totalRequested > 1 ? ` — ${run.results.length} of ${run.totalRequested} processed` : '')
            }
          />
          <div className="space-y-3 p-5">
            {isRunning && (
              <p className="flex items-center gap-2 text-sm text-text">
                <Loader2 size={16} className="animate-spin text-accent" />
                {phaseLabel(run.phase)}
                {run.totalRequested > 1 && ` (${run.results.length} of ${run.totalRequested} done)`}
              </p>
            )}

            {/* A batch summary, so a single failure among many can't be lost
                by scrolling past it. */}
            {run.totalRequested > 1 && run.results.length > 0 && (
              <p className="text-sm text-text">
                <span className="font-semibold text-success">{succeeded} scrapped</span>
                {anyFailed && <span className="font-semibold text-danger">, {run.results.length - succeeded} failed</span>}
                {!isRunning && run.results.length < run.totalRequested && (
                  <span className="text-muted"> · {run.totalRequested - run.results.length} never attempted</span>
                )}
              </p>
            )}

            {run.certPreview && (
              <div className="rounded-md border border-border bg-bg p-3 text-sm">
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Read from the certificate</p>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
                  <Field label="Order" value={run.certPreview.orderNumber} />
                  <Field label="Serial" value={run.certPreview.serialNumber} />
                  <Field label="P/N" value={run.certPreview.partNumber} />
                  <Field label="Vendor" value={run.certPreview.vendorName} />
                </div>
              </div>
            )}

            {run.fatalError && <p className="text-sm text-danger">{run.fatalError}</p>}

            {/* One block per serial. Each keeps its own steps and reason, so
                a batch failure says exactly which part and why rather than
                collapsing into a single verdict. */}
            {run.results.map((result, idx) => (
              <div
                key={result.serialNumber ?? idx}
                className={
                  run.results.length > 1
                    ? `rounded-md border p-3 ${result.status === 'success' ? 'border-border bg-bg' : 'border-danger bg-danger-soft/30'}`
                    : ''
                }
              >
                <p className="flex items-center gap-2 text-sm font-medium">
                  {result.status === 'success' ? (
                    <>
                      <CheckCircle2 size={16} className="text-success" />
                      <span className="text-success">Scrapped and verified</span>
                    </>
                  ) : (
                    <>
                      <AlertTriangle size={16} className="text-danger" />
                      <span className="text-danger">Not scrapped</span>
                    </>
                  )}
                  {result.serialNumber && (
                    <span className="font-mono text-xs text-muted">{result.serialNumber}</span>
                  )}
                </p>

                {result.errorMessage && <p className="mt-1 text-sm text-text">{result.errorMessage}</p>}

                {run.kind === 'vendor' && result.status === 'success' && !result.certAttached && (
                  <p className="mt-1 text-sm text-warning">
                    The part was scrapped, but the certificate file could not be attached — attach it by hand in MXI.
                  </p>
                )}
                {result.locationUsed && (
                  <p className="mt-1 text-sm text-muted">
                    Location used: <span className="font-medium text-text">{result.locationUsed}</span>
                  </p>
                )}

                {result.stepsTaken.length > 0 && (
                  <div className="mt-2">
                    <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
                      Steps actually performed
                    </p>
                    <ul className="space-y-0.5">
                      {result.stepsTaken.map((s, i) => (
                        <li key={i} className="text-xs text-muted">
                          · {s}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ))}
          </div>
          {!isRunning && (
            <div className="flex justify-end border-t border-border px-5 py-4">
              <SecondaryButton onClick={reset}>Scrap another</SecondaryButton>
            </div>
          )}
        </Card>
      )}

      {showConfirm && (
        <ConfirmDialog
          title={
            kind === 'vendor' || parsedSerials.serials.length === 1
              ? `Scrap this part in ${env}?`
              : `Scrap ${parsedSerials.serials.length} parts in ${env}?`
          }
          message={
            kind === 'vendor'
              ? `The order number and serial will be read from "${certificate?.name}", and that part will be physically scrapped in ${env}. This cannot be undone. If the certificate doesn't read cleanly, nothing is scrapped.`
              : `${parsedSerials.serials.join(', ')} will be scheduled and transferred for scrap in ${env}, one at a time. This cannot be undone. If one fails, the rest still run — each reports its own result.`
          }
          confirmLabel={`Yes, scrap in ${env}`}
          cancelLabel="Never mind"
          onConfirm={handleConfirmed}
          onCancel={() => setShowConfirm(false)}
        />
      )}

      {showCancelConfirm && (
        <ConfirmDialog
          title="Cancel this scrap?"
          message="This stops after the current step. Anything already committed in MXI stays committed — a partially-processed part will need checking by hand."
          confirmLabel="Yes, cancel"
          cancelLabel="Never mind"
          onConfirm={handleCancelConfirmed}
          onCancel={() => setShowCancelConfirm(false)}
        />
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className="text-sm font-medium text-text">{value ?? '—'}</p>
    </div>
  )
}
