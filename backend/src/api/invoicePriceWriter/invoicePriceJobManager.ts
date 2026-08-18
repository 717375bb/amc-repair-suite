import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { mxiCredentialEnvOverrides, requestCancellation, spawnRunner } from '../jobManager.js';
import type { MxiEnv } from '../../mxiWriter/config.js';
import type { MxiCredential } from '../../auth/authService.js';

/**
 * Job registry for the Invoice Price Writer tab — a third independent
 * workstream, deliberately separate from both jobManager.ts's own
 * activeRunId (Order Write-Ups) and esdFinderJobManager.ts's activeRunId
 * (ESD Finder). Reuses spawnRunner (same process-spawning discipline: no
 * shell, real .env secrets inherited by the child rather than touched by
 * this code, one JSON envelope per stdout line) — nothing about *how* a
 * job runs is reimplemented here, only *what* job runs and how its
 * per-line results are stored, same as esdFinderJobManager.ts.
 */

export type InvoicePriceJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface InvoicePriceOrderResult {
  orderNumber: string;
  serialNumberSheet: string;
  serialNumberMxi: string | null;
  originalPrice: string | null;
  newPrice: string;
  status: 'success' | 'failed' | 'skipped';
  outcome: string;
  errorMessage: string | null;
}

export interface InvoicePriceJob {
  runId: string;
  status: InvoicePriceJobStatus;
  startedAt: string;
  completedAt: string | null;
  fatalError: string | null;
  writeEnv: MxiEnv;
  /**
   * CLAUDE_CODE_PROMPT (retry failed lines) — the SQL invoice_price_runs.id
   * this job's rows are recorded under. Set from the runner's own
   * 'summary' envelope (both fresh runs and retries emit it) — needed so a
   * later retry can reconstruct row data from invoice_price_writes once
   * the originally-uploaded file is gone.
   */
  dbRunId: number | null;
  rowCount: number | null;
  duplicateCount: number | null;
  results: InvoicePriceOrderResult[];
  process: ChildProcess | null;
  cancelRequested: boolean;
}

const jobs = new Map<string, InvoicePriceJob>();
let activeRunId: string | null = null;

function nextRunId(): string {
  return `invprice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getInvoicePriceJob(runId: string): InvoicePriceJob | undefined {
  return jobs.get(runId);
}

export function getActiveInvoicePriceJob(): InvoicePriceJob | undefined {
  return activeRunId ? jobs.get(activeRunId) : undefined;
}

export interface StartInvoicePriceJobResult {
  ok: boolean;
  runId?: string;
  conflictRunId?: string;
}

/**
 * Copies the uploaded file (already saved to a temp path by multer at the
 * HTTP layer) into a per-run scratch directory before spawning the runner
 * — same reasoning as esdFinderJobManager.ts's stageUploadedFiles: multer's
 * own temp file is deleted once the request completes, before this
 * background job is done reading it.
 */
function stageUploadedFile(runDir: string, filePath: string, fileName: string): string {
  fs.mkdirSync(runDir, { recursive: true });
  const staged = path.join(runDir, fileName);
  fs.copyFileSync(filePath, staged);
  return staged;
}

interface RunnerEnvelope {
  type: string;
  dbRunId?: number;
  rowCount?: number;
  duplicateCount?: number;
  orderNumber?: string;
  serialNumberSheet?: string;
  serialNumberMxi?: string | null;
  originalPrice?: string | null;
  newPrice?: string;
  status?: InvoicePriceOrderResult['status'];
  outcome?: string;
  errorMessage?: string | null;
  message?: string;
}

/**
 * CLAUDE_CODE_PROMPT (retry failed lines) — shared by both a fresh run and
 * a retry. 'order-result' UPSERTS into job.results (replaces an existing
 * entry for the same order number, or appends if new) rather than always
 * pushing — this is what makes a retry's outcomes update the SAME visible
 * row in the results table instead of duplicating it, and is a no-op
 * difference for a fresh run (every order number there is new anyway).
 */
function handleEnvelope(job: InvoicePriceJob, envelope: unknown): void {
  const e = envelope as RunnerEnvelope;
  if (e.type === 'summary') {
    if (e.dbRunId !== undefined) job.dbRunId = e.dbRunId;
    job.rowCount = e.rowCount ?? null;
    job.duplicateCount = e.duplicateCount ?? null;
  } else if (e.type === 'order-result' && e.orderNumber && e.status && e.outcome) {
    const result: InvoicePriceOrderResult = {
      orderNumber: e.orderNumber,
      serialNumberSheet: e.serialNumberSheet ?? '',
      serialNumberMxi: e.serialNumberMxi ?? null,
      originalPrice: e.originalPrice ?? null,
      newPrice: e.newPrice ?? '',
      status: e.status,
      outcome: e.outcome,
      errorMessage: e.errorMessage ?? null,
    };
    const existingIndex = job.results.findIndex((r) => r.orderNumber === result.orderNumber);
    if (existingIndex >= 0) job.results[existingIndex] = result;
    else job.results.push(result);
  } else if (e.type === 'fatal') {
    job.fatalError = e.message ?? 'Unknown fatal error';
  }
}

export function startInvoicePriceWriteJob(
  env: MxiEnv,
  filePath: string,
  fileName: string,
  mxiCredential: MxiCredential,
): StartInvoicePriceJobResult {
  if (activeRunId) return { ok: false, conflictRunId: activeRunId };

  const runId = nextRunId();
  const runDir = path.join('data', 'invoice-price-tmp', runId);
  const stagedFilePath = stageUploadedFile(runDir, filePath, fileName);

  const job: InvoicePriceJob = {
    runId,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    fatalError: null,
    writeEnv: env,
    dbRunId: null,
    rowCount: null,
    duplicateCount: null,
    results: [],
    process: null,
    cancelRequested: false,
  };
  jobs.set(runId, job);
  activeRunId = runId;

  const cleanup = () => {
    fs.rm(runDir, { recursive: true, force: true }, () => {});
  };

  job.process = spawnRunner(
    'src/api/jobRunners/invoicePriceWriteRunner.ts',
    ['--env', env, '--file-path', stagedFilePath, '--file-name', fileName],
    (envelope) => handleEnvelope(job, envelope),
    (code) => {
      job.completedAt = new Date().toISOString();
      job.status = job.cancelRequested ? 'cancelled' : job.fatalError || code !== 0 ? 'failed' : 'completed';
      if (activeRunId === runId) activeRunId = null;
      cleanup();
    },
    mxiCredentialEnvOverrides(mxiCredential),
  );

  return { ok: true, runId };
}

export interface RetryInvoicePriceJobResult {
  ok: boolean;
  error?: string;
}

/**
 * CLAUDE_CODE_PROMPT (retry failed lines) — re-runs specific order numbers
 * from an already-finished job, appending to the SAME run (same string
 * runId the frontend is already polling, same underlying dbRunId) rather
 * than starting a fresh one, so the results table naturally shows the
 * merged picture: untouched rows keep their prior outcome, retried rows
 * get their latest one. The runner itself re-derives each row's
 * (serialNumberSheet, newPrice) from invoice_price_writes and structurally
 * refuses to re-attempt anything that already succeeded — this function
 * just re-validates the job is actually retry-eligible before spawning.
 */
export function retryInvoicePriceWriteJob(
  runId: string,
  orderNumbers: string[],
  mxiCredential: MxiCredential,
): RetryInvoicePriceJobResult {
  if (activeRunId) return { ok: false, error: `An Invoice Price Writer job is already running (${activeRunId}).` };

  const job = jobs.get(runId);
  if (!job) return { ok: false, error: `No Invoice Price Writer run found for runId "${runId}".` };
  if (job.status === 'running' || job.status === 'pending') {
    return { ok: false, error: `Run ${runId} is still in progress — nothing to retry yet.` };
  }
  if (job.dbRunId === null) {
    return { ok: false, error: `Run ${runId} has no recorded database run id — cannot reconstruct rows to retry.` };
  }
  if (orderNumbers.length === 0) {
    return { ok: false, error: 'orderNumbers must be a non-empty array.' };
  }

  job.status = 'running';
  job.completedAt = null;
  job.fatalError = null;
  job.cancelRequested = false;
  activeRunId = runId;

  job.process = spawnRunner(
    'src/api/jobRunners/invoicePriceWriteRunner.ts',
    ['--env', job.writeEnv, '--retry-run-id', String(job.dbRunId), '--order-numbers', JSON.stringify(orderNumbers)],
    (envelope) => handleEnvelope(job, envelope),
    (code) => {
      job.completedAt = new Date().toISOString();
      job.status = job.cancelRequested ? 'cancelled' : job.fatalError || code !== 0 ? 'failed' : 'completed';
      if (activeRunId === runId) activeRunId = null;
    },
    mxiCredentialEnvOverrides(mxiCredential),
  );

  return { ok: true };
}

export interface CancelInvoicePriceJobResult {
  ok: boolean;
  error?: string;
}

export function cancelInvoicePriceJob(runId: string): CancelInvoicePriceJobResult {
  const job = jobs.get(runId);
  if (!job) return { ok: false, error: `No Invoice Price Writer run found for runId "${runId}".` };
  if (job.status !== 'running' && job.status !== 'pending') {
    return { ok: false, error: `Run ${runId} is already ${job.status} — nothing to cancel.` };
  }
  if (job.cancelRequested) return { ok: true };
  job.cancelRequested = true;
  job.status = 'cancelled';
  if (activeRunId === runId) activeRunId = null;
  if (job.process) requestCancellation(job.process);
  return { ok: true };
}
