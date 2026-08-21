import { ApiError } from './api'

/**
 * Vendor Quote Writer API client. JSON-only (unlike esdFinderApi.ts, which
 * needs multipart) — this tab has no file upload at all: the input is an
 * Outlook folder read on the server's own machine.
 */

export interface QuoteExtractionRow {
  extractionId: number
  entryId: string
  subject: string | null
  senderName: string | null
  fileName: string
  documentKind: 'quote' | 'shop_finding_report' | 'other_not_a_quote'
  orderNumber: string | null
  orderNumberSource: string | null
  quoteNumber: string | null
  vendorName: string | null
  partNumber: string | null
  serialNumber: string | null
  unitPrice: number | null
  currency: string | null
  quoteDate: string | null
  promisedShipDate: string | null
  resolvedEsd: string | null
  esdBasis: string | null
  esdExplanation: string | null
  needsReview: boolean
  reviewReasons: string[]
  /** Vendor-stated non-repairable (NREP) — read off their document, not a human decision. */
  vendorSaysNonRepairable: boolean
  nonRepairableEvidence: string | null
  disposition: QuoteDisposition
  confidence: 'high' | 'medium' | 'low'
  reasoningNote: string
}

/**
 * `excluded_nrep` is vendor-derived and set automatically; only the other
 * three can be chosen by a human (see the backend's quoteDisposition.ts).
 */
export type QuoteDisposition = 'pending' | 'excluded_nrep' | 'excluded_ber' | 'excluded_other'
export type HumanSettableDisposition = 'pending' | 'excluded_ber' | 'excluded_other'

export interface QuoteRunStatusResponse {
  runId: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  completedAt: string | null
  fatalError: string | null
  phase: string | null
  folderPath: string | null
  scannedCount: number | null
  pdfCount: number | null
  rows: QuoteExtractionRow[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    credentials: 'same-origin',
  })
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    let activeRunId: string | undefined
    try {
      const body = await response.json()
      if (body?.error) message = body.error
      if (body?.activeRunId) activeRunId = body.activeRunId
    } catch {
      /* non-JSON error body — keep the generic message */
    }
    throw new ApiError(response.status, message, activeRunId)
  }
  return response.json() as Promise<T>
}

export interface StartIngestOptions {
  maxMessages: number
  unreadOnly: boolean
}

export function startQuoteIngest(options: StartIngestOptions): Promise<{ runId: string }> {
  return request('/api/quotes/ingest', { method: 'POST', body: JSON.stringify(options) })
}

export function getActiveQuoteJob(): Promise<{ activeRunId: string | null }> {
  return request('/api/quotes/active-job')
}

export function getQuoteRun(runId: string): Promise<QuoteRunStatusResponse> {
  return request(`/api/quotes/runs/${encodeURIComponent(runId)}`)
}

export function cancelQuoteRun(runId: string): Promise<{ ok: boolean }> {
  return request(`/api/quotes/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
}

/**
 * Records a human decision on one quote: mark BER, exclude outright, or
 * put it back to pending. Append-only server-side — every decision is kept,
 * so the future scrap workflow can see who decided what and when.
 */
export function setQuoteDisposition(
  extractionId: number,
  disposition: HumanSettableDisposition,
  runId: string,
): Promise<{ ok: boolean; extractionId: number; disposition: QuoteDisposition }> {
  return request(`/api/quotes/extractions/${extractionId}/disposition`, {
    method: 'POST',
    body: JSON.stringify({ disposition, runId }),
  })
}
