import type { ChildProcess } from 'node:child_process';
import { mxiCredentialEnvOverrides, requestCancellation, spawnRunner } from '../jobManager.js';
import type { MxiEnv } from '../../mxiWriter/config.js';
import type { MxiCredential } from '../../auth/authService.js';
import type { QuoteDisposition } from '../../quoteWriter/quoteDisposition.js';

/**
 * Job registry for the Vendor Quote Writer tab — a fourth independent
 * workstream, deliberately separate from jobManager.ts (Order Write-Ups),
 * esdFinderJobManager.ts (ESD Finder), and invoicePriceJobManager.ts
 * (Invoice Price Writer), each of which owns its own activeRunId.
 *
 * Reuses spawnRunner for the process discipline (no shell, real .env
 * secrets inherited by the child rather than handled here, one JSON
 * envelope per stdout line). Nothing about *how* a job runs is
 * reimplemented — only what runs and how its results are stored.
 *
 * Unlike the other three tabs there is no file upload: the input is an
 * Outlook folder read on the server's own machine, so there's nothing to
 * stage to a temp directory.
 */

export type QuoteJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface QuoteExtractionRow {
  extractionId: number;
  entryId: string;
  subject: string | null;
  senderName: string | null;
  fileName: string;
  documentKind: string;
  orderNumber: string | null;
  orderNumberSource: string | null;
  quoteNumber: string | null;
  vendorName: string | null;
  partNumber: string | null;
  serialNumber: string | null;
  unitPrice: number | null;
  currency: string | null;
  quoteDate: string | null;
  promisedShipDate: string | null;
  resolvedEsd: string | null;
  esdBasis: string | null;
  esdExplanation: string | null;
  needsReview: boolean;
  reviewReasons: string[];
  /** Vendor-stated non-repairable (NREP) — an extraction fact, not a human decision. */
  vendorSaysNonRepairable: boolean;
  nonRepairableEvidence: string | null;
  /** Effective disposition: the auto-derived initial value, overridden by any later human decision. */
  disposition: QuoteDisposition;
  confidence: string;
  reasoningNote: string;
}

export interface QuoteWriteResult {
  extractionId: number;
  orderNumber: string;
  status: 'success' | 'failed' | 'skipped';
  outcome: string | null;
  originalPrice: string | null;
  writtenPrice: string | null;
  writtenEsd: string | null;
  /** Whether the source email was marked read. Only ever true after a verified write. */
  markedRead: boolean;
  /** A mailbox bookkeeping miss — deliberately separate from errorMessage, which means the MXI write failed. */
  markReadError: string | null;
  errorMessage: string | null;
}

export interface QuoteJob {
  runId: string;
  /** 'ingest' reads and extracts; 'write' pushes to MXI. Same run slot, two phases. */
  kind: 'ingest' | 'write';
  status: QuoteJobStatus;
  startedAt: string;
  completedAt: string | null;
  fatalError: string | null;
  phase: string | null;
  folderPath: string | null;
  /** The SQL quote_runs.id these rows are recorded under. */
  dbRunId: number | null;
  scannedCount: number | null;
  pdfCount: number | null;
  rows: QuoteExtractionRow[];
  /** Populated by a write job. Keyed by extractionId. */
  writeEnv: MxiEnv | null;
  writeResults: QuoteWriteResult[];
  process: ChildProcess | null;
  cancelRequested: boolean;
}

const jobs = new Map<string, QuoteJob>();
let activeRunId: string | null = null;

function nextRunId(): string {
  return `quote_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getQuoteJob(runId: string): QuoteJob | undefined {
  return jobs.get(runId);
}

export function getActiveQuoteJob(): QuoteJob | undefined {
  return activeRunId ? jobs.get(activeRunId) : undefined;
}

interface RunnerEnvelope {
  type: string;
  phase?: string;
  folderPath?: string;
  dbRunId?: number;
  scannedCount?: number;
  pdfCount?: number;
  row?: QuoteExtractionRow;
  message?: string;
  extractionId?: number;
  orderNumber?: string;
  status?: 'success' | 'failed' | 'skipped';
  outcome?: string | null;
  originalPrice?: string | null;
  writtenPrice?: string | null;
  writtenEsd?: string | null;
  markedRead?: boolean;
  markReadError?: string | null;
  errorMessage?: string | null;
}

function handleEnvelope(job: QuoteJob, envelope: unknown): void {
  const e = envelope as RunnerEnvelope;
  if (e.type === 'phase') {
    job.phase = e.phase ?? null;
  } else if (e.type === 'summary') {
    // Every field is applied only when the envelope actually carries it.
    // The WRITE runner emits a summary too, but without scannedCount /
    // pdfCount / folderPath — an unconditional `?? null` would blank the
    // ingest's real counts the moment a write started, making the header
    // read "0 PDFs" mid-write.
    if (e.dbRunId !== undefined) job.dbRunId = e.dbRunId;
    if (e.folderPath !== undefined) job.folderPath = e.folderPath;
    if (e.scannedCount !== undefined) job.scannedCount = e.scannedCount;
    if (e.pdfCount !== undefined) job.pdfCount = e.pdfCount;
  } else if (e.type === 'extraction' && e.row) {
    // Keyed on extractionId (a real DB primary key), so a row can never be
    // silently merged with a different PDF that happens to share an order
    // number — one email legitimately carries several PDFs.
    const idx = job.rows.findIndex((r) => r.extractionId === e.row!.extractionId);
    if (idx >= 0) job.rows[idx] = e.row;
    else job.rows.push(e.row);
  } else if (e.type === 'order-result' && typeof e.extractionId === 'number') {
    const result: QuoteWriteResult = {
      extractionId: e.extractionId,
      orderNumber: e.orderNumber ?? '',
      status: e.status ?? 'failed',
      outcome: e.outcome ?? null,
      originalPrice: e.originalPrice ?? null,
      writtenPrice: e.writtenPrice ?? null,
      writtenEsd: e.writtenEsd ?? null,
      markedRead: e.markedRead === true,
      markReadError: e.markReadError ?? null,
      errorMessage: e.errorMessage ?? null,
    };
    const idx = job.writeResults.findIndex((r) => r.extractionId === result.extractionId);
    if (idx >= 0) job.writeResults[idx] = result;
    else job.writeResults.push(result);
  } else if (e.type === 'fatal') {
    job.fatalError = e.message ?? 'Unknown fatal error';
  }
}

export interface StartQuoteJobResult {
  ok: boolean;
  runId?: string;
  conflictRunId?: string;
}

export interface StartQuoteIngestOptions {
  folderPath: string;
  maxMessages: number;
  unreadOnly: boolean;
}

/**
 * Starts an ingest run: Outlook read -> Claude extraction -> ESD
 * derivation -> DB. Touches neither MXI nor the mailbox.
 */
export function startQuoteIngestJob(options: StartQuoteIngestOptions): StartQuoteJobResult {
  if (activeRunId) return { ok: false, conflictRunId: activeRunId };

  const runId = nextRunId();
  const job: QuoteJob = {
    runId,
    kind: 'ingest',
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    fatalError: null,
    phase: null,
    folderPath: options.folderPath,
    dbRunId: null,
    scannedCount: null,
    pdfCount: null,
    rows: [],
    writeEnv: null,
    writeResults: [],
    process: null,
    cancelRequested: false,
  };
  jobs.set(runId, job);
  activeRunId = runId;

  const args = [
    '--folder',
    options.folderPath,
    '--max',
    String(options.maxMessages),
  ];
  if (options.unreadOnly) args.push('--unread-only');

  job.process = spawnRunner(
    'src/api/jobRunners/quoteIngestRunner.ts',
    args,
    (envelope) => handleEnvelope(job, envelope),
    (code) => {
      job.completedAt = new Date().toISOString();
      job.status = job.cancelRequested ? 'cancelled' : job.fatalError || code !== 0 ? 'failed' : 'completed';
      if (activeRunId === runId) activeRunId = null;
    },
  );

  return { ok: true, runId };
}

export interface StartQuoteWriteResult {
  ok: boolean;
  error?: string;
  conflictRunId?: string;
}

/**
 * Starts the MXI write for specific extractions of an already-ingested run.
 *
 * Appends to the SAME runId the UI is already polling (like the Invoice
 * Price Writer's retry does) rather than opening a second run, so the
 * review table can show extraction and write outcomes side by side.
 *
 * Deliberately does NOT filter by disposition here — quoteWriteRunner.ts
 * re-reads the effective disposition from the DB and refuses anything not
 * writable. Filtering in two places invites the two from drifting apart;
 * the runner's check is the one that actually protects a real order.
 */
export function startQuoteWriteJob(
  runId: string,
  env: MxiEnv,
  extractionIds: number[],
  mxiCredential: MxiCredential,
): StartQuoteWriteResult {
  if (activeRunId) return { ok: false, conflictRunId: activeRunId };

  const job = jobs.get(runId);
  if (!job) return { ok: false, error: `No Vendor Quote run found for runId "${runId}".` };
  if (job.dbRunId === null) {
    return { ok: false, error: `Run ${runId} has no recorded database run id — nothing to write from.` };
  }
  if (job.status === 'running' || job.status === 'pending') {
    return { ok: false, error: `Run ${runId} is still in progress.` };
  }
  if (extractionIds.length === 0) return { ok: false, error: 'extractionIds must be a non-empty array.' };

  job.kind = 'write';
  job.status = 'running';
  job.completedAt = null;
  job.fatalError = null;
  job.cancelRequested = false;
  job.writeEnv = env;
  activeRunId = runId;

  job.process = spawnRunner(
    'src/api/jobRunners/quoteWriteRunner.ts',
    ['--env', env, '--db-run-id', String(job.dbRunId), '--extraction-ids', JSON.stringify(extractionIds)],
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

/**
 * Reflects a human disposition decision back into the in-memory job so the
 * UI's next poll shows it, after it's been persisted to
 * quote_dispositions. The DB is the source of truth; this only keeps the
 * live view consistent without forcing a re-ingest.
 */
export function applyQuoteDisposition(
  runId: string,
  extractionId: number,
  disposition: QuoteDisposition,
): boolean {
  const job = jobs.get(runId);
  if (!job) return false;
  const row = job.rows.find((r) => r.extractionId === extractionId);
  if (!row) return false;
  row.disposition = disposition;
  return true;
}

export function cancelQuoteJob(runId: string): boolean {
  const job = jobs.get(runId);
  if (!job || !job.process) return false;
  job.cancelRequested = true;
  requestCancellation(job.process);
  return true;
}
