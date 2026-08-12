import fs from 'node:fs';
import path from 'node:path';
import { spawnRunner } from '../jobManager.js';
import type { EsdCompareResult } from '../jobRunners/esdCompareRunner.js';
import type { MxiEnv } from '../../mxiWriter/config.js';

/**
 * Job registry for the Open Order ESD Finder tab — deliberately separate
 * from jobManager.ts's own activeRunId: "Independent workstream from the
 * Order Write-Ups tab" per the spec, so an active write-up job must not
 * block an ESD compare/write job or vice versa. Reuses spawnRunner (same
 * process-spawning discipline: no shell, real .env secrets inherited by
 * the child rather than touched by this code, one JSON envelope per stdout
 * line) — nothing about *how* a job runs is reimplemented here, only *what*
 * job runs and how its single-result envelope is stored.
 *
 * Compare and write jobs share the SAME activeRunId slot (unlike compare
 * vs. Order Write-Ups, which are genuinely independent) — a write shouldn't
 * start while a compare is running and vice versa, since they're two
 * phases of the same real workflow on this one tab.
 */

export type EsdJobKind = 'compare' | 'write';
export type EsdJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface EsdWriteOrderResult {
  orderNumber: string;
  status: 'success' | 'failed' | 'skipped';
  errorMessage: string | null;
}

export interface EsdJob {
  runId: string;
  kind: EsdJobKind;
  status: EsdJobStatus;
  phase: string | null;
  startedAt: string;
  completedAt: string | null;
  fatalError: string | null;
  /** kind === 'compare' only. */
  result: EsdCompareResult | null;
  /** kind === 'write' only — the actual env this specific job ran with. */
  writeEnv: MxiEnv | null;
  /** kind === 'write' only — grows live as each order finishes. */
  writeResults: EsdWriteOrderResult[];
}

const jobs = new Map<string, EsdJob>();
let activeRunId: string | null = null;

function nextRunId(): string {
  return `esd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getEsdJob(runId: string): EsdJob | undefined {
  return jobs.get(runId);
}

export function getActiveEsdJob(): EsdJob | undefined {
  return activeRunId ? jobs.get(activeRunId) : undefined;
}

export interface StartEsdJobResult {
  ok: boolean;
  runId?: string;
  conflictRunId?: string;
}

export interface UploadedFileRef {
  filePath: string;
  fileName: string;
}

/**
 * Copies uploaded files (already saved to a temp path by multer at the
 * HTTP layer) into a per-run scratch directory under data/esd-finder-tmp/
 * before spawning the runner — the runner reads these by path, and multer's
 * own temp files are deleted by the HTTP layer once the request completes,
 * before this background job is done with them. Cleaned up after the job
 * finishes (success or failure) — this is scratch input, not the audit
 * record (the saved Output .xlsx and the DB rows are).
 */
function stageUploadedFiles(runDir: string, files: UploadedFileRef[]): UploadedFileRef[] {
  fs.mkdirSync(runDir, { recursive: true });
  return files.map((f, i) => {
    const staged = path.join(runDir, `${i}-${f.fileName}`);
    fs.copyFileSync(f.filePath, staged);
    return { filePath: staged, fileName: f.fileName };
  });
}

export function startEsdCompareJob(vendorFiles: UploadedFileRef[], craFile: UploadedFileRef): StartEsdJobResult {
  if (activeRunId) return { ok: false, conflictRunId: activeRunId };

  const runId = nextRunId();
  const runDir = path.join('data', 'esd-finder-tmp', runId);
  const stagedVendorFiles = stageUploadedFiles(runDir, vendorFiles);
  const stagedCraFile = stageUploadedFiles(runDir, [craFile])[0];

  const job: EsdJob = {
    runId,
    kind: 'compare',
    status: 'running',
    phase: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    fatalError: null,
    result: null,
    writeEnv: null,
    writeResults: [],
  };
  jobs.set(runId, job);
  activeRunId = runId;

  const cleanup = () => {
    fs.rm(runDir, { recursive: true, force: true }, () => {});
  };

  spawnRunner(
    'src/api/jobRunners/esdCompareRunner.ts',
    ['--vendor-files', JSON.stringify(stagedVendorFiles), '--cra-file', JSON.stringify(stagedCraFile)],
    (envelope) => {
      const e = envelope as { type: string; phase?: string; message?: string; result?: EsdCompareResult };
      if (e.type === 'phase') {
        job.phase = e.phase ?? null;
      } else if (e.type === 'done') {
        job.result = e.result ?? null;
      } else if (e.type === 'fatal') {
        job.fatalError = e.message ?? 'Unknown fatal error';
      }
    },
    (code) => {
      job.completedAt = new Date().toISOString();
      job.status = job.fatalError || code !== 0 || !job.result ? 'failed' : 'completed';
      if (!job.fatalError && job.status === 'failed') {
        job.fatalError = 'Runner exited without producing a result.';
      }
      if (activeRunId === runId) activeRunId = null;
      cleanup();
    },
  );

  return { ok: true, runId };
}

/**
 * Starts a write job for a specific set of already-validated order
 * numbers against a specific compare run's DB row (dbRunId), in a
 * specific, explicit env — never inherited from server.ts's own
 * server-lifetime mxiClient. See esdWriteRunner.ts's docstring for why
 * that distinction is the entire point of this function existing
 * separately rather than reusing the /esd-updates/:orderNumber/approve
 * endpoint's shared client.
 */
export function startEsdWriteJob(env: MxiEnv, dbRunId: number, orderNumbers: string[]): StartEsdJobResult {
  if (activeRunId) return { ok: false, conflictRunId: activeRunId };

  const runId = nextRunId();
  const job: EsdJob = {
    runId,
    kind: 'write',
    status: 'running',
    phase: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    fatalError: null,
    result: null,
    writeEnv: env,
    writeResults: [],
  };
  jobs.set(runId, job);
  activeRunId = runId;

  spawnRunner(
    'src/api/jobRunners/esdWriteRunner.ts',
    ['--env', env, '--esd-run-id', String(dbRunId), '--order-numbers', JSON.stringify(orderNumbers)],
    (envelope) => {
      const e = envelope as { type: string; orderNumber?: string; status?: EsdWriteOrderResult['status']; errorMessage?: string | null; message?: string };
      if (e.type === 'order-result' && e.orderNumber && e.status) {
        job.writeResults.push({ orderNumber: e.orderNumber, status: e.status, errorMessage: e.errorMessage ?? null });
      } else if (e.type === 'fatal') {
        job.fatalError = e.message ?? 'Unknown fatal error';
      }
    },
    (code) => {
      job.completedAt = new Date().toISOString();
      job.status = job.fatalError || code !== 0 ? 'failed' : 'completed';
      if (activeRunId === runId) activeRunId = null;
    },
  );

  return { ok: true, runId };
}
