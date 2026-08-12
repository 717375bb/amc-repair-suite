/**
 * Order Write-Ups API client. Talks directly to backend/src/server.ts
 * (127.0.0.1-bound, CORS-restricted to this dev origin) — never a proxy,
 * per the backend spec's explicit CORS design.
 *
 * VITE_AUTOMATION_API_KEY is bundled into the client build and visible in
 * devtools — acceptable ONLY because this server binds to 127.0.0.1 and is
 * built for exactly one local analyst's own browser tab, never a publicly
 * reachable deployment. Do not reuse this pattern for anything internet-facing.
 */

export type MxiEnv = 'stage' | 'production'
export type VendorSearchKind = 'partNumber' | 'vendorCode'
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'partial'
export type LineStatus = 'in_progress' | 'completed' | 'skipped' | 'exception' | 'retrying'

export interface VendorListEntry {
  id: string
  displayName: string
  searchKind: VendorSearchKind
}

export interface RunLogEvent {
  seq: number
  timestamp: string
  vendorId: string
  vendorDisplayName: string
  partNumber: string
  serialNumber: string
  description: string
  status: LineStatus
  summary: string
  orderNumber?: string
  routedTo?: string
  exceptionType?: string
  detail?: string
}

export interface DiscoveredLineSummary {
  lineId: string
  vendorId: string
  vendorDisplayName: string
  partNumber: string
  serialNumber: string
  description: string
  status: 'completed' | 'exception'
  summary: string
  exceptionType?: string
  routedTo?: string
  detail?: string
}

export interface JobCounts {
  completed: number
  skipped: number
  exception: number
  inProgress: number
  total: number
}

export interface RunStatusResponse {
  runId: string
  kind: 'discovery' | 'execute'
  env: MxiEnv
  vendorIds: string[]
  status: JobStatus
  startedAt: string
  completedAt: string | null
  fatalError: string | null
  counts: JobCounts
  lines?: DiscoveredLineSummary[]
  sourceDiscoveryRunId: string | null
}

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3001'
const API_KEY = import.meta.env.VITE_AUTOMATION_API_KEY ?? ''

export class ApiError extends Error {
  status: number
  /** The active job's runId, present only on a 409 Conflict response. */
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Automation-Key': API_KEY,
      ...(init?.headers ?? {}),
    },
  })
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
  return res.json() as Promise<T>
}

export function getVendors(): Promise<VendorListEntry[]> {
  return request('/api/vendors')
}

export function getActiveJob(): Promise<{ activeRunId: string | null; kind: 'discovery' | 'execute' | null }> {
  return request('/api/active-job')
}

export function startDiscovery(vendorIds: string[], env: MxiEnv): Promise<{ runId: string }> {
  return request('/api/discovery', { method: 'POST', body: JSON.stringify({ vendorIds, env }) })
}

export function getRunStatus(runId: string): Promise<RunStatusResponse> {
  return request(`/api/runs/${encodeURIComponent(runId)}`)
}

export function getRunLog(runId: string, since: number): Promise<{ events: RunLogEvent[]; latestSeq: number }> {
  return request(`/api/runs/${encodeURIComponent(runId)}/log?since=${since}`)
}

export function startExecute(runId: string, selectedLineIds: string[], env: MxiEnv): Promise<{ executeRunId: string }> {
  return request('/api/execute', { method: 'POST', body: JSON.stringify({ runId, selectedLineIds, env }) })
}
