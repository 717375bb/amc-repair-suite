import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { mxiCredentialEnvOverrides, requestCancellation, spawnRunner } from '../jobManager.js';
import type { MxiEnv } from '../../mxiWriter/config.js';
import type { MxiCredential } from '../../auth/authService.js';
import type { BackShopRow } from '../../backShop/backShopRows.js';
import type { ScrapRecommendation } from '../../backShop/scrapNoteJudgement.js';

/**
 * Job registry for the Back Shop tab's DISCOVERY pass — reading each part's
 * note in MXI to decide which are scrap candidates.
 *
 * Read-only by construction: this job never writes to MXI. The actual scrap
 * is the existing Scrap tab's in-house job, started separately once a human
 * has reviewed and confirmed a selection. Keeping them as two jobs is the
 * point — discovery must never flow straight into an irreversible action.
 *
 * Its own activeRunId, separate from every other workstream, so a discovery
 * pass and (say) an ESD run can be in flight at once.
 */

export type BackShopJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface BackShopFinding {
  partNumber: string;
  serialNumber: string;
  partName: string | null;
  cra: string | null;
  /** The sheet's Location column, verbatim, e.g. "QRO/USSTG". */
  location: string | null;
  sheetRow: number;
  /**
   * 'unreadable' is deliberately its own outcome rather than being folded
   * into no_scrap_note: a part we could not read must never be presented as
   * a part with nothing to say.
   */
  outcome: ScrapRecommendation | 'unreadable';
  /** The part note, verbatim, so the analyst confirms against MXI's words. */
  note: string | null;
  /** Why it was not recommended, or why it could not be read. */
  reason: string | null;
  /** Whether the sheet's base is one PSA scraps at, and where it routes to. */
  baseApproved: boolean;
  routedTo: string | null;
}

export interface BackShopJob {
  runId: string;
  status: BackShopJobStatus;
  startedAt: string;
  completedAt: string | null;
  fatalError: string | null;
  phase: string | null;
  env: MxiEnv;
  findings: BackShopFinding[];
  /** How many rows were submitted, so progress reads "N of M" honestly. */
  totalRequested: number;
  process: ChildProcess | null;
  cancelRequested: boolean;
}

const jobs = new Map<string, BackShopJob>();
let activeRunId: string | null = null;

function nextRunId(): string {
  return `backshop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getBackShopJob(runId: string): BackShopJob | undefined {
  return jobs.get(runId);
}

export function getActiveBackShopJob(): BackShopJob | undefined {
  return activeRunId ? jobs.get(activeRunId) : undefined;
}

function handleEnvelope(job: BackShopJob, envelope: unknown): void {
  const e = envelope as { type?: string; phase?: string; message?: string; finding?: BackShopFinding };
  if (e.type === 'phase') {
    job.phase = e.phase ?? null;
  } else if (e.type === 'finding' && e.finding) {
    // Keyed by serial so a re-emitted finding replaces rather than
    // duplicates, matching how the scrap job keys its results.
    const idx = job.findings.findIndex((f) => f.serialNumber === e.finding!.serialNumber);
    if (idx >= 0) job.findings[idx] = e.finding;
    else job.findings.push(e.finding);
  } else if (e.type === 'fatal') {
    job.fatalError = e.message ?? 'Unknown fatal error';
  }
}

export interface StartBackShopResult {
  ok: boolean;
  runId?: string;
  error?: string;
  conflictRunId?: string;
}

export function startBackShopDiscoveryJob(
  options: { env: MxiEnv; rows: BackShopRow[] },
  mxiCredential: MxiCredential,
): StartBackShopResult {
  if (activeRunId) return { ok: false, conflictRunId: activeRunId };
  if (options.rows.length === 0) return { ok: false, error: 'No rows were given to check.' };

  const runId = nextRunId();
  const runDir = path.join('data', 'backshop-tmp', runId);
  fs.mkdirSync(runDir, { recursive: true });

  // Written to a file rather than passed as an argv string: part numbers and
  // serials are free-form and a whole day's list would push a command line
  // toward Windows' length limit.
  const rowsPath = path.join(runDir, 'rows.json');
  fs.writeFileSync(rowsPath, JSON.stringify(options.rows), 'utf-8');

  const job: BackShopJob = {
    runId,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    fatalError: null,
    phase: null,
    env: options.env,
    findings: [],
    totalRequested: options.rows.length,
    process: null,
    cancelRequested: false,
  };
  jobs.set(runId, job);
  activeRunId = runId;

  job.process = spawnRunner(
    'src/api/jobRunners/backShopDiscoveryRunner.ts',
    ['--env', options.env, '--rows-path', rowsPath],
    (envelope) => handleEnvelope(job, envelope),
    (code) => {
      job.completedAt = new Date().toISOString();
      job.status = job.cancelRequested ? 'cancelled' : job.fatalError || code !== 0 ? 'failed' : 'completed';
      if (activeRunId === runId) activeRunId = null;
      fs.rm(runDir, { recursive: true, force: true }, () => {});
    },
    mxiCredentialEnvOverrides(mxiCredential),
  );

  return { ok: true, runId };
}

export function cancelBackShopJob(runId: string): boolean {
  const job = jobs.get(runId);
  if (!job || !job.process) return false;
  job.cancelRequested = true;
  requestCancellation(job.process);
  return true;
}
