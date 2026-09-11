import { ApiError } from './api'
import type { MxiEnv } from './quoteApi'

/**
 * Back Shop tab's "Run" button (2026-09-11) — per explicit user direction,
 * pins found in a discovery pass are folded into the SAME run action as
 * the scrap batch, not a separate per-row button (an earlier, now-
 * corrected design). Every pin found is submitted together as ONE batched
 * job — the same "many targets, one job" shape startInHouseScrap already
 * uses for serials.
 *
 * Not part of the shared tracked-run system (tabRuns.tsx): that infra is
 * for long batch jobs the analyst wants to track across navigation and in
 * the sidebar; a pins run is started and watched from the same card it
 * was launched from (the Pins card, right alongside the scrap flow), so
 * plain page-local polling (see BackshopRepairs.tsx) is enough.
 */

export type PinsRoutingPath = 'correct_base' | 'wrong_base' | 'unknown'
export type PinsRoutingStatus = 'success' | 'failed' | 'tied' | 'destination_not_found'

export interface PinsRoutingRunResult {
  bn: string
  currentLocation: string
  base: string | null
  path: PinsRoutingPath
  status: PinsRoutingStatus
  locationUsed: string | null
  destination: string | null
  totals: Record<string, number> | null
  errorMessage: string | null
}

export interface PinsRunStatusResponse {
  runId: string
  bns: string[]
  status: 'pending' | 'running' | 'completed' | 'failed'
  startedAt: string
  completedAt: string | null
  fatalError: string | null
  phase: string | null
  env: MxiEnv
  /** One entry per BN, appended as each finishes — may be shorter than `bns` while the job is still running. */
  results: PinsRoutingRunResult[]
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
    if (response.status === 404 && path.startsWith('/api/pins/')) {
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

/** `bns` — a newline/comma-separated list is fine too; the backend normalises it the same way startInHouseScrap's serial list already is. */
export function startPinsRun(bns: string[], env: MxiEnv): Promise<{ runId: string; env: MxiEnv; bns: string[] }> {
  return jsonRequest('/api/pins/start', { method: 'POST', body: JSON.stringify({ bns: bns.join('\n'), env }) })
}

export function getActivePinsJob(): Promise<{ activeRunId: string | null }> {
  return jsonRequest('/api/pins/active-job')
}

export function getPinsRun(runId: string): Promise<PinsRunStatusResponse> {
  return jsonRequest(`/api/pins/runs/${encodeURIComponent(runId)}`)
}
