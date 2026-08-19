import 'dotenv/config';
import Database from 'better-sqlite3';
import { getPriorMxiWriteEnvironments, insertMxiWrite } from '../db/db.js';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import { assembleNoteText, toMxiDateFormat } from '../mxiWriter/esdFormatting.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import { navigateToOrder, readIssuedCount } from '../mxiWriter/selectors.js';
import { writeEsdAndNotes } from '../mxiWriter/writeEsdAndNotes.js';
import { writeToolOutputFlags, type WriteOutcomeByOrder } from '../output/writeToolOutputFlags.js';
import type { InferenceRecord } from '../types.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('cli');

/**
 * The real, permanent "approve these specific orders for real" tool —
 * supersedes the one-off partCAutoWrite.ts (deleted; this replaces it,
 * generalized beyond that specific 44-order run).
 *
 * Trusts writeEsdAndNotes's own result directly rather than
 * re-implementing verification here: writeEsdAndNotes now always
 * independently verifies and self-heals a silent-partial notes gap
 * internally (see its docstring — a real gap found and fixed at 40-order
 * scale). A 'success' here means both the ESD and the note (if requested)
 * are genuinely correct, not just "no exception was thrown."
 *
 * Automatically refreshes the tool-table (Automation Flag/Flag
 * Note/Suggested Action) at the end, rebuilt from the FULL history in
 * mxi_writes for this run (not just this invocation's orders) — so
 * approvals from earlier runs of this same tool aren't overwritten back
 * to "Pending Review" the next time this is called. This is the step that
 * previously required a separate, bespoke script every time.
 *
 * Usage:
 *   tsx approveAndWrite.ts <runId> <toolFilePath> approve <orderNumber1,orderNumber2,...> <approvedBy> [--env stage]
 *   tsx approveAndWrite.ts <runId> <toolFilePath> reject  <orderNumber1,orderNumber2,...> <approvedBy> [--env stage]
 *
 * Defaults to production (per explicit user instruction, 2026-08-19).
 * `--env stage` (can appear anywhere in the args) makes `approve` write to
 * stage instead. `reject` never touches MXI at all (no client is created
 * for it), so --env only affects the targetEnv recorded on its audit row.
 *
 * Pass the literal word `all` instead of a comma-separated list to act on
 * every flag='ok' order for this run that doesn't already have a recorded
 * outcome (skips anything already approved/rejected in an earlier
 * invocation, so it's never a re-write). `all` only lists what it would do
 * and does NOT touch anything until you add `--confirm` too — still a
 * deliberate, reviewed action, just without retyping every order number.
 */

type RawEsdInferenceRow = {
  id: number;
  order_number: string;
  vendor_name: string | null;
  ro_esd_raw: string | null;
  mxi_esd_raw: string | null;
  current_status: string | null;
  vendor_notes: string | null;
  order_status: string | null;
  classification: string | null;
  extracted_base_date: string | null;
  buffer_days_applied: number | null;
  used_fallback: number;
  confidence: string | null;
  reasoning_note: string | null;
  inferred_esd: string | null;
  flag: string;
  delta_days_vs_mxi: number | null;
};

function toInferenceRecord(r: RawEsdInferenceRow): InferenceRecord {
  return {
    orderNumber: r.order_number,
    vendorName: r.vendor_name,
    roEsdRaw: r.ro_esd_raw,
    mxiEsdRaw: r.mxi_esd_raw,
    currentStatus: r.current_status,
    vendorNotes: r.vendor_notes,
    orderStatus: r.order_status,
    classification: r.classification as InferenceRecord['classification'],
    extractedBaseDate: r.extracted_base_date,
    bufferDaysApplied: r.buffer_days_applied,
    usedFallback: !!r.used_fallback,
    confidence: r.confidence as InferenceRecord['confidence'],
    reasoningNote: r.reasoning_note,
    inferredEsd: r.inferred_esd,
    flag: r.flag as InferenceRecord['flag'],
    deltaDaysVsMxi: r.delta_days_vs_mxi,
    aiCallMade: false,
  };
}

/** Rebuilds the full outcomes map for a run from mxi_writes' real history — not just this invocation. */
function loadHistoricalOutcomes(db: Database.Database, runId: number): WriteOutcomeByOrder {
  const rows = db
    .prepare(
      `SELECT mw.order_number, mw.action, mw.write_status, mw.error_message, mw.id
       FROM mxi_writes mw
       JOIN esd_inferences ei ON ei.id = mw.esd_inference_id
       WHERE ei.run_id = ?
       ORDER BY mw.id ASC`,
    )
    .all(runId) as Array<{ order_number: string; action: string; write_status: string; error_message: string | null; id: number }>;

  const outcomes: WriteOutcomeByOrder = {};
  for (const row of rows) {
    // Later rows win — e.g. a corrective follow-up row after an initial failure.
    if (row.action === 'rejected') {
      outcomes[row.order_number] = { status: 'rejected' };
    } else if (row.write_status === 'success') {
      outcomes[row.order_number] = { status: 'success' };
    } else if (/not found in stage mxi/i.test(row.error_message ?? '')) {
      outcomes[row.order_number] = { status: 'not_found' };
    } else {
      outcomes[row.order_number] = { status: 'failed', errorMessage: row.error_message ?? undefined };
    }
  }
  return outcomes;
}

async function main(): Promise<void> {
  const { env, rest: rawRest } = parseEnvFlag(process.argv.slice(2));
  const confirmIndex = rawRest.indexOf('--confirm');
  const confirmed = confirmIndex !== -1;
  const rest = confirmed ? [...rawRest.slice(0, confirmIndex), ...rawRest.slice(confirmIndex + 1)] : rawRest;

  const runId = Number(rest[0]);
  const toolFilePath = rest[1];
  const action = rest[2];

  if (!runId || !toolFilePath || (action !== 'approve' && action !== 'reject' && action !== 'refresh')) {
    log.error(
      'Usage: tsx approveAndWrite.ts <runId> <toolFilePath> approve|reject <orderNumber1,orderNumber2,...> <approvedBy> [--env production]\n' +
        '       tsx approveAndWrite.ts <runId> <toolFilePath> refresh   (re-writes the tool-table from the run\'s existing mxi_writes history only — no new approve/reject action, no MXI client created; use this to retry the tool-table write-back after a file-lock failure without re-touching MXI)',
    );
    process.exitCode = 1;
    return;
  }

  if (action === 'refresh') {
    log.info({ runId }, 'Refreshing tool-table from existing history only — no new MXI action taken.');
    const refreshDb = new Database('data/audit.db');
    const allRows = refreshDb.prepare('SELECT * FROM esd_inferences WHERE run_id = ?').all(runId) as RawEsdInferenceRow[];
    const records = allRows.map(toInferenceRecord);
    const outcomes = loadHistoricalOutcomes(refreshDb, runId);
    refreshDb.close();
    const writeBackResult = await writeToolOutputFlags(toolFilePath, records, outcomes);
    log.info({ summary: writeBackResult.summary }, 'Tool-table write-back summary');
    return;
  }

  const orderNumbersArg = rest[3] ?? '';
  const approvedBy = rest[4] ?? 'manual-approval';

  if (!orderNumbersArg) {
    log.error(
      'Usage: tsx approveAndWrite.ts <runId> <toolFilePath> approve|reject <orderNumber1,orderNumber2,...>|all <approvedBy> [--env production] [--confirm]',
    );
    process.exitCode = 1;
    return;
  }

  const db = new Database('data/audit.db');

  let orderNumbers: string[];
  if (orderNumbersArg.toLowerCase() === 'all') {
    const allOkRows = db
      .prepare(`SELECT order_number FROM esd_inferences WHERE run_id = ? AND flag = 'ok'`)
      .all(runId) as Array<{ order_number: string }>;
    const existingOutcomes = loadHistoricalOutcomes(db, runId);
    orderNumbers = allOkRows.map((r) => r.order_number).filter((o) => !(o in existingOutcomes));

    if (orderNumbers.length === 0) {
      log.info({ runId }, "No pending flag='ok' orders remain — everything already has a recorded outcome.");
      db.close();
      return;
    }

    log.info({ runId, orderCount: orderNumbers.length }, '"all" resolved to order(s) with no existing outcome yet');
    log.info({ orderNumbers }, 'Resolved order numbers');

    if (!confirmed) {
      log.info(
        { action, orderCount: orderNumbers.length },
        'Nothing has been written. Re-run with --confirm added to actually act on all of these.',
      );
      db.close();
      return;
    }
  } else {
    orderNumbers = orderNumbersArg.split(',').filter(Boolean);
  }

  if (orderNumbers.length === 0) {
    log.error(
      'Usage: tsx approveAndWrite.ts <runId> <toolFilePath> approve|reject <orderNumber1,orderNumber2,...>|all <approvedBy> [--env production] [--confirm]',
    );
    db.close();
    process.exitCode = 1;
    return;
  }

  if (action === 'approve') {
    log.info({ env: env.toUpperCase() }, 'Target MXI environment');
  }

  const placeholders = orderNumbers.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, order_number, inferred_esd, vendor_notes FROM esd_inferences
       WHERE run_id = ? AND flag = 'ok' AND order_number IN (${placeholders})`,
    )
    .all(runId, ...orderNumbers) as Array<{ id: number; order_number: string; inferred_esd: string; vendor_notes: string | null }>;

  if (rows.length !== orderNumbers.length) {
    log.error(
      { runId, expectedCount: orderNumbers.length, foundCount: rows.length },
      "Expected matching flag='ok' rows count mismatch — aborting before touching anything.",
    );
    db.close();
    process.exitCode = 1;
    return;
  }

  const byOrderNumber = new Map(rows.map((r) => [r.order_number, r]));
  const ordered = orderNumbers.map((o) => byOrderNumber.get(o)!);

  if (action === 'reject') {
    for (const row of ordered) {
      insertMxiWrite(db, {
        esdInferenceId: row.id,
        orderNumber: row.order_number,
        targetEnv: env,
        action: 'rejected',
        inferredEsd: row.inferred_esd,
        writeStatus: 'skipped',
        errorMessage: null,
        approvedBy,
      });
      log.info({ orderNumber: row.order_number }, 'Rejected (no MXI write attempted).');
    }
  } else {
    const client = await createReadyMxiClient(env);
    try {
      const page = await client.getAuthenticatedPage();

      for (const row of ordered) {
        const orderNumber = row.order_number;
        const expectedEsd = toMxiDateFormat(row.inferred_esd);
        const noteText = assembleNoteText(row.vendor_notes) ?? undefined;

        log.info({ orderNumber }, 'Processing order');

        // Order numbers are confirmed NOT unique across environments (found
        // live during aeroRepair testing). Real mxi_writes history shows
        // this project's common case is legitimate test-in-stage-then-
        // deploy-to-production on the SAME real order, so this warns
        // rather than blocking (explicit decision) — but it's surfaced
        // loudly, not silently assumed fine.
        const priorEnvs = getPriorMxiWriteEnvironments(db, orderNumber);
        const differingEnvs = priorEnvs.filter((e) => e !== env);
        if (differingEnvs.length > 0) {
          log.warn(
            { orderNumber, priorEnvs: differingEnvs, requestedEnv: env },
            'Cross-environment: order has prior mxi_writes history under a different environment — confirm this is the same real order intentionally handled in both, not a coincidental collision.',
          );
        }

        const start = Date.now();

        const issuedBefore = await navigateToOrder(page, orderNumber, client.todoListUrl)
          .then(() => readIssuedCount(page))
          .catch(() => null);

        const result = await writeEsdAndNotes(client, orderNumber, { esd: expectedEsd, noteText });
        const durationMs = Date.now() - start;

        if (result.status === 'failed') {
          const clientState = client.getState();
          const looksLikeSessionLoss =
            clientState.status === 'failed' ||
            /MXI client was never initialized|Re-authentication failed/i.test(result.errorMessage ?? '');

          if (looksLikeSessionLoss) {
            log.error({ orderNumber, errorMessage: result.errorMessage }, 'SESSION/LOGIN LOSS');
            log.error('Halting immediately, per the standing rule.');
            insertMxiWrite(db, {
              esdInferenceId: row.id,
              orderNumber,
              targetEnv: client.config.env,
              action: 'approved_write',
              inferredEsd: row.inferred_esd,
              writeStatus: 'failed',
              errorMessage: result.errorMessage,
              approvedBy,
            });
            break;
          }

          const notFound = /could not be found in the system/i.test(
            await page
              .locator('body')
              .innerText({ timeout: 5000 })
              .catch(() => ''),
          );

          log.info({ orderNumber, notFound, errorMessage: result.errorMessage }, 'FAILED');
          insertMxiWrite(db, {
            esdInferenceId: row.id,
            orderNumber,
            targetEnv: client.config.env,
            action: 'approved_write',
            inferredEsd: row.inferred_esd,
            writeStatus: 'failed',
            errorMessage: notFound ? 'Order not found in stage MXI.' : result.errorMessage,
            approvedBy,
          });
          continue;
        }

        const issuedAfter = await navigateToOrder(page, orderNumber, client.todoListUrl)
          .then(() => readIssuedCount(page))
          .catch(() => null);
        log.info(
          { orderNumber, includesNote: !!noteText, issuedBefore, issuedAfter, durationMs },
          'SUCCESS — ESD independently verified by writeEsdAndNotes itself.',
        );
        insertMxiWrite(db, {
          esdInferenceId: row.id,
          orderNumber,
          targetEnv: client.config.env,
          action: 'approved_write',
          inferredEsd: row.inferred_esd,
          writeStatus: 'success',
          errorMessage: null,
          approvedBy,
        });
      }
    } finally {
      await client.shutdown();
    }
  }

  log.info('Refreshing tool-table with the full real history for this run');
  const allRows = db.prepare('SELECT * FROM esd_inferences WHERE run_id = ?').all(runId) as RawEsdInferenceRow[];
  const records = allRows.map(toInferenceRecord);
  const outcomes = loadHistoricalOutcomes(db, runId);
  db.close();

  const writeBackResult = await writeToolOutputFlags(toolFilePath, records, outcomes);
  log.info({ summary: writeBackResult.summary }, 'Tool-table write-back summary');
}

main().catch((err) => {
  log.error({ errorMessage: err instanceof Error ? err.message : String(err) }, 'Failed');
  process.exitCode = 1;
});
