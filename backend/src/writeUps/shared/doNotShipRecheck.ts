import type Database from 'better-sqlite3';
import type { MxiClient } from '../../mxiWriter/mxiClient.js';
import { openInventoryBySerial } from '../../mxiWriter/openInventoryBySerial.js';
import { readPartOwnDetails } from './partOwnDetails.js';
import { classifyUsageTable } from './usageTable.js';
import { completeCreateOrderOnly, verifyExternalReferenceCommitted, ZERO_USAGE_DO_NOT_SHIP_REASON } from './createOrderOnly.js';
import { insertWriteUpAction } from '../../db/db.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('writeup');

/**
 * CLAUDE_CODE_PROMPT (DO NOT SHIP auto-clear, 2026-09-11) — per explicit
 * user direction: "if a unit that had 0 times and cycles has those times
 * and cycles corrected... I want, after a repair order is created, to
 * look to see if there is any note saying not to ship. If the times and
 * cycles are good, I want that note removed." Confirmed scope via
 * explicit follow-up: this ONLY removes the note — it does not also
 * request authorization / issue / move to dock (a materially bigger,
 * less-reviewed action the user explicitly did not ask for) — and it runs
 * fully automatically on a periodic timer (server.ts), not on demand.
 *
 * Scoped strictly to the ZERO_USAGE_DO_NOT_SHIP_REASON condition
 * (createOrderOnly.ts's only reason for this outcome today) — the RMA
 * "AWAITING RMA" note (composeAwaitingRmaNote) is a vendor-membership
 * rule, not a correctable data condition, and the user's own request only
 * ever described times and cycles.
 *
 * **The read step below (openInventoryBySerial -> readPartOwnDetails) is
 * a NEW COMBINATION, not independently verified live.** Each half is
 * separately proven: openInventoryBySerial already reaches
 * InventoryDetails.jsp from cold for the back-shop discovery pass, and
 * readPartOwnDetails already reads the Current Usage table correctly once
 * standing on that same page (partOwnDetails.ts's own docstring: "this
 * function is already standing on InventoryDetails.jsp to read the usage
 * table"). They have not been run back-to-back before. The WRITE step
 * (completeCreateOrderOnly / verifyExternalReferenceCommitted) is
 * unchanged, already-proven code, just called with an empty note instead
 * of a composed one. Recommend a first watched run before trusting the
 * periodic pass unattended.
 */

export interface DoNotShipCandidate {
  writeUpActionId: number;
  orderNumber: string;
  partNumber: string;
  serialNumber: string;
}

interface RawCandidateRow {
  id: number;
  order_number: string;
  part_number: string;
  filled_fields_json: string | null;
}

/**
 * Every order whose MOST RECENT write_up_actions row (for this env) is
 * still 'order_created_do_not_ship' with the zero-usage reason — the
 * append-only "latest row is truth" pattern already used elsewhere in
 * this project (e.g. esdWriteRunner's "already succeeded" check): once a
 * 'do_not_ship_note_cleared' row is inserted for an order, that becomes
 * its latest row and it stops appearing here on the next pass, with no
 * separate "already processed" bookkeeping needed.
 */
export function findDoNotShipCandidates(db: Database.Database, targetEnv: string, limit: number): DoNotShipCandidate[] {
  const rows = db
    .prepare(
      `SELECT w.id, w.order_number, w.part_number, w.filled_fields_json
       FROM write_up_actions w
       INNER JOIN (
         SELECT order_number, MAX(id) AS max_id
         FROM write_up_actions
         WHERE order_number IS NOT NULL AND target_env = ?
         GROUP BY order_number
       ) latest ON w.order_number = latest.order_number AND w.id = latest.max_id
       WHERE w.outcome = 'order_created_do_not_ship'
       ORDER BY w.id ASC
       LIMIT ?`,
    )
    .all(targetEnv, limit) as RawCandidateRow[];

  const candidates: DoNotShipCandidate[] = [];
  for (const row of rows) {
    let parsed: { reason?: string; serialNumber?: string } = {};
    try {
      parsed = row.filled_fields_json ? JSON.parse(row.filled_fields_json) : {};
    } catch {
      log.warn({ orderNumber: row.order_number }, '[do-not-ship-recheck] filled_fields_json did not parse — skipping');
      continue;
    }
    if (parsed.reason !== ZERO_USAGE_DO_NOT_SHIP_REASON) continue;
    if (!parsed.serialNumber) {
      log.warn({ orderNumber: row.order_number }, '[do-not-ship-recheck] no serialNumber recorded for this order — skipping');
      continue;
    }
    candidates.push({
      writeUpActionId: row.id,
      orderNumber: row.order_number,
      partNumber: row.part_number,
      serialNumber: parsed.serialNumber,
    });
  }
  return candidates;
}

export type DoNotShipRecheckStatus = 'cleared' | 'still_zero' | 'inconclusive' | 'error';

export interface DoNotShipRecheckResult {
  orderNumber: string;
  status: DoNotShipRecheckStatus;
  detail: string | null;
}

/**
 * Re-reads one candidate's current usage and clears its DO NOT SHIP note
 * if it's no longer all-zero. Never removes the note on an inconclusive
 * read (no usage table found at all) — an order this can't positively
 * confirm as fixed is left exactly as it was for the next pass, not
 * guessed at either way.
 */
export async function recheckAndClearDoNotShip(
  client: MxiClient,
  db: Database.Database,
  targetEnv: string,
  candidate: DoNotShipCandidate,
): Promise<DoNotShipRecheckResult> {
  const page = await client.getAuthenticatedPage();

  try {
    const opened = await openInventoryBySerial(page, client.todoListUrl, candidate.serialNumber);
    if (opened.status !== 'opened') {
      return { orderNumber: candidate.orderNumber, status: 'inconclusive', detail: opened.error };
    }

    const details = await readPartOwnDetails(page, candidate.partNumber, candidate.serialNumber);
    if (!details.usageTableFound) {
      return {
        orderNumber: candidate.orderNumber,
        status: 'inconclusive',
        detail: 'No Current Usage table found on the inventory record — not treated as fixed.',
      };
    }

    const classification = classifyUsageTable(details.usageRows);
    if (classification !== 'present_nonzero') {
      // 'present_all_zero' -> genuinely still zero, nothing to do.
      // 'absent' can't happen here (usageTableFound is true), kept for
      // exhaustiveness rather than assumed impossible.
      return { orderNumber: candidate.orderNumber, status: 'still_zero', detail: null };
    }

    await completeCreateOrderOnly(page, candidate.orderNumber, '');
    const verified = await verifyExternalReferenceCommitted(page, candidate.orderNumber, client.todoListUrl, '');
    if (!verified.committed) {
      return {
        orderNumber: candidate.orderNumber,
        status: 'error',
        detail: `Cleared the note but re-read "${verified.realValue}" afterward instead of blank — the write may not have taken.`,
      };
    }

    insertWriteUpAction(db, {
      vendor: 'DO_NOT_SHIP_RECHECK',
      partNumber: candidate.partNumber,
      targetEnv,
      outcome: 'do_not_ship_note_cleared',
      stationCode: null,
      routedLocation: null,
      filledFieldsJson: JSON.stringify({ serialNumber: candidate.serialNumber, usageRows: details.usageRows }),
      errorMessage: null,
      orderNumber: candidate.orderNumber,
    });
    log.info({ orderNumber: candidate.orderNumber, partNumber: candidate.partNumber }, '[do-not-ship-recheck] note cleared — usage no longer zero');
    return { orderNumber: candidate.orderNumber, status: 'cleared', detail: null };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ orderNumber: candidate.orderNumber, errorMessage }, '[do-not-ship-recheck] recheck failed');
    return { orderNumber: candidate.orderNumber, status: 'error', detail: errorMessage };
  }
}

/**
 * One full pass: find candidates, recheck each in turn, on the SAME
 * already-authenticated client. One candidate's failure does not stop the
 * rest — same "each reports its own result" discipline as every other
 * multi-target job in this project.
 */
export async function runDoNotShipRecheckPass(
  client: MxiClient,
  db: Database.Database,
  targetEnv: string,
  limit: number,
): Promise<DoNotShipRecheckResult[]> {
  const candidates = findDoNotShipCandidates(db, targetEnv, limit);
  if (candidates.length === 0) return [];

  log.info({ count: candidates.length, targetEnv }, '[do-not-ship-recheck] starting pass');
  const results: DoNotShipRecheckResult[] = [];
  for (const candidate of candidates) {
    results.push(await recheckAndClearDoNotShip(client, db, targetEnv, candidate));
  }
  const cleared = results.filter((r) => r.status === 'cleared').length;
  log.info({ count: candidates.length, cleared, targetEnv }, '[do-not-ship-recheck] pass complete');
  return results;
}
