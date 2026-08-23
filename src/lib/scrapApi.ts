import { ApiError } from './api'
import type { MxiEnv } from './quoteApi'

/**
 * Scrap tab API client. Multipart for the vendor path (a certificate PDF
 * is uploaded), JSON-shaped responses throughout.
 */

export interface ScrapCertPreview {
  orderNumber: string | null
  serialNumber: string | null
  partNumber: string | null
  vendorName: string | null
  confidence: string | null
}

export interface ScrapOutResult {
  status: 'success' | 'failed'
  orderNumber: string | null
  serialNumber: string | null
  partNumber: string | null
  vendorName: string | null
  /** Which of the flow's intermittent steps actually fired. */
  stepsTaken: string[]
  certAttached: boolean
  locationUsed: string | null
  errorMessage: string | null
}

export interface ScrapRunStatusResponse {
  runId: string
  kind: 'vendor' | 'in_house'
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  completedAt: string | null
  fatalError: string | null
  phase: string | null
  env: MxiEnv
  certPreview: ScrapCertPreview | null
  /** One entry per serial — the in-house path accepts several at once. */
  results: ScrapOutResult[]
  /** How many serials were submitted, so progress reads "N of M" honestly. */
  totalRequested: number
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    credentials: 'same-origin',
  })
  return handle<T>(response, path)
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
    // Same diagnosis as quoteApi: these paths are hardcoded and proxied
    // same-origin, so a 404 means the backend is older than this page.
    if (response.status === 404 && path.startsWith('/api/scrap/')) {
      message =
        `The backend doesn't recognise ${path} (404). This usually means the API server is running an ` +
        `older build than this page — restart it (npm run server in backend/) and try again.`
    }
    throw new ApiError(response.status, message, activeRunId)
  }
  return response.json() as Promise<T>
}

export interface StartVendorScrapOptions {
  certificate: File
  env: MxiEnv
}

export async function startVendorScrap(options: StartVendorScrapOptions): Promise<{ runId: string; env: MxiEnv }> {
  const form = new FormData()
  form.append('kind', 'vendor')
  form.append('env', options.env)
  form.append('certificate', options.certificate)
  // No Content-Type header: the browser must set the multipart boundary.
  const response = await fetch('/api/scrap/start', { method: 'POST', body: form, credentials: 'same-origin' })
  return handle(response, '/api/scrap/start')
}

/**
 * `serialNumbers` is sent as raw pasted text — the server splits on
 * newlines, commas, tabs, or semicolons and de-duplicates. Parsing there
 * rather than here keeps one authority over what counts as a serial, and
 * de-duplication is a safety property: scrapping is irreversible, so the
 * same serial twice in one paste must not become two attempts.
 */
export async function startInHouseScrap(serialNumbers: string, env: MxiEnv): Promise<{ runId: string; env: MxiEnv }> {
  const form = new FormData()
  form.append('kind', 'in_house')
  form.append('env', env)
  form.append('serialNumbers', serialNumbers)
  const response = await fetch('/api/scrap/start', { method: 'POST', body: form, credentials: 'same-origin' })
  return handle(response, '/api/scrap/start')
}

/**
 * Mirrors the server's parseSerialList so the UI can preview the count and
 * warn about duplicates before anything irreversible starts. The SERVER's
 * copy is authoritative — this one only informs.
 */
export function previewSerialList(raw: string): { serials: string[]; duplicatesRemoved: number } {
  const seen = new Set<string>()
  const serials: string[] = []
  let duplicatesRemoved = 0
  for (const piece of raw.split(/[\n\r,;\t]+/)) {
    const serial = piece.trim()
    if (!serial) continue
    const key = serial.toUpperCase()
    if (seen.has(key)) {
      duplicatesRemoved++
      continue
    }
    seen.add(key)
    serials.push(serial)
  }
  return { serials, duplicatesRemoved }
}

export function getActiveScrapJob(): Promise<{ activeRunId: string | null }> {
  return jsonRequest('/api/scrap/active-job')
}

export function getScrapRun(runId: string): Promise<ScrapRunStatusResponse> {
  return jsonRequest(`/api/scrap/runs/${encodeURIComponent(runId)}`)
}

export function cancelScrapRun(runId: string): Promise<{ ok: boolean }> {
  return jsonRequest(`/api/scrap/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
}
