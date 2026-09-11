import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  Loader2,
  PlayCircle,
  RefreshCw,
  Search,
  StopCircle,
  UploadCloud,
} from 'lucide-react'
import { Badge, Card, CardHeader, PrimaryButton, SecondaryButton } from '../components/ui'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { EnvironmentBar } from '../components/EnvironmentBar'
import { BackShopRun, ScrapRun } from '../lib/tabRuns'
import { ApiError } from '../lib/api'
import type { MxiEnv } from '../lib/quoteApi'
import {
  getActiveBackShopJob,
  getSyncedListing,
  startDiscovery,
  uploadListing,
  type BackShopFinding,
  type BackShopListing,
  type BackShopRow,
} from '../lib/backShopApi'
import { startInHouseScrap } from '../lib/scrapApi'
import { getActivePinsJob, getPinsRun, startPinsRun, type PinsRoutingRunResult, type PinsRunStatusResponse } from '../lib/pinsApi'

/**
 * Back Shop — the daily in-house scrap list.
 *
 * Three steps, kept visibly separate because the last one is irreversible:
 *   1. Load the day's sheet (synced from SharePoint, or uploaded).
 *   2. Read each part's note in MXI — read-only — to see which say scrap.
 *   3. Review the candidates and confirm a selection to actually scrap.
 *
 * Step 3 hands off to the Scrap tab's existing in-house job, which is the
 * one authority on scrapping. Nothing here scraps anything by itself, and
 * discovery never flows straight into the write.
 */

const useBackShopRun = BackShopRun.useTrackedRun
const useScrapRun = ScrapRun.useTrackedRun

function isTerminal(status: string | undefined): boolean {
  return !!status && status !== 'running' && status !== 'pending'
}

function serialKey(row: { serialNumber: string }): string {
  return row.serialNumber.toUpperCase()
}

/** One pin's own result within the (possibly still-running) batched pins job, if it's reported back yet. */
function PinsResultLine({ result }: { result: PinsRoutingRunResult | undefined }) {
  if (!result) return null
  if (result.status === 'success') {
    const detail =
      result.path === 'correct_base' ? `transferred to ${result.locationUsed}` : `shipped to ${result.destination}/DOCK`
    return (
      <p className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-success">
        <CheckCircle2 size={13} />
        Done — {detail} ({result.currentLocation} was the starting location)
      </p>
    )
  }
  if (result.status === 'tied') {
    return (
      <p className="mt-1.5 text-xs text-warning">
        Two or more back shops are tied for the lowest total — nothing was written.{' '}
        {result.totals && Object.entries(result.totals).map(([base, total]) => `${base}: ${total}`).join(', ')}
      </p>
    )
  }
  if (result.status === 'destination_not_found') {
    return <p className="mt-1.5 text-xs text-warning">{result.errorMessage}</p>
  }
  return (
    <p className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-danger">
      <AlertTriangle size={13} />
      Failed — {result.errorMessage ?? 'unknown error'}
    </p>
  )
}

export default function BackshopRepairs() {
  const [env, setEnv] = useState<MxiEnv>('production')
  const [listing, setListing] = useState<BackShopListing | null>(null)
  const [listingMissing, setListingMissing] = useState(false)
  const [loadingListing, setLoadingListing] = useState(true)
  const [craFilter, setCraFilter] = useState<string>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  // Per explicit user direction (2026-09-11): pins are "looped in with the
  // scrap process" — ONE Run action handles both a selected scrap batch
  // and every pin found, not two separate buttons. showRunConfirm gates
  // that single combined action.
  const [showRunConfirm, setShowRunConfirm] = useState(false)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Pins batch job — plain page-local polling rather than the shared
  // tracked-run system, since this is started and watched from the same
  // card it was launched from, not a long-running job an analyst would
  // navigate away from and check on later (see lib/pinsApi.ts's own
  // docblock). ONE job covers every pin found in this discovery pass.
  const [activePinsRunId, setActivePinsRunId] = useState<string | null>(null)
  const [pinsRun, setPinsRun] = useState<PinsRunStatusResponse | null>(null)
  const [pinsStarting, setPinsStarting] = useState(false)
  const isPinsRunning = !!activePinsRunId && !isTerminal(pinsRun?.status)

  const { runId, run, startTracking, cancel: cancelRun, clear: clearRun } = useBackShopRun()
  const { startTracking: startScrapTracking } = useScrapRun()
  const isDiscovering = !!runId && !isTerminal(run?.status)

  const reportError = (err: unknown) => {
    setError(err instanceof ApiError || err instanceof Error ? err.message : String(err))
  }

  const loadSynced = async () => {
    setLoadingListing(true)
    setError(null)
    try {
      const result = await getSyncedListing()
      setListing(result.listing)
      setListingMissing(!result.found)
    } catch (err) {
      reportError(err)
    } finally {
      setLoadingListing(false)
    }
  }

  useEffect(() => {
    void loadSynced()
    // Re-attach to a discovery pass already running from another tab.
    void getActiveBackShopJob()
      .then(({ activeRunId }) => {
        if (activeRunId) startTracking(activeRunId)
      })
      .catch(() => {
        /* a missing active job is not an error worth showing */
      })
    // Same re-attach, for a pins run — a page reload mid-run would
    // otherwise show an idle button while the job kept going server-side.
    void getActivePinsJob()
      .then(({ activeRunId }) => {
        if (activeRunId) setActivePinsRunId(activeRunId)
      })
      .catch(() => {
        /* a missing active job is not an error worth showing */
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Poll while a pins run is tracked and not yet terminal — same shape as
  // trackedRun.tsx's own polling loop, just page-local (see the state
  // declarations above for why this isn't the shared system).
  useEffect(() => {
    if (!activePinsRunId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      try {
        const next = await getPinsRun(activePinsRunId)
        if (stopped) return
        setPinsRun(next)
        if (isTerminal(next.status)) return
      } catch {
        // Keep polling through a transient failure rather than abandoning
        // a live run — a genuinely gone run resolves to a terminal status
        // soon enough, same reasoning as trackedRun.tsx.
      }
      if (!stopped) timer = setTimeout(() => void tick(), 2000)
    }

    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [activePinsRunId])

  const handleUpload = async (file: File | null | undefined) => {
    if (!file) return
    setLoadingListing(true)
    setError(null)
    try {
      const result = await uploadListing(file)
      setListing(result.listing)
      setListingMissing(false)
    } catch (err) {
      reportError(err)
    } finally {
      setLoadingListing(false)
    }
  }

  const craFiltered = useMemo(() => {
    if (!listing) return []
    if (craFilter === 'all') return listing.open
    return listing.open.filter((row) => (row.cra ?? '') === craFilter)
  }, [listing, craFilter])

  const findings: BackShopFinding[] = run?.findings ?? []
  const recommended = findings.filter((f) => f.outcome === 'scrap_recommended')
  const negated = findings.filter((f) => f.outcome === 'scrap_negated')
  const noNote = findings.filter((f) => f.outcome === 'no_scrap_note')
  const unreadable = findings.filter((f) => f.outcome === 'unreadable')
  // Pins (PN 4114T06P03) are never scrapped, so they never had a scrap note
  // to find — kept in their own section rather than lumped into "Not
  // recommended," which would otherwise make them look identical to a part
  // with genuinely nothing to do (the exact problem this was built to fix).
  const pinsProcess = findings.filter((f) => f.outcome === 'pins_process')

  // Never re-offered to run again once it has genuinely succeeded.
  // Neither runPinCorrectBaseFlow nor runPinWrongBaseShipmentFlow check
  // "is this already done" before acting, so re-submitting a pin whose
  // last attempt succeeded would create a real second task/transfer/
  // shipment in MXI, not a harmless no-op — same reasoning OrderWriteUps
  // already applies to an already-written line. Pins have no checkbox
  // selection (per explicit user direction, all found pins run together),
  // so this exclusion is what keeps a second "Run" press safe.
  const pinsAlreadySucceeded = new Set(
    (pinsRun?.results ?? []).filter((r) => r.status === 'success').map((r) => r.bn.toUpperCase()),
  )
  const pinsToRun = pinsProcess.filter((f) => !pinsAlreadySucceeded.has(serialKey(f)))

  // Every scrap-recommended part at an approved base starts selected, per
  // the ask ("default to select all parts that are scrap-recommended").
  // Parts at a base PSA doesn't scrap at are deliberately NOT pre-selected —
  // the scrap flow itself refuses them, and pre-ticking something that
  // cannot run would just produce a batch of failures.
  const previousRecommendedCount = useRef(0)
  useEffect(() => {
    if (recommended.length === previousRecommendedCount.current) return
    previousRecommendedCount.current = recommended.length
    setSelected(new Set(recommended.filter((f) => f.baseApproved).map(serialKey)))
  }, [recommended])

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectedFindings = findings.filter((f) => selected.has(serialKey(f)))

  const handleDiscover = async () => {
    setError(null)
    try {
      const rows: BackShopRow[] = craFiltered
      const { runId: newRunId } = await startDiscovery(rows, env)
      clearRun()
      startTracking(newRunId)
    } catch (err) {
      if (err instanceof ApiError && err.activeRunId) startTracking(err.activeRunId)
      reportError(err)
    }
  }

  // Per explicit user direction (2026-09-11): ONE "Run" press handles both
  // the selected scrap batch and every pin found — "looped in with the
  // scrap process" rather than a separate button. The two are still
  // mechanically distinct jobs (a scrap batch and a pins batch, each with
  // its own MXI session), just started together from this one confirm.
  const handleRunConfirmed = async () => {
    setShowRunConfirm(false)
    setError(null)
    try {
      if (selectedFindings.length > 0) {
        // Handed to the Scrap tab's job, which owns every scrap in this
        // app. Its own guards (already-scrapped check, approved-base
        // check) still run — this selection is a request, not an
        // authority.
        const { runId: scrapRunId } = await startInHouseScrap(
          selectedFindings.map((f) => f.serialNumber).join('\n'),
          env,
        )
        startScrapTracking(scrapRunId)
      }
      if (pinsToRun.length > 0) {
        setPinsStarting(true)
        const { runId } = await startPinsRun(pinsToRun.map((f) => f.serialNumber), env)
        setPinsRun(null)
        setActivePinsRunId(runId)
      }
    } catch (err) {
      reportError(err)
    } finally {
      setPinsStarting(false)
    }
  }

  const handleCancelConfirmed = async () => {
    setShowCancelConfirm(false)
    setCancelling(true)
    try {
      await cancelRun()
    } catch (err) {
      reportError(err)
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div data-workflow="backshop-repairs" className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-text">Back Shop</h1>
        <p className="mt-1 text-sm text-muted">
          Today's back-shop list, checked against each part's note in MXI. Reading is automatic; scrapping is not.
        </p>
      </div>

      <EnvironmentBar env={env} onChange={setEnv} disabled={isDiscovering} />

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-danger bg-danger-soft px-4 py-3 text-sm text-danger">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* ---------------- Step 1: the sheet ---------------- */}
      <Card>
        <CardHeader
          title="1. Today's list"
          description="BackShopListing.xlsm, sheet &quot;Today&quot;."
          action={
            <SecondaryButton onClick={() => void loadSynced()} disabled={loadingListing}>
              <RefreshCw size={16} /> Reload
            </SecondaryButton>
          }
        />
        <div className="space-y-3 px-5 py-4">
          {loadingListing && (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Loader2 size={16} className="animate-spin" /> Looking for the synced sheet...
            </p>
          )}

          {!loadingListing && listingMissing && (
            <div className="space-y-2">
              <p className="text-sm text-text">
                No synced copy found on this machine. Sync the CRA Team library in OneDrive, or upload the workbook
                directly.
              </p>
              <SecondaryButton onClick={() => fileInputRef.current?.click()}>
                <UploadCloud size={16} /> Upload BackShopListing.xlsm
              </SecondaryButton>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsm,.xlsx"
            className="hidden"
            onChange={(e) => void handleUpload(e.target.files?.[0])}
          />

          {listing && (
            <div className="space-y-3">
              {/* Never suppressed: running yesterday's list would scrap the wrong parts. */}
              {listing.warning && (
                <div className="flex items-start gap-2 rounded-md border border-warning bg-warning-soft px-3 py-2 text-sm text-warning">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                  <span>{listing.warning}</span>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                <FileSpreadsheet size={16} />
                <span>
                  {listing.open.length} open, {listing.alreadyHandled.length} already handled on the sheet
                </span>
                {listing.isToday && <Badge tone="success">Today's list</Badge>}
                {listing.source === 'upload' && <Badge tone="neutral">Uploaded copy</Badge>}
              </div>

              {listing.filePath && <p className="text-xs text-muted">{listing.filePath}</p>}

              <div className="flex flex-wrap items-center gap-2">
                <label className="text-sm text-text" htmlFor="cra-filter">
                  CRA
                </label>
                <select
                  id="cra-filter"
                  value={craFilter}
                  onChange={(e) => setCraFilter(e.target.value)}
                  disabled={isDiscovering}
                  className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
                >
                  <option value="all">Everyone ({listing.open.length})</option>
                  {listing.craOptions.map((cra) => (
                    <option key={cra} value={cra}>
                      {cra} ({listing.open.filter((r) => r.cra === cra).length})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* ---------------- Step 2: discovery ---------------- */}
      <Card>
        <CardHeader
          title="2. Check each part's note in MXI"
          description="Read-only. Opens each part record and reads its note — nothing is written or scrapped."
          action={
            isDiscovering ? (
              <SecondaryButton onClick={() => setShowCancelConfirm(true)} disabled={cancelling}>
                <StopCircle size={16} /> {cancelling ? 'Stopping...' : 'Stop'}
              </SecondaryButton>
            ) : (
              <PrimaryButton onClick={() => void handleDiscover()} disabled={craFiltered.length === 0}>
                <Search size={16} /> Check {craFiltered.length} part{craFiltered.length === 1 ? '' : 's'}
              </PrimaryButton>
            )
          }
        />
        <div className="px-5 py-4">
          {isDiscovering && (
            <p className="flex items-center gap-2 text-sm text-text">
              <Loader2 size={16} className="animate-spin" />
              {run?.phase ?? 'Starting...'}
            </p>
          )}
          {!isDiscovering && findings.length === 0 && (
            <p className="text-sm text-muted">
              Nothing checked yet. This reads the part note for each listed part and sorts them into scrap candidates
              and everything else.
            </p>
          )}
          {!isDiscovering && findings.length > 0 && (
            <p className="text-sm text-text">
              {recommended.length} scrap-recommended, {negated.length} whose note says not to, {noNote.length} with no
              scrap note, {unreadable.length} that could not be read, {pinsProcess.length} pin{pinsProcess.length === 1 ? '' : 's'} routed to the Pins process instead.
            </p>
          )}
          {run?.fatalError && <p className="mt-2 text-sm text-danger">{run.fatalError}</p>}
        </div>
      </Card>

      {/*
        ---------------- Step 3: review and run ----------------
        Per explicit user direction (2026-09-11): ONE Run action for both
        the scrap batch and every pin found — pins are "looped in with the
        scrap process" rather than reviewed/run separately. Scrap
        candidates keep their own checkboxes (each has a real note worth
        weighing); pins don't (there's no note to weigh — a pin is a pin)
        and always run when found, minus any that already succeeded.
      */}
      {(recommended.length > 0 || pinsProcess.length > 0) && (
        <Card>
          <CardHeader
            title="3. Review and run"
            description="Scrap candidates are pre-selected — untick anything you don't want scrapped. Pins found always run; there's no note to review for one."
            action={
              <PrimaryButton
                onClick={() => setShowRunConfirm(true)}
                disabled={(selectedFindings.length === 0 && pinsToRun.length === 0) || isPinsRunning || pinsStarting}
              >
                <PlayCircle size={16} />
                Run
                {selectedFindings.length > 0 && ` ${selectedFindings.length} scrap`}
                {selectedFindings.length > 0 && pinsToRun.length > 0 && ' +'}
                {pinsToRun.length > 0 && ` ${pinsToRun.length} pin${pinsToRun.length === 1 ? '' : 's'}`}
              </PrimaryButton>
            }
          />
          {recommended.length > 0 && (
            <div className="border-t border-border">
              <p className="px-5 pt-3 text-xs font-medium uppercase tracking-wide text-muted">Scrap candidates</p>
              <div className="divide-y divide-border">
                {recommended.map((f) => (
                  <label key={serialKey(f)} className="flex cursor-pointer items-start gap-3 px-5 py-3 hover:bg-bg">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selected.has(serialKey(f))}
                      onChange={() => toggle(serialKey(f))}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-text">
                          {f.partNumber} / {f.serialNumber}
                        </span>
                        {f.baseApproved ? (
                          <Badge tone="accent">
                            {f.location} → {f.routedTo}
                          </Badge>
                        ) : (
                          <Badge tone="warning">{f.location} — not an approved base</Badge>
                        )}
                        {f.cra && <span className="text-xs text-muted">{f.cra}</span>}
                      </div>
                      {f.partName && <p className="text-xs text-muted">{f.partName}</p>}
                      <p className="mt-1 text-xs text-muted">“{f.note}”</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}
          {pinsProcess.length > 0 && (
            <div className="border-t border-border">
              <p className="px-5 pt-3 text-xs font-medium uppercase tracking-wide text-muted">
                Pins (PN 4114T06P03) — never scrapped, routed separately
              </p>
              {isPinsRunning && pinsRun?.phase && <p className="px-5 pt-1 text-xs text-muted">{pinsRun.phase}</p>}
              {pinsRun?.fatalError && (
                <p className="flex items-center gap-1.5 px-5 pt-1 text-xs font-semibold text-danger">
                  <AlertTriangle size={13} />
                  {pinsRun.fatalError}
                </p>
              )}
              <div className="divide-y divide-border">
                {pinsProcess.map((f) => {
                  const bnKey = serialKey(f)
                  const rowResult = pinsRun?.results.find((r) => r.bn.toUpperCase() === bnKey)
                  const succeeded = rowResult?.status === 'success'
                  // Reported for in this run, but no result back yet.
                  const stillRunning =
                    isPinsRunning && !!pinsRun?.bns.some((bn) => bn.toUpperCase() === bnKey) && !rowResult
                  return (
                    <div key={bnKey} className="px-5 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-text">
                          {f.partNumber} / {f.serialNumber}
                        </span>
                        <Badge tone="accent">Pins process</Badge>
                        {succeeded && <Badge tone="accent">Done</Badge>}
                        {stillRunning && (
                          <span className="flex items-center gap-1.5 text-xs text-muted">
                            <Loader2 size={12} className="animate-spin" />
                            Running...
                          </span>
                        )}
                        {f.cra && <span className="text-xs text-muted">{f.cra}</span>}
                      </div>
                      {f.partName && <p className="text-xs text-muted">{f.partName}</p>}
                      <PinsResultLine result={rowResult} />
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Everything not recommended, so nothing silently disappears. */}
      {findings.length > 0 && (negated.length > 0 || noNote.length > 0 || unreadable.length > 0) && (
        <Card>
          <CardHeader
            title="Not recommended"
            description="Listed so nothing drops out of view. These are never pre-selected."
          />
          <div className="divide-y divide-border">
            {[...unreadable, ...negated, ...noNote].map((f) => (
              <div key={serialKey(f)} className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-text">
                    {f.partNumber} / {f.serialNumber}
                  </span>
                  {f.outcome === 'unreadable' && <Badge tone="danger">Could not read</Badge>}
                  {f.outcome === 'scrap_negated' && <Badge tone="warning">Note says not to scrap</Badge>}
                  {f.outcome === 'no_scrap_note' && <Badge tone="neutral">No scrap note</Badge>}
                </div>
                {f.reason && <p className="mt-1 text-xs text-muted">{f.reason}</p>}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Rows the sheet itself already marks as dealt with. */}
      {listing && listing.alreadyHandled.length > 0 && (
        <Card>
          <CardHeader
            title="Already handled on the sheet"
            description="Excluded before MXI is touched at all — scrapping these again would be a second irreversible action."
          />
          <div className="divide-y divide-border">
            {listing.alreadyHandled.map((row) => (
              <div key={`${row.sheetRow}-${row.serialNumber}`} className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-text">
                    {row.partNumber} / {row.serialNumber}
                  </span>
                  <CheckCircle2 size={14} className="text-success" />
                </div>
                <p className="mt-1 text-xs text-muted">{row.exclusionReason}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      {showRunConfirm && (
        <ConfirmDialog
          title={`Run in ${env}?`}
          message={[
            selectedFindings.length > 0 &&
              `${selectedFindings.map((f) => f.serialNumber).join(', ')} will be scheduled and transferred for ` +
                `scrap in ${env}, one at a time. This cannot be undone. If one fails, the rest still run — each ` +
                `reports its own result on the Scrap tab.`,
            pinsToRun.length > 0 &&
              `${pinsToRun.map((f) => f.serialNumber).join(', ')} will be routed through the Pins process in ` +
                `${env}, all together in one job. This writes to real MXI and cannot be undone. This path has not ` +
                `yet had a first live test — watch it closely.`,
          ]
            .filter(Boolean)
            .join(' ')}
          confirmLabel={`Yes, run in ${env}`}
          cancelLabel="Never mind"
          onConfirm={() => void handleRunConfirmed()}
          onCancel={() => setShowRunConfirm(false)}
        />
      )}

      {showCancelConfirm && (
        <ConfirmDialog
          title="Stop checking?"
          message="This stops after the part currently being read. Nothing has been written to MXI either way — this pass only reads."
          confirmLabel="Yes, stop"
          cancelLabel="Never mind"
          onConfirm={() => void handleCancelConfirmed()}
          onCancel={() => setShowCancelConfirm(false)}
        />
      )}
    </div>
  )
}
