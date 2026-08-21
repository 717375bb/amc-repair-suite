import type { ChildProcess } from 'node:child_process';
import { requestCancellation, spawnRunner } from '../jobManager.js';

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
  confidence: string;
  reasoningNote: string;
}

export interface QuoteJob {
  runId: string;
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
}

function handleEnvelope(job: QuoteJob, envelope: unknown): void {
  const e = envelope as RunnerEnvelope;
  if (e.type === 'phase') {
    job.phase = e.phase ?? null;
  } else if (e.type === 'summary') {
    if (e.dbRunId !== undefined) job.dbRunId = e.dbRunId;
    if (e.folderPath !== undefined) job.folderPath = e.folderPath;
    job.scannedCount = e.scannedCount ?? null;
    job.pdfCount = e.pdfCount ?? null;
  } else if (e.type === 'extraction' && e.row) {
    // Keyed on extractionId (a real DB primary key), so a row can never be
    // silently merged with a different PDF that happens to share an order
    // number — one email legitimately carries several PDFs.
    const idx = job.rows.findIndex((r) => r.extractionId === e.row!.extractionId);
    if (idx >= 0) job.rows[idx] = e.row;
    else job.rows.push(e.row);
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

export function cancelQuoteJob(runId: string): boolean {
  const job = jobs.get(runId);
  if (!job || !job.process) return false;
  job.cancelRequested = true;
  requestCancellation(job.process);
  return true;
}
