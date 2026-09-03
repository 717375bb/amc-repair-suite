/**
 * Invoice Price Writer API client. Same backend, same session-cookie auth
 * as esdFinderApi.ts — kept as its own file for the same reason
 * esdFinderApi.ts is separate from lib/api.ts: multipart-upload-based
 * endpoints, not JSON-body-based, and mixing request helpers risks the
 * wrong Content-Type.
 */

export type MxiEnv = 'stage' | 'production'
export type InvoicePriceJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface InvoicePriceOrderResult {
  orderNumber: string
  serialNumberSheet: string
  serialNumberMxi: string | null
  originalPrice: string | null
  newPrice: string
  status: 'success' | 'failed' | 'skipped'
  outcome: string
  errorMessage: string | null
}

export interface InvoicePriceRunStatusResponse {
  runId: string
  status: InvoicePriceJobStatus
  startedAt: string
  completedAt: string | null
  fatalError: string | null
  writeEnv: MxiEnv
  rowCount: number | null
  duplicateCount: number | null
  results: InvoicePriceOrderResult[]
}

// Same #6 real-bug-fix reasoning as lib/api.ts / lib/esdFinderApi.ts: '' (a
// same-origin relative path) proxied through Vite's dev server, never a
// direct cross-origin request that would silently drop the session cookie.
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

export function peekInvoicePriceFile(file: File): Promise<{ fileName: string; rowCount: number }> {
  const formData = new FormData()
  formData.append('file', file)
  return uploadRequest('/api/invoice-price/peek', formData)
}

export function getActiveInvoicePriceJob(): Promise<{ activeRunId: string | null }> {
  return jsonRequest('/api/invoice-price/active-job')
}

export function startInvoicePriceRun(file: File, env: MxiEnv): Promise<{ runId: string; env: MxiEnv }> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('env', env)
  return uploadRequest('/api/invoice-price/start', formData)
}

export function getInvoicePriceRunStatus(runId: string): Promise<InvoicePriceRunStatusResponse> {
  return jsonRequest(`/api/invoice-price/runs/${encodeURIComponent(runId)}`)
}

export function cancelInvoicePriceRun(runId: string): Promise<{ ok: true }> {
  return jsonRequest(`/api/invoice-price/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
}

/** CLAUDE_CODE_PROMPT (retry failed lines) — re-runs specific order numbers from a finished run, appending to that same runId. */
export function retryInvoicePriceRun(runId: string, orderNumbers: string[]): Promise<{ runId: string }> {
  return jsonPostRequest(`/api/invoice-price/runs/${encodeURIComponent(runId)}/retry`, { orderNumbers })
}
