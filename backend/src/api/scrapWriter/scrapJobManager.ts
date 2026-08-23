import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { mxiCredentialEnvOverrides, requestCancellation, spawnRunner } from '../jobManager.js';
import type { MxiEnv } from '../../mxiWriter/config.js';
import type { MxiCredential } from '../../auth/authService.js';

/**
 * Job registry for the Scrap tab — a fifth independent workstream, with
 * its own activeRunId separate from Order Write-Ups, ESD Finder, Invoice
 * Price Writer, and Vendor Quotes.
 */

export type ScrapJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ScrapOutResult {
  status: 'success' | 'failed';
  orderNumber: string | null;
  serialNumber: string | null;
  partNumber: string | null;
  vendorName: string | null;
  stepsTaken: string[];
  certAttached: boolean;
  locationUsed: string | null;
  errorMessage: string | null;
}

export interface ScrapJob {
  runId: string;
  kind: 'vendor' | 'in_house';
  status: ScrapJobStatus;
  startedAt: string;
  completedAt: string | null;
  fatalError: string | null;
  phase: string | null;
  env: MxiEnv;
  /** Populated once the certificate has been read, before the scrap begins. */
  certPreview: {
    orderNumber: string | null;
    serialNumber: string | null;
    partNumber: string | null;
    vendorName: string | null;
    confidence: string | null;
  } | null;
  result: ScrapOutResult | null;
  process: ChildProcess | null;
  cancelRequested: boolean;
}

const jobs = new Map<string, ScrapJob>();
let activeRunId: string | null = null;

function nextRunId(): string {
  return `scrap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getScrapJob(runId: string): ScrapJob | undefined {
  return jobs.get(runId);
}

export function getActiveScrapJob(): ScrapJob | undefined {
  return activeRunId ? jobs.get(activeRunId) : undefined;
}

interface RunnerEnvelope {
  type: string;
  phase?: string;
  status?: 'success' | 'failed';
  orderNumber?: string | null;
  serialNumber?: string | null;
  partNumber?: string | null;
  vendorName?: string | null;
  confidence?: string | null;
  stepsTaken?: string[];
  certAttached?: boolean;
  locationUsed?: string | null;
  errorMessage?: string | null;
  message?: string;
}

function handleEnvelope(job: ScrapJob, envelope: unknown): void {
  const e = envelope as RunnerEnvelope;
  if (e.type === 'phase') {
    job.phase = e.phase ?? null;
    if (e.phase === 'certificate-read') {
      job.certPreview = {
        orderNumber: e.orderNumber ?? null,
        serialNumber: e.serialNumber ?? null,
        partNumber: e.partNumber ?? null,
        vendorName: e.vendorName ?? null,
        confidence: e.confidence ?? null,
      };
    }
  } else if (e.type === 'result') {
    job.result = {
      status: e.status ?? 'failed',
      orderNumber: e.orderNumber ?? null,
      serialNumber: e.serialNumber ?? null,
      partNumber: e.partNumber ?? null,
      vendorName: e.vendorName ?? null,
      stepsTaken: e.stepsTaken ?? [],
      certAttached: e.certAttached === true,
      locationUsed: e.locationUsed ?? null,
      errorMessage: e.errorMessage ?? null,
    };
  } else if (e.type === 'fatal') {
    job.fatalError = e.message ?? 'Unknown fatal error';
  }
}

export interface StartScrapResult {
  ok: boolean;
  runId?: string;
  error?: string;
  conflictRunId?: string;
}

export interface StartScrapOptions {
  kind: 'vendor' | 'in_house';
  env: MxiEnv;
  /** Vendor path: multer's temp path for the uploaded certificate. */
  certTempPath?: string;
  certFileName?: string;
  /** In-house path: the serial to scrap. */
  serialNumber?: string;
  performedBy: string;
}

/**
 * Copies the uploaded certificate into a per-run directory before spawning
 * the runner — multer deletes its own temp file once the HTTP request
 * completes, well before this background job is done with it. Same reason
 * esdFinderJobManager stages its uploads.
 */
function stageCertificate(runDir: string, tempPath: string, fileName: string): string {
  fs.mkdirSync(runDir, { recursive: true });
  const staged = path.join(runDir, fileName);
  fs.copyFileSync(tempPath, staged);
  return staged;
}

export function startScrapOutJob(options: StartScrapOptions, mxiCredential: MxiCredential): StartScrapResult {
  if (activeRunId) return { ok: false, conflictRunId: activeRunId };

  if (options.kind === 'vendor' && !options.certTempPath) {
    return { ok: false, error: 'A scrap certificate is required for a vendor scrap.' };
  }
  if (options.kind === 'in_house' && !options.serialNumber?.trim()) {
    return { ok: false, error: 'A serial number is required for an in-house scrap.' };
  }

  const runId = nextRunId();
  const runDir = path.join('data', 'scrap-tmp', runId);

  const job: ScrapJob = {
    runId,
    kind: options.kind,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    fatalError: null,
    phase: null,
    env: options.env,
    certPreview: null,
    result: null,
    process: null,
    cancelRequested: false,
  };
  jobs.set(runId, job);
  activeRunId = runId;

  const args = ['--env', options.env, '--kind', options.kind, '--performed-by', options.performedBy];
  if (options.kind === 'vendor') {
    const fileName = options.certFileName ?? 'certificate.pdf';
    const staged = stageCertificate(runDir, options.certTempPath!, fileName);
    args.push('--cert-path', staged, '--cert-file-name', fileName);
  } else {
    args.push('--serial', options.serialNumber!.trim());
  }

  job.process = spawnRunner(
    'src/api/jobRunners/scrapOutRunner.ts',
    args,
    (envelope) => handleEnvelope(job, envelope),
    (code) => {
      job.completedAt = new Date().toISOString();
      job.status = job.cancelRequested ? 'cancelled' : job.fatalError || code !== 0 ? 'failed' : 'completed';
      if (activeRunId === runId) activeRunId = null;
      // The certificate is real vendor paperwork; don't leave copies lying
      // around after the run that needed it is over.
      fs.rm(runDir, { recursive: true, force: true }, () => {});
    },
    mxiCredentialEnvOverrides(mxiCredential),
  );

  return { ok: true, runId };
}

export function cancelScrapJob(runId: string): boolean {
  const job = jobs.get(runId);
  if (!job || !job.process) return false;
  job.cancelRequested = true;
  requestCancellation(job.process);
  return true;
}
