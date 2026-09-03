/**
 * Order Write-Ups API client. Talks to backend/src/server.ts.
 *
 * CLAUDE_CODE_PROMPT (#6, login/account system) — this used to send a
 * VITE_AUTOMATION_API_KEY bundled into the client build (visible in
 * devtools, acceptable only for a single-local-analyst server). Real
 * per-user login replaces that: every request now sends `credentials:
 * 'include'` so the browser attaches the httpOnly session cookie set by
 * /api/auth/login instead. A 401 here means "not logged in" (see
 * lib/authContext.tsx), not "misconfigured shared secret."
 *
 * CLAUDE_CODE_PROMPT (#6 fix, real bug) — REAL BUG FOUND AND FIXED: this
 * used to talk directly to http://127.0.0.1:3001 (a genuine cross-origin
 * request whenever the app is opened as "localhost:5173"), and the session
 * cookie's SameSite=Lax silently drops on cross-SITE fetch calls — CORS
 * itself was fine, the cookie just never got attached. Login/register still
 * "worked" (that response is what sets the cookie) but every subsequent
 * call 401'd with "Not logged in", confirmed live. BASE_URL now defaults to
 * '' (a same-origin relative path), proxied through Vite's dev server
 * (vite.config.ts) to the real backend — no more cross-origin request at
 * all from the browser's point of view, so nothing for SameSite to block.
 */

export type MxiEnv = 'stage' | 'production'
export type VendorSearchKind = 'partNumber' | 'vendorCode'
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'partial' | 'cancelled'
export type LineStatus = 'in_progress' | 'completed' | 'skipped' | 'exception' | 'retrying'

export interface VendorListEntry {
  id: string
  /** The vendor code itself (e.g. "0T1Y4") — only present for searchKind: 'vendorCode' entries. */
  code?: string
  displayName: string
  searchKind: VendorSearchKind
}

/** CRA (Component Repair Analyst) grouping — see backend/src/writeUps/shared/craAssignments.ts. Only CRAs with at least one registered vendor are ever returned. */
export interface CraGroupEntry {
  craCode: string
  craName: string
  /** VendorListEntry ids — ready to feed straight into the existing selectedVendorIds Set. */
  vendorIds: string[]
}

export interface UsageParmRow {
  label: string
  tsn: string
  tso: string
  tsi: string
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
  /** Only ever set on exceptionType 'zero_usage' events — for the "Email Maintenance Records" draft button. */
  usageRows?: UsageParmRow[]
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
  /** execute jobs only — how many lines were targeted at start (see jobManager.ts's Job.targetLineCount docstring for why this can't be derived from counts.total alone). */
  targetLineCount: number | null
}

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

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
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
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
  return await res.json() as Promise<T>
}

export function getVendors(): Promise<VendorListEntry[]> {
  return request('/api/vendors')
}

export function getCraGroups(): Promise<CraGroupEntry[]> {
  return request('/api/vendors/cra-groups')
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

/** CLAUDE_CODE_PROMPT (cancel button) — cancels whichever run (discovery or execute) this runId refers to, wherever it currently is. */
export function cancelRun(runId: string): Promise<{ ok: true }> {
  return request(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
}

export interface MaintenanceRecordsDraftResponse {
  ok: true
  subject: string
  recipients: string[]
  /** Whether Outlook resolved the DL to a real recipient in the draft. */
  resolved: boolean
  mode: 'draft' | 'send'
}

/**
 * Drafts the zero-times-and-cycles notification into the analyst's own
 * Outlook Drafts, via the backend's Outlook COM path.
 *
 * Replaces a `mailto:` link, which needed a registered mail handler on the
 * machine and did nothing at all when there wasn't one. Recipient and
 * subject are fixed server-side — the client cannot choose them.
 */
export function draftMaintenanceRecordsEmail(input: {
  partNumber: string
  serialNumber: string
  usageRows: UsageParmRow[]
}): Promise<MaintenanceRecordsDraftResponse> {
  return request('/api/writeups/maintenance-records-draft', { method: 'POST', body: JSON.stringify(input) })
}
