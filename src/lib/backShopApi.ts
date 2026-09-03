import { ApiError } from './api'
import type { MxiEnv } from './quoteApi'

/**
 * Back Shop tab API client.
 *
 * Two distinct steps, and the split is deliberate: this module only READS —
 * it fetches the day's listing and runs the note-reading discovery pass.
 * Actually scrapping the selection goes through scrapApi's
 * startInHouseScrap, which is a separate, explicitly confirmed action.
 * Nothing here can start something irreversible.
 */

export interface BackShopRow {
  partNumber: string
  serialNumber: string
  partName: string | null
  cra: string | null
  status: string | null
  location: string | null
  workPackageNo: string | null
  sheetRow: number
}

export interface HandledRow extends BackShopRow {
  /** The sheet's own Status, quoted, as the reason it isn't offered. */
  exclusionReason: string
}

export interface BackShopListing {
  source: 'synced' | 'upload'
  /** Where the synced copy was found, so the analyst can confirm it's the right library. */
  filePath: string | null
  syncedAt: string | null
  sheetDate: string | null
  isToday: boolean
  /** Non-null whenever the sheet isn't today's, or its date couldn't be read. Never suppressed. */
  warning: string | null
  craOptions: string[]
  open: BackShopRow[]
  alreadyHandled: HandledRow[]
  skippedIncomplete: number
}

export type BackShopOutcome = 'scrap_recommended' | 'scrap_negated' | 'no_scrap_note' | 'unreadable'

export interface BackShopFinding {
  partNumber: string
  serialNumber: string
  partName: string | null
  cra: string | null
  location: string | null
  sheetRow: number
  outcome: BackShopOutcome
  /** The part note in MXI, verbatim. */
  note: string | null
  reason: string | null
  baseApproved: boolean
  routedTo: string | null
}

export interface BackShopRunStatusResponse {
  runId: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  completedAt: string | null
  fatalError: string | null
  phase: string | null
  env: MxiEnv
  findings: BackShopFinding[]
  totalRequested: number
}

async function handle<T>(response: Response, path: string): Promise<T> {
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    let activeRunId: string | undefined
    try {
      const body = await response.json()
      if (body?.error) message = body.error
      if (body?.activeRunId) activeRunId = body.activeRunId
    } catch {
      /* non-JSON error body */
    }
    // Same diagnosis as scrapApi: these paths are hardcoded and proxied
    // same-origin, so a 404 means the backend is older than this page. That
    // exact confusion cost a real session once already.
    if (response.status === 404 && path.startsWith('/api/backshop/')) {
      message =
        `The backend doesn't recognise ${path} (404). This usually means the API server is running an ` +
        `older build than this page — restart it (npm run server in backend/) and try again.`
    }
    throw new ApiError(response.status, message, activeRunId)
  }
  return response.json() as Promise<T>
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    credentials: 'same-origin',
  })
  return handle<T>(response, path)
}

/** The synced SharePoint copy. `found: false` is normal — the upload fallback covers it. */
export function getSyncedListing(): Promise<{ found: boolean; listing: BackShopListing | null }> {
  return jsonRequest('/api/backshop/listing')
}

/** The fallback for a machine where the SharePoint library isn't synced. */
export async function uploadListing(file: File): Promise<{ found: boolean; listing: BackShopListing }> {
  const form = new FormData()
  form.append('listing', file)
  const response = await fetch('/api/backshop/listing', { method: 'POST', body: form, credentials: 'same-origin' })
  return handle(response, '/api/backshop/listing')
}

/** Starts the read-only note-reading pass. Writes nothing to MXI. */
export function startDiscovery(rows: BackShopRow[], env: MxiEnv): Promise<{ runId: string; env: MxiEnv; totalRequested: number }> {
  return jsonRequest('/api/backshop/discover', { method: 'POST', body: JSON.stringify({ rows, env }) })
}

export function getActiveBackShopJob(): Promise<{ activeRunId: string | null }> {
  return jsonRequest('/api/backshop/active-job')
}

export function getBackShopRun(runId: string): Promise<BackShopRunStatusResponse> {
  return jsonRequest(`/api/backshop/runs/${encodeURIComponent(runId)}`)
}

export function cancelBackShopRun(runId: string): Promise<{ ok: boolean }> {
  return jsonRequest(`/api/backshop/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
}
