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
  /** Populated once a certificate has been read, before that scrap begins. */
  certPreview: {
    orderNumber: string | null;
    serialNumber: string | null;
    partNumber: string | null;
    vendorName: string | null;
    confidence: string | null;
  } | null;
  /**
   * One entry per serial.
   *
   * A LIST even when only one serial was submitted: the in-house path
   * accepts several at once, and a single-result field would silently show
   * only the last one of a batch — hiding earlier failures behind a later
   * success.
   */
  results: ScrapOutResult[];
  /** How many serials were submitted, so progress can read "N of M" honestly. */
  totalRequested: number;
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
    const result: ScrapOutResult = {
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
    // Keyed by serial so a re-emitted result replaces rather than
    // duplicates. Falls back to appending when there's no serial to key on.
    const idx = result.serialNumber
      ? job.results.findIndex((r) => r.serialNumber === result.serialNumber)
      : -1;
    if (idx >= 0) job.results[idx] = result;
    else job.results.push(result);
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
  /** In-house path: one or more serials to scrap, processed in order. */
  serialNumbers?: string[];
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

/**
 * Normalises a pasted list of serials: splits on newlines, commas, tabs, or
 * semicolons, trims, drops blanks, and removes duplicates.
 *
 * De-duplication matters here specifically. Scrapping is irreversible and
 * not idempotent, so the same serial appearing twice in a paste must not
 * become two attempts — the second would try to scrap something already
 * gone.
 */
export function parseSerialList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of raw.split(/[\n\r,;\t]+/)) {
    const serial = piece.trim();
    if (!serial) continue;
    const key = serial.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(serial);
  }
  return out;
}

export function startScrapOutJob(options: StartScrapOptions, mxiCredential: MxiCredential): StartScrapResult {
  if (activeRunId) return { ok: false, conflictRunId: activeRunId };

  if (options.kind === 'vendor' && !options.certTempPath) {
    return { ok: false, error: 'A scrap certificate is required for a vendor scrap.' };
  }
  const serials = options.serialNumbers ?? [];
  if (options.kind === 'in_house' && serials.length === 0) {
    return { ok: false, error: 'At least one serial number is required for an in-house scrap.' };
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
    results: [],
    totalRequested: options.kind === 'vendor' ? 1 : serials.length,
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
    // JSON rather than a delimited string: serials are free-form vendor
    // text and could contain almost any separator character.
    args.push('--serials', JSON.stringify(serials));
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
