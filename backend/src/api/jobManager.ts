import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import type { MxiEnv } from '../mxiWriter/config.js';
import type { MxiCredential } from '../auth/authService.js';
import type { RunLogEvent } from './runLog.js';
import { listVendors } from './vendors.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('api');

/**
 * CLAUDE_CODE_PROMPT (#6, login/account system) — the env vars a spawned
 * runner's own createReadyMxiClient(env) reads (see cliMxiClient.ts).
 * "One per user, same for stage and prod" per explicit user direction — no
 * per-env split, both prefixes get the same logged-in user's credential.
 */
export function mxiCredentialEnvOverrides(credential: MxiCredential): Record<string, string> {
  return {
    MXI_STAGE_USERNAME: credential.username,
    MXI_STAGE_PASSWORD: credential.password,
    MXI_PROD_USERNAME: credential.username,
    MXI_PROD_PASSWORD: credential.password,
  };
}

export type JobKind = 'discovery' | 'execute';
/**
 * 'cancelled' — CLAUDE_CODE_PROMPT (cancel button) — a user-initiated stop,
 * distinct from 'failed' (an unexpected error). Set by cancelJob() the
 * moment cancellation is requested, and left untouched by the runner's own
 * exit handler regardless of the child's real exit code — a runner that
 * exits 0 after honoring a cancel request is still a cancelled run, not a
 * completed one.
 */
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'partial' | 'cancelled';

export interface DiscoveredLineSummary {
  lineId: string;
  vendorId: string;
  vendorDisplayName: string;
  partNumber: string;
  serialNumber: string;
  description: string;
  status: 'completed' | 'exception';
  summary: string;
  exceptionType?: string;
  routedTo?: string;
  detail?: string;
}

export interface JobCounts {
  completed: number;
  skipped: number;
  exception: number;
  inProgress: number;
  total: number;
}

export interface Job {
  runId: string;
  kind: JobKind;
  env: MxiEnv;
  vendorIds: string[];
  status: JobStatus;
  startedAt: string;
  completedAt: string | null;
  log: RunLogEvent[];
  fatalError: string | null;
  /** discovery jobs only — the reviewable snapshot; keyed by lineId for O(1) selection lookups at execute time. */
  lines: Map<string, DiscoveredLineSummary> | null;
  /**
   * CLAUDE_CODE_PROMPT (cancel button) — execute jobs only: how many lines
   * were targeted at start. counts.total only grows as terminal events
   * arrive, so it can't answer "how many total" on its own — needed so a
   * freshly re-attached page (e.g. after a cancel-and-revert, or a browser
   * reload mid-run) can still render an accurate "line X of Y" without the
   * original selectedLineIds list, which is never itself persisted.
   */
  targetLineCount: number | null;
  /** execute jobs only — the discovery runId this execution was confirmed against. */
  sourceDiscoveryRunId: string | null;
  counts: JobCounts;
  /** The spawned runner's own process handle — needed so cancelJob() can signal it. Null only in the brief window before spawnRunner() returns. */
  process: ChildProcess | null;
  /** True once cancelJob() has been called for this run — the runner's own exit handler checks this first, before fatalError/exit-code, to decide final status. */
  cancelRequested: boolean;
}

// In-memory registry — acceptable for v1 (localhost, single analyst). Every
// real outcome still reaches data/audit.db via the runner's own calls to
// the exact same insertWriteUpAction/logVendorCodeOutcome functions the CLI
// path uses; this registry is UI-convenience state, not the audit record.
const jobs = new Map<string, Job>();
let activeRunId: string | null = null;

function nextRunId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function lineIdFor(vendorId: string, partNumber: string, serialNumber: string): string {
  return `${vendorId}::${partNumber}::${serialNumber}`;
}

export function getJob(runId: string): Job | undefined {
  return jobs.get(runId);
}

export function getActiveJob(): Job | undefined {
  return activeRunId ? jobs.get(activeRunId) : undefined;
}

function tsxCliPath(): string {
  return path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
}

/**
 * Spawns via `node <tsx-cli.mjs> <script> ...args` directly (no shell,
 * shell:false is Node's own default) — avoids Windows shell-quoting
 * entirely, which matters because executeRunner's --targets argument is a
 * raw JSON blob (braces/quotes that a shell would try to interpret). `env`
 * is omitted from the spawn options deliberately: Node's child_process
 * default IS to inherit the full parent process.env, which already holds
 * every real .env-resolved secret this server itself loaded at startup —
 * so the child gets real credentials without this code ever touching,
 * copying, or logging them, and without a single secret ever appearing in
 * argv (verifiable via `Get-Process`/task manager command-line columns).
 */
export function spawnRunner(
  scriptRelPath: string,
  args: string[],
  onEnvelope: (envelope: unknown) => void,
  onExit: (code: number | null) => void,
  /**
   * CLAUDE_CODE_PROMPT (#6, login/account system) — merged OVER process.env
   * (never replacing it) so the child still inherits everything else the
   * parent server has (ANTHROPIC_API_KEY, MXI_STAGE_BASE_URL, etc.), with
   * only the logged-in user's own MXI credential overriding whatever
   * (if anything) backend/.env itself sets for those specific keys. Before
   * this, every spawned job silently used the server's own static .env
   * credential regardless of who was using the UI — see
   * mxiCredentialEnvOverrides() above for the real per-request values.
   */
  envOverrides?: Record<string, string>,
): ChildProcess {
  // stdin is now 'pipe' (was 'ignore') so requestCancellation() below can
  // write a cancel message into it — see cancellationWatcher.ts's docstring
  // for why this cooperative approach exists instead of relying on
  // ChildProcess.kill()'s signal argument (unreliable on Windows).
  const child = spawn(process.execPath, [tsxCliPath(), path.join(process.cwd(), scriptRelPath), ...args], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
  });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onEnvelope(JSON.parse(trimmed));
    } catch {
      // A non-JSON stdout line (shouldn't happen — the runner only ever
      // writes JSON envelopes) is logged server-side for debugging but
      // never surfaced to the UI as a fabricated event.
      log.warn({ line: trimmed }, '[job-manager] Non-JSON line from runner, ignored');
    }
  });

  let stderrBuffer = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuffer += chunk.toString();
  });

  child.on('close', (code) => {
    if (code !== 0 && stderrBuffer.trim()) {
      log.error({ exitCode: code, stderr: stderrBuffer }, '[job-manager] Runner stderr');
    }
    onExit(code);
  });

  return child;
}

/**
 * CLAUDE_CODE_PROMPT (cancel button) — sends the cooperative cancel
 * message (see cancellationWatcher.ts) and starts a grace-period fallback:
 * if the child hasn't exited on its own within CANCEL_GRACE_PERIOD_MS
 * (meaning it's hung well past its own next checkpoint, or never reaches
 * one), it's force-killed as a last resort. `child.kill()`'s signal
 * argument is meaningless on Windows (force-terminates immediately
 * regardless) — this is accepted here only as the rare fallback, not the
 * primary mechanism.
 */
const CANCEL_GRACE_PERIOD_MS = 10_000;

export function requestCancellation(child: ChildProcess): void {
  try {
    child.stdin?.write(JSON.stringify({ type: 'cancel' }) + '\n');
  } catch {
    // stdin may already be closed if the child is on its way out anyway —
    // the grace-period fallback below still applies regardless.
  }
  setTimeout(() => {
    if (child.exitCode === null && !child.killed) {
      log.warn('[job-manager] Runner did not exit within the cancel grace period — force-killing.');
      child.kill();
    }
  }, CANCEL_GRACE_PERIOD_MS);
}

function applyDiscoveryEnvelope(job: Job, envelope: any): void {
  if (envelope.type === 'line' && envelope.event) {
    const event: RunLogEvent = envelope.event;
    job.log.push(event);
    const id = lineIdFor(event.vendorId, event.partNumber, event.serialNumber);
    job.lines!.set(id, {
      lineId: id,
      vendorId: event.vendorId,
      vendorDisplayName: event.vendorDisplayName,
      partNumber: event.partNumber,
      serialNumber: event.serialNumber,
      description: event.description,
      status: event.status === 'exception' ? 'exception' : 'completed',
      summary: event.summary,
      exceptionType: event.exceptionType,
      routedTo: event.routedTo,
      detail: event.detail,
    });
    job.counts.total++;
    if (event.status === 'exception') job.counts.exception++;
    else job.counts.completed++;
  } else if (envelope.type === 'fatal') {
    job.fatalError = envelope.message ?? 'Unknown fatal error';
  }
}

function applyExecuteEnvelope(job: Job, envelope: any): void {
  if (envelope.type === 'line' && envelope.event) {
    const event: RunLogEvent = envelope.event;
    // The in_progress event and its terminal follow-up share a seq
    // allocation gap (executeRunner emits both) — both are kept in the log
    // (the UI wants to see "now processing" transition to its outcome),
    // but only the terminal one counts toward the summary tallies.
    //
    // CLAUDE_CODE_PROMPT_WRITEUP_FAILSAFE.md Layer 3 — 'retrying' is a
    // THIRD non-terminal status (quarantined on the main pass, pending an
    // automatic second-pass retry). It must not decrement inProgress (the
    // line isn't done — it's still outstanding) and must not count toward
    // total/completed/skipped/exception (the executeRunner deliberately
    // does NOT emit a fresh in_progress event when the second pass later
    // reprocesses this same line, so exactly one inProgress increment and
    // one terminal decrement happen per line overall, matching every
    // other line's accounting).
    job.log.push(event);
    if (event.status === 'in_progress') {
      job.counts.inProgress++;
    } else if (event.status === 'retrying') {
      // No count change — see above.
    } else {
      job.counts.inProgress = Math.max(0, job.counts.inProgress - 1);
      job.counts.total++;
      if (event.status === 'exception') job.counts.exception++;
      else if (event.status === 'skipped') job.counts.skipped++;
      else job.counts.completed++;
    }
  } else if (envelope.type === 'fatal') {
    job.fatalError = envelope.message ?? 'Unknown fatal error';
  }
}

export interface StartJobResult {
  ok: boolean;
  runId?: string;
  conflictRunId?: string;
  error?: string;
}

export function startDiscoveryJob(env: MxiEnv, vendorIds: string[], mxiCredential: MxiCredential): StartJobResult {
  if (activeRunId) return { ok: false, conflictRunId: activeRunId };

  const runId = nextRunId('disc');
  const job: Job = {
    runId,
    kind: 'discovery',
    env,
    vendorIds,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    log: [],
    fatalError: null,
    lines: new Map(),
    sourceDiscoveryRunId: null,
    targetLineCount: null,
    counts: { completed: 0, skipped: 0, exception: 0, inProgress: 0, total: 0 },
    process: null,
    cancelRequested: false,
  };
  jobs.set(runId, job);
  activeRunId = runId;

  job.process = spawnRunner(
    'src/api/jobRunners/discoveryRunner.ts',
    ['--env', env, '--vendors', vendorIds.join(',')],
    (envelope) => applyDiscoveryEnvelope(job, envelope),
    (code) => {
      job.completedAt = new Date().toISOString();
      job.status = job.cancelRequested ? 'cancelled' : job.fatalError || code !== 0 ? 'failed' : 'completed';
      if (activeRunId === runId) activeRunId = null;
    },
    mxiCredentialEnvOverrides(mxiCredential),
  );

  return { ok: true, runId };
}

export interface ExecuteTarget {
  vendorId: string;
  partNumber: string;
  serialNumber: string;
}

export function startExecuteJob(
  discoveryRunId: string,
  selectedLineIds: string[],
  env: MxiEnv,
  mxiCredential: MxiCredential,
): StartJobResult {
  if (activeRunId) return { ok: false, conflictRunId: activeRunId };

  const discoveryJob = jobs.get(discoveryRunId);
  if (!discoveryJob || discoveryJob.kind !== 'discovery') {
    return { ok: false, error: `No discovery run found for runId "${discoveryRunId}".` };
  }
  if (discoveryJob.env !== env) {
    return {
      ok: false,
      error:
        `Refusing to proceed: discovery run ${discoveryRunId} was generated for env "${discoveryJob.env}" but this ` +
        `execute request targets "${env}". Re-run discovery with the matching environment first.`,
    };
  }

  const targets: ExecuteTarget[] = [];
  for (const lineId of selectedLineIds) {
    const line = discoveryJob.lines!.get(lineId);
    if (!line) return { ok: false, error: `Selected line id "${lineId}" was not found in discovery run ${discoveryRunId}.` };
    if (line.status === 'exception') return { ok: false, error: `Line id "${lineId}" is an exception line and is not selectable for execution.` };
    targets.push({ vendorId: line.vendorId, partNumber: line.partNumber, serialNumber: line.serialNumber });
  }
  if (targets.length === 0) return { ok: false, error: 'No lines selected.' };

  const runId = nextRunId('exec');
  const vendorIds = [...new Set(targets.map((t) => t.vendorId))];
  const job: Job = {
    runId,
    kind: 'execute',
    env,
    vendorIds,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    log: [],
    fatalError: null,
    lines: null,
    sourceDiscoveryRunId: discoveryRunId,
    targetLineCount: targets.length,
    counts: { completed: 0, skipped: 0, exception: 0, inProgress: 0, total: 0 },
    process: null,
    cancelRequested: false,
  };
  jobs.set(runId, job);
  activeRunId = runId;

  job.process = spawnRunner(
    'src/api/jobRunners/executeRunner.ts',
    ['--env', env, '--targets', JSON.stringify(targets)],
    (envelope) => applyExecuteEnvelope(job, envelope),
    (code) => {
      job.completedAt = new Date().toISOString();
      if (job.cancelRequested) {
        job.status = 'cancelled';
      } else if (job.fatalError) {
        job.status = 'failed';
      } else if (code !== 0) {
        job.status = 'failed';
      } else if (job.counts.exception > 0) {
        job.status = 'partial';
      } else {
        job.status = 'completed';
      }
      if (activeRunId === runId) activeRunId = null;
    },
    mxiCredentialEnvOverrides(mxiCredential),
  );

  return { ok: true, runId };
}

export interface CancelJobResult {
  ok: boolean;
  error?: string;
}

/**
 * CLAUDE_CODE_PROMPT (cancel button) — real cancel of a real run, not a
 * frontend-only "stop watching." Marks the job cancelled immediately (so a
 * poll landing right after this call already sees the new status, even
 * before the child process has actually exited) and asks the runner to
 * stop at its next safe checkpoint — see requestCancellation()/
 * cancellationWatcher.ts for the full mechanism and why it isn't a raw
 * process signal.
 */
export function cancelJob(runId: string): CancelJobResult {
  const job = jobs.get(runId);
  if (!job) return { ok: false, error: `No run found for runId "${runId}".` };
  if (job.status !== 'running' && job.status !== 'pending') {
    return { ok: false, error: `Run ${runId} is already ${job.status} — nothing to cancel.` };
  }
  if (job.cancelRequested) return { ok: true }; // already in progress — idempotent
  job.cancelRequested = true;
  job.status = 'cancelled';
  if (activeRunId === runId) activeRunId = null;
  if (job.process) requestCancellation(job.process);
  return { ok: true };
}

/** Re-derived from the real registry every call, never hardcoded — used by GET /api/vendors. */
export function getVendorList() {
  return listVendors();
}
