import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import type { MxiEnv } from '../mxiWriter/config.js';
import type { MxiCredential } from '../auth/authService.js';
import type { RunLogEvent } from './runLog.js';
import { listVendors } from './vendors.js';

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
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'partial';

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
  /** execute jobs only — the discovery runId this execution was confirmed against. */
  sourceDiscoveryRunId: string | null;
  counts: JobCounts;
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
): void {
  const child = spawn(process.execPath, [tsxCliPath(), path.join(process.cwd(), scriptRelPath), ...args], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
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
      console.warn(`[job-manager] Non-JSON line from runner, ignored: ${trimmed}`);
    }
  });

  let stderrBuffer = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuffer += chunk.toString();
  });

  child.on('close', (code) => {
    if (code !== 0 && stderrBuffer.trim()) {
      console.error(`[job-manager] Runner stderr (exit ${code}):\n${stderrBuffer}`);
    }
    onExit(code);
  });
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
    counts: { completed: 0, skipped: 0, exception: 0, inProgress: 0, total: 0 },
  };
  jobs.set(runId, job);
  activeRunId = runId;

  spawnRunner(
    'src/api/jobRunners/discoveryRunner.ts',
    ['--env', env, '--vendors', vendorIds.join(',')],
    (envelope) => applyDiscoveryEnvelope(job, envelope),
    (code) => {
      job.completedAt = new Date().toISOString();
      job.status = job.fatalError || code !== 0 ? 'failed' : 'completed';
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
    counts: { completed: 0, skipped: 0, exception: 0, inProgress: 0, total: 0 },
  };
  jobs.set(runId, job);
  activeRunId = runId;

  spawnRunner(
    'src/api/jobRunners/executeRunner.ts',
    ['--env', env, '--targets', JSON.stringify(targets)],
    (envelope) => applyExecuteEnvelope(job, envelope),
    (code) => {
      job.completedAt = new Date().toISOString();
      if (job.fatalError) {
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

/** Re-derived from the real registry every call, never hardcoded — used by GET /api/vendors. */
export function getVendorList() {
  return listVendors();
}
