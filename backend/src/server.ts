import type { Database as DatabaseType } from 'better-sqlite3';
import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getActionableEsdInference, getPendingEsdUpdates, getPriorMxiWriteEnvironments, insertMxiWrite, insertQuoteDisposition, openDb } from './db/db.js';
import { openAuthDb } from './db/authDb.js';
import { loadMxiConfig, type MxiEnv } from './mxiWriter/config.js';
import { assembleNoteText, toMxiDateFormat } from './mxiWriter/esdFormatting.js';
import { MxiClient } from './mxiWriter/mxiClient.js';
import { writeEsdAndNotes } from './mxiWriter/writeEsdAndNotes.js';
import { cancelJob, getActiveJob, getJob, getVendorList, startDiscoveryJob, startExecuteJob } from './api/jobManager.js';
import { isKnownVendorId, listCraGroupsForKnownVendors } from './api/vendors.js';
import { applyQuoteDisposition, cancelQuoteJob, getActiveQuoteJob, getQuoteJob, startQuoteIngestJob, startQuoteWriteJob } from './api/quoteWriter/quoteJobManager.js';
import { isHumanSettableDisposition } from './quoteWriter/quoteDisposition.js';
import { cancelScrapJob, getActiveScrapJob, getScrapJob, parseSerialList, startScrapOutJob } from './api/scrapWriter/scrapJobManager.js';
import { cancelEsdJob, getActiveEsdJob, getEsdJob, startEsdCompareJob, startEsdWriteJob } from './api/esdFinder/esdFinderJobManager.js';
import { MissingHeadersError, peekEsdFinderFile, validateHeadersOnly } from './api/esdFinder/ingestion.js';
import {
  cancelInvoicePriceJob,
  getActiveInvoicePriceJob,
  getInvoicePriceJob,
  retryInvoicePriceWriteJob,
  startInvoicePriceWriteJob,
} from './api/invoicePriceWriter/invoicePriceJobManager.js';
import {
  MissingHeadersError as InvoicePriceMissingHeadersError,
  peekInvoicePriceFile,
} from './api/invoicePriceWriter/ingestion.js';
import { registerAuthRoutes, requireSession, type AuthedRequest } from './api/authRoutes.js';
import { createMaintenanceRecordsDraft } from './writeUps/shared/maintenanceRecordsDraft.js';
import { getMxiCredentialForUser } from './auth/authService.js';
import { getOptionalSecret, getSecretProvider } from './security/secretProvider.js';
import { createLogger } from './logging/logger.js';

const log = createLogger('api');

/**
 * Shared-secret gate for the three endpoints Power Automate calls. GET
 * /health is deliberately left open — monitoring/load-balancer checks
 * shouldn't need a credential. A misconfigured server (no
 * AUTOMATION_API_KEY set) refuses every gated request rather than silently
 * accepting anything; a valid request needs an exact match on the
 * X-Automation-Key header, nothing else.
 */
function requireAutomationKey(req: Request, res: Response, next: NextFunction): void {
  // CLAUDE_CODE_PROMPT (#6-hardening, secrets-seam) — getOptionalSecret
  // preserves the exact old behavior (empty string, not a throw, when
  // unset) — this stays a per-request 500 "misconfigured," never a crash.
  const expected = getOptionalSecret('AUTOMATION_API_KEY');
  if (!expected) {
    res.status(500).json({ error: 'Server misconfigured: AUTOMATION_API_KEY is not set' });
    return;
  }
  // CLAUDE_CODE_PROMPT (security.md hardening pass) — real gap closed: a
  // plain `!==` string comparison leaks timing information proportional to
  // how many leading characters match, letting an attacker recover the key
  // byte-by-byte over enough requests. timingSafeEqual requires equal-length
  // buffers (it throws otherwise) — the length check is the guard for that,
  // not a shortcut around it; length alone isn't the sensitive part, the
  // key's actual value is.
  const provided = Buffer.from(req.header('X-Automation-Key') ?? '');
  const expectedBuf = Buffer.from(expected);
  const keyMatches = provided.length === expectedBuf.length && timingSafeEqual(provided, expectedBuf);
  if (!keyMatches) {
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

  // CLAUDE_CODE_PROMPT (CRA/vendor grouping, 2026-08-19) — feeds the
  // Order Write-Ups CRA dropdown: selecting a CRA auto-checks all of its
  // registered vendors in the existing vendor selection list. Only CRAs
  // with at least one registered vendor are returned.
  app.get('/api/vendors/cra-groups', requireSession, (_req, res) => {
    res.json(listCraGroupsForKnownVendors());
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
      targetLineCount: job.targetLineCount,
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

  // CLAUDE_CODE_PROMPT (cancel button) — cancels whichever job (discovery
  // or execute) this runId refers to, at whatever point it's currently at.
  // See jobManager.ts's cancelJob() docstring for the real stop mechanism.
  /**
   * Drafts the zero-times-and-cycles notification to Maintenance Records
   * into the analyst's own Outlook Drafts.
   *
   * Replaces a `mailto:` link, which depended on the machine having a
   * registered mail handler and, in a browser, silently did nothing when
   * it did not. Outlook COM is the mechanism this project already uses and
   * has proven for the quote replies.
   *
   * Recipient and subject are FIXED server-side (see
   * maintenanceRecordsDraft.ts) — the client cannot choose who this goes
   * to. Draft only: nothing leaves the mailbox.
   */
  app.post('/api/writeups/maintenance-records-draft', requireSession, async (req, res) => {
    const { partNumber, serialNumber, usageRows } = (req.body ?? {}) as {
      partNumber?: unknown;
      serialNumber?: unknown;
      usageRows?: unknown;
    };

    if (typeof partNumber !== 'string' || !partNumber.trim()) {
      res.status(400).json({ error: 'partNumber is required.' });
      return;
    }
    if (typeof serialNumber !== 'string' || !serialNumber.trim()) {
      res.status(400).json({ error: 'serialNumber is required.' });
      return;
    }
    if (!Array.isArray(usageRows) || usageRows.length === 0) {
      res.status(400).json({ error: 'usageRows is required and must not be empty.' });
      return;
    }

    // Normalize to strings rather than trusting the shape off the wire —
    // these land verbatim in a message a human sends to another team.
    const rows = usageRows.map((row) => {
      const r = (row ?? {}) as Record<string, unknown>;
      return {
        label: String(r.label ?? ''),
        tsn: String(r.tsn ?? ''),
        tso: String(r.tso ?? ''),
        tsi: String(r.tsi ?? ''),
      };
    });

    const result = await createMaintenanceRecordsDraft({
      partNumber: partNumber.trim(),
      serialNumber: serialNumber.trim(),
      usageRows: rows,
    });

    if (!result.ok) {
      // 502: the request was fine, the local Outlook step is what failed.
      res.status(502).json({ error: result.error ?? 'Could not create the Outlook draft.' });
      return;
    }
    res.json({
      ok: true,
      subject: result.subject,
      recipients: result.recipients,
      resolved: result.resolved,
      mode: result.mode,
    });
  });

  app.post('/api/runs/:runId/cancel', requireSession, (req, res) => {
    const result = cancelJob(req.params.runId);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
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
    // craFile removed 2026-08-26 — the ESD Finder runs from the Vendor OOR
    // file alone. Still declared so an older client posting one gets a
    // clear 400 below rather than multer rejecting the whole request with
    // an opaque "Unexpected field".
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
      if (craFiles.length > 0) {
        cleanupUploads();
        res.status(400).json({
          error:
            'A CRA OOR file is no longer used — the ESD Finder now runs from the Vendor OOR file alone. ' +
            'Re-load the page if this came from an older tab.',
        });
        return;
      }

      const vendorFileRefs = vendorFiles.map((f) => ({ filePath: f.path, fileName: f.originalname }));

      // Fast rejection before a background job is even started — see
      // validateHeadersOnly's docstring for why this is a convenience, not
      // the structural guarantee (that lives inside ingestEsdFinderFiles,
      // re-checked regardless of what this pre-check already found).
      try {
        for (const f of vendorFileRefs) {
          await validateHeadersOnly(f.filePath, f.fileName, 'vendor');
        }
      } catch (err) {
        cleanupUploads();
        if (err instanceof MissingHeadersError) {
          res.status(400).json({ error: err.message });
        } else {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      const result = startEsdCompareJob(vendorFileRefs);
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
    res.json({ activeRunId: job?.runId ?? null, kind: job?.kind ?? null });
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
      sourceCompareRunId: job.sourceCompareRunId,
    });
  });

  // CLAUDE_CODE_PROMPT (cancel button) — mirrors /api/runs/:runId/cancel above.
  app.post('/api/esd/runs/:runId/cancel', requireSession, (req, res) => {
    const result = cancelEsdJob(req.params.runId);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
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
    const result = startEsdWriteJob(env, compareJob.result.dbRunId, orderNumbers, mxiCredential, runId);
    if (!result.ok) {
      res.status(409).json({ error: 'An ESD Finder job is already running.', activeRunId: result.conflictRunId });
      return;
    }
    res.status(202).json({ runId: result.runId, env });
  });

  // --- Invoice Price Writer API — a third independent workstream (own job
  // slot in invoicePriceJobManager.ts), same requireSession gate as the
  // rest of the browser UI. Single-phase: unlike the ESD Finder, there's no
  // separate compare/approve gate — the uploaded sheet already fully
  // specifies what to do per row, so "peek" is purely a local, non-MXI
  // preview (row count + header validation) and "start" goes straight to
  // the real per-row MXI job. ---

  const invoicePriceUpload = multer({ dest: path.join('data', 'invoice-price-uploads-tmp') });

  app.post('/api/invoice-price/peek', requireSession, invoicePriceUpload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'file is required.' });
      return;
    }
    try {
      const peeked = await peekInvoicePriceFile(file.path, file.originalname);
      res.json(peeked);
    } catch (err) {
      if (err instanceof InvoicePriceMissingHeadersError) {
        res.status(400).json({ error: err.message });
      } else {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      fs.rm(file.path, { force: true }, () => {});
    }
  });

  app.post('/api/invoice-price/start', requireSession, invoicePriceUpload.single('file'), async (req, res) => {
    const env = parseRequiredEnv(req, res);
    if (!env) {
      if (req.file) fs.rm(req.file.path, { force: true }, () => {});
      return;
    }
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'file is required.' });
      return;
    }

    // Fast rejection before a background job is even started — same
    // convenience-only pre-check pattern as /api/esd/compare; the runner
    // re-validates headers itself regardless.
    try {
      await peekInvoicePriceFile(file.path, file.originalname);
    } catch (err) {
      fs.rm(file.path, { force: true }, () => {});
      if (err instanceof InvoicePriceMissingHeadersError) {
        res.status(400).json({ error: err.message });
      } else {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    const session = (req as AuthedRequest).session!;
    const mxiCredential = getMxiCredentialForUser(authDb, session.userId);
    const result = startInvoicePriceWriteJob(env, file.path, file.originalname, mxiCredential);
    fs.rm(file.path, { force: true }, () => {}); // already copied into the job's own staging dir by now
    if (!result.ok) {
      res.status(409).json({ error: 'An Invoice Price Writer job is already running.', activeRunId: result.conflictRunId });
      return;
    }
    res.status(202).json({ runId: result.runId, env });
  });

  app.get('/api/invoice-price/active-job', requireSession, (_req, res) => {
    const job = getActiveInvoicePriceJob();
    res.json({ activeRunId: job?.runId ?? null });
  });

  app.get('/api/invoice-price/runs/:runId', requireSession, (req, res) => {
    const job = getInvoicePriceJob(req.params.runId);
    if (!job) {
      res.status(404).json({ error: `No Invoice Price Writer run found for runId "${req.params.runId}".` });
      return;
    }
    res.json({
      runId: job.runId,
      status: job.status,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      fatalError: job.fatalError,
      writeEnv: job.writeEnv,
      rowCount: job.rowCount,
      duplicateCount: job.duplicateCount,
      results: job.results,
    });
  });

  app.post('/api/invoice-price/runs/:runId/cancel', requireSession, (req, res) => {
    const result = cancelInvoicePriceJob(req.params.runId);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  });

  // CLAUDE_CODE_PROMPT (retry failed lines) — re-runs specific order
  // numbers from a finished run, appending to that same run rather than
  // starting a fresh one. Requested order numbers are validated against
  // the run's own stored results (must currently show 'failed') — never
  // trusted blindly from the client, same discipline as /api/esd/write's
  // own order-number validation against its source compare run.
  app.post('/api/invoice-price/runs/:runId/retry', requireSession, (req, res) => {
    const { runId } = req.params;
    const { orderNumbers } = req.body ?? {};
    if (!Array.isArray(orderNumbers) || orderNumbers.length === 0 || !orderNumbers.every((o) => typeof o === 'string')) {
      res.status(400).json({ error: 'orderNumbers must be a non-empty array of order number strings.' });
      return;
    }

    const job = getInvoicePriceJob(runId);
    if (!job) {
      res.status(404).json({ error: `No Invoice Price Writer run found for runId "${runId}".` });
      return;
    }

    const failedOrderNumbers = new Set(job.results.filter((r) => r.status === 'failed').map((r) => r.orderNumber));
    const invalid = orderNumbers.filter((o) => !failedOrderNumbers.has(o));
    if (invalid.length > 0) {
      res.status(400).json({
        error: `The following order number(s) are not currently-failed rows from run "${runId}": ${invalid.join(', ')}. Refusing to retry any of the requested orders.`,
      });
      return;
    }

    const session = (req as AuthedRequest).session!;
    const mxiCredential = getMxiCredentialForUser(authDb, session.userId);
    const result = retryInvoicePriceWriteJob(runId, orderNumbers, mxiCredential);
    if (!result.ok) {
      res.status(409).json({ error: result.error });
      return;
    }
    res.status(202).json({ runId });
  });

  // -------------------------------------------------------------------
  // Vendor Quote Writer (docs/VENDOR_QUOTE_WRITER_SPEC.md)
  //
  // Ingest only — reads the configured Outlook folder, extracts each PDF,
  // derives an ESD, records to audit.db. Touches neither MXI nor the
  // mailbox; the write half is a separate, human-approved step.
  // -------------------------------------------------------------------
  app.post('/api/quotes/ingest', requireSession, (req, res) => {
    const folderPath: string | undefined = req.body?.folderPath || process.env.QUOTES_FOLDER_PATH;
    if (!folderPath) {
      res.status(400).json({
        error:
          'No quotes folder configured. Set QUOTES_FOLDER_PATH in the server\'s .env, or pass folderPath in the request body.',
      });
      return;
    }

    // Bounded server-side regardless of what the client asks for: each PDF
    // is a real, paid model call, so an accidental (or malicious) huge
    // value must not be able to spend unbounded money.
    const requestedMax = Number(req.body?.maxMessages ?? 10);
    const maxMessages = Number.isFinite(requestedMax) ? Math.min(Math.max(1, Math.trunc(requestedMax)), 100) : 10;
    const unreadOnly = req.body?.unreadOnly !== false; // default ON — the intended operating mode

    const result = startQuoteIngestJob({ folderPath, maxMessages, unreadOnly });
    if (!result.ok) {
      res.status(409).json({ error: 'A Vendor Quote job is already running.', activeRunId: result.conflictRunId });
      return;
    }
    res.status(202).json({ runId: result.runId });
  });

  app.get('/api/quotes/active-job', requireSession, (_req, res) => {
    const job = getActiveQuoteJob();
    res.json({ activeRunId: job?.runId ?? null });
  });

  app.get('/api/quotes/runs/:runId', requireSession, (req, res) => {
    const job = getQuoteJob(req.params.runId);
    if (!job) {
      res.status(404).json({ error: `No Vendor Quote run found for runId "${req.params.runId}".` });
      return;
    }
    res.json({
      runId: job.runId,
      status: job.status,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      fatalError: job.fatalError,
      phase: job.phase,
      folderPath: job.folderPath,
      kind: job.kind,
      scannedCount: job.scannedCount,
      pdfCount: job.pdfCount,
      rows: job.rows,
      writeEnv: job.writeEnv,
      writeResults: job.writeResults,
    });
  });

  /**
   * Writes approved quotes into MXI: Unit Price + Price Type=QUOTE +
   * Promise By (the ESD derived from the vendor's own quote), then marks
   * each source email read — but only after a verified-successful write.
   *
   * `env` is required and explicit, never defaulted: this endpoint spends
   * real money against real orders, and "which environment" must be a
   * deliberate choice on every single call, the same rule the ESD Finder's
   * own write endpoint follows.
   *
   * Requested ids are validated to belong to this run, but the authoritative
   * writability check (disposition, already-written, missing fields) lives
   * in quoteWriteRunner.ts against the DB — a stray or replayed id cannot
   * force a write of something marked NREP/BER/excluded.
   */
  app.post('/api/quotes/write', requireSession, (req, res) => {
    const env = parseRequiredEnv(req, res);
    if (!env) return;

    const { runId, extractionIds } = req.body ?? {};
    if (typeof runId !== 'string' || !runId) {
      res.status(400).json({ error: 'runId is required.' });
      return;
    }
    if (
      !Array.isArray(extractionIds) ||
      extractionIds.length === 0 ||
      !extractionIds.every((id) => Number.isInteger(id) && id > 0)
    ) {
      res.status(400).json({ error: 'extractionIds must be a non-empty array of positive integers.' });
      return;
    }

    const job = getQuoteJob(runId);
    if (!job) {
      res.status(404).json({ error: `No Vendor Quote run found for runId "${runId}".` });
      return;
    }
    const knownIds = new Set(job.rows.map((r) => r.extractionId));
    const foreign = extractionIds.filter((id: number) => !knownIds.has(id));
    if (foreign.length > 0) {
      res.status(400).json({
        error: `Extraction id(s) ${foreign.join(', ')} do not belong to run "${runId}". Refusing the whole request.`,
      });
      return;
    }

    const session = (req as AuthedRequest).session!;
    const mxiCredential = getMxiCredentialForUser(authDb, session.userId);
    const result = startQuoteWriteJob(runId, env, extractionIds, mxiCredential);
    if (!result.ok) {
      if (result.conflictRunId) {
        res.status(409).json({ error: 'A Vendor Quote job is already running.', activeRunId: result.conflictRunId });
      } else {
        res.status(400).json({ error: result.error });
      }
      return;
    }
    res.status(202).json({ runId, env });
  });

  /**
   * Records a human disposition decision on one extracted quote: mark it
   * BER, exclude it outright, or put it back to pending.
   *
   * `excluded_nrep` is deliberately NOT accepted here — that disposition is
   * derived from what the vendor's own document says, so letting a client
   * assert it would fabricate a vendor claim that was never made. A human
   * who disagrees with an auto-NREP can set the row back to `pending`
   * instead, which is recorded as their decision.
   */
  app.post('/api/quotes/extractions/:extractionId/disposition', requireSession, (req, res) => {
    const extractionId = Number(req.params.extractionId);
    if (!Number.isInteger(extractionId) || extractionId <= 0) {
      res.status(400).json({ error: 'extractionId must be a positive integer.' });
      return;
    }

    const disposition: unknown = req.body?.disposition;
    if (typeof disposition !== 'string' || !isHumanSettableDisposition(disposition)) {
      res.status(400).json({
        error:
          "disposition must be one of 'pending', 'excluded_ber', or 'excluded_other'. " +
          "'excluded_nrep' is vendor-derived and cannot be set by hand — set 'pending' to override it.",
      });
      return;
    }

    const exists = db.prepare('SELECT 1 FROM quote_extractions WHERE id = ?').get(extractionId);
    if (!exists) {
      res.status(404).json({ error: `No quote extraction found with id ${extractionId}.` });
      return;
    }

    const session = (req as AuthedRequest).session!;
    insertQuoteDisposition(db, { quoteExtractionId: extractionId, disposition, decidedBy: session.username });

    // Best-effort in-memory sync so the UI's next poll reflects it. The DB
    // row above is the real record — a miss here (e.g. server restarted
    // since the run) is not a failure.
    const runId: unknown = req.body?.runId;
    if (typeof runId === 'string') applyQuoteDisposition(runId, extractionId, disposition);

    res.json({ ok: true, extractionId, disposition });
  });

  app.post('/api/quotes/runs/:runId/cancel', requireSession, (req, res) => {
    const ok = cancelQuoteJob(req.params.runId);
    if (!ok) {
      res.status(400).json({ error: `Run "${req.params.runId}" is not cancellable (not found or already finished).` });
      return;
    }
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------
  // Scrap-out tab — physically scraps a part in MXI.
  //
  // The most destructive action in this project: irreversible and NOT
  // idempotent. `env` is required and never defaulted, and the runner
  // re-validates everything (certificate authenticity, already-scrapped)
  // against real data rather than trusting this request.
  // -------------------------------------------------------------------
  const scrapUpload = multer({ dest: path.join('data', 'scrap-uploads-tmp') });

  app.post('/api/scrap/start', requireSession, scrapUpload.single('certificate'), (req, res) => {
    const env = parseRequiredEnv(req, res);
    if (!env) return;

    const kind = req.body?.kind;
    if (kind !== 'vendor' && kind !== 'in_house') {
      res.status(400).json({ error: 'kind must be exactly "vendor" or "in_house".' });
      return;
    }
    if (kind === 'vendor' && !req.file) {
      res.status(400).json({ error: 'A scrap certificate PDF is required for a vendor scrap.' });
      return;
    }
    // Accepts a pasted list — newline, comma, tab, or semicolon separated.
    // Parsed and de-duplicated server-side rather than trusting the client:
    // scrapping is irreversible, so the same serial twice in one paste must
    // not become two attempts.
    const serialNumbers = kind === 'in_house' ? parseSerialList(String(req.body?.serialNumbers ?? req.body?.serialNumber ?? '')) : [];
    if (kind === 'in_house' && serialNumbers.length === 0) {
      res.status(400).json({ error: 'At least one serial number is required for an in-house scrap.' });
      return;
    }

    const session = (req as AuthedRequest).session!;
    const mxiCredential = getMxiCredentialForUser(authDb, session.userId);
    const result = startScrapOutJob(
      {
        kind,
        env,
        certTempPath: req.file?.path,
        certFileName: req.file?.originalname,
        serialNumbers,
        performedBy: session.username,
      },
      mxiCredential,
    );

    if (!result.ok) {
      if (result.conflictRunId) {
        res.status(409).json({ error: 'A scrap job is already running.', activeRunId: result.conflictRunId });
      } else {
        res.status(400).json({ error: result.error });
      }
      return;
    }
    res.status(202).json({ runId: result.runId, env });
  });

  app.get('/api/scrap/active-job', requireSession, (_req, res) => {
    const job = getActiveScrapJob();
    res.json({ activeRunId: job?.runId ?? null });
  });

  app.get('/api/scrap/runs/:runId', requireSession, (req, res) => {
    const job = getScrapJob(req.params.runId);
    if (!job) {
      res.status(404).json({ error: `No scrap run found for runId "${req.params.runId}".` });
      return;
    }
    res.json({
      runId: job.runId,
      kind: job.kind,
      status: job.status,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      fatalError: job.fatalError,
      phase: job.phase,
      env: job.env,
      certPreview: job.certPreview,
      results: job.results,
      totalRequested: job.totalRequested,
    });
  });

  app.post('/api/scrap/runs/:runId/cancel', requireSession, (req, res) => {
    const ok = cancelScrapJob(req.params.runId);
    if (!ok) {
      res.status(400).json({ error: `Run "${req.params.runId}" is not cancellable (not found or already finished).` });
      return;
    }
    res.json({ ok: true });
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
      log.warn({ orderNumber, crossEnvWarning }, '[cross-environment] warning');
    }

    const result = await writeEsdAndNotes(mxiClient, orderNumber, {
      esd: toMxiDateFormat(pending.inferredEsd),
      // CORRECTED 2026-08-20 — the note states the vendor's own assumed
      // ESD (extractedBaseDate, pre-buffer), not the buffered promised-by
      // date going into the ESD field above. Consistent with the ESD
      // Finder's esd_write branch (esdWriteRunner.ts) and approveAndWrite.
      noteText: assembleNoteText(pending.vendorNotes, pending.extractedBaseDate) ?? undefined,
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
      log.warn({ orderNumber, crossEnvWarning }, '[cross-environment] warning');
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
  // CLAUDE_CODE_PROMPT (#6-hardening, secrets-seam) — loaded once, before
  // anything below that needs a secret (loadMxiConfig()'s MXI_USERNAME/
  // MXI_PASSWORD read, and every later per-request AUTOMATION_API_KEY /
  // CREDENTIAL_ENCRYPTION_KEY read via crypto.ts).
  await getSecretProvider().init();

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
    log.info({ port, mxiEnv: config.env }, 'ESD approval API listening');
  });

  const shutdown = async (): Promise<void> => {
    log.info('Shutting down...');
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
    log.error({ err }, 'Server failed to start');
    process.exit(1);
  });
}
