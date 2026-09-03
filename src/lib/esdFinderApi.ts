/**
 * Open Order ESD Finder API client. Same backend, same 127.0.0.1-bound
 * CORS-restricted server as lib/api.ts's Order Write-Ups client, same
 * `credentials: 'include'` session-cookie auth as of #6 (see lib/api.ts's
 * own docstring for the full story) — kept as its own file rather than
 * folded into lib/api.ts because this tab's endpoints are multipart-
 * upload-based, not JSON-body-based, and mixing the two request helpers in
 * one file would make it easy to send the wrong Content-Type for one or
 * the other.
 */

export type EsdClassification =
  | 'explicit_date'
  | 'vendor_quote_estimate'
  | 'parts_pending'
  | 'not_esd_relevant'
  | 'quote_sent_reference'
  | 'none'
export type EsdFlag = 'ok' | 'no_esd_found' | 'inference_unavailable' | 'orphaned_vendor_row' | 'orphaned_cra_row'
// CLAUDE_CODE_PROMPT (ESD writer changes, A4) — mirrors backend's
// classifyRowAction.ts RowActionType.
export type EsdRowActionType = 'esd_write' | 'note_only_reissue' | 'skipped_no_commentary'
export type EsdJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
export type EsdJobKind = 'compare' | 'write'
export type MxiEnv = 'stage' | 'production'

export interface EsdWriteOrderResult {
  orderNumber: string
  status: 'success' | 'failed' | 'skipped'
  errorMessage: string | null
}

export interface EsdCompareResultRow {
  orderNumber: string
  vendorName: string | null
  roEsdRaw: string | null
  mxiEsdRaw: string | null
  currentStatus: string | null
  vendorNotes: string | null
  orderStatus: string | null
  classification: EsdClassification | null
  extractedBaseDate: string | null
  bufferDaysApplied: number | null
  usedFallback: boolean
  confidence: 'high' | 'medium' | 'low' | null
  reasoningNote: string | null
  inferredEsd: string | null
  flag: EsdFlag
  deltaDaysVsMxi: number | null
  aiCallMade: boolean
  actionType: EsdRowActionType
  actionable: boolean
  notesToReceiverPreview: string | null
  partNumber: string | null
  serialNumber: string | null
}

export interface DuplicateOrderNumber {
  orderNumber: string
  occurrences: Array<{ sourceFileName: string; vendorName: string | null }>
}

export interface EsdRunSummary {
  processed: number
  matched: number
  orphanedVendor: number
  orphanedCra: number
  aiCallsMade: number
  aiFallbackUsed: number
}

export interface EsdCompareResult {
  dbRunId: number
  records: EsdCompareResultRow[]
  duplicates: DuplicateOrderNumber[]
  outputFilePath: string
  summary: EsdRunSummary
}

export interface EsdRunStatusResponse {
  runId: string
  kind: EsdJobKind
  status: EsdJobStatus
  phase: string | null
  startedAt: string
  completedAt: string | null
  fatalError: string | null
  result: EsdCompareResult | null
  writeEnv: MxiEnv | null
  writeResults: EsdWriteOrderResult[]
  /** kind === 'write' only — the compare run this write came from (see esdFinderJobManager.ts's Job.sourceCompareRunId docstring). */
  sourceCompareRunId: string | null
}

// See lib/api.ts's docstring — same #6 real-bug fix, same reason: '' (a
// same-origin relative path) proxied through Vite's dev server, not a
// direct cross-origin request that silently drops the session cookie.
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

export class ApiError extends Error {
  status: number
  activeRunId?: string
  constructor(status: number, message: string, activeRunId?: string) {
    super(message)
    this.status = status
    this.activeRunId = activeRunId
  }
}

interface ErrorBody {
  error?: string
  activeRunId?: string
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = res.statusText
    let activeRunId: string | undefined
    try {
      const body = (await res.json()) as ErrorBody
      message = body.error ?? message
      activeRunId = body.activeRunId
    } catch {
      // response body wasn't JSON — fall back to statusText
    }
    throw new ApiError(res.status, message, activeRunId)
  }
  return await res.json() as Promise<T>
}

function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { ...(init?.headers ?? {}) },
  }).then(handleResponse<T>)
}

function jsonPostRequest<T>(path: string, body: unknown): Promise<T> {
  return jsonRequest<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** No manual Content-Type header — the browser sets the correct multipart boundary itself. */
function uploadRequest<T>(path: string, formData: FormData): Promise<T> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  }).then(handleResponse<T>)
}

export function peekFile(file: File, role: 'vendor' | 'cra'): Promise<{ fileName: string; rowCount: number }> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('role', role)
  return uploadRequest('/api/esd/peek', formData)
}

export function getActiveEsdJob(): Promise<{ activeRunId: string | null; kind: EsdJobKind | null }> {
  return jsonRequest('/api/esd/active-job')
}

/**
 * CRA file removed 2026-08-26 — the ESD Finder runs from the Vendor OOR
 * file alone. Every field the inference reads comes off the vendor row, so
 * the comparison influenced no decision.
 */
export function startCompare(vendorFiles: File[]): Promise<{ runId: string }> {
  const formData = new FormData()
  for (const f of vendorFiles) formData.append('vendorFiles', f)
  return uploadRequest('/api/esd/compare', formData)
}

export function getEsdRunStatus(runId: string): Promise<EsdRunStatusResponse> {
  return jsonRequest(`/api/esd/runs/${encodeURIComponent(runId)}`)
}

/**
 * An analyst's typed correction for one order, from the review table.
 *
 * Both fields optional and independent; blank means "leave it alone", never
 * "write a blank". The server re-validates and normalises the date, and
 * refuses the whole request if one cannot be read — a garbage date must
 * never reach a real order.
 */
export interface EsdWriteOverride {
  esd?: string
  note?: string
}

export function startWrite(
  runId: string,
  orderNumbers: string[],
  env: MxiEnv,
  overrides: Record<string, EsdWriteOverride> = {},
): Promise<{ runId: string; env: MxiEnv }> {
  return jsonPostRequest('/api/esd/write', { runId, orderNumbers, env, overrides })
}

/** CLAUDE_CODE_PROMPT (cancel button) — cancels whichever ESD Finder run (compare or write) this runId refers to. */
export function cancelEsdRun(runId: string): Promise<{ ok: true }> {
  return jsonPostRequest(`/api/esd/runs/${encodeURIComponent(runId)}/cancel`, {})
}
