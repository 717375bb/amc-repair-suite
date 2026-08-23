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
  /** Vendor offered a replacement unit — converted to an exchange rather than priced. */
  suggestsExchange: boolean
  exchangeEvidence: string | null
  disposition: QuoteDisposition
  confidence: 'high' | 'medium' | 'low'
  reasoningNote: string
}

/**
 * `excluded_nrep` is vendor-derived and set automatically; only the other
 * three can be chosen by a human (see the backend's quoteDisposition.ts).
 */
export type QuoteDisposition = 'pending' | 'excluded_nrep' | 'excluded_ber' | 'excluded_other'

/**
 * Which MXI action a row will take. NREP/BER are no longer dead ends — they
 * route to scrap pricing (see the backend's quoteDisposition.ts).
 */
export type QuoteWriteAction = 'exchange' | 'scrap_price' | 'price_line' | 'none'

/**
 * MUST stay identical to the backend's own resolveWriteAction
 * (quoteWriter/quoteDisposition.ts) — if these drift, the UI promises one
 * action and the runner performs another.
 *
 * Precedence: analyst exclusion, then BER (a human's judgement outranks
 * anything the model read), then exchange, then NREP, then a normal repair.
 * Exchange deliberately beats NREP: a vendor saying "not repairable, here
 * is a replacement" is describing an exchange, and the exchange is how the
 * non-repairable unit gets resolved.
 */
export function resolveWriteAction(
  disposition: QuoteDisposition,
  suggestsExchange: boolean,
): QuoteWriteAction {
  if (disposition === 'excluded_other') return 'none'
  if (disposition === 'excluded_ber') return 'scrap_price'
  if (suggestsExchange) return 'exchange'
  if (disposition === 'excluded_nrep') return 'scrap_price'
  return 'price_line'
}

export type HumanSettableDisposition = 'pending' | 'excluded_ber' | 'excluded_other'

export interface QuoteWriteResult {
  extractionId: number
  orderNumber: string
  status: 'success' | 'failed' | 'skipped'
  outcome: string | null
  originalPrice: string | null
  writtenPrice: string | null
  writtenEsd: string | null
  /** Whether the source email got marked read. Only ever true after a verified write. */
  markedRead: boolean
  /** Mailbox bookkeeping miss — NOT a failed MXI write. Deliberately separate from errorMessage. */
  markReadError: string | null
  /** What happened at the authorize/issue step. Present on success too. */
  issueDetail: string | null
  errorMessage: string | null
}

export interface QuoteRunStatusResponse {
  runId: string
  kind: 'ingest' | 'write'
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  completedAt: string | null
  fatalError: string | null
  phase: string | null
  folderPath: string | null
  scannedCount: number | null
  pdfCount: number | null
  rows: QuoteExtractionRow[]
  writeEnv: MxiEnv | null
  writeResults: QuoteWriteResult[]
}

export type MxiEnv = 'stage' | 'production'

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

    // REAL DIAGNOSIS, from a real incident: a 404 on one of THIS tab's own
    // endpoints almost never means "wrong URL" — the paths are hardcoded
    // here and proxied same-origin. It means the backend process is older
    // than the frontend and simply doesn't have the route yet. That
    // presented to the user as buttons that "don't do anything," which cost
    // real debugging time. Say the actual likely cause instead of a bare
    // "Request failed (404)".
    if (response.status === 404 && path.startsWith('/api/quotes/')) {
      message =
        `The backend doesn't recognise ${path} (404). This usually means the API server is running an ` +
        `older build than this page — restart it (npm run server in backend/) and try again.`
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
 * Writes the selected quotes into MXI (price + Price Type=QUOTE + ESD as
 * Promise By), then marks each source email read on success. `env` is
 * always explicit — never defaulted client-side.
 */
export function startQuoteWrite(
  runId: string,
  extractionIds: number[],
  env: MxiEnv,
): Promise<{ runId: string; env: MxiEnv }> {
  return request('/api/quotes/write', {
    method: 'POST',
    body: JSON.stringify({ runId, extractionIds, env }),
  })
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
