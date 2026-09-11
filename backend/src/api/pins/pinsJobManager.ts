import type { ChildProcess } from 'node:child_process';
import { mxiCredentialEnvOverrides, spawnRunner } from '../jobManager.js';
import type { MxiEnv } from '../../mxiWriter/config.js';
import type { MxiCredential } from '../../auth/authService.js';
import type { PinsRoutingRunResult } from '../../backShop/pinRouting.js';

/**
 * Job registry for the Back Shop tab's "Run" button (2026-09-11) — per
 * explicit user direction, pins found in a discovery pass are folded into
 * the SAME run action as the scrap batch, not a separate per-row button
 * (that was the previous, now-corrected design — see pinRouting.ts's own
 * runPinsRoutingForBn for the shared per-BN logic this still calls).
 * Every pin found in one discovery pass is submitted together as ONE job
 * (multiple BNs, one browser session) — the same "many targets, one job"
 * shape scrapJobManager.ts's in-house batch already uses, run via the same
 * runPinsRoutingForBn() the standalone CLI (cli/pinsRoutingCli.ts) uses.
 *
 * Its own activeRunId, separate from every other workstream (matching
 * backShopJobManager.ts's own reasoning) — a pins batch and (say) a scrap
 * batch can be in flight together, since they're unrelated actions even
 * when started from the same page.
 *
 * No cancel support, unlike discovery/scrap/ESD: unlike those, a pin's own
 * routing has no natural "safe to stop here" point mid-BN (see
 * runPinCorrectBaseFlow/runPinWrongBaseShipmentFlow — neither is
 * idempotent-safe to interrupt), and this write path has never been run
 * live. Between-BN cancellation could be added later if that changes.
 */

export type PinsJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface PinsJob {
  runId: string;
  bns: string[];
  status: PinsJobStatus;
  startedAt: string;
  completedAt: string | null;
  fatalError: string | null;
  phase: string | null;
  env: MxiEnv;
  /** Keyed by BN so a re-emitted result (shouldn't happen, but matches backShopJobManager's own defensiveness) replaces rather than duplicates. */
  results: PinsRoutingRunResult[];
  totalRequested: number;
  process: ChildProcess | null;
}

const jobs = new Map<string, PinsJob>();
let activeRunId: string | null = null;

function nextRunId(): string {
  return `pins_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getPinsJob(runId: string): PinsJob | undefined {
  return jobs.get(runId);
}

export function getActivePinsJob(): PinsJob | undefined {
  return activeRunId ? jobs.get(activeRunId) : undefined;
}

function handleEnvelope(job: PinsJob, envelope: unknown): void {
  const e = envelope as { type?: string; phase?: string; message?: string; result?: PinsRoutingRunResult };
  if (e.type === 'phase') {
    job.phase = e.phase ?? null;
  } else if (e.type === 'result' && e.result) {
    const idx = job.results.findIndex((r) => r.bn.toUpperCase() === e.result!.bn.toUpperCase());
    if (idx >= 0) job.results[idx] = e.result;
    else job.results.push(e.result);
  } else if (e.type === 'fatal') {
    job.fatalError = e.message ?? 'Unknown fatal error';
  }
}

export interface StartPinsResult {
  ok: boolean;
  runId?: string;
  error?: string;
  conflictRunId?: string;
}

export function startPinsRoutingJob(
  options: { env: MxiEnv; bns: string[] },
  mxiCredential: MxiCredential,
): StartPinsResult {
  if (activeRunId) return { ok: false, conflictRunId: activeRunId };
  if (options.bns.length === 0) return { ok: false, error: 'At least one BN is required.' };

  const runId = nextRunId();
  const job: PinsJob = {
    runId,
    bns: options.bns,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    fatalError: null,
    phase: null,
    env: options.env,
    results: [],
    totalRequested: options.bns.length,
    process: null,
  };
  jobs.set(runId, job);
  activeRunId = runId;

  job.process = spawnRunner(
    'src/api/jobRunners/pinsRoutingRunner.ts',
    ['--env', options.env, '--bns', JSON.stringify(options.bns)],
    (envelope) => handleEnvelope(job, envelope),
    (code) => {
      job.completedAt = new Date().toISOString();
      job.status = job.fatalError || code !== 0 ? 'failed' : 'completed';
      if (activeRunId === runId) activeRunId = null;
    },
    mxiCredentialEnvOverrides(mxiCredential),
  );

  return { ok: true, runId };
}
