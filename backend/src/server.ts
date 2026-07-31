import type { Database as DatabaseType } from 'better-sqlite3';
import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getActionableEsdInference, getPendingEsdUpdates, getPriorMxiWriteEnvironments, insertMxiWrite, openDb } from './db/db.js';
import { loadMxiConfig } from './mxiWriter/config.js';
import { assembleNoteText, toMxiDateFormat } from './mxiWriter/esdFormatting.js';
import { MxiClient } from './mxiWriter/mxiClient.js';
import { writeEsdAndNotes } from './mxiWriter/writeEsdAndNotes.js';

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

export function createApp(db: DatabaseType, mxiClient: MxiClient) {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
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
  const port = Number(process.env.PORT) || 3001;

  const config = loadMxiConfig(); // throws if MXI_ENV isn't literally "stage" or "production"

  const db = openDb(dbPath);
  const mxiClient = new MxiClient(config);
  await mxiClient.initialize();

  const app = createApp(db, mxiClient);
  const httpServer = app.listen(port, () => {
    console.log(`ESD approval API listening on http://localhost:${port} (MXI_ENV=${config.env})`);
  });

  const shutdown = async (): Promise<void> => {
    console.log('\nShutting down...');
    httpServer.close();
    await mxiClient.shutdown();
    db.close();
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
