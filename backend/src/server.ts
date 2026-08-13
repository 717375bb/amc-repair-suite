import type { Database as DatabaseType } from 'better-sqlite3';
import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getActionableEsdInference, getPendingEsdUpdates, getPriorMxiWriteEnvironments, insertMxiWrite, openDb } from './db/db.js';
import { openAuthDb } from './db/authDb.js';
import { loadMxiConfig, type MxiEnv } from './mxiWriter/config.js';
import { assembleNoteText, toMxiDateFormat } from './mxiWriter/esdFormatting.js';
import { MxiClient } from './mxiWriter/mxiClient.js';
import { writeEsdAndNotes } from './mxiWriter/writeEsdAndNotes.js';
import { getActiveJob, getJob, getVendorList, startDiscoveryJob, startExecuteJob } from './api/jobManager.js';
import { isKnownVendorId } from './api/vendors.js';
import { getActiveEsdJob, getEsdJob, startEsdCompareJob, startEsdWriteJob } from './api/esdFinder/esdFinderJobManager.js';
import { MissingHeadersError, peekEsdFinderFile, validateHeadersOnly } from './api/esdFinder/ingestion.js';
import { registerAuthRoutes, requireSession, type AuthedRequest } from './api/authRoutes.js';
import { getMxiCredentialForUser } from './auth/authService.js';

/**
 * Shared-secret gate for the three endpoints Power Automate calls. GET
 * /health is deliberately left open — monitoring/load-balancer checks
 * shouldn't need a credential. A misconfigured server (no
 * AUTOMATION_API_KEY set) refuses every gated request rather than silently
 * accepting anything; a valid request needs an exact match on the
 * X-Automation-Key header, nothing else.
 */
function requireAutomationKey(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.AUTOMATION_API_KEY;
  if (!expected) {
    res.status(500).json({ error: 'Server misconfigured: AUTOMATION_API_KEY is not set' });
    return;
  }
  if (req.header('X-Automation-Key') !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

/**
 * Order numbers are confirmed NOT unique across environments (found live
 * during aeroRepair testing: a stage test order coincidentally matched an
 * unrelated real production order). For the ESD writer, real historical
 * mxi_writes data shows the common case is a legitimate test-in-stage-
 * then-deploy-to-production pattern on the SAME real order — so this is a
 * warning, not a hard block (per explicit decision), unlike aeroRepair's
 * approve-issue/reject-issue where the colliding orders were freshly-
 * created test artifacts, not the same real-world thing. Returns a
 * human-readable warning string if this order number has prior mxi_writes
 * history under a DIFFERENT environment than the one about to be used, or
 * null if there's no such history (or it's consistent).
 */
function checkCrossEnvironmentHistory(db: DatabaseType, orderNumber: string, currentEnv: string): string | null {
  const priorEnvs = getPriorMxiWriteEnvironments(db, orderNumber);
  const differing = priorEnvs.filter((e) => e !== currentEnv);
  if (differing.length === 0) return null;
  return (
    `Order ${orderNumber} has prior mxi_writes history under ${differing.join(', ')}, ` +
    `but this action is using "${currentEnv}". Order numbers are not unique across environments — ` +
    `confirm this is the same real order intentionally being handled in both, not a coincidental collision.`
  );
}

/**
 * Order Write-Ups frontend additions. CORS is restricted to the Vite dev
 * origin only — this server binds to 127.0.0.1 (see main() below) and is
 * meant for exactly one local analyst's browser tab, never a public API.
 * Both localhost and 127.0.0.1 forms of the default Vite port are allowed
 * since browsers treat them as distinct origins.
 */
const ALLOWED_UI_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);

function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header('Origin');
  if (origin && ALLOWED_UI_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Automation-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    // CLAUDE_CODE_PROMPT (#6, login/account system) — required for the
    // browser to send/receive the httpOnly session cookie cross-origin
    // (localhost:5173 -> 127.0.0.1:3001 counts as cross-origin even though
    // both are local). A wildcard Access-Control-Allow-Origin can't be
    // combined with credentials per the fetch spec, which is exactly why
    // this only sets it inside the explicit ALLOWED_UI_ORIGINS check above,
    // never as a blanket '*'.
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}

function parseRequiredEnv(req: Request, res: Response): MxiEnv | null {
  const raw = req.body?.env;
  if (raw !== 'stage' && raw !== 'production') {
    res.status(400).json({ error: 'env is required and must be exactly "stage" or "production" — no default.' });
    return null;
  }
  return raw;
}

export function createApp(db: DatabaseType, mxiClient: MxiClient, authDb: DatabaseType) {
  const app = express();
  app.use(corsMiddleware);
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // CLAUDE_CODE_PROMPT (#6, login/account system) — register/login/logout/
  // me/change-password. Unauthenticated by design (you can't require a
  // session to obtain one) except change-password, which requireSession
  // gates internally (see authRoutes.ts).
  registerAuthRoutes(app, authDb);

  // --- Order Write-Ups API (carry-forward rule: reuses this same Express
  // app, this same error/response conventions — no second server).
  // requireAutomationKey -> requireSession as of #6: this is the browser
  // UI's own traffic, now gated by real per-user login instead of the
  // bundled shared secret. The Power-Automate-facing endpoints further
  // below (/pending-esd-updates, /esd-updates/...) deliberately keep
  // requireAutomationKey — a different, machine-to-machine trust boundary,
  // per explicit user direction. ---

  app.get('/api/vendors', requireSession, (_req, res) => {
    res.json(getVendorList());
  });

  // State A needs to know, before even starting a job, whether one is
  // already active — so the UI can disable Run and link to it directly,
  // rather than only discovering the conflict on submit.
  app.get('/api/active-job', requireSession, (_req, res) => {
    const job = getActiveJob();
    res.json({ activeRunId: job?.runId ?? null, kind: job?.kind ?? null });
  });

  app.post('/api/discovery', requireSession, (req, res) => {
    const env = parseRequiredEnv(req, res);
    if (!env) return;
    const vendorIds: unknown = req.body?.vendorIds;
    if (!Array.isArray(vendorIds) || vendorIds.length === 0 || !vendorIds.every((v) => typeof v === 'string')) {
      res.status(400).json({ error: 'vendorIds must be a non-empty array of vendor id strings.' });
      return;
    }
    const unknownIds = vendorIds.filter((v) => !isKnownVendorId(v));
    if (unknownIds.length > 0) {
      res.status(400).json({ error: `Unknown vendor id(s): ${unknownIds.join(', ')}` });
      return;
    }

    const session = (req as AuthedRequest).session!;
    const mxiCredential = getMxiCredentialForUser(authDb, session.userId);
    const result = startDiscoveryJob(env, vendorIds, mxiCredential);
    if (!result.ok) {
      res.status(409).json({ error: 'A write-up job is already running.', activeRunId: result.conflictRunId });
      return;
    }
    res.status(202).json({ runId: result.runId });
  });

  app.get('/api/runs/:runId', requireSession, (req, res) => {
    const job = getJob(req.params.runId);
    if (!job) {
      res.status(404).json({ error: `No run found for runId "${req.params.runId}".` });
      return;
    }
    res.json({
      runId: job.runId,
      kind: job.kind,
      env: job.env,
      vendorIds: job.vendorIds,
      status: job.status,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      fatalError: job.fatalError,
      counts: job.counts,
      lines: job.lines ? Array.from(job.lines.values()) : undefined,
      sourceDiscoveryRunId: job.sourceDiscoveryRunId,
    });
  });

  app.get('/api/runs/:runId/log', requireSession, (req, res) => {
    const job = getJob(req.params.runId);
    if (!job) {
      res.status(404).json({ error: `No run found for runId "${req.params.runId}".` });
      return;
    }
    const since = Number(req.query.since ?? -1);
    const events = job.log.filter((e) => e.seq > since);
    res.json({ events, latestSeq: job.log.length > 0 ? job.log[job.log.length - 1].seq : since });
  });

  app.post('/api/execute', requireSession, (req, res) => {
    const env = parseRequiredEnv(req, res);
    if (!env) return;
    const { runId, selectedLineIds } = req.body ?? {};
    if (typeof runId !== 'string' || !runId) {
      res.status(400).json({ error: 'runId is required.' });
      return;
    }
    if (!Array.isArray(selectedLineIds) || selectedLineIds.length === 0 || !selectedLineIds.every((v) => typeof v === 'string')) {
      res.status(400).json({ error: 'selectedLineIds must be a non-empty array of line id strings.' });
      return;
    }

    const session = (req as AuthedRequest).session!;
    const mxiCredential = getMxiCredentialForUser(authDb, session.userId);
    const result = startExecuteJob(runId, selectedLineIds, env, mxiCredential);
    if (!result.ok) {
      if (result.conflictRunId) {
        res.status(409).json({ error: 'A write-up job is already running.', activeRunId: result.conflictRunId });
      } else {
        res.status(400).json({ error: result.error });
      }
      return;
    }
    res.status(202).json({ executeRunId: result.runId });
  });

  // --- Open Order ESD Finder API (independent workstream from Order
  // Write-Ups — its own job slot in esdFinderJobManager.ts, so an active
  // job on one tab never blocks the other — same server, same requireSession
  // gate as the rest of the browser UI (was requireAutomationKey — see #6). ---

  const esdUpload = multer({ dest: path.join('data', 'esd-finder-uploads-tmp') });

  // State A's per-file preview: row count + immediate header-rejection
  // feedback as each file is dropped, before the analyst commits to a full
  // comparison run.
  app.post('/api/esd/peek', requireSession, esdUpload.single('file'), async (req, res) => {
    const file = req.file;
    const role = req.body?.role;
    if (!file) {
      res.status(400).json({ error: 'file is required.' });
      return;
    }
    if (role !== 'vendor' && role !== 'cra') {
      fs.rm(file.path, { force: true }, () => {});
      res.status(400).json({ error: 'role is required and must be "vendor" or "cra".' });
      return;
    }
    try {
      const peeked = await peekEsdFinderFile(file.path, file.originalname, role);
      res.json(peeked);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      fs.rm(file.path, { force: true }, () => {});
    }
  });

  app.post(
    '/api/esd/compare',
    requireSession,
    esdUpload.fields([
      { name: 'vendorFiles', maxCount: 20 },
      { name: 'craFile', maxCount: 1 },
    ]),
    async (req, res) => {
      const files = req.files as { vendorFiles?: Express.Multer.File[]; craFile?: Express.Multer.File[] } | undefined;
      const vendorFiles = files?.vendorFiles ?? [];
      const craFiles = files?.craFile ?? [];
      // multer saves every uploaded file to disk regardless of outcome
      // below — startEsdCompareJob copies what it needs into its own
      // per-run staging directory, so these originals are always scratch
      // to be deleted before this handler returns, on every path.
      const allUploadedPaths = [...vendorFiles, ...craFiles].map((f) => f.path);
      const cleanupUploads = () => {
        for (const p of allUploadedPaths) fs.rm(p, { force: true }, () => {});
      };

      if (vendorFiles.length === 0) {
        cleanupUploads();
        res.status(400).json({ error: 'At least one Vendor OOR file is required.' });
        return;
      }
      if (craFiles.length !== 1) {
        cleanupUploads();
        res.status(400).json({ error: 'Exactly one CRA OOR file is required.' });
        return;
      }

      const vendorFileRefs = vendorFiles.map((f) => ({ filePath: f.path, fileName: f.originalname }));
      const craFileRef = { filePath: craFiles[0].path, fileName: craFiles[0].originalname };

      // Fast rejection before a background job is even started — see
      // validateHeadersOnly's docstring for why this is a convenience, not
      // the structural guarantee (that lives inside ingestEsdFinderFiles,
      // re-checked regardless of what this pre-check already found).
      try {
        for (const f of vendorFileRefs) {
          await validateHeadersOnly(f.filePath, f.fileName, 'vendor');
        }
        await validateHeadersOnly(craFileRef.filePath, craFileRef.fileName, 'cra');
      } catch (err) {
        cleanupUploads();
        if (err instanceof MissingHeadersError) {
          res.status(400).json({ error: err.message });
        } else {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      const result = startEsdCompareJob(vendorFileRefs, craFileRef);
      cleanupUploads(); // already copied into the job's own staging dir by now
      if (!result.ok) {
        res.status(409).json({ error: 'An ESD Finder job is already running.', activeRunId: result.conflictRunId });
        return;
      }
      res.status(202).json({ runId: result.runId });
    },
  );

  app.get('/api/esd/active-job', requireSession, (_req, res) => {
    const job = getActiveEsdJob();
    res.json({ activeRunId: job?.runId ?? null });
  });

  app.get('/api/esd/runs/:runId', requireSession, (req, res) => {
    const job = getEsdJob(req.params.runId);
    if (!job) {
      res.status(404).json({ error: `No ESD Finder run found for runId "${req.params.runId}".` });
      return;
    }
    res.json({
      runId: job.runId,
      kind: job.kind,
      status: job.status,
      phase: job.phase,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      fatalError: job.fatalError,
      result: job.result,
      writeEnv: job.writeEnv,
      writeResults: job.writeResults,
    });
  });

  // Writes the surviving, non-X'd, actionable, non-duplicate rows from a
  // completed compare run. `env` is explicit and required on every call —
  // no default, no inheriting server.ts's own server-lifetime mxiClient
  // (see esdWriteRunner.ts's docstring for why that distinction matters).
  // The requested order numbers are validated against the SOURCE compare
  // job's own stored result, not trusted from the client: anything
  // actionable-but-duplicate, not actionable at all, or simply not present
  // in that run is rejected outright rather than silently dropped.
  app.post('/api/esd/write', requireSession, (req, res) => {
    const env = parseRequiredEnv(req, res);
    if (!env) return;

    const { runId, orderNumbers } = req.body ?? {};
    if (typeof runId !== 'string' || !runId) {
      res.status(400).json({ error: 'runId is required (the compare run to write from).' });
      return;
    }
    if (!Array.isArray(orderNumbers) || orderNumbers.length === 0 || !orderNumbers.every((o) => typeof o === 'string')) {
      res.status(400).json({ error: 'orderNumbers must be a non-empty array of order number strings.' });
      return;
    }

    const compareJob = getEsdJob(runId);
    if (!compareJob || compareJob.kind !== 'compare') {
      res.status(404).json({ error: `No ESD Finder compare run found for runId "${runId}".` });
      return;
    }
    if (compareJob.status !== 'completed' || !compareJob.result) {
      res.status(400).json({ error: `Compare run "${runId}" has not completed successfully — nothing to write.` });
      return;
    }

    const duplicateOrderNumbers = new Set(
      compareJob.result.duplicates.map((d) => d.orderNumber.trim().toUpperCase()),
    );
    const writeableOrderNumbers = new Set(
      compareJob.result.records
        .filter((r) => r.actionable && !duplicateOrderNumbers.has(r.orderNumber.trim().toUpperCase()))
        .map((r) => r.orderNumber),
    );

    const invalid = orderNumbers.filter((o) => !writeableOrderNumbers.has(o));
    if (invalid.length > 0) {
      res.status(400).json({
        error: `The following order number(s) are not actionable, non-duplicate rows from run "${runId}": ${invalid.join(', ')}. Refusing to write any of the requested orders.`,
      });
      return;
    }

    const session = (req as AuthedRequest).session!;
    const mxiCredential = getMxiCredentialForUser(authDb, session.userId);
    const result = startEsdWriteJob(env, compareJob.result.dbRunId, orderNumbers, mxiCredential);
    if (!result.ok) {
      res.status(409).json({ error: 'An ESD Finder job is already running.', activeRunId: result.conflictRunId });
      return;
    }
    res.status(202).json({ runId: result.runId, env });
  });

  app.get('/pending-esd-updates', requireAutomationKey, (_req, res) => {
    const rows = getPendingEsdUpdates(db);
    res.json(
      rows.map((r) => ({
        orderNumber: r.orderNumber,
        vendorName: r.vendorName,
        currentMxiEsd: r.mxiEsdRaw,
        inferredEsd: r.inferredEsd,
        classification: r.classification,
        confidence: r.confidence,
        reasoningNote: r.reasoningNote,
      })),
    );
  });

  // One of exactly two call sites for writeEsdAndNotes() in this codebase
  // (the other is the manual `npm run mxi:write-esd` CLI tool) —
  // self-checked via `grep -rn "writeEsdAndNotes(" src`. No route, job, or
  // scheduler besides this handler may call it automatically/unattended.
  app.post('/esd-updates/:orderNumber/approve', requireAutomationKey, async (req, res) => {
    const { orderNumber } = req.params;
    const approvedBy: string | null = req.body?.approvedBy || process.env.DEFAULT_APPROVED_BY || null;

    const pending = getActionableEsdInference(db, orderNumber);
    if (!pending) {
      res.status(404).json({ error: `No actionable ESD update found for order ${orderNumber}` });
      return;
    }
    if (!pending.inferredEsd) {
      // Should be unreachable — flag = 'ok' guarantees inferredEsd is set (see applyInferenceRules.ts).
      res.status(409).json({ error: `Order ${orderNumber} has flag=ok but no inferred ESD` });
      return;
    }

    const crossEnvWarning = checkCrossEnvironmentHistory(db, orderNumber, mxiClient.config.env);
    if (crossEnvWarning) {
      console.warn(`[cross-environment] ${crossEnvWarning}`);
    }

    const result = await writeEsdAndNotes(mxiClient, orderNumber, {
      esd: toMxiDateFormat(pending.inferredEsd),
      noteText: assembleNoteText(pending.vendorNotes) ?? undefined,
    });

    const mxiWriteId = insertMxiWrite(db, {
      esdInferenceId: pending.id,
      orderNumber,
      targetEnv: mxiClient.config.env,
      action: 'approved_write',
      inferredEsd: pending.inferredEsd,
      writeStatus: result.status,
      errorMessage: result.errorMessage,
      approvedBy,
    });

    if (result.status === 'success') {
      res.status(200).json({ orderNumber, writeStatus: result.status, mxiWriteId, crossEnvironmentWarning: crossEnvWarning });
    } else {
      res.status(502).json({ orderNumber, writeStatus: result.status, error: result.errorMessage, mxiWriteId, crossEnvironmentWarning: crossEnvWarning });
    }
  });

  app.post('/esd-updates/:orderNumber/reject', requireAutomationKey, (req, res) => {
    const { orderNumber } = req.params;
    const approvedBy: string | null = req.body?.approvedBy || process.env.DEFAULT_APPROVED_BY || null;

    const pending = getActionableEsdInference(db, orderNumber);
    if (!pending) {
      res.status(404).json({ error: `No actionable ESD update found for order ${orderNumber}` });
      return;
    }

    const crossEnvWarning = checkCrossEnvironmentHistory(db, orderNumber, mxiClient.config.env);
    if (crossEnvWarning) {
      console.warn(`[cross-environment] ${crossEnvWarning}`);
    }

    // Never calls the writer.
    const mxiWriteId = insertMxiWrite(db, {
      esdInferenceId: pending.id,
      orderNumber,
      targetEnv: mxiClient.config.env,
      action: 'rejected',
      inferredEsd: pending.inferredEsd,
      writeStatus: 'skipped',
      errorMessage: null,
      approvedBy,
    });

    res.status(200).json({ orderNumber, action: 'rejected', mxiWriteId, crossEnvironmentWarning: crossEnvWarning });
  });

  return app;
}

async function main(): Promise<void> {
  const dbPath = process.env.MXI_DB_PATH || path.join('data', 'audit.db');
  // CLAUDE_CODE_PROMPT (#6, login/account system) — separate file from
  // audit.db, see db/authDb.ts's docstring for why.
  const authDbPath = process.env.AUTH_DB_PATH || path.join('data', 'auth.db');
  const port = Number(process.env.PORT) || 3001;

  const config = loadMxiConfig(); // throws if MXI_ENV isn't literally "stage" or "production"

  const db = openDb(dbPath);
  const authDb = openAuthDb(authDbPath);
  const mxiClient = new MxiClient(config);
  await mxiClient.initialize();

  const app = createApp(db, mxiClient, authDb);
  // 127.0.0.1 only, never 0.0.0.0 — this now also serves the Order
  // Write-Ups job-spawning endpoints, which is not something to expose on
  // the network even accidentally.
  const httpServer = app.listen(port, '127.0.0.1', () => {
    console.log(`ESD approval API listening on http://127.0.0.1:${port} (MXI_ENV=${config.env})`);
  });

  const shutdown = async (): Promise<void> => {
    console.log('\nShutting down...');
    httpServer.close();
    await mxiClient.shutdown();
    db.close();
    authDb.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
if (isMain) {
  main().catch((err) => {
    console.error('Server failed to start:', err);
    process.exit(1);
  });
}
